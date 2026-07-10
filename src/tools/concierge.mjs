import { z } from 'zod';
import { getEpgFull } from '../data/store.mjs';
import {
  shapeProgram, programOverlaps, utcFromLocalParts, localFromUtc,
} from '../lib/time.mjs';
import { resolveMood, moodFit } from '../lib/moods.mjs';
import { extractGenres } from '../lib/genre-extract.mjs';
import { freshnessEmbed } from '../lib/freshness.mjs';
import { normalize } from '../lib/text.mjs';
import { buildStreamingPool } from '../lib/streaming-pool.mjs';
import { detectNoise, NOISE_CATEGORY_KEYS } from '../lib/anti-noise.mjs';
import { dedupCandidates } from '../lib/dedup.mjs';
import {
  ratingSignal, moodFitAxis, timeFitAxis, availabilityAxis, opportunityAxis,
  computeComposite, computeConfidence, confidenceBreakdown,
} from '../lib/confidence.mjs';
import { buildTimeline, buildDegradedTimeline } from '../lib/timeline.mjs';
import { Freshness, Loose } from '../lib/output-shapes.mjs';

export const ConciergeOutput = {
  ok: z.boolean(),
  reason: z.string().optional(),
  asked_at_utc: z.string(),
  window: Loose,
  context: Loose,
  decision: z.object({
    degraded: z.boolean(),
    primary_kind: z.string().nullable(),
    primary_title: z.string().nullable(),
    primary_summary: z.string().optional(),
    segments: z.array(Loose),
    confidence_pct: z.number(),
    confidence_label: z.string(),
    confidence_breakdown: Loose.nullable(),
  }).passthrough(),
  reasoning: z.array(z.string()),
  anti_noise: z.object({
    enabled_categories: z.array(z.string()),
    filtered_count: z.number(),
    by_category: Loose,
  }).passthrough(),
  alternatives: z.array(Loose),
  lookahead: Loose,
  sources_used: z.array(z.string()),
  freshness: Freshness,
};

const NOISE_CATS_TUPLE = ['politica', 'reality', 'talkshow', 'stiri'];

export const ConciergeInput = {
  window: z
    .object({
      start: z.string().default('now').describe('"now" | "HH:MM" (Europe/Bucharest) | ISO instant'),
      duration_min: z.number().int().min(30).max(360).default(120),
    })
    .optional()
    .describe('Explicit window. Skips lookahead.'),
  duration_hours: z.number().min(0.5).max(6).optional().describe('Shorthand when window is absent; starts at now.'),
  mood: z.string().optional().describe('obosit | vesel | concentrat | romantic | familie | captivant (RO/EN aliases accepted)'),
  exclude_categories: z
    .array(z.enum(['politica', 'reality', 'talkshow', 'stiri']))
    .default(['politica', 'reality', 'talkshow', 'stiri'])
    .describe('Anti-noise filter (default: all four).'),
  exclude_keywords: z.array(z.string()).optional(),
  sources: z.array(z.enum(['tv', 'streaming'])).default(['tv', 'streaming']),
  max_alternatives: z.number().int().min(0).max(5).default(3),
  risk_aversion: z.enum(['low', 'high']).default('low').describe('low = 3 alternatives, high = none'),
  allow_pauses: z.boolean().default(true),
  min_rating: z.number().min(0).max(10).default(0),
  prefer: z.array(z.string()).optional(),
};

function resolveStart(startRef, now) {
  const ref = String(startRef || '').trim().toLowerCase();
  if (ref === 'now' || !ref) return new Date(now);
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(ref);
  if (hhmm) {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const obj = Object.fromEntries(local.map((p) => [p.type, p.value]));
    return utcFromLocalParts({
      year: Number(obj.year), month: Number(obj.month), day: Number(obj.day),
      hour: Number(hhmm[1]), minute: Number(hhmm[2]),
    });
  }
  const d = new Date(startRef);
  return Number.isNaN(d.getTime()) ? new Date(now) : d;
}

