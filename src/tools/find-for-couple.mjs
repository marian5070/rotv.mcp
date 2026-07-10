import { z } from 'zod';
import { getEpgFull, getStreaming } from '../data/store.mjs';
import { shapeProgram, resolveTimeRef, programOverlaps } from '../lib/time.mjs';
import { resolveMood, moodFit } from '../lib/moods.mjs';
import { extractGenres } from '../lib/genre-extract.mjs';
import { findStreamingFor } from '../lib/xref.mjs';
import { freshnessEmbed } from '../lib/freshness.mjs';
import { normalize } from '../lib/text.mjs';
import { dedupByTitle } from '../lib/rank.mjs';
import { WindowUtc, Freshness, Loose } from '../lib/output-shapes.mjs';

export const FindForCoupleOutput = {
  asked_at_utc: z.string(),
  timeframe_label: z.string(),
  window: WindowUtc,
  person_a: Loose,
  person_b: Loose,
  fairness: z.string(),
  min_score: z.number(),
  degraded: z.boolean(),
  count: z.number(),
  items: z.array(Loose),
  freshness: Freshness,
};

const personSchema = z.object({
  mood: z.string().optional(),
  prefer: z.array(z.string()).optional(),
  dislike_genres: z.array(z.string()).optional(),
  dislike_keywords: z.array(z.string()).optional(),
});

export const FindForCoupleInput = {
  person_a: personSchema.describe('Preferences for person A'),
  person_b: personSchema.describe('Preferences for person B'),
  timeframe: z.string().default('tonight'),
  fairness: z.enum(['strict', 'average']).default('strict'),
  min_score: z.number().default(1.0),
  limit: z.number().int().min(1).max(10).default(5),
  include_streaming_xref: z.boolean().default(true),
};

const CHANNEL_SCORE = { 'Filme & Seriale': 3, 'Documentare': 3, 'Generaliste': 1, 'Copii': 1, 'Sport': 0.5, 'Muzică': 0.25, 'Altele': 0, 'Știri': -10, 'General': 0 };

function scoreForPerson(item, person, genres) {
  const mood = resolveMood(person.mood);
  const extraPrefer = (person.prefer || []).map(normalize);
  const dislikeGenres = (person.dislike_genres || []).map(normalize);
  const dislikeKeywords = (person.dislike_keywords || []).map(normalize);

  let score = CHANNEL_SCORE[item.channel_category] ?? 0;
  const mf = moodFit(item, genres, mood);
  score += mf.score;
  if (extraPrefer.includes(normalize(item.channel_category))) score += 1;

  if (genres.some((g) => dislikeGenres.includes(normalize(g.genre)))) score -= 3;
  const titleLower = normalize(item.program.title);
  if (dislikeKeywords.some((kw) => titleLower.includes(kw))) score -= 3;

  return { score: Math.round(score * 100) / 100, mood: mood.key, mood_label: mood.label_ro, parts: mf.parts };
}

function collectAndScore(epg, window, personA, personB, streaming, includeXref) {
  const items = [];
  let evaluated = 0;
  let crossUsed = false;
  let fallback = false;
  for (const ch of epg.channels) {
    for (const p of (ch.programs || [])) {
      if (!programOverlaps(p, window)) continue;
      evaluated++;
      const item = shapeProgram(ch, p);
      const genres = extractGenres(p.title, p.description, p);
      if (genres.length === 0) fallback = true;
      const a = scoreForPerson(item, personA, genres);
      const b = scoreForPerson(item, personB, genres);
      let xref = null;
      if (includeXref && streaming && Math.min(a.score, b.score) >= 0.5) {
        xref = findStreamingFor(item.program.title, streaming);
        if (xref) crossUsed = true;
      }
      items.push({ item, a, b, genres, xref });
    }
  }
  return { items, evaluated, crossUsed, fallback };
}

