import { z } from 'zod';
import { getEpgFull, getStreaming } from '../data/store.mjs';
import { shapeProgram, resolveTimeRef, programOverlaps, utcFromLocalParts } from '../lib/time.mjs';
import { resolveMood, moodFit } from '../lib/moods.mjs';
import { extractGenres } from '../lib/genre-extract.mjs';
import { freshnessEmbed } from '../lib/freshness.mjs';
import { normalize } from '../lib/text.mjs';
import { Freshness, Loose } from '../lib/output-shapes.mjs';

export const PlanEveningOutput = {
  ok: z.boolean(),
  reason: z.string().nullable().optional(),
  asked_at_utc: z.string(),
  start_utc: z.string(),
  end_utc: z.string(),
  duration_budget_min: z.number(),
  mood: z.string(),
  mood_label_ro: z.string(),
  plan: z.array(Loose),
  totals: z.object({
    segments: z.number(),
    total_filled_min: z.number(),
    gap_min: z.number(),
    switches: z.number(),
  }).passthrough(),
  alternatives: z.array(Loose),
  freshness: Freshness,
};

export const PlanEveningInput = {
  start: z.string().default('20:00').describe('Start time: "now" | "HH:MM" (Europe/Bucharest) | ISO instant'),
  duration_min: z.number().int().min(30).max(360).default(180),
  mood: z.string().optional(),
  prefer: z.array(z.string()).optional(),
  max_segments: z.number().int().min(1).max(3).default(3),
  allow_channel_switch: z.boolean().default(true),
  max_gap_min: z.number().int().min(0).max(30).default(10),
};

function resolveStart(startRef, now) {
  const ref = String(startRef || '').trim().toLowerCase();
  if (ref === 'now' || !ref) return now;
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
  return Number.isNaN(d.getTime()) ? now : d;
}

function scoreItem(item, mood, extraPrefer) {
  const CHANNEL_SCORE = { 'Filme & Seriale': 3, 'Documentare': 3, 'Generaliste': 1, 'Copii': 1, 'Sport': 0.5, 'Muzică': 0.25, 'Altele': 0, 'Știri': -10, 'General': 0 };
  let base = CHANNEL_SCORE[item.channel_category] ?? 0;
  const genres = extractGenres(item.program.title, item.program.description, item);
  const mf = moodFit(item, genres, mood);
  if (extraPrefer?.includes(normalize(item.channel_category))) base += 1;
  return { score: base + mf.score, genres, moodParts: mf.parts };
}