function resolveWindow(args, now) {
  if (args.window?.start) {
    const startUtc = resolveStart(args.window.start, now);
    const dur = args.window.duration_min || 120;
    return {
      start_utc: startUtc,
      end_utc: new Date(startUtc.getTime() + dur * 60_000),
      duration_min: dur,
      source: 'explicit',
    };
  }
  if (args.duration_hours) {
    const dur = Math.round(args.duration_hours * 60);
    return {
      start_utc: new Date(now),
      end_utc: new Date(now.getTime() + dur * 60_000),
      duration_min: dur,
      source: 'duration_hours',
    };
  }
  return {
    start_utc: new Date(now),
    end_utc: new Date(now.getTime() + 120 * 60_000),
    duration_min: 120,
    source: 'default',
  };
}

function buildTvCandidates(epg, windowStart, windowEnd, mood) {
  const candidates = [];
  let evaluated = 0;
  const window = { from: windowStart, to: windowEnd };
  for (const ch of (epg?.channels || [])) {
    for (const p of (ch.programs || [])) {
      if (!programOverlaps(p, window)) continue;
      evaluated++;
      const shaped = shapeProgram(ch, p);
      const genres = extractGenres(p.title, p.description, p);
      const mf = moodFit(shaped, genres, mood);
      candidates.push({ source: 'tv', shaped, _genres: genres, _moodFit: mf });
    }
  }
  return { candidates, evaluated };
}

function buildStreamingCandidates(windowDurationMin, mood, minRating) {
  const pool = buildStreamingPool({ minRating, maxDurationMin: windowDurationMin });
  for (const s of pool) {
    const fakeShaped = {
      channel_category: 'Filme & Seriale',
      program: {
        title: s.title || '',
        description: s.description || '',
        duration_min: s.runtime ?? 90,
      },
    };
    const genres = extractGenres(s.title, s.description, s);
    const mf = moodFit(fakeShaped, genres, mood);
    s._genres = genres;
    s._moodFit = mf;
  }
  return pool;
}

function applyNoiseFilter(candidates, enabledCats) {
  const counts = Object.fromEntries(NOISE_CATEGORY_KEYS.map((k) => [k, 0]));
  const keep = [];
  let filtered = 0;
  for (const c of candidates) {
    const r = detectNoise(c, enabledCats);
    if (r.is_noise) {
      counts[r.category] = (counts[r.category] || 0) + 1;
      filtered++;
    } else {
      keep.push(c);
    }
  }
  return { keep, filtered, counts };
}

function applyKeywordFilter(candidates, excludeKw) {
  if (!excludeKw?.length) return candidates;
  const needles = excludeKw.map(normalize).filter(Boolean);
  if (!needles.length) return candidates;
  return candidates.filter((c) => {
    const title = c.source === 'tv'
      ? c.shaped.program.title
      : `${c.title || ''} ${c.original_title || ''}`;
    const h = normalize(title);
    return !needles.some((n) => h.includes(n));
  });
}

function computePartialAxes(c, winDurationMin, winStartUtc) {
  return {
    rating_signal: ratingSignal(c),
    mood_fit: moodFitAxis(c._moodFit?.score ?? 0),
    time_fit: timeFitAxis(c, winDurationMin),
    availability: availabilityAxis(c, winStartUtc),
  };
}

function primaryTitleOf(c) {
  return c.source === 'tv' ? c.shaped.program.title : c.title;
}

function primarySummary(c) {
  if (c.source === 'tv') {
    const start = (c.shaped.program.start_local || '').slice(11, 16);
    return `${c.shaped.program.title} pe ${c.shaped.channel_name} la ${start}`;
  }
  const yr = c.year ? ` (${c.year})` : '';
  return `${c.title}${yr} pe ${c.provider_name}`;
}

function buildAltPros(c) {
  const pros = [];
  if (c.source === 'streaming') {
    if (Number.isFinite(c.vote_average) && c.vote_average >= 7.5) {
      pros.push(`rating ridicat (${c.vote_average.toFixed(1)})`);
    }
    pros.push('disponibil oricând');
  } else {
    const dur = c.shaped.program.duration_min;
    if (dur >= 60 && dur <= 180) pros.push(`durată confortabilă (${dur} min)`);
  }
  if (c._genres?.length) {
    pros.push(`genuri: ${c._genres.slice(0, 2).map((g) => g.genre).join(', ')}`);
  }
  return pros.slice(0, 3);
}

