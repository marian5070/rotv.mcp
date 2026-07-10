import { normalize } from './text.mjs';

const MIN_SUB = 4;
const MIN_JACC = 0.5;

function tokSet(s) {
  return new Set(
    normalize(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

export function matchTitles(progTitle, sItem) {
  const p = normalize(progTitle || '');
  const t = normalize(sItem?.title || '');
  const o = normalize(sItem?.original_title || '');
  if (!p) return { matched: false, confidence: 0, tier: null };

  if (p === t || (o && p === o)) {
    return { matched: true, confidence: 1.0, tier: 'exact' };
  }

  for (const cand of [t, o].filter(Boolean)) {
    if (Math.min(p.length, cand.length) >= MIN_SUB && (p.includes(cand) || cand.includes(p))) {
      const ratio = Math.min(p.length, cand.length) / Math.max(p.length, cand.length);
      return { matched: true, confidence: Math.max(0.6, Math.min(0.85, ratio)), tier: 'substr' };
    }
  }

  const pa = tokSet(progTitle || '');
  for (const cand of [sItem?.title, sItem?.original_title].filter(Boolean)) {
    const cb = tokSet(cand);
    if (pa.size === 0 || cb.size === 0) continue;
    let inter = 0;
    for (const w of pa) if (cb.has(w)) inter++;
    const jacc = inter / (pa.size + cb.size - inter);
    if (jacc >= MIN_JACC) {
      return { matched: true, confidence: 0.5 + 0.4 * jacc, tier: 'jaccard' };
    }
  }

  return { matched: false, confidence: 0, tier: null };
}

export function confidenceLabel(c) {
  if (c >= 0.9) return 'high';
  if (c >= 0.65) return 'medium';
  return 'low';
}

export function findStreamingFor(title, streaming) {
  if (!streaming?.providers || !title) return null;
  let best = null;
  for (const [pid, prov] of Object.entries(streaming.providers)) {
    for (const kind of ['movies', 'tv']) {
      for (const sItem of (prov[kind] || [])) {
        const r = matchTitles(title, sItem);
        if (r.matched && (!best || r.confidence > best.confidence)) {
          best = {
            provider_id: Number(pid),
            provider_name: prov.name,
            kind: kind === 'movies' ? 'movie' : 'tv',
            confidence: r.confidence,
            confidence_label: confidenceLabel(r.confidence),
            tier: r.tier,
            tmdb_id: sItem.id,
            title: sItem.title,
            original_title: sItem.original_title,
            year: sItem.year,
            genres: sItem.genres || [],
            runtime: sItem.runtime ?? null,
            vote_average: sItem.voteAverage ?? sItem.vote_average ?? null,
          };
        }
      }
    }
  }
  return best;
}
