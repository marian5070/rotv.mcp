import { z } from 'zod';
import { getEpgFull } from '../data/store.mjs';
import { shapeProgram, resolveTimeRef, programOverlaps } from '../lib/time.mjs';
import { scoreShaped, buildWhy, dedupByTitle } from '../lib/rank.mjs';
import { ShapedProgram, WindowUtc } from '../lib/output-shapes.mjs';

export const RecommendOutput = {
  generated_at: z.string().nullable().optional(),
  asked_at_utc: z.string(),
  timeframe_label: z.string(),
  window: WindowUtc,
  prefer: z.array(z.string()),
  exclude_news: z.boolean(),
  count: z.number(),
  items: z.array(
    ShapedProgram.extend({
      score: z.number(),
      why_recommended: z.string(),
    })
  ),
};

export const RecommendInput = {
  timeframe: z.string().default('tonight').describe(
    'now | tonight | primetime | tomorrow | weekend | today | YYYY-MM-DD | ISO range "A/B"'
  ),
  prefer: z.array(z.enum(['filme', 'seriale', 'documentare', 'sport', 'copii', 'muzica']))
    .default(['filme', 'documentare'])
    .describe('Preferred categories for ranking boost'),
  exclude_news: z.boolean().default(true).describe('Drop news channels and news programs'),
  limit: z.number().int().min(1).max(10).default(5),
};

export async function handleRecommend(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');

  const window = resolveTimeRef(args.timeframe || 'tonight');
  const now = new Date();

  const shaped = [];
  for (const ch of epg.channels) {
    if (args.exclude_news && ch.category === 'Știri') continue;
    for (const p of (ch.programs || [])) {
      if (!programOverlaps(p, window)) continue;
      const titleLower = (p.title || '').toLowerCase();
      if (args.exclude_news && (titleLower.includes('știri') || titleLower.includes('stiri'))) continue;
      const item = shapeProgram(ch, p);
      const score = scoreShaped(item, { prefer: args.prefer, excludeNews: args.exclude_news, now });
      if (score === null) continue;
      item._score = score;
      shaped.push(item);
    }
  }

  const deduped = dedupByTitle(shaped);
  deduped.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  const top = deduped.slice(0, args.limit).map((it) => {
    const { _score, ...rest } = it;
    return { ...rest, score: Math.round(_score * 100) / 100, why_recommended: buildWhy(it) };
  });

  return {
    generated_at: epg.generatedAt,
    asked_at_utc: now.toISOString(),
    timeframe_label: window.label,
    window: { from_utc: window.from.toISOString(), to_utc: window.to.toISOString() },
    prefer: args.prefer,
    exclude_news: args.exclude_news,
    count: top.length,
    items: top,
  };
}

export const recommendTool = {
  name: 'tv_recommend_today',
  config: {
    title: 'Recommend something to watch on Romanian TV',
    description:
      'Returns up to N ranked program recommendations for a given timeframe. Uses a deterministic scorer that rewards films / documentaries / generalist channels, penalises news, and boosts programs starting within the next hour. Use for queries like "recommend me something for tonight", "ce e bun la TV diseară".',
    inputSchema: RecommendInput,
    outputSchema: RecommendOutput,
  },
};