function buildAltCons(c, primary) {
  const cons = [];
  const pPct = primary._confidence?.pct ?? 0;
  const aPct = c._confidence?.pct ?? 0;
  if (aPct < pPct) cons.push(`confidence ${aPct}% sub primary ${pPct}%`);
  if (c.source === 'tv' && primary.source === 'streaming') cons.push('depinde de orar TV');
  if (c.source === 'streaming' && primary.source === 'tv') cons.push('necesită abonament');
  return cons.slice(0, 3);
}

function makeAlternative(c, primary, reason) {
  if (c.source === 'tv') {
    return {
      title: c.shaped.program.title,
      kind: 'tv',
      channel_name: c.shaped.channel_name,
      channel_category: c.shaped.channel_category,
      start_local: c.shaped.program.start_local,
      duration_min: c.shaped.program.duration_min,
      extracted_genres: (c._genres || []).map((g) => g.genre),
      confidence_pct: c._confidence?.pct ?? null,
      reason_not_picked: reason,
      summary: `${c.shaped.channel_name} (${c.shaped.channel_category}), ${(c.shaped.program.start_local || '').slice(11, 16)}, ${c.shaped.program.duration_min} min`,
      pros: buildAltPros(c),
      cons: buildAltCons(c, primary),
    };
  }
  return {
    title: c.title,
    kind: 'streaming',
    provider_name: c.provider_name,
    media_kind: c.kind,
    year: c.year,
    runtime: c.runtime,
    vote_average: c.vote_average,
    extracted_genres: (c._genres || []).map((g) => g.genre),
    confidence_pct: c._confidence?.pct ?? null,
    reason_not_picked: reason,
    summary: `${c.provider_name}, ${c.kind === 'movie' ? 'film' : 'serial'} ${c.year ?? ''}, ${c.runtime ?? '?'} min, rating ${Number.isFinite(c.vote_average) ? c.vote_average.toFixed(1) : '?'}`,
    pros: buildAltPros(c),
    cons: buildAltCons(c, primary),
  };
}

function pickDiverseAlternatives(scored, primary, max) {
  if (max <= 0) return [];
  const usedIdx = new Set([scored.indexOf(primary)]);
  const alts = [];

  const primaryGenre = primary._genres?.[0]?.genre || null;
  const primaryDuration = primary.source === 'tv'
    ? (primary.shaped.program.duration_min ?? 0)
    : (primary.runtime ?? 90);
  const primaryVa = primary.source === 'streaming' ? (primary.vote_average ?? 0) : 0;

  const findFirst = (predicate) => {
    for (let i = 0; i < scored.length; i++) {
      if (usedIdx.has(i)) continue;
      if (predicate(scored[i], i)) return { item: scored[i], idx: i };
    }
    return null;
  };

  // different source
  const altSource = primary.source === 'tv' ? 'streaming' : 'tv';
  const r1 = findFirst((c) => c.source === altSource);
  if (r1 && alts.length < max) {
    alts.push(makeAlternative(r1.item, primary, `alternativă din ${altSource === 'streaming' ? 'streaming' : 'TV'} — alt mediu`));
    usedIdx.add(r1.idx);
  }

  // longer
  const r2 = findFirst((c) => {
    const dur = c.source === 'tv' ? (c.shaped.program.duration_min ?? 0) : (c.runtime ?? 0);
    return dur > primaryDuration + 30;
  });
  if (r2 && alts.length < max) {
    alts.push(makeAlternative(r2.item, primary, 'mai lungă — umple mai mult timp'));
    usedIdx.add(r2.idx);
  }

  // shorter higher rated (streaming only — rating known)
  const r3 = findFirst((c) => {
    if (c.source !== 'streaming') return false;
    const dur = c.runtime ?? 0;
    if (dur >= primaryDuration) return false;
    return Number.isFinite(c.vote_average) && c.vote_average > primaryVa;
  });
  if (r3 && alts.length < max) {
    alts.push(makeAlternative(r3.item, primary, 'mai scurt dar rating mai mare'));
    usedIdx.add(r3.idx);
  }

  // different top genre
  if (primaryGenre) {
    const r4 = findFirst((c) => {
      const g = c._genres?.[0]?.genre;
      return g && g !== primaryGenre;
    });
    if (r4 && alts.length < max) {
      alts.push(makeAlternative(r4.item, primary, `gen diferit (${r4.item._genres?.[0]?.genre}) — variație`));
      usedIdx.add(r4.idx);
    }
  }

  // next-best fallback
  for (let i = 0; i < scored.length && alts.length < max; i++) {
    if (usedIdx.has(i)) continue;
    alts.push(makeAlternative(scored[i], primary, 'next-best — scor imediat sub primary'));
    usedIdx.add(i);
  }

  return alts;
}

