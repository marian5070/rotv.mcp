import { z } from 'zod';
import { getEpgFull, getStreaming } from '../data/store.mjs';
import { shapeProgram, resolveTimeRef, programOverlaps } from '../lib/time.mjs';
import { resolveMood, moodFit } from '../lib/moods.mjs';
import { extractGenres } from '../lib/genre-extract.mjs';
import { findStreamingFor } from '../lib/xref.mjs';
import { freshnessEmbed } from '../lib/freshness.mjs';
import { dedupByTitle } from '../lib/rank.mjs';
import { normalize } from '../lib/text.mjs';
import { WindowUtc, Freshness, Loose } from '../lib/output-shapes.mjs';

export const RecommendByMoodOutput = {
  generated_at: z.string().nullable().optional(),
  asked_at_utc: z.string(),
  mood: z.string(),
  mood_label_ro: z.string(),
  timeframe_label: z.string(),
  window: WindowUtc,
  count: z.number(),
  items: z.array(Loose),
  freshness: Freshness,
};

export const RecommendByMoodInput = {
  mood: z.string().min(2).max(40).describe(
    'Mood: obosit | vesel | concentrat | romantic | familie | captivant (also accepts tired, happy, focused, family, thrilling, etc.)'
  ),
  timeframe: z.string().default('tonight').describe('now | tonight | primetime | tomorrow | weekend | today | YYYY-MM-DD | ISO range "A/B"'),
  prefer: z.array(z.string()).optional().describe('Additional channel-category preferences (additive boost)'),
  dislike_genres: z.array(z.string()).optional(),
  dislike_keywords: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(10).default(5),
  include_streaming_xref: z.boolean().default(true),
};

const CHANNEL_BASE_SCORE = {
  'Filme & Seriale': 3,
  'Documentare': 3,
  'Generaliste': 1,
  'Copii': 1,
  'Sport': 0.5,
  'Muzică': 0.25,
  'Altele': 0,
  'Știri': -10,
  'General': 0,
};

export async function handleRecommendByMood(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');
  const streaming = args.include_streaming_xref ? getStreaming() : null;
  const window = resolveTimeRef(args.timeframe || 'tonight');
  const mood = resolveMood(args.mood);
  const now = new Date();

  const dislikeGenres = (args.dislike_genres || []).map(normalize);
  const dislikeKeywords = (args.dislike_keywords || []).map(normalize);
  const extraPrefer = (args.prefer || []).map(normalize);

  const candidates = [];
  let evaluated = 0;
  let fallbackUsed = false;
  let crossUsed = false;

  for (const ch of epg.channels) {
    if (mood.excl_channel_cats.includes(ch.channel_category) || mood.excl_channel_cats.includes(ch.category)) continue;
    for (const p of (ch.programs || [])) {
      if (!programOverlaps(p, window)) continue;
      evaluated++;
      const item = shapeProgram(ch, p);
      const titleLower = normalize(item.program.title);
      if (dislikeKeywords.some((kw) => titleLower.includes(kw))) continue;

      const genres = extractGenres(p.title, p.description, p);
      if (genres.length === 0) fallbackUsed = true;

      if (dislikeGenres.length && genres.some((g) => dislikeGenres.includes(normalize(g.genre)))) continue;

      let score = CHANNEL_BASE_SCORE[ch.category] ?? 0;
      const mf = moodFit(item, genres, mood);
      score += mf.score;

      if (extraPrefer.includes(normalize(ch.category))) score += 1;

      const startMs = new Date(item.program.start_utc).getTime();
      const deltaMin = (startMs - now.getTime()) / 60_000;
      if (deltaMin >= -5 && deltaMin <= 60) score += 2;

      if (item.program.duration_min >= 45 && item.program.duration_min <= 180) score += 0.5;

      let xref = null;
      if (streaming && score >= 1.5) {
        xref = findStreamingFor(item.program.title, streaming);
        if (xref) {
          crossUsed = true;
          score += 0.5;
        }
      }

      item._score = Math.round(score * 100) / 100;
      item._moodParts = mf.parts;
      item._extractedGenres = genres;
      item._xref = xref;
      candidates.push(item);
    }
  }

  const deduped = dedupByTitle(candidates);
  deduped.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

  const top = deduped.slice(0, args.limit).map((it) => {
    const { _score, _moodParts, _extractedGenres, _xref, ...rest } = it;
    return {
      ...rest,
      score: _score,
      extracted_genres: _extractedGenres,
      streaming_xref: _xref,
      mood_parts: _moodParts,
      why_recommended: buildWhy(it, mood),
    };
  });

  const fresh = freshnessEmbed(now);
  const avgScore = top.length ? Math.round((top.reduce((s, x) => s + x.score, 0) / top.length) * 100) / 100 : 0;
  const maxScore = top.length ? Math.max(...top.map((x) => x.score)) : 0;
  const uniqueChannels = new Set(top.map((x) => x.channel_id)).size;

  return {
    payload: {
      generated_at: epg.generatedAt,
      asked_at_utc: now.toISOString(),
      mood: mood.key,
      mood_label_ro: mood.label_ro,
      timeframe_label: window.label,
      window: { from_utc: window.from.toISOString(), to_utc: window.to.toISOString() },
      count: top.length,
      items: top,
      freshness: fresh,
    },
    _quality: {
      items_returned: top.length,
      candidates_evaluated: evaluated,
      avg_score: avgScore,
      max_score: maxScore,
      unique_channels: uniqueChannels,
      cross_source_used: crossUsed,
      fallback_used: fallbackUsed,
      freshness_stale: fresh.stale,
    },
  };
}

function buildWhy(item, mood) {
  const parts = [];
  parts.push(`${item.channel_name} (${item.channel_category})`);
  const start = item.program.start_local.slice(11, 16);
  parts.push(`începe la ${start}, durata ${item.program.duration_min} min`);
  if (item._extractedGenres?.length) {
    parts.push(`genuri: ${item._extractedGenres.map((g) => g.genre).join(', ')}`);
  }
  if (item._xref) {
    parts.push(`și pe ${item._xref.provider_name} (${item._xref.confidence_label})`);
  }
  parts.push(`mood ${mood.label_ro}`);
  return parts.join(' • ');
}

export const recommendByMoodTool = {
  name: 'tv_recommend_by_mood',
  config: {
    title: 'Recommend by mood',
    description:
      'Returns top-N Romanian TV programs ranked for a given mood (obosit/vesel/concentrat/romantic/familie/captivant — RO/EN aliases accepted). Combines: channel category, mood-fit (genre + duration + keywords), time proximity, and streaming cross-reference. Output includes mood_parts breakdown and freshness embedded.',
    inputSchema: RecommendByMoodInput,
    outputSchema: RecommendByMoodOutput,
  },
};
