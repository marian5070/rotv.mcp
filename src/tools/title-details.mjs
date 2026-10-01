import { z } from 'zod';
import { getEpgFull, getStreaming } from '../data/store.mjs';
import { shapeProgram } from '../lib/time.mjs';
import { matchesQuery, normalize } from '../lib/text.mjs';
import { titleMatchRank, matchLabel } from '../lib/title-match.mjs';
import { isSameWork } from '../lib/xref.mjs';
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

  const allTvAirings = [];
  for (const ch of epg.channels) {
    for (const p of (ch.programs || [])) {
      const stopMs = new Date(p.stop).getTime();
      if (stopMs < now.getTime()) continue;
      const startMs = new Date(p.start).getTime();
      if (startMs > horizon.getTime()) continue;
      const rank = titleMatchRank(p.title, args.title);
      if (rank === null) continue;
      allTvAirings.push({ ...shapeProgram(ch, p), match: matchLabel(rank), _rank: rank });
    }
  }
  // Întâi titlul exact, apoi cronologic în cadrul aceleiași calități de potrivire.
  allTvAirings.sort((a, b) => (a._rank - b._rank) || (new Date(a.program.start_utc) - new Date(b.program.start_utc)));

  const streamingHits = [];
  if (args.include_streaming) {
    const streaming = getStreaming();
    if (streaming?.providers) {
      for (const [pid, prov] of Object.entries(streaming.providers)) {
        for (const kind of ['movies', 'tv']) {
          for (const item of (prov[kind] || [])) {
            const sRank = titleMatchRank(item.title, args.title, item.original_title);
            if (sRank !== null) {
              streamingHits.push({
                match: matchLabel(sRank),
                _rank: sRank,
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

  streamingHits.sort((a, b) => a._rank - b._rank); // stabil: exact înaintea potrivirilor parțiale

  // Când titlul cerut există EXACT undeva (la TV sau în catalog), difuzările TV
  // care doar îl conțin ca fragment sunt alt program: „Începutul" e filmul de pe
  // HBO Max, nu „90 de zile până la nuntă: Începutul poveștii". Fără nicio
  // potrivire exactă, fragmentele rămân — sunt tot ce avem. Catalogul de
  // streaming rămâne ordonat, nefiltrat (continuările sunt utile acolo).
  const exactSomewhere = allTvAirings.some((a) => a._rank <= 1) || streamingHits.some((h) => h._rank <= 1);
  const tvAirings = exactSomewhere ? allTvAirings.filter((a) => a._rank < 3) : allTvAirings;
  const tvPartialOmitted = allTvAirings.length - tvAirings.length;
  // Același titlu, altă operă: documentarul de o oră „Fight Club" nu e filmul de
  // 139 de minute din catalog. Marcăm difuzarea, nu o ascundem.
  const exactStreaming = streamingHits.filter((h) => h._rank <= 1);
  let differentWork = 0;
  if (exactStreaming.length) {
    for (const a of tvAirings) {
      if (a._rank > 1) continue;
      const same = exactStreaming.some((h) => isSameWork(a.program.duration_min, { kind: h.kind, runtime: h.runtime_min }));
      if (!same) { a.streaming_same_work = false; differentWork++; }
    }
  }
  for (const a of allTvAirings) delete a._rank;
  for (const h of streamingHits) delete h._rank;

  return {
    title_query: args.title,
    asked_at_utc: now.toISOString(),
    upcoming_window_hours: args.upcoming_window_hours,
    tv_airings: tvAirings.slice(0, 20),
    tv_airings_count: tvAirings.length,
    streaming: streamingHits.slice(0, 20),
    streaming_count: streamingHits.length,
    summary: summarize(args.title, tvAirings, streamingHits, tvPartialOmitted, differentWork),
  };
}

function summarize(title, tv, streaming, tvPartialOmitted = 0, differentWork = 0) {
  const parts = [];
  if (tv.length) {
    const channels = [...new Set(tv.slice(0, 5).map((a) => a.channel_name))];
    parts.push(`${tv.length} airing(s) on ${channels.join(', ')}${tv.length > 5 ? '…' : ''}`);
  } else {
    parts.push('no upcoming TV airings');
  }
  if (tvPartialOmitted) {
    parts.push(`${tvPartialOmitted} TV airing(s) that only contain the words in a longer title were left out because the exact title exists`);
  }
  if (streaming.length) {
    const providers = [...new Set(streaming.map((s) => s.provider_name))];
    parts.push(`streaming on ${providers.join(', ')}`);
  } else {
    parts.push('not in streaming catalog');
  }
  if (differentWork) {
    parts.push(`${differentWork} TV airing(s) share the title but are too short to be the film in the catalog (streaming_same_work: false)`);
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