function computeLookahead(epg, windowEnd, windowDurationMin, mood, currentMaxComposite, enabledNoiseCats) {
  const lookStart = new Date(windowEnd);
  const lookEnd = new Date(windowEnd.getTime() + windowDurationMin * 60_000);
  const { candidates: tvLook } = buildTvCandidates(epg, lookStart, lookEnd, mood);
  const { keep: filtered } = applyNoiseFilter(tvLook, enabledNoiseCats);

  for (const c of filtered) {
    const axes = computePartialAxes(c, windowDurationMin, lookStart);
    c._composite = computeComposite(c, axes);
  }
  filtered.sort((a, b) => (b._composite ?? 0) - (a._composite ?? 0));
  const top = filtered[0];
  if (!top) return { found: false };

  const ratio = (top._composite ?? 0) / (currentMaxComposite || 1);
  if (ratio <= 1.15) {
    return { found: false, threshold_ratio: Math.round(ratio * 100) / 100 };
  }
  return {
    found: true,
    title: top.shaped.program.title,
    channel_name: top.shaped.channel_name,
    start_local: top.shaped.program.start_local,
    threshold_ratio: Math.round(ratio * 100) / 100,
  };
}

function buildReasoning(primary, axes, exclCats, antiNoiseFiltered, lookahead) {
  const r = [];
  if (primary.source === 'streaming') {
    const va = Number.isFinite(primary.vote_average) ? primary.vote_average.toFixed(1) : '?';
    r.push(`Rating TMDB ${va}/10 pe ${primary.provider_name}`);
  } else {
    const start = (primary.shaped.program.start_local || '').slice(11, 16);
    r.push(`${primary.shaped.channel_name} (${primary.shaped.channel_category}) la ${start}`);
  }
  if (primary._genres?.length) {
    r.push(`Genuri detectate: ${primary._genres.map((g) => g.genre).join(', ')}`);
  }
  if (axes.time_fit.value >= 0.8) r.push('Durata se potrivește bine cu fereastra ta');
  if (axes.mood_fit.value >= 0.6) r.push('Mood-fit peste pragul de încredere');
  if (axes.opportunity_cost.value >= 0.95) {
    r.push('Cea mai bună opțiune disponibilă în acest interval');
  }
  if (antiNoiseFiltered > 0) {
    const cats = exclCats.length ? exclCats.join('/') : '';
    r.push(`Filtrate ${antiNoiseFiltered} programe de zgomot (${cats})`);
  }
  if (primary.dup_count && primary.dup_count > 1 && primary.dup_other_airings?.length) {
    r.push(`Același titlu și pe: ${primary.dup_other_airings.slice(0, 3).join('; ')}`);
  }
  if (lookahead?.found) {
    const startShort = (lookahead.start_local || '').slice(11, 16);
    const pct = Math.round((lookahead.threshold_ratio - 1) * 100);
    r.push(`Atenție: "${lookahead.title}" pe ${lookahead.channel_name} la ${startShort} pare ${pct}% mai bun — consideră extinderea ferestrei`);
  }
  return r;
}

function outputWindow(window) {
  return {
    start_local: localFromUtc(window.start_utc),
    end_local: localFromUtc(window.end_utc),
    start_utc: window.start_utc.toISOString(),
    end_utc: window.end_utc.toISOString(),
    duration_min: window.duration_min,
    source: window.source,
  };
}

function outputContext(args, mood, sources) {
  return {
    mood: mood.key,
    mood_label_ro: mood.label_ro,
    sources,
    risk_aversion: args.risk_aversion || 'low',
    min_rating: args.min_rating ?? 0,
    exclude_categories: args.exclude_categories || [],
    exclude_keywords: args.exclude_keywords || [],
    prefer: args.prefer || [],
  };
}

