import { z } from 'zod';
import { getEpgFull, getStreaming } from '../data/store.mjs';
import { shapeProgram } from '../lib/time.mjs';
import { resolveMood, moodFit } from '../lib/moods.mjs';
import { extractGenres } from '../lib/genre-extract.mjs';
import { findStreamingFor } from '../lib/xref.mjs';
import { freshnessEmbed } from '../lib/freshness.mjs';
import { matchesQuery, normalize } from '../lib/text.mjs';
import { Freshness, Loose } from '../lib/output-shapes.mjs';

export const CompareOptionsOutput = {
  asked_at_utc: z.string(),
  mood: z.string(),
  mood_label_ro: z.string(),
  options: z.array(Loose),
  winner: z.object({
    query: z.string(),
    total_score: z.number(),
    reason: z.string(),
  }).passthrough().nullable(),
  freshness: Freshness,
};

export const CompareOptionsInput = {
  options: z.array(
    z.union([
      z.string(),
      z.object({ title: z.string(), channel: z.string().optional() }),
    ])
  ).min(2).max(5).describe('Array of 2-5 titles (string) or { title, channel? } objects to compare'),
  mood: z.string().optional(),
  prefer: z.array(z.string()).optional(),
  upcoming_window_hours: z.number().int().min(1).max(72).default(48),
};

const CHANNEL_SCORE = { 'Filme & Seriale': 3, 'Documentare': 3, 'Generaliste': 1, 'Copii': 1, 'Sport': 0.5, 'Muzică': 0.25, 'Altele': 0, 'Știri': -10, 'General': 0 };

function findAiring(epg, query, channel, horizon) {
  const now = Date.now();
  let best = null;
  for (const ch of epg.channels) {
    if (channel && !channelMatches(ch, channel)) continue;
    for (const p of (ch.programs || [])) {
      const stopMs = new Date(p.stop).getTime();
      if (stopMs < now) continue;
      const startMs = new Date(p.start).getTime();
      if (startMs > horizon) continue;
      if (!matchesQuery(p.title, query)) continue;
      if (!best || startMs < new Date(best.program.start).getTime()) {
        best = { ch, program: p };
      }
    }
  }
  return best;
}

function channelMatches(ch, raw) {
  const q = normalize(raw);
  if (!q) return true;
  if (normalize(ch.id) === q) return true;
  if (normalize(ch.displayName).includes(q) || q.includes(normalize(ch.displayName))) return true;
  return (ch.aliases || []).some((a) => normalize(a).includes(q) || q.includes(normalize(a)));
}

