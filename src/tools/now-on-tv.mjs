import { z } from 'zod';
import { getEpgHome, getEpgFull } from '../data/store.mjs';
import { shapeProgram } from '../lib/time.mjs';
import { ShapedProgram } from '../lib/output-shapes.mjs';

export const NowOnTvOutput = {
  generated_at: z.string().nullable().optional(),
  asked_at_utc: z.string(),
  scope: z.string(),
  count: z.number(),
  items: z.array(ShapedProgram),
};

export const NowOnTvInput = {
  scope: z.enum(['main', 'all']).default('main').describe(
    'main = 14 main Romanian channels (PRO TV, Antena 1, Kanal D, TVR 1/2, Digi 24, etc.); all = all 254 channels'
  ),
  exclude_news: z.boolean().default(false).describe(
    'Drop channels whose category is "Știri" (Romanian news channels)'
  ),
  category: z.string().optional().describe(
    'Filter by channel category: Generaliste | Știri | Sport | Filme & Seriale | Documentare | Copii | Muzică | Altele'
  ),
  limit: z.number().int().min(1).max(50).default(15).describe('Max number of items to return'),
};

export async function handleNowOnTv(args) {
  const source = (args.scope === 'all' ? getEpgFull() : getEpgHome());
  if (!source || !Array.isArray(source.channels)) {
    throw new Error('EPG data not loaded');
  }

  const now = new Date();
  const nowMs = now.getTime();
  const items = [];

  for (const ch of source.channels) {
    if (args.exclude_news && ch.category === 'Știri') continue;
    if (args.category && ch.category !== args.category) continue;
    const programs = ch.programs || [];
    const current = programs.find((p) => {
      const s = new Date(p.start).getTime();
      const e = new Date(p.stop).getTime();
      return s <= nowMs && nowMs < e;
    });
    if (current) items.push(shapeProgram(ch, current));
    if (items.length >= args.limit) break;
  }

  return {
    generated_at: source.generatedAt,
    asked_at_utc: now.toISOString(),
    scope: args.scope,
    count: items.length,
    items,
  };
}

export const nowOnTvTool = {
  name: 'tv_now_on_tv',
  config: {
    title: 'What is on TV right now',
    description:
      'Returns the programs currently broadcasting on Romanian TV channels. Use this for "What is on TV now?" type questions. Default scope is the 14 main channels; pass scope="all" for the full 254-channel list.',
    inputSchema: NowOnTvInput,
    outputSchema: NowOnTvOutput,
  },
};