export async function handleConcierge(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');

  const now = new Date();
  const window = resolveWindow(args, now);
  const mood = resolveMood(args.mood);
  const sources = args.sources?.length ? args.sources : ['tv', 'streaming'];
  const exclCats = args.exclude_categories ?? ['politica', 'reality', 'talkshow', 'stiri'];

  let tvList = [];
  let tvEvaluated = 0;
  if (sources.includes('tv')) {
    const r = buildTvCandidates(epg, window.start_utc, window.end_utc, mood);
    tvList = r.candidates;
    tvEvaluated = r.evaluated;
  }

  let streamList = [];
  if (sources.includes('streaming')) {
    streamList = buildStreamingCandidates(window.duration_min, mood, args.min_rating || 0);
  }

  const allCands = [...tvList, ...streamList];
  const candidatesEvaluated = tvEvaluated + streamList.length;

  const noiseRes = applyNoiseFilter(allCands, exclCats);
  let cands = applyKeywordFilter(noiseRes.keep, args.exclude_keywords);

  for (const c of cands) {
    const partialAxes = computePartialAxes(c, window.duration_min, window.start_utc);
    c._partialAxes = partialAxes;
    c._composite = computeComposite(c, partialAxes);
  }

  const candsAfterDedup = dedupCandidates(cands);
  const dedupRatio = cands.length > 0
    ? Math.round((1 - candsAfterDedup.length / cands.length) * 1000) / 1000
    : 0;

  const winMaxComp = candsAfterDedup.reduce((m, c) => Math.max(m, c._composite ?? 0), 0);

  for (const c of candsAfterDedup) {
    const axes = {
      ...c._partialAxes,
      opportunity_cost: opportunityAxis(c, winMaxComp),
    };
    c._axes = axes;
    c._confidence = computeConfidence(c, axes);
  }

  candsAfterDedup.sort((a, b) => (b._confidence?.pct ?? 0) - (a._confidence?.pct ?? 0));

  const fresh = freshnessEmbed(now);
  const sourcesUsed = [
    ...(sources.includes('tv') ? ['epg-normalized'] : []),
    ...(sources.includes('streaming') ? ['streaming-full'] : []),
    'moods', 'title-genre-extract', 'anti-noise',
  ];

  if (candsAfterDedup.length === 0) {
    return {
      payload: {
        ok: false,
        reason: 'no_candidates_after_filters',
        asked_at_utc: now.toISOString(),
        window: outputWindow(window),
        context: outputContext(args, mood, sources),
        decision: {
          degraded: true,
          primary_kind: null,
          primary_title: null,
          segments: [],
          confidence_pct: 0,
          confidence_label: 'low',
          confidence_breakdown: null,
        },
        reasoning: [
          'Niciun candidat după filtre',
          `Filtrate ${noiseRes.filtered} de zgomot (${exclCats.join('/')})`,
        ],
        anti_noise: {
          enabled_categories: exclCats,
          filtered_count: noiseRes.filtered,
          by_category: noiseRes.counts,
        },
        alternatives: [],
        lookahead: { found: false, skipped_reason: 'no_candidates' },
        sources_used: sourcesUsed,
        freshness: fresh,
      },
      _quality: {
        items_returned: 0,
        candidates_evaluated: candidatesEvaluated,
        candidates_after_noise: noiseRes.keep.length,
        candidates_after_dedup: 0,
        avg_score: 0,
        max_score: 0,
        unique_channels: 0,
        cross_source_used: false,
        fallback_used: true,
        freshness_stale: fresh.stale,
        degraded: true,
        noise_filtered: noiseRes.filtered,
        dedup_ratio: dedupRatio,
        lookahead_evaluated: false,
      },
    };
  }

  const primary = candsAfterDedup[0];
  const PRIMARY_THRESHOLD = 55;
  let degraded = false;
  let segments;
  const allowPauses = args.allow_pauses !== false;

  if (primary._confidence.pct < PRIMARY_THRESHOLD && sources.includes('tv')) {
    degraded = true;
    const tvTop = candsAfterDedup.filter((c) => c.source === 'tv').slice(0, 3);
    segments = buildDegradedTimeline(tvTop.length ? tvTop : [primary], {
      windowStart: window.start_utc, windowEnd: window.end_utc, allowPauses,
    });
  } else {
    segments = buildTimeline(primary, {
      windowStart: window.start_utc, windowEnd: window.end_utc, allowPauses,
    });
  }

  let lookahead = { found: false };
  let lookaheadEvaluated = false;
  if (window.source !== 'explicit' && sources.includes('tv')) {
    lookaheadEvaluated = true;
    lookahead = computeLookahead(epg, window.end_utc, window.duration_min, mood, winMaxComp, exclCats);
  } else if (window.source === 'explicit') {
    lookahead = { found: false, skipped_reason: 'window_explicit' };
  }

  const maxAlts = args.risk_aversion === 'high'
    ? 0
    : Math.min(args.max_alternatives ?? 3, 3);
  const alternatives = pickDiverseAlternatives(candsAfterDedup, primary, maxAlts);

  const breakdown = confidenceBreakdown(primary._axes);
  const reasoning = buildReasoning(primary, primary._axes, exclCats, noiseRes.filtered, lookahead);

  const tvCount = candsAfterDedup.filter((c) => c.source === 'tv').length;
  const streamingCount = candsAfterDedup.filter((c) => c.source === 'streaming').length;
  const crossUsed = tvCount > 0 && streamingCount > 0;

  const sumPct = candsAfterDedup.reduce((s, c) => s + (c._confidence?.pct ?? 0), 0);
  const avg = candsAfterDedup.length ? Math.round((sumPct / candsAfterDedup.length) * 100) / 100 : 0;
  const max = primary._confidence.pct;

  const segmentKinds = new Set(segments.filter((s) => s.kind !== 'pause').map((s) => s.kind));
  const primary_kind = segmentKinds.size > 1 ? 'mixed' : primary.source;

  return {
    payload: {
      ok: true,
      asked_at_utc: now.toISOString(),
      window: outputWindow(window),
      context: outputContext(args, mood, sources),
      decision: {
        degraded,
        primary_kind,
        primary_title: primaryTitleOf(primary),
        primary_summary: primarySummary(primary),
        segments,
        confidence_pct: primary._confidence.pct,
        confidence_label: primary._confidence.label,
        confidence_breakdown: breakdown,
      },
      reasoning,
      anti_noise: {
        enabled_categories: exclCats,
        filtered_count: noiseRes.filtered,
        by_category: noiseRes.counts,
      },
      alternatives,
      lookahead,
      sources_used: sourcesUsed,
      freshness: fresh,
    },
    _quality: {
      items_returned: 1 + alternatives.length,
      candidates_evaluated: candidatesEvaluated,
      candidates_after_noise: noiseRes.keep.length,
      candidates_after_dedup: candsAfterDedup.length,
      avg_score: avg,
      max_score: max,
      unique_channels: new Set(candsAfterDedup.filter((c) => c.source === 'tv').map((c) => c.shaped.channel_id)).size,
      cross_source_used: crossUsed,
      fallback_used: degraded,
      freshness_stale: fresh.stale,
      degraded,
      noise_filtered: noiseRes.filtered,
      dedup_ratio: dedupRatio,
      lookahead_evaluated: lookaheadEvaluated,
    },
  };
}

