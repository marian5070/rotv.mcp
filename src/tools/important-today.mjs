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

  const events = [];
  for (const ch of source.channels) {
    for (const p of ch.programs || []) {
      if (!programOverlaps(p, window)) continue;
      const imp = assessImportance(p, ch);
      if (imp.tier === 0 || imp.tier > args.min_tier) continue;
      events.push({ ...shapeProgram(ch, p), tier: imp.tier, score: imp.score, reasons: imp.reasons });
    }
  }

  // Same event often airs on several channels / repeats — keep the strongest
  // per normalized title + start hour.
  const seen = new Map();
  for (const e of events) {
    const key = `${normalize(e.program.title)}|${e.program.start_utc.slice(0, 13)}`;
    const prev = seen.get(key);
    if (!prev || e.score > prev.score) seen.set(key, e);
  }

  // tier 1 first, then higher score, then air time
  const result = [...seen.values()]
    .sort((a, b) =>
      (a.tier - b.tier) ||
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
      ? 'tier 1 = major event (World Cup / Euro / Champions League / final). reasons quote the EPG text that matched.'
      : 'Nothing above the importance threshold today. Note: the EPG has sparse metadata (many events carry generic titles), so also check tv_now_on_tv or tv_get_prime_time.',
  };
}

export const importantTodayTool = {
  name: 'tv_important_today',
  config: {
    title: "Today's important broadcasts (major events)",
    description:
      "What actually matters on Romanian TV today: World Cup / Euro / Champions League matches, finals, knockout games, national-team fixtures. Detected from real EPG text (titles + descriptions) with quoted evidence — the EPG has no structured event metadata, so detection is keyword-based and honest about it. Use this FIRST for questions like \"what's important to watch today?\".",
    inputSchema: ImportantTodayInput,
    outputSchema: ImportantTodayOutput,
  },
};
