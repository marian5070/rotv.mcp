import { z } from 'zod';
import { getEpgFull, getStreaming } from '../data/store.mjs';
import { shapeProgram, resolveTimeRef, programOverlaps, windowAdmits } from '../lib/time.mjs';
import { resolveMood, moodLabel } from '../lib/moods.mjs';
import { extractGenres } from '../lib/genre-extract.mjs';
import { findStreamingFor, findStreamingForProgram } from '../lib/xref.mjs';
import { computeFreshness, freshnessEmbed } from '../lib/freshness.mjs';
import { matchesQuery, normalize } from '../lib/text.mjs';
import { Freshness, Loose } from '../lib/output-shapes.mjs';
import { resolvePreferLabel } from '../lib/rank.mjs';
import { titleMatchRank, isMostlyMissed } from '../lib/title-match.mjs';
import { scoreComponents, sumComponents, PROFILE, channelScore, streamingAsItem } from '../lib/mood-score.mjs';

export const ExplainOutput = {
  ok: z.boolean(),
  reason: z.string().optional(),
  subject: Loose.optional(),
  context: Loose.optional(),
  score_breakdown: Loose.optional(),
  extracted_genres: z.array(Loose).optional(),
  streaming_xref: Loose.nullable().optional(),
  sources_used: z.array(z.string()).optional(),
  fresh_status: Loose.optional(),
  alternatives_not_picked: z.array(Loose).optional(),
  confidence: z.string().optional(),
  freshness: Freshness,
};

export const ExplainInput = {
  title: z.string().min(2).max(200).describe('Program title to explain'),
  channel: z.string().optional().describe('Optional channel id/name/alias to disambiguate'),
  start_utc: z.string().optional().describe('Optional ISO start time to disambiguate'),
  context: z.object({
    mood: z.string().optional(),
    prefer: z.array(z.string()).optional(),
    timeframe: z.string().optional(),
  }).optional(),
};


// Cu o fereastră cerută și fără start_utc, se explică difuzarea DIN fereastră
// (aceeași pe care o întoarce tv_recommend_by_mood), nu prima din EPG:
// „FBI" are episoade la 19:10 și la 20:05, iar „diseară" înseamnă al doilea.
function findProgram(epg, title, channel, startUtc, window = null, now = new Date()) {
  if (window && !startUtc) {
    const inWindow = findProgramWhere(epg, title, channel, null, (p) => programOverlaps(p, window) && windowAdmits(p, window, now));
    if (inWindow) return inWindow;
  }
  return findProgramWhere(epg, title, channel, startUtc, () => true);
}

function findProgramWhere(epg, title, channel, startUtc, accept) {
  const nowMs = Date.now();
  let best = null;
  for (const ch of epg.channels) {
    if (channel) {
      const q = normalize(channel);
      const hit = normalize(ch.id) === q ||
        normalize(ch.displayName).includes(q) || q.includes(normalize(ch.displayName)) ||
        (ch.aliases || []).some((a) => normalize(a).includes(q) || q.includes(normalize(a)));
      if (!hit) continue;
    }
    for (const p of (ch.programs || [])) {
      const rank = titleMatchRank(p.title, title);
      if (rank === null) continue;
      if (startUtc && new Date(p.start).toISOString() !== new Date(startUtc).toISOString()) continue;
      if (!accept(p)) continue;
      // Aceeași ordine ca în tv_compare_options: titlu exact → difuzare care se
      // mai poate prinde (nu una încheiată sau aproape pierdută) → cea mai apropiată.
      const startMs = new Date(p.start).getTime();
      const gone = new Date(p.stop).getTime() <= nowMs || isMostlyMissed(p, nowMs) ? 1 : 0;
      const key = [rank, startUtc ? 0 : gone, startMs];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) {
        best = { ch, program: p, key };
      }
    }
  }
  return best ? { ch: best.ch, program: best.program, rank: best.key[0] } : null;
}

