// Scorerul comun al uneltelor „de mood": tv_recommend_by_mood,
// tv_compare_options, tv_explain_recommendation, tv_plan_evening,
// tv_find_for_couple. Până la 1 oct 2026 formula era copiată în fiecare
// unealtă și copiile au divergat (compare dădea 7,5 și explain 6,5 pentru
// același program). O componentă se calculează ACUM într-un singur loc; fiecare
// unealtă alege doar CE componente însumează (profilul ei).
import { normalize } from './text.mjs';
import { moodFit } from './moods.mjs';

export const CHANNEL_SCORE = Object.freeze({
  'Filme & Seriale': 3,
  'Documentare': 3,
  'Generaliste': 1,
  'Copii': 1,
  'Sport': 0.5,
  'Muzică': 0.25,
  'Altele': 0,
  'Știri': -10,
  'General': 0,
});

export const PROXIMITY_BONUS = 2;
export const DURATION_BONUS = 0.5;
export const PREFER_BONUS = 1;
export const XREF_BONUS = 0.5;

export function channelScore(category) {
  return CHANNEL_SCORE[category] ?? 0;
}

// Minute până la start față de `now` și bonusul de proximitate (-5…+60 min).
export function timeProximity(startUtc, now = new Date()) {
  const deltaMin = (new Date(startUtc).getTime() - now.getTime()) / 60_000;
  const inBand = deltaMin >= -5 && deltaMin <= 60;
  return { value: inBand ? PROXIMITY_BONUS : 0, deltaMin, inBand };
}

export function durationMatch(durationMin) {
  return durationMin >= 45 && durationMin <= 180 ? DURATION_BONUS : 0;
}

// `preferLabels` = etichete deja rezolvate prin resolvePreferLabel (rank.mjs).
export function preferBoost(category, preferLabels) {
  return preferLabels?.length && preferLabels.includes(normalize(category)) ? PREFER_BONUS : 0;
}

/**
 * Toate componentele pentru un program „shaped". Nu însumează nimic.
 * @returns {{channel_cat:number, mood_fit:number, moodParts:string[],
 *   time_proximity:number, deltaMin:number, inProximity:boolean,
 *   duration_match:number, prefer_boost:number, xref_boost:number}}
 */
export function scoreComponents(item, { genres = [], mood, preferLabels = [], now = new Date(), xref = null } = {}) {
  const mf = moodFit(item, genres, mood);
  const prox = timeProximity(item.program.start_utc, now);
  return {
    channel_cat: channelScore(item.channel_category),
    mood_fit: mf.score,
    moodParts: mf.parts,
    time_proximity: prox.value,
    deltaMin: prox.deltaMin,
    inProximity: prox.inBand,
    duration_match: durationMatch(item.program.duration_min),
    prefer_boost: preferBoost(item.channel_category, preferLabels),
    xref_boost: xref ? XREF_BONUS : 0,
  };
}

// Profilurile: ce componente însumează fiecare unealtă.
export const PROFILE = Object.freeze({
  full: ['channel_cat', 'mood_fit', 'time_proximity', 'duration_match', 'prefer_boost', 'xref_boost'], // compare, explain, by-mood
  plan: ['channel_cat', 'mood_fit', 'prefer_boost'],                                                    // plan_evening, find_for_couple
  base: ['channel_cat', 'mood_fit'],                                                                    // alternativele din explain
});

export function sumComponents(components, keys) {
  let total = 0;
  for (const k of keys) total += components[k] ?? 0;
  return total;
}
