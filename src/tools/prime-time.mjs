import { z } from 'zod';
import { getEpgFull, getEpgHome } from '../data/store.mjs';
import { shapeProgram, resolveTimeRef, programOverlaps } from '../lib/time.mjs';
import { ProgramInner, WindowUtc } from '../lib/output-shapes.mjs';

export const PrimeTimeOutput = {
  generated_at: z.string().nullable().optional(),
  asked_at_utc: z.string(),
  date: z.string(),
  window_local: z.string(),
  window: WindowUtc,
  scope: z.string(),
  exclude_news: z.boolean(),
  count: z.number(),
  channels: z.array(
    z.object({
      channel_id: z.string(),
      channel_name: z.string(),
      channel_category: z.string().nullable().optional(),
      programs: z.array(ProgramInner),
    }).passthrough()
  ),
};

export const PrimeTimeInput = {
  date: z.string().default('today').describe(
    'today | tomorrow | YYYY-MM-DD (interpreted in Europe/Bucharest)'
  ),
  scope: z.enum(['main', 'all']).default('main'),
  exclude_news: z.boolean().default(true),
};

function primeTimeWindow(dateRef) {
  if (dateRef === 'today' || dateRef === 'tomorrow') {
    const base = resolveTimeRef(dateRef);
    return resolveTimeRef(`${formatYmd(base.from)}T17:00:00.000Z`) && {
      from: base.from,
      to: base.to,
      label: dateRef,
    };
  }
  return null;
}

function formatYmd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export async function handlePrimeTime(args) {
  const source = args.scope === 'all' ? getEpgFull() : getEpgHome();
  if (!source) throw new Error('EPG data not loaded');

  let window;
  if (args.date === 'today' || args.date === 'tomorrow') {
    const dayRange = resolveTimeRef(args.date);
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Bucharest',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(dayRange.from).split('-').map(Number);
    window = resolveTimeRef(`${ymd[0]}-${String(ymd[1]).padStart(2,'0')}-${String(ymd[2]).padStart(2,'0')}`);
    // narrow to 20:00–23:00 in local time
    const { utcFromLocalParts } = await import('../lib/time.mjs');
    window = {
      from: utcFromLocalParts({ year: ymd[0], month: ymd[1], day: ymd[2], hour: 20, minute: 0 }),
      to:   utcFromLocalParts({ year: ymd[0], month: ymd[1], day: ymd[2], hour: 23, minute: 0 }),
      label: args.date,
    };
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date);
    if (!m) throw new Error('Invalid date — use today | tomorrow | YYYY-MM-DD');
    const { utcFromLocalParts } = await import('../lib/time.mjs');
    window = {
      from: utcFromLocalParts({ year: +m[1], month: +m[2], day: +m[3], hour: 20, minute: 0 }),
      to:   utcFromLocalParts({ year: +m[1], month: +m[2], day: +m[3], hour: 23, minute: 0 }),
      label: args.date,
    };
  }

  const byChannel = [];
  for (const ch of source.channels) {
    if (args.exclude_news && ch.category === 'Știri') continue;
    const progs = (ch.programs || [])
      .filter((p) => programOverlaps(p, window))
      .map((p) => {
        const s = shapeProgram(ch, p);
        return s.program;
      });
    if (progs.length) {
      byChannel.push({
        channel_id: ch.id,
        channel_name: ch.displayName,
        channel_category: ch.category,
        programs: progs,
      });
    }
  }

  return {
    generated_at: source.generatedAt,
    asked_at_utc: new Date().toISOString(),
    date: args.date,
    window_local: '20:00–23:00 (Europe/Bucharest)',
    window: { from_utc: window.from.toISOString(), to_utc: window.to.toISOString() },
    scope: args.scope,
    exclude_news: args.exclude_news,
    count: byChannel.reduce((sum, c) => sum + c.programs.length, 0),
    channels: byChannel,
  };
}

export const primeTimeTool = {
  name: 'tv_get_prime_time',
  config: {
    title: 'Prime-time TV lineup',
    description:
      'Returns the prime-time lineup (20:00–23:00 Europe/Bucharest) for a given date, grouped by channel. Use for queries like "what is on prime time tonight" or "tomorrow night TV". By default, news channels are excluded.',
    inputSchema: PrimeTimeInput,
    outputSchema: PrimeTimeOutput,
  },
};
