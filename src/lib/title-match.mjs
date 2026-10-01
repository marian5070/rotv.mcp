// Rezolvarea unui titlu cerut de utilizator, comună pentru tv_compare_options,
// tv_get_title_details și tv_explain_recommendation.
//
// Până la 1 oct 2026 fiecare unealtă folosea matchesQuery (subșir) și lua
// prima potrivire: „Amurg" nimerea „Saga Amurg: Zori de Zi" doar pentru că
// începea mai devreme, iar „Începutul" punea „The King's Man: Începutul"
// înaintea filmului cu exact acest titlu. Ordinea e acum explicită.
import { normalize, matchesQuery } from './text.mjs';

export const MATCH_LABELS = ['exact', 'exact-original', 'prefix', 'partial'];

/**
 * @returns {number|null} 0 exact · 1 exact pe titlul original · 2 prefix la
 *   limită de cuvânt · 3 parțial (toate cuvintele cerute apar) · null fără potrivire
 */
export function titleMatchRank(candidateTitle, query, originalTitle = null) {
  const q = normalize(query || '');
  if (!q) return null;
  const t = normalize(candidateTitle || '');
  const o = normalize(originalTitle || '');
  if (t && t === q) return 0;
  if (o && o === q) return 1;
  if (t.startsWith(q) && !/[a-z0-9]/.test(t.charAt(q.length))) return 2;
  if (matchesQuery(candidateTitle || '', query) || (originalTitle && matchesQuery(originalTitle, query))) return 3;
  return null;
}

export function matchLabel(rank) {
  return rank === null || rank === undefined ? null : MATCH_LABELS[rank];
}

// O difuzare „în curs, dar aproape pierdută": a început și s-a dus mai mult de
// max(10 min, 25% din durată). Nu e „următoarea difuzare" a nimănui.
export function isMostlyMissed(program, nowMs) {
  const s = new Date(program.start).getTime();
  const e = new Date(program.stop).getTime();
  if (s >= nowMs) return false;
  const durMin = Math.max(1, (e - s) / 60_000);
  return (nowMs - s) / 60_000 > Math.max(10, 0.25 * durMin);
}