export async function handleExplain(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');
  const streaming = getStreaming();
  const now = new Date();
  const ctx = args.context || {};
  const mood = resolveMood(ctx.mood);

  const window = ctx.timeframe ? resolveTimeRef(ctx.timeframe, now) : null;
  let hit = findProgram(epg, args.title, args.channel, args.start_utc, window, now);
  // La fel ca în tv_compare_options: titlul cerut există exact în catalog, iar
  // la TV doar ca fragment din alt titlu → se explică titlul din catalog.
  if (hit && hit.rank === 3 && !args.channel && !args.start_utc && streaming) {
    const exact = findStreamingFor(args.title, streaming);
    if (exact?.tier === 'exact') hit = null;
  }
  if (!hit) {
    // Nu e în grila TV, dar poate fi în catalogul de streaming: îl explicăm cu
    // aceleași componente pe care le folosește tv_compare_options.
    const sx = streaming ? findStreamingFor(args.title, streaming) : null;
    if (sx) return explainStreamingOnly(sx, { mood, ctx, now });
    return {
      payload: {
        ok: false,
        reason: `Nu am găsit "${args.title}"${args.channel ? ' pe canalul ' + args.channel : ''} nici în grila TV, nici în catalogul de streaming.`,
        freshness: freshnessEmbed(now),
      },
      _quality: {
        items_returned: 0, candidates_evaluated: 0, avg_score: 0, max_score: 0,
        unique_channels: 0, cross_source_used: false, fallback_used: false, freshness_stale: false,
      },
    };
  }

  const item = shapeProgram(hit.ch, hit.program);
  const genres = extractGenres(hit.program.title, hit.program.description, hit.program);
  const fallbackUsed = genres.length === 0;
  const extraPrefer = (ctx.prefer || []).map(resolvePreferLabel);
  const xref = streaming ? findStreamingForProgram(item.program, streaming) : null;
  const crossUsed = !!xref;

  // Aceleași componente și același profil ca tv_compare_options / tv_recommend_by_mood.
  // Cu context.timeframe, proximitatea și startul târziu se măsoară față de
  // fereastra cerută — exact ca în tv_recommend_by_mood pentru același timeframe.
  const c = scoreComponents(item, { genres, mood, preferLabels: extraPrefer, now, xref, window });
  const mf = { score: c.mood_fit, parts: c.moodParts };
  const channelCat = c.channel_cat;
  const deltaMin = c.deltaMin;
  const timeProx = Math.round((c.time_proximity + c.late_start) * 100) / 100;
  const proxRef = c.proximityAnchored ? 'de la începutul ferestrei' : 'de acum';
  const durMatch = c.duration_match;
  const prefBoost = c.prefer_boost;
  const xrefBoost = c.xref_boost;

  const total = Math.round(sumComponents(c, PROFILE.full) * 100) / 100;
  const fresh = computeFreshness(now);
  const epgAge = fresh.epgAge ?? 0;

  const score_breakdown = {
    channel_cat: { value: channelCat, why: `Categoria '${item.channel_category}' valorează ${channelCat >= 0 ? '+' + channelCat : channelCat}` },
    mood_fit: { value: mf.score, why: mf.parts.length ? `Mood '${mood.label_ro}': ${mf.parts.join('; ')}` : `Mood '${mood.label_ro}' — niciun factor nu se aplică` },
    time_proximity: {
      value: timeProx,
      why: c.late_start < 0
        ? `Începe la ${Math.round(deltaMin)} min ${proxRef} — start târziu în fereastra cerută (${c.late_start})${c.inProximity ? ', dar în banda de proximitate (+2)' : ''}`
        : c.inProximity
          ? `Începe la ${Math.round(deltaMin)} min ${proxRef} (bandă -5…+${Math.round(c.proximityBandMax)} min)`
          : `Începe la ${Math.round(deltaMin)} min ${proxRef} — în afara benzii de proximitate`,
    },
    duration_match: { value: durMatch, why: durMatch > 0 ? `${item.program.duration_min} min se încadrează în 45–180` : `${item.program.duration_min} min — în afara band-ului 45–180` },
    prefer_boost: { value: prefBoost, why: prefBoost > 0 ? `Categoria '${item.channel_category}' e în lista prefer` : 'Nicio preferință explicită aplicată' },
    xref_boost: { value: xrefBoost, why: xref ? `Bonus 0.5 — și pe ${xref.provider_name} (${xref.confidence_label} confidence)` : 'Nu apare în catalogul streaming' },
    total,
  };

  const alternatives = findAlternatives(epg, hit, ctx, now);

  let confidence = 'medium';
  if (xref && genres.length > 0 && epgAge < 60) confidence = 'high';
  else if (fresh.overall_stale || genres.length === 0) confidence = 'low';

  return {
    payload: {
      ok: true,
      subject: {
        channel_id: item.channel_id,
        channel_name: item.channel_name,
        channel_category: item.channel_category,
        title: item.program.title,
        start_local: item.program.start_local,
        start_utc: item.program.start_utc,
        duration_min: item.program.duration_min,
        description: item.program.description,
      },
      context: {
        mood: mood.key,
        mood_label_ro: moodLabel(mood, ctx.mood),
        prefer: ctx.prefer || [],
        timeframe: ctx.timeframe || null,
      },
      score_breakdown,
      extracted_genres: genres,
      streaming_xref: xref,
      sources_used: [
        'epg-normalized',
        ...(crossUsed ? ['streaming-full'] : []),
        ...(genres.length ? ['title-genre-extract'] : []),
        'moods',
      ],
      fresh_status: {
        epg_generated_at: fresh.sources.epg.generated_at,
        epg_age_min: fresh.sources.epg.age_minutes,
        streaming_age_min: fresh.sources.streaming.age_minutes,
        stale: fresh.overall_stale,
      },
      alternatives_not_picked: alternatives,
      confidence,
      freshness: { epg_age_min: fresh.sources.epg.age_minutes, streaming_age_min: fresh.sources.streaming.age_minutes, stale: fresh.overall_stale },
    },
    _quality: {
      items_returned: 1,
      candidates_evaluated: alternatives.length + 1,
      avg_score: total,
      max_score: total,
      unique_channels: 1,
      cross_source_used: crossUsed,
      fallback_used: fallbackUsed,
      freshness_stale: fresh.overall_stale,
    },
  };
}

