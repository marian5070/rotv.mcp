import { getStreaming } from '../data/store.mjs';

export function buildStreamingPool({ minRating = 0, maxDurationMin = null } = {}) {
  const streaming = getStreaming();
  if (!streaming?.providers) return [];

  const pool = [];
  for (const [pid, prov] of Object.entries(streaming.providers)) {
    for (const kind of ['movies', 'tv']) {
      for (const sItem of (prov[kind] || [])) {
        const rating = sItem.voteAverage ?? sItem.vote_average ?? null;
        if (rating !== null && rating < minRating) continue;

        const runtime = sItem.runtime ?? null;
        if (maxDurationMin !== null && runtime !== null && runtime > maxDurationMin + 5) continue;

        pool.push({
          source: 'streaming',
          provider_id: Number(pid),
          provider_name: prov.name,
          kind: kind === 'movies' ? 'movie' : 'tv',
          tmdb_id: sItem.id,
          title: sItem.title,
          original_title: sItem.original_title,
          year: sItem.year ?? null,
          genres: sItem.genres || [],
          runtime,
          vote_average: rating,
          description: sItem.overview || sItem.description || '',
        });
      }
    }
  }
  return pool;
}
