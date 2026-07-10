import { z } from 'zod';
import { getEpgFull } from '../data/store.mjs';
import { shapeProgram, resolveTimeRef, programOverlaps } from '../lib/time.mjs';
import { matchesQuery, normalize } from '../lib/text.mjs';
import { ShapedProgram, WindowUtc } from '../lib/output-shapes.mjs';

export const SearchOutput = {
  generated_at: z.string().nullable().optional(),
  asked_at_utc: z.string(),
  timeframe_label: z.string(),
  window: WindowUtc,
  count: z.number(),
  items: z.array(ShapedProgram.extend({ match_reason: z.string().optional() })),
};

export const SearchInput = {
  query: z.string().min(1).max(200).optional().describe(
    'Free text to match against program title (case/diacritic-insensitive)'
  ),
  channel: z.string().optional().describe(
    'Channel id, display name, or alias (e.g. "PRO TV", "tv-pro-tv", "HBO")'
  ),
  category: z.string().optional().describe(
    'Channel category: Generaliste | Știri | Sport | Filme & Seriale | Documentare | Copii | Muzică | Altele'
  ),
  timeframe: z.string().default('now').describe(
    'Natural time reference: now | tonight | tomorrow | weekend | primetime | today | YYYY-MM-DD | ISO instant | ISO range "A/B"'
  ),
  exclude_news: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10),
};

function channelMatches(ch, raw) {
  const q = normalize(raw);
  if (!q) return true;
  if (normalize(ch.id) === q) return true;
  if (normalize(ch.displayName) === q) return true;
  if (normalize(ch.displayName).includes(q) || q.includes(normalize(ch.displayName))) return true;
  const aliases = ch.aliases || [];
  for (const a of aliases) if (normalize(a) === q || normalize(a).includes(q)) return true;
  return false;
}

export async function handleSearch(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');

  const window = resolveTimeRef(args.timeframe || 'now');
  const items = [];
  const matchReasons = [];

  for (const ch of epg.channels) {
    if (args.exclude_news && ch.category === 'Știri') continue;
    if (args.category && ch.category !== args.category) continue;
    if (args.channel && !channelMatches(ch, args.channel)) continue;

    for (const p of (ch.programs || [])) {
      if (!programOverlaps(p, window)) continue;
      if (args.query && !matchesQuery(p.title, args.query) && !matchesQuery(p.description || '', args.query)) continue;

      const shaped = shapeProgram(ch, p);
      const reasons = [];
      if (args.query) reasons.push(`title contains "${args.query}"`);
      if (args.channel) reasons.push(`channel match: ${ch.displayName}`);
      if (args.category) reasons.push(`category: ${ch.category}`);
      shaped.match_reason = reasons.join(' • ') || 'in timeframe';
      items.push(shaped);
      matchReasons.push(shaped.match_reason);
      if (items.length >= args.limit) break;
    }
    if (items.length >= args.limit) break;
  }

  items.sort((a, b) => new Date(a.program.start_utc) - new Date(b.program.start_utc));

  return {
    generated_at: epg.generatedAt,
    asked_at_utc: new Date().toISOString(),
    timeframe_label: window.label,
    window: { from_utc: window.from.toISOString(), to_utc: window.to.toISOString() },
    count: items.length,
    items,
  };
}

export const searchProgramTool = {
  name: 'tv_search_program',
  config: {
    title: 'Search Romanian TV programs',
    description:
      'Search programs across all 254 Romanian TV channels by free-text title, channel, category, and time window. Use for queries like "documentaries on Discovery tomorrow", "football on Saturday", "what is on Antena 1 right now". Time references accepted: now, tonight, tomorrow, weekend, primetime, today, YYYY-MM-DD, ISO instant, or ISO range "A/B".',
    inputSchema: SearchInput,
    outputSchema: SearchOutput,
  },
};