export async function handlePlanEvening(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');
  const now = new Date();
  const startUtc = resolveStart(args.start, now);
  const endUtc = new Date(startUtc.getTime() + args.duration_min * 60_000);
  const window = { from: new Date(startUtc.getTime() - 15 * 60_000), to: endUtc, label: 'plan' };
  const mood = resolveMood(args.mood);
  const extraPrefer = (args.prefer || []).map(normalize);

  const candidates = [];
  let evaluated = 0;
  for (const ch of epg.channels) {
    if (mood.excl_channel_cats.includes(ch.category)) continue;
    for (const p of (ch.programs || [])) {
      if (!programOverlaps(p, window)) continue;
      evaluated++;
      const item = shapeProgram(ch, p);
      const { score, genres, moodParts } = scoreItem(item, mood, extraPrefer);
      item._score = Math.round(score * 100) / 100;
      item._genres = genres;
      item._moodParts = moodParts;
      candidates.push(item);
    }
  }

  // Try 1-segment plan
  const oneShot = candidates
    .filter((c) => {
      const cs = new Date(c.program.start_utc).getTime();
      const startDelta = Math.abs(cs - startUtc.getTime()) / 60_000;
      return startDelta <= 15
        && c.program.duration_min >= args.duration_min * 0.8
        && c.program.duration_min <= args.duration_min * 1.2;
    })
    .filter((c) => c._score >= 2)
    .sort((a, b) => b._score - a._score)[0];

  let plan = [];
  let alternatives = [];

  if (oneShot) {
    plan = [makeSegment(1, oneShot, mood, 'single program fills budget')];
  } else {
    // Greedy multi-segment
    let cursor = startUtc.getTime();
    let remaining = args.duration_min;
    let lastChannel = null;
    while (remaining > 30 && plan.length < args.max_segments) {
      const cursorMs = cursor;
      const feasible = candidates
        .filter((c) => !plan.some((s) => s.title === c.program.title))
        .filter((c) => {
          const cs = new Date(c.program.start_utc).getTime();
          const dt = (cs - cursorMs) / 60_000;
          if (dt < -5 || dt > args.max_gap_min) return false;
          if (c.program.duration_min > remaining + 20) return false;
          if (!args.allow_channel_switch && lastChannel && c.channel_id !== lastChannel) return false;
          return true;
        })
        .sort((a, b) => {
          if (b._score !== a._score) return b._score - a._score;
          return Math.abs(b.program.duration_min - remaining) - Math.abs(a.program.duration_min - remaining);
        });
      const pick = feasible[0];
      if (!pick) break;
      plan.push(makeSegment(plan.length + 1, pick, mood));
      cursor = new Date(pick.program.stop_utc).getTime();
      remaining -= pick.program.duration_min;
      lastChannel = pick.channel_id;
    }
  }

  if (plan.length === 0) {
    alternatives = candidates.sort((a, b) => b._score - a._score).slice(0, 3).map((c) => ({
      channel_name: c.channel_name,
      title: c.program.title,
      start_local: c.program.start_local,
      duration_min: c.program.duration_min,
      score: c._score,
      reason: 'Niciun program nu se potrivește ca timing — alternativă cu cel mai mare scor',
    }));
  } else {
    const planTitles = new Set(plan.map((s) => s.title));
    alternatives = candidates
      .filter((c) => !planTitles.has(c.program.title))
      .sort((a, b) => b._score - a._score)
      .slice(0, 3)
      .map((c) => ({
        channel_name: c.channel_name,
        title: c.program.title,
        start_local: c.program.start_local,
        duration_min: c.program.duration_min,
        score: c._score,
        reason: dropReason(c, plan, args),
      }));
  }

  const totalFilled = plan.reduce((s, p) => s + p.duration_min, 0);
  const switches = plan.length > 1 ? new Set(plan.map((p) => p.channel_id)).size - 1 : 0;
  const fresh = freshnessEmbed(now);

  return {
    payload: {
      ok: plan.length > 0,
      reason: plan.length > 0 ? null : 'no_candidates_in_window',
      asked_at_utc: now.toISOString(),
      start_utc: startUtc.toISOString(),
      end_utc: endUtc.toISOString(),
      duration_budget_min: args.duration_min,
      mood: mood.key,
      mood_label_ro: mood.label_ro,
      plan,
      totals: {
        segments: plan.length,
        total_filled_min: totalFilled,
        gap_min: Math.max(0, args.duration_min - totalFilled),
        switches,
      },
      alternatives,
      freshness: fresh,
    },
    _quality: {
      items_returned: plan.length,
      candidates_evaluated: evaluated,
      avg_score: plan.length ? Math.round((plan.reduce((s, p) => s + p.score, 0) / plan.length) * 100) / 100 : 0,
      max_score: plan.length ? Math.max(...plan.map((p) => p.score)) : 0,
      unique_channels: new Set(plan.map((p) => p.channel_id)).size,
      cross_source_used: false,
      fallback_used: candidates.some((c) => c._genres.length === 0),
      freshness_stale: fresh.stale,
    },
  };
}

function makeSegment(order, item, mood, note) {
  return {
    order,
    channel_id: item.channel_id,
    channel_name: item.channel_name,
    channel_category: item.channel_category,
    title: item.program.title,
    start_local: item.program.start_local,
    stop_local: item.program.stop_local,
    start_utc: item.program.start_utc,
    stop_utc: item.program.stop_utc,
    duration_min: item.program.duration_min,
    extracted_genres: item._genres,
    mood_fit: item._moodParts,
    score: item._score,
    why: note || buildSegmentWhy(item, mood),
  };
}

function buildSegmentWhy(item, mood) {
  const parts = [`${item.channel_name} (${item.channel_category})`];
  if (item._genres?.length) parts.push(`genuri: ${item._genres.map((g) => g.genre).join(', ')}`);
  parts.push(`mood ${mood.label_ro}`);
  parts.push(`durata ${item.program.duration_min} min`);
  return parts.join(' • ');
}

function dropReason(c, plan, args) {
  if (plan.some((s) => s.title === c.program.title)) return 'deja inclus în plan';
  if (c.program.duration_min > args.duration_min) return `prea lung (${c.program.duration_min} min vs buget ${args.duration_min})`;
  const planEnd = plan.length ? new Date(plan[plan.length - 1].stop_utc).getTime() : null;
  if (planEnd) {
    const dt = (new Date(c.program.start_utc).getTime() - planEnd) / 60_000;
    if (dt > args.max_gap_min) return `începe după gap mai mare decât ${args.max_gap_min} min`;
    if (dt < -5) return 'începe înainte de fereastra disponibilă';
  }
  return `scor mai mic (${c._score}) decât selecția`;
}

export const planEveningTool = {
  name: 'tv_plan_evening',
  config: {
    title: 'Plan an evening',
    description:
      'Builds a coherent TV watching plan for an evening — either one long program filling the budget or 2-3 segments with small gaps. Accepts start time, duration budget, mood, and channel preferences. Output: ordered timeline + alternatives dropped + totals.',
    inputSchema: PlanEveningInput,
    outputSchema: PlanEveningOutput,
  },
};
