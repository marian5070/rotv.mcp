import { liveStatus, firstAiringIndex } from '../lib/live-status.mjs';
import { z } from 'zod';
import { getEpgFull } from '../data/store.mjs';
import { utcFromLocalParts, programOverlaps, shapeProgram, TZ } from '../lib/time.mjs';
import { assessImportance } from '../lib/importance.mjs';
import { normalize } from '../lib/text.mjs';
import { Loose } from '../lib/output-shapes.mjs';

export const ImportantTodayOutput = {
  generated_at: z.string().nullable().optional(),
  asked_at_utc: z.string(),
  date: z.string(),
  min_tier: z.number(),
  count: z.number(),
  events: z.array(Loose),
  hint: z.string(),
};

export const ImportantTodayInput = {
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(`Day to scan, YYYY-MM-DD in ${TZ}. Default: today.`),
  min_tier: z
    .number()
    .int()
    .min(1)
    .max(2)
    .default(2)
    .describe('1 = only major events (World Cup, Euro, Champions League, finals); 2 = also notable ones (national-team matches, knockout games)'),
  limit: z.number().int().min(1).max(25).default(10).describe('Max number of events to return'),
};

// „danemarca - portugalia" / „danemarca – portugalia" / „danemarca vs portugalia"
// → aceeași cheie, indiferent de ordinea în care apar echipele.
const TEAM_SYNONYMS = { 'tarile de jos': 'olanda', 'statele unite': 'sua' };
function eventKey(e) {
  const pair = (e.reasons || []).map((r) => /^national teams match: "(.+)"$/.exec(r)).find(Boolean);
  if (pair) {
    const teams = pair[1].split(/\s*(?:-|–|—|vs\.?|v\.)\s*/).map((t) => TEAM_SYNONYMS[t.trim()] || t.trim()).filter(Boolean).sort();
    if (teams.length === 2) return `pair:${teams.join('|')}`;
  }
  return `title:${normalize(e.program.title)}`;
}

// Reprezentantul unui eveniment: întâi ce nu e reluare dovedită, apoi scorul,
// apoi difuzarea cea mai timpurie.
function betterRepresentative(a, b) {
  const ra = a.live_status === 'replay' ? 1 : 0;
  const rb = b.live_status === 'replay' ? 1 : 0;
  if (ra !== rb) return ra < rb;
  if (a.score !== b.score) return a.score > b.score;
  return a.program.start_utc < b.program.start_utc;
}

export async function handleImportantToday(args) {
  const source = getEpgFull();
  if (!source || !Array.isArray(source.channels)) {
    throw new Error('EPG data not loaded');
  }

  const now = new Date();
  let day;
  if (args.date) {
    const [y, m, d] = args.date.split('-').map(Number);
    day = { year: y, month: m, day: d };
  } else {
    // today in Europe/Bucharest, derived from the same TZ helpers as the rest
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
    const [y, m, d] = local.split('-').map(Number);
    day = { year: y, month: m, day: d };
  }
  const window = {
    from: utcFromLocalParts({ ...day, hour: 0, minute: 0 }),
    to: utcFromLocalParts({ ...day, hour: 23, minute: 59, second: 59 }),
  };

  const airings = firstAiringIndex(source);
  const events = [];
  for (const ch of source.channels) {
    for (const p of ch.programs || []) {
      if (!programOverlaps(p, window)) continue;
      const imp = assessImportance(p, ch);
      if (imp.tier === 0 || imp.tier > args.min_tier) continue;
      const live = liveStatus(p, airings);
      events.push({
        ...shapeProgram(ch, p),
        tier: imp.tier,
        score: imp.score,
        reasons: imp.reasons,
        live_status: live.status,
        ...(live.evidence ? { live_evidence: live.evidence } : {}),
      });
    }
  }

  // Un EVENIMENT, mai multe difuzări. Același meci apare pe mai multe canale
  // (cu titluri diferite: „Danemarca – Portugalia" și „etapa 3 UEFA Nations
  // League: Danemarca-Portugalia Grupe") și se reia în aceeași zi. Grupăm pe
  // perechea de echipe când detectorul a găsit-o, altfel pe titlu; evenimentul
  // e reprezentat de cea mai bună difuzare, iar restul stau în `broadcasts`.
  const seen = new Map();
  for (const e of events) {
    const key = eventKey(e);
    const g = seen.get(key);
    if (!g) seen.set(key, { best: e, all: [e] });
    else {
      g.all.push(e);
      if (betterRepresentative(e, g.best)) g.best = e;
    }
  }
  for (const [key, g] of seen) {
    g.all.sort((a, b) => a.program.start_utc.localeCompare(b.program.start_utc));
    seen.set(key, {
      ...g.best,
      broadcast_count: g.all.length,
      broadcasts: g.all.map((b) => ({
        channel_id: b.channel_id,
        channel_name: b.channel_name,
        title: b.program.title,
        start_local: b.program.start_local,
        start_utc: b.program.start_utc,
        duration_min: b.program.duration_min,
        live_status: b.live_status,
      })),
    });
  }

  // tier 1 first, then higher score, then air time
  const result = [...seen.values()]
    .sort((a, b) =>
      (a.tier - b.tier) ||
      ((a.live_status === 'replay') - (b.live_status === 'replay')) || // reluările dovedite, după restul din același tier
      (b.score - a.score) ||
      a.program.start_utc.localeCompare(b.program.start_utc))
    .slice(0, args.limit);

  return {
    generated_at: source.generatedAt,
    asked_at_utc: now.toISOString(),
    date: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`,
    min_tier: args.min_tier,
    count: result.length,
    events: result,
    hint: result.length
      ? 'tier 1 = major event (World Cup / Euro / Champions League / final). reasons quote the EPG text that matched. each entry is ONE event; broadcasts lists every airing of it today (other channels, repeats). live_status: "live" or "replay" only when the EPG proves it (live_evidence says how); "unknown" means the EPG does not say — do not present such a broadcast as live.'
      : 'Nothing above the importance threshold today. Note: the EPG has sparse metadata (many events carry generic titles), so also check tv_now_on_tv or tv_get_prime_time.',
  };
}

export const importantTodayTool = {
  name: 'tv_important_today',
  config: {
    title: "Today's important broadcasts (major events)",
    description:
      "What actually matters on Romanian TV today: World Cup / Euro / Champions League matches, finals, knockout games, national-team fixtures. Detected from real EPG text (titles + descriptions) with quoted evidence — the EPG has no structured event metadata, so detection is keyword-based and honest about it. Each event carries live_status (live / replay / unknown) with the evidence it was derived from; unknown means the EPG does not say whether the broadcast is live. Use this FIRST for questions like \"what's important to watch today?\".",
    inputSchema: ImportantTodayInput,
    outputSchema: ImportantTodayOutput,
  },
};