function explainStreamingOnly(xref, { mood, ctx, now }) {
  const extraPrefer = (ctx.prefer || []).map(resolvePreferLabel);
  const s = streamingAsItem(xref, now);
  const c = scoreComponents(s.item, { genres: s.genres, mood, preferLabels: extraPrefer, now, xref });
  const total = Math.round(sumComponents(c, PROFILE.full) * 100) / 100;
  const fresh = computeFreshness(now);
  const runtime = xref.runtime ?? null;
  const rating = Number.isFinite(xref.vote_average) ? xref.vote_average : null;

  const score_breakdown = {
    channel_cat: { value: c.channel_cat, why: `Titlu din catalogul de streaming (film/serial) — aceeași valoare ca un canal „Filme & Seriale": +${c.channel_cat}` },
    mood_fit: { value: c.mood_fit, why: c.moodParts.length ? `Mood '${mood.label_ro}': ${c.moodParts.join('; ')}` : `Mood '${mood.label_ro}' — niciun factor nu se aplică` },
    time_proximity: { value: c.time_proximity, why: `Disponibil oricând pe ${xref.provider_name} — contează ca „începe acum" (+${c.time_proximity})` },
    duration_match: {
      value: c.duration_match,
      why: runtime === null
        ? 'Durată necunoscută în catalog — fără bonus de durată'
        : c.duration_match > 0 ? `${runtime} min se încadrează în 45–180` : `${runtime} min — în afara band-ului 45–180`,
    },
    prefer_boost: { value: c.prefer_boost, why: c.prefer_boost > 0 ? "Categoria 'Filme & Seriale' e în lista prefer" : 'Nicio preferință explicită aplicată' },
    xref_boost: { value: c.xref_boost, why: `Bonus ${c.xref_boost} — în catalog pe ${xref.provider_name} (${xref.confidence_label} confidence)` },
    total,
  };

  let confidence = 'medium';
  if (fresh.overall_stale) confidence = 'low';
  else if (xref.tier === 'exact' && s.genres.length > 0) confidence = 'high';

  return {
    payload: {
      ok: true,
      subject: {
        source: 'streaming',
        channel_id: null,
        channel_name: xref.provider_name,
        channel_category: 'Filme & Seriale',
        title: xref.title,
        start_local: null,
        start_utc: null,
        duration_min: runtime,
        description: rating !== null ? `Doar în streaming · rating TMDB ${rating.toFixed(1)}` : 'Doar în streaming',
      },
      context: {
        mood: mood.key,
        mood_label_ro: moodLabel(mood, ctx.mood),
        prefer: ctx.prefer || [],
        timeframe: ctx.timeframe || null,
      },
      score_breakdown,
      extracted_genres: s.genres,
      streaming_xref: xref,
      sources_used: ['streaming-full', 'moods'],
      fresh_status: {
        epg_generated_at: fresh.sources.epg.generated_at,
        epg_age_min: fresh.sources.epg.age_minutes,
        streaming_age_min: fresh.sources.streaming.age_minutes,
        stale: fresh.overall_stale,
      },
      alternatives_not_picked: [],
      confidence,
      freshness: { epg_age_min: fresh.sources.epg.age_minutes, streaming_age_min: fresh.sources.streaming.age_minutes, stale: fresh.overall_stale },
    },
    _quality: {
      items_returned: 1,
      candidates_evaluated: 1,
      avg_score: total,
      max_score: total,
      unique_channels: 0,
      cross_source_used: true,
      fallback_used: false,
      freshness_stale: fresh.overall_stale,
    },
  };
}

