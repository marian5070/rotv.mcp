import { z } from 'zod';
import { getEpgFull, getStreaming } from '../data/store.mjs';
import { shapeProgram } from '../lib/time.mjs';
import { matchesQuery, normalize } from '../lib/text.mjs';
import { ShapedProgram, Loose } from '../lib/output-shapes.mjs';

export const TitleDetailsOutput = {
  title_query: z.string(),
  asked_at_utc: z.string(),
  upcoming_window_hours: z.number(),
  tv_airings: z.array(ShapedProgram),
  tv_airings_count: z.number(),
  streaming: z.array(Loose),
  streaming_count: z.number(),
  summary: z.string(),
};

export const TitleDetailsInput = {
  title: z.string().min(2).max(200).describe('Title to look up (case/diacritic-insensitive)'),
  include_streaming: z.boolean().default(true).describe(
    'Also look up the title in Netflix / HBO Max / Prime Video / Disney+ / Apple TV+ catalog for Romania'
  ),
  upcoming_window_hours: z.number().int().min(1).max(72).default(48).describe(
    'How far ahead (hours) to scan TV airings'
  ),
};

export async function handleTitleDetails(args) {
  const epg = getEpgFull();
  if (!epg) throw new Error('EPG data not loaded');

  const now = new Date();
  const horizon = new Date(now.getTime() + args.upcoming_window_hours * 3600_000);

  const tvAirings = [];
  for (const ch of epg.channels) {
    for (const p of (ch.programs || [])) {
      const stopMs = new Date(p.stop).getTime();
      if (stopMs < now.getTime()) continue;
      const startMs = new Date(p.start).getTime();
      if (startMs > horizon.getTime()) continue;
      if (!matchesQuery(p.title, args.title)) continue;
      tvAirings.push(shapeProgram(ch, p));
    }
  }
  tvAirings.sort((a, b) => new Date(a.program.start_utc) - new Date(b.program.start_utc));

  const streamingHits = [];
  if (args.include_streaming) {
    const streaming = getStreaming();
    if (streaming?.providers) {
      for (const [pid, prov] of Object.entries(streaming.providers)) {
        for (const kind of ['movies', 'tv']) {
          for (const item of (prov[kind] || [])) {
            if (matchesQuery(item.title, args.title) || matchesQuery(item.original_title, args.title)) {
              streamingHits.push({
                provider_id: Number(pid),
                provider_name: prov.name,
                kind: kind === 'movies' ? 'movie' : 'tv',
                tmdb_id: item.id,
                title: item.title,
                original_title: item.original_title,
                year: item.year,
                runtime_min: item.runtime ?? null,
                seasons: item.numberOfSeasons ?? null,
                episodes: item.numberOfEpisodes ?? null,
                genres: item.genres || [],
                vote_average: item.voteAverage ?? item.vote_average ?? null,
                overview: item.overview || '',
                director: item.director || null,
              });
            }
          }
        }
      }
    }
  }

  return {
    title_query: args.title,
    asked_at_utc: now.toISOString(),
    upcoming_window_hours: args.upcoming_window_hours,
    tv_airings: tvAirings.slice(0, 20),
    tv_airings_count: tvAirings.length,
    streaming: streamingHits.slice(0, 20),
    streaming_count: streamingHits.length,
    summary: summarize(args.title, tvAirings, streamingHits),
  };
}

function summarize(title, tv, streaming) {
  const parts = [];
  if (tv.length) {
    const channels = [...new Set(tv.slice(0, 5).map((a) => a.channel_name))];
    parts.push(`${tv.length} airing(s) on ${channels.join(', ')}${tv.length > 5 ? '…' : ''}`);
  } else {
    parts.push('no upcoming TV airings');
  }
  if (streaming.length) {
    const providers = [...new Set(streaming.map((s) => s.provider_name))];
    parts.push(`streaming on ${providers.join(', ')}`);
  } else {
    parts.push('not in streaming catalog');
  }
  return `"${title}": ${parts.join('; ')}.`;
}

export const titleDetailsTool = {
  name: 'tv_get_title_details',
  config: {
    title: 'Lookup a title across TV and streaming',
    description:
      'Looks up a title across upcoming Romanian TV airings (next N hours, default 48) and the live streaming catalog for Romania (Netflix, HBO Max, Prime Video, Disney+, Apple TV+). Use for queries like "is Avatar on Netflix?", "when does Game of Thrones air next?".',
    inputSchema: TitleDetailsInput,
    outputSchema: TitleDetailsOutput,
  },
};
