// Scorerul comun al uneltelor „de mood": tv_recommend_by_mood,
// tv_compare_options, tv_explain_recommendation, tv_plan_evening,
// tv_find_for_couple. Până la 1 oct 2026 formula era copiată în fiecare
// unealtă și copiile au divergat (compare dădea 7,5 și explain 6,5 pentru
// același program). O componentă se calculează ACUM într-un singur loc; fiecare
// unealtă alege doar CE componente însumează (profilul ei).
import { normalize } from './text.mjs';
import { moodFit } from './moods.mjs';
import { effectiveWindowStart, isEveningWindow } from './time.mjs';

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
export const LATE_START_MAX_PENALTY = 2;

export function channelScore(category) {
  return CHANNEL_SCORE[category] ?? 0;
}

// Momentul față de care se măsoară proximitatea: începutul efectiv al
// ferestrei pentru o fereastră de seară (cerută la 14:00 pentru 20:00–24:00,
// „aproape" înseamnă aproape de 20:00, nu de 14:00); altfel ceasul.
export function proximityAnchor(window, now = new Date()) {
  return window && isEveningWindow(window, now) ? new Date(effectiveWindowStart(window, now)) : now;
}

// Minute până la start față de ancoră și bonusul de proximitate (-5…+60 min).
export function timeProximity(startUtc, now = new Date(), window = null) {
  const anchor = proximityAnchor(window, now);
  const anchored = anchor !== now;
  // Față de ceas, „aproape" = următoarea oră. Față de o fereastră viitoare,
  // „aproape" = prima ei jumătate (cel puțin o oră): într-o seară 20:00–24:00,
  // filmul de la 21:30 e la fel de „la început" ca emisiunea de la 20:00, iar
  // de la jumătate încolo preia penalizarea de start târziu.
  const bandMax = anchored ? Math.max(60, (window.to.getTime() - anchor.getTime()) / 2 / 60_000) : 60;
  const deltaMin = (new Date(startUtc).getTime() - anchor.getTime()) / 60_000;
  const inBand = deltaMin >= -5 && deltaMin <= bandMax;
  return { value: inBand ? PROXIMITY_BONUS : 0, deltaMin, inBand, anchored, bandMax };
}

// Penalizare pentru start târziu într-o fereastră de seară: 0 până la
// jumătatea ferestrei rămase, apoi liniar până la -2 la capăt. Un program de
// la 23:50 nu mai poate fi primul pentru o seară cerută de la 20:00 doar
// pentru că are același scor de canal.
export function lateStart(startUtc, now = new Date(), window = null) {
  if (!window || !isEveningWindow(window, now)) return 0;
  const wf = effectiveWindowStart(window, now);
  const wt = window.to.getTime();
  const mid = wf + (wt - wf) / 2;
  const s = new Date(startUtc).getTime();
  if (s <= mid) return 0;
  const frac = Math.min(1, (s - mid) / (wt - mid));
  const penalty = Math.round(LATE_START_MAX_PENALTY * frac * 100) / 100;
  return penalty ? -penalty : 0;
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
 * `late_start` (≤ 0) și ancorarea proximității cer `window`; fără el sunt 0 / ceas.
 * @returns {{channel_cat:number, mood_fit:number, moodParts:string[],
 *   time_proximity:number, deltaMin:number, inProximity:boolean,
 *   duration_match:number, prefer_boost:number, xref_boost:number}}
 */
export function scoreComponents(item, { genres = [], mood, preferLabels = [], now = new Date(), xref = null, window = null } = {}) {
  const mf = moodFit(item, genres, mood);
  const prox = timeProximity(item.program.start_utc, now, window);
  return {
    channel_cat: channelScore(item.channel_category),
    mood_fit: mf.score,
    moodParts: mf.parts,
    time_proximity: prox.value,
    deltaMin: prox.deltaMin,
    inProximity: prox.inBand,
    proximityAnchored: prox.anchored,
    proximityBandMax: prox.bandMax,
    late_start: lateStart(item.program.start_utc, now, window),
    duration_match: durationMatch(item.program.duration_min),
    prefer_boost: preferBoost(item.channel_category, preferLabels),
    xref_boost: xref ? XREF_BONUS : 0,
  };
}

// Un titlu care există DOAR în catalogul de streaming, pus pe aceeași scară cu
// un program TV (la fel ca în tv_concierge): categorie „Filme & Seriale",
// genurile din catalog (același vocabular ca extractorul), durata = runtime,
// disponibil oricând = „începe acum". Până la 1 oct 2026 tv_compare_options îi
// dădea 1 + rating/10 (≈1,8), pe o scară pe care un program TV lua 5–8, deci
// un titlu de streaming nu putea câștiga niciodată o comparație.
export function streamingAsItem(xref, now = new Date()) {
  return {
    item: {
      channel_category: 'Filme & Seriale',
      program: {
        title: xref.title || '',
        description: '',
        duration_min: xref.runtime ?? 0, // runtime necunoscut = fără bonus de durată
        start_utc: now.toISOString(),
      },
    },
    genres: (xref.genres || []).map((g) => ({ genre: g, confidence: 1, anchors: ['catalog'] })),
  };
}

// Profilurile: ce componente însumează fiecare unealtă.
export const PROFILE = Object.freeze({
  full: ['channel_cat', 'mood_fit', 'time_proximity', 'late_start', 'duration_match', 'prefer_boost', 'xref_boost'], // compare, explain, by-mood
  plan: ['channel_cat', 'mood_fit', 'prefer_boost'],                                                    // plan_evening
  couple: ['channel_cat', 'mood_fit', 'prefer_boost', 'late_start'],                                    // find_for_couple
  base: ['channel_cat', 'mood_fit'],                                                                    // alternativele din explain
});

export function sumComponents(components, keys) {
  let total = 0;
  for (const k of keys) total += components[k] ?? 0;
  return total;
}
