import { z } from 'zod';
import { getEpgFull, getStreaming } from '../data/store.mjs';
import { shapeProgram, resolveTimeRef, programOverlaps } from '../lib/time.mjs';
import { resolveMood, moodFit } from '../lib/moods.mjs';
import { extractGenres } from '../lib/genre-extract.mjs';
import { findStreamingFor } from '../lib/xref.mjs';
import { computeFreshness, freshnessEmbed } from '../lib/freshness.mjs';
import { matchesQuery, normalize } from '../lib/text.mjs';
import { Freshness, Loose } from '../lib/output-shapes.mjs';

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

const CHANNEL_SCORE = { 'Filme & Seriale': 3, 'Documentare': 3, 'Generaliste': 1, 'Copii': 1, 'Sport': 0.5, 'Muzică': 0.25, 'Altele': 0, 'Știri': -10, 'General': 0 };

function findProgram(epg, title, channel, startUtc) {
  for (const ch of epg.channels) {
    if (channel) {
      const q = normalize(channel);
      const hit = normalize(ch.id) === q ||
        normalize(ch.displayName).includes(q) || q.includes(normalize(ch.displayName)) ||
        (ch.aliases || []).some((a) => normalize(a).includes(q) || q.includes(normalize(a)));
      if (!hit) continue;
    }
    for (const p of (ch.programs || [])) {
      if (!matchesQuery(p.title, title)) continue;
      if (startUtc && new Date(p.start).toISOString() !== new Date(startUtc).toISOString()) continue;
      return { ch, program: p };
    }
  }
  return null;
}

export async function handleExplain(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');
  const streaming = getStreaming();
  const now = new Date();
  const ctx = args.context || {};
  const mood = resolveMood(ctx.mood);

  const hit = findProgram(epg, args.title, args.channel, args.start_utc);
  if (!hit) {
    return {
      payload: {
        ok: false,
        reason: `Nu am găsit programul "${args.title}"${args.channel ? ' pe canalul ' + args.channel : ''}.`,
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
  const mf = moodFit(item, genres, mood);
  const channelCat = CHANNEL_SCORE[item.channel_category] ?? 0;
  const startMs = new Date(item.program.start_utc).getTime();
  const deltaMin = (startMs - now.getTime()) / 60_000;
  const timeProx = (deltaMin >= -5 && deltaMin <= 60) ? 2 : 0;
  const durMatch = (item.program.duration_min >= 45 && item.program.duration_min <= 180) ? 0.5 : 0;
  const extraPrefer = (ctx.prefer || []).map(normalize);
  const prefBoost = extraPrefer.includes(normalize(item.channel_category)) ? 1 : 0;

  const xref = streaming ? findStreamingFor(hit.program.title, streaming) : null;
  const crossUsed = !!xref;
  const xrefBoost = xref ? 0.5 : 0;

  const total = Math.round((channelCat + mf.score + timeProx + durMatch + prefBoost + xrefBoost) * 100) / 100;
  const fresh = computeFreshness(now);
  const epgAge = fresh.epgAge ?? 0;

  const score_breakdown = {
    channel_cat: { value: channelCat, why: `Categoria '${item.channel_category}' valorează ${channelCat >= 0 ? '+' + channelCat : channelCat}` },
    mood_fit: { value: mf.score, why: mf.parts.length ? `Mood '${mood.label_ro}': ${mf.parts.join('; ')}` : `Mood '${mood.label_ro}' — niciun factor nu se aplică` },
    time_proximity: { value: timeProx, why: deltaMin >= -5 && deltaMin <= 60 ? `Începe în ${Math.round(deltaMin)} min (fereastră ±60 min)` : `Începe în ${Math.round(deltaMin)} min — în afara ferestrei de proximitate` },
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
        mood_label_ro: mood.label_ro,
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
      const base = CHANNEL_SCORE[item.channel_category] ?? 0;
      const mf = moodFit(item, genres, mood);
      const score = base + mf.score;

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