export async function handleFindForCouple(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');
  const streaming = args.include_streaming_xref ? getStreaming() : null;
  const window = resolveTimeRef(args.timeframe || 'tonight');
  const now = new Date();

  const { items, evaluated, crossUsed, fallback } = collectAndScore(epg, window, args.person_a, args.person_b, streaming, args.include_streaming_xref);

  let degraded = false;
  let fairness = args.fairness;
  let minScore = args.min_score;
  let picks = filterAndRank(items, fairness, minScore, args.limit);

  if (picks.length === 0 && fairness === 'strict') {
    degraded = true;
    fairness = 'average';
    minScore = args.min_score * 0.5;
    picks = filterAndRank(items, fairness, minScore, args.limit);
  }

  const shapedPicks = picks.map(({ item, a, b, genres, xref, combined }) => ({
    ...item,
    extracted_genres: genres,
    streaming_xref: xref,
    score: { a: a.score, b: b.score, combined: Math.round(combined * 100) / 100, delta: Math.round(Math.abs(a.score - b.score) * 100) / 100 },
    why_for_couple: buildCoupleWhy(item, a, b, genres, xref),
    compromise_note: Math.abs(a.score - b.score) > 1.5 ? (a.score > b.score ? 'A câștigă comfortabil — alege dacă vrei să faci pe placul lui A.' : 'B câștigă comfortabil — alege dacă vrei să faci pe placul lui B.') : null,
  }));

  const fresh = freshnessEmbed(now);
  const avgCombined = picks.length ? Math.round((picks.reduce((s, p) => s + p.combined, 0) / picks.length) * 100) / 100 : 0;

  return {
    payload: {
      asked_at_utc: now.toISOString(),
      timeframe_label: window.label,
      window: { from_utc: window.from.toISOString(), to_utc: window.to.toISOString() },
      person_a: { ...args.person_a, mood_resolved: resolveMood(args.person_a.mood).key },
      person_b: { ...args.person_b, mood_resolved: resolveMood(args.person_b.mood).key },
      fairness,
      min_score: minScore,
      degraded,
      count: shapedPicks.length,
      items: shapedPicks,
      freshness: fresh,
    },
    _quality: {
      items_returned: shapedPicks.length,
      candidates_evaluated: evaluated,
      avg_score: avgCombined,
      max_score: shapedPicks.length ? shapedPicks[0].score.combined : 0,
      unique_channels: new Set(shapedPicks.map((p) => p.channel_id)).size,
      cross_source_used: crossUsed,
      fallback_used: fallback,
      freshness_stale: fresh.stale,
    },
  };
}

function filterAndRank(items, fairness, minScore, limit) {
  const scored = items.map((x) => {
    const combined = fairness === 'strict' ? Math.min(x.a.score, x.b.score) : (x.a.score + x.b.score) / 2;
    return { ...x, combined };
  }).filter((x) => x.combined >= minScore);

  const uniqueMap = new Map();
  for (const s of scored.sort((a, b) => b.combined - a.combined)) {
    const key = normalize(s.item.program.title);
    if (!uniqueMap.has(key)) uniqueMap.set(key, s);
  }
  return [...uniqueMap.values()].slice(0, limit);
}

function buildCoupleWhy(item, a, b, genres, xref) {
  const parts = [`${item.channel_name} la ${item.program.start_local.slice(11, 16)}`];
  if (genres.length) parts.push(`genuri: ${genres.map((g) => g.genre).join(', ')}`);
  parts.push(`A=${a.score} (${a.mood_label})`);
  parts.push(`B=${b.score} (${b.mood_label})`);
  if (xref) parts.push(`și pe ${xref.provider_name}`);
  return parts.join(' • ');
}

export const findForCoupleTool = {
  name: 'tv_find_for_couple',
  config: {
    title: 'Find content for a couple',
    description:
      'Finds TV programs that satisfy two people with different moods/preferences. Default fairness=strict (min(scoreA,scoreB) >= threshold — no veto). Auto-falls-back to fairness=average if strict returns empty, marked with degraded:true. Returns per-person score breakdown + compromise note when one side wins by >1.5 points.',
    inputSchema: FindForCoupleInput,
    outputSchema: FindForCoupleOutput,
  },
};