export const conciergeTool = {
  name: 'tv_concierge',
  config: {
    title: 'Personal Entertainment Concierge — decide for me',
    description:
      'You have a window of free time — decide for me what to watch right now. Returns ONE primary decision (TV program OR streaming title) with confidence percentage, full reasoning breakdown, and up to 3 diverse alternatives with explicit trade-offs (pros/cons, reason not picked). Picks across live Romanian TV EPG AND streaming catalog (Netflix, HBO Max, Disney+, Prime Video, Apple TV+, SkyShowtime). Built-in anti-noise filter automatically removes news, political talk, reality shows, talk-shows (NO manual filtering needed by the model). Built-in title dedup (handles ~46% duplicate-airing ratio in TV EPG). Built-in opportunity-cost lookahead (flags better options just outside the window). PREFER THIS TOOL over tv_recommend_by_mood, tv_plan_evening, and tv_recommend_today whenever the user wants ONE answer / a single decision / a plan for a specific window — those tools return ranked LISTS for browsing, this tool returns a DECISION. Routes any mood internally (obosit / vesel / concentrat / romantic / familie / captivant + EN aliases tired/happy/focused/romantic/family/thrilling). Trigger phrases: "what should I do", "decide for me", "pick for me", "I have X hours", "ce să fac", "am 2 ore", "alege tu", "mood X durată Y", "o singură decizie", "fii consilierul meu", "what to watch", "concierge me".',
    inputSchema: ConciergeInput,
    outputSchema: ConciergeOutput,
  },
};