function findAlternatives(epg, hit, ctx, now) {
  const window = resolveTimeRef(ctx.timeframe || 'tonight');
  const mood = resolveMood(ctx.mood);
  const candidates = [];
  for (const ch of epg.channels) {
    for (const p of (ch.programs || [])) {
      if (p === hit.program) continue;
      if (!programOverlaps(p, window)) continue;
      const item = shapeProgram(ch, p);
      const genres = extractGenres(p.title, p.description, p);
      const score = sumComponents(scoreComponents(item, { genres, mood, now }), PROFILE.base);

      let reason = null;
      if (ch.category === 'Știri' && mood.excl_channel_cats.includes('Știri')) {
        reason = `Penalizat ca Știri (-10) pentru mood ${mood.label_ro}`;
      } else if (genres.some((g) => mood.excl_genres.includes(g.genre))) {
        reason = `Mood '${mood.label_ro}' exclude genul ${genres.find((g) => mood.excl_genres.includes(g.genre)).genre}`;
      } else if (item.program.duration_min < mood.duration_min || item.program.duration_min > mood.duration_max) {
        reason = `Durata ${item.program.duration_min} min e în afara band-ului mood ${mood.duration_min}-${mood.duration_max}`;
      } else if (score < 1) {
        reason = `Scor total ${Math.round(score * 100) / 100} sub pragul pentru ${mood.label_ro}`;
      }
      if (reason) {
        candidates.push({ score, item, reason });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3).map((c) => ({
    title: c.item.program.title,
    channel_name: c.item.channel_name,
    start_local: c.item.program.start_local,
    score: Math.round(c.score * 100) / 100,
    reason: c.reason,
  }));
}

export const explainTool = {
  name: 'tv_explain_recommendation',
  config: {
    title: 'Explain why a program was recommended',
    description:
      'Returns a full score breakdown for a specific program in a given mood/context: per-component value + reason, extracted genres, streaming cross-ref, freshness, sources used, and a list of alternatives that were not picked (with the specific reason each was dropped). Use to understand or debug a recommendation.',
    inputSchema: ExplainInput,
    outputSchema: ExplainOutput,
  },
};
