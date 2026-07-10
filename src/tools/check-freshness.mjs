import { z } from 'zod';
import { computeFreshness, summarizeFreshness } from '../lib/freshness.mjs';
import { Freshness, Loose } from '../lib/output-shapes.mjs';

export const CheckFreshnessOutput = {
  asked_at_utc: z.string(),
  now_utc: z.string(),
  sources: Loose,
  overall_stale: z.boolean(),
  summary: z.string(),
  freshness: Freshness,
};

export const CheckFreshnessInput = {
  source: z.enum(['all', 'epg', 'streaming']).default('all').describe('Optional filter for which source to report'),
};

export async function handleCheckFreshness(args) {
  const now = new Date();
  const fresh = computeFreshness(now);

  let sources = fresh.sources;
  if (args.source === 'epg') {
    sources = { epg: fresh.sources.epg, epg_home: fresh.sources.epg_home };
  } else if (args.source === 'streaming') {
    sources = { streaming: fresh.sources.streaming };
  }

  return {
    payload: {
      asked_at_utc: now.toISOString(),
      now_utc: now.toISOString(),
      sources,
      overall_stale: fresh.overall_stale,
      summary: summarizeFreshness(fresh),
      freshness: { epg_age_min: fresh.sources.epg.age_minutes, streaming_age_min: fresh.sources.streaming.age_minutes, stale: fresh.overall_stale },
    },
    _quality: {
      items_returned: Object.keys(sources).length,
      candidates_evaluated: Object.keys(sources).length,
      avg_score: 0,
      max_score: 0,
      unique_channels: 0,
      cross_source_used: false,
      fallback_used: false,
      freshness_stale: fresh.overall_stale,
    },
  };
}

export const checkFreshnessTool = {
  name: 'tv_check_freshness',
  config: {
    title: 'Check data freshness',
    description:
      'Reports the last-updated time of each underlying data source (EPG normalized, EPG homepage, streaming catalog), the age in minutes, the expected next refresh, and whether any source is stale (older than 1.5× the expected refresh interval).',
    inputSchema: CheckFreshnessInput,
    outputSchema: CheckFreshnessOutput,
  },
};