export async function handleCompareOptions(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');
  const streaming = getStreaming();
  const now = new Date();
  const horizon = now.getTime() + args.upcoming_window_hours * 3600_000;
  const mood = resolveMood(args.mood);
  const extraPrefer = (args.prefer || []).map(normalize);

  const results = [];
  let crossUsed = false;
  let fallbackUsed = false;

  for (const opt of args.options) {
    const query = typeof opt === 'string' ? opt : opt.title;
    const channelFilter = typeof opt === 'object' ? opt.channel : undefined;

    const found = findAiring(epg, query, channelFilter, horizon);
    const xref = streaming ? findStreamingFor(query, streaming) : null;
    if (xref) crossUsed = true;

    if (!found && !xref) {
      results.push({ query, found: false, next_airing: null, streaming: null, score_breakdown: null, total_score: -Infinity });
      continue;
    }

    let scoreBreakdown = null;
    let total = 0;
    let extractedGenres = [];
    let nextAiring = null;
    if (found) {
      const item = shapeProgram(found.ch, found.program);
      extractedGenres = extractGenres(found.program.title, found.program.description, found.program);
      if (extractedGenres.length === 0) fallbackUsed = true;
      const channelCat = CHANNEL_SCORE[item.channel_category] ?? 0;
      const mf = moodFit(item, extractedGenres, mood);
      const startMs = new Date(item.program.start_utc).getTime();
      const deltaMin = (startMs - now.getTime()) / 60_000;
      const timeProx = (deltaMin >= -5 && deltaMin <= 60) ? 2 : 0;
      const durMatch = (item.program.duration_min >= 45 && item.program.duration_min <= 180) ? 0.5 : 0;
      const prefBoost = extraPrefer.includes(normalize(item.channel_category)) ? 1 : 0;
      const xrefBoost = xref ? 0.5 : 0;
      total = channelCat + mf.score + timeProx + durMatch + prefBoost + xrefBoost;
      scoreBreakdown = {
        channel_cat: channelCat,
        mood_fit: mf.score,
        time_proximity: timeProx,
        duration_match: durMatch,
        prefer_boost: prefBoost,
        xref_boost: xrefBoost,
        total: Math.round(total * 100) / 100,
      };
      nextAiring = {
        channel_id: item.channel_id,
        channel_name: item.channel_name,
        channel_category: item.channel_category,
        start_local: item.program.start_local,
        start_utc: item.program.start_utc,
        duration_min: item.program.duration_min,
        description: item.program.description,
      };
    } else {
      total = xref ? (1 + (xref.vote_average ? xref.vote_average / 10 : 0)) : -Infinity;
      scoreBreakdown = { channel_cat: 0, mood_fit: 0, time_proximity: 0, duration_match: 0, prefer_boost: 0, xref_boost: xref ? 1 : 0, total: Math.round(total * 100) / 100 };
    }

    results.push({
      query,
      found: !!found,
      next_airing: nextAiring,
      extracted_genres: extractedGenres,
      streaming: xref,
      score_breakdown: scoreBreakdown,
      total_score: total,
      vote_average: xref?.vote_average ?? null,
    });
  }

  let winner = null;
  const ranked = [...results].filter((r) => Number.isFinite(r.total_score)).sort((a, b) => b.total_score - a.total_score);
  if (ranked.length) {
    const top = ranked[0];
    winner = {
      query: top.query,
      total_score: Math.round(top.total_score * 100) / 100,
      reason: buildWinnerReason(top, ranked[1], mood),
    };
  }

  const cleaned = results.map((r) => ({ ...r, total_score: Number.isFinite(r.total_score) ? Math.round(r.total_score * 100) / 100 : null }));
  const fresh = freshnessEmbed(now);

  return {
    payload: {
      asked_at_utc: now.toISOString(),
      mood: mood.key,
      mood_label_ro: mood.label_ro,
      options: cleaned,
      winner,
      freshness: fresh,
    },
    _quality: {
      items_returned: cleaned.length,
      candidates_evaluated: cleaned.length,
      avg_score: ranked.length ? Math.round((ranked.reduce((s, r) => s + r.total_score, 0) / ranked.length) * 100) / 100 : 0,
      max_score: ranked.length ? ranked[0].total_score : 0,
      unique_channels: new Set(cleaned.filter((r) => r.next_airing).map((r) => r.next_airing.channel_id)).size,
      cross_source_used: crossUsed,
      fallback_used: fallbackUsed,
      freshness_stale: fresh.stale,
    },
  };
}

function buildWinnerReason(top, runnerUp, mood) {
  const parts = [`Cel mai mare scor total (${Math.round(top.total_score * 100) / 100})`];
  if (top.next_airing) parts.push(`disponibil pe ${top.next_airing.channel_name} la ${top.next_airing.start_local.slice(11, 16)}`);
  if (top.streaming) parts.push(`și pe ${top.streaming.provider_name}`);
  parts.push(`pentru mood ${mood.label_ro}`);
  if (runnerUp) {
    const delta = Math.round((top.total_score - runnerUp.total_score) * 100) / 100;
    parts.push(`bate "${runnerUp.query}" cu ${delta} puncte`);
  }
  return parts.join(' • ');
}

export const compareOptionsTool = {
  name: 'tv_compare_options',
  config: {
    title: 'Compare TV options side-by-side',
    description:
      'Compares 2-5 program titles by scoring each against the chosen mood, finding the next TV airing (next 48h by default) and looking each up in the streaming catalog. Returns side-by-side breakdown and a winner with reasoning.',
    inputSchema: CompareOptionsInput,
    outputSchema: CompareOptionsOutput,
  },
};
