import { normalize } from './text.mjs';

export function dedupKey(c) {
  if (c.source === 'streaming') {
    const base = normalize(c.original_title || c.title || '');
    return `stream|${base}|${c.year ?? ''}`;
  }
  return `tv|${normalize(c.shaped?.program?.title || '')}`;
}

function airingLabel(c) {
  if (c.source === 'streaming') {
    return `${c.provider_name} (${c.kind === 'movie' ? 'film' : 'serial'})`;
  }
  const start = (c.shaped?.program?.start_local || '').slice(11, 16);
  return `${c.shaped?.channel_name || '?'} la ${start}`;
}

export function dedupCandidates(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const k = dedupKey(c);
    if (!k || k.endsWith('|')) {
      groups.set(`__solo_${groups.size}`, [c]);
      continue;
    }
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }

  const winners = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      group[0].dup_count = 1;
      group[0].dup_other_airings = [];
      winners.push(group[0]);
      continue;
    }
    group.sort((a, b) => {
      const compDelta = (b._composite ?? 0) - (a._composite ?? 0);
      if (compDelta !== 0) return compDelta;
      if (a.source === 'tv' && b.source === 'tv') {
        return new Date(a.shaped.program.start_utc).getTime()
             - new Date(b.shaped.program.start_utc).getTime();
      }
      return 0;
    });
    const winner = group[0];
    winner.dup_count = group.length;
    winner.dup_other_airings = group.slice(1).map(airingLabel).slice(0, 8);
    winners.push(winner);
  }
  return winners;
}
