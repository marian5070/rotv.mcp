// Stare „live / reluare / necunoscut" pentru un program din EPG.
//
// EPG-ul nu are metadate structurate de transmisie (în flux nu există
// <live/> sau <previously-shown/>), deci starea se deduce DOAR din semnale
// verificabile și se citează dovada. Când niciun semnal nu se aplică, starea e
// 'unknown' — nu se presupune „live" doar pentru că programul e sport.
import { normalize } from './text.mjs';
import { localFromUtc } from './time.mjs';

const REPLAY_TITLE_RE = /\b(reluare|reluarea|redifuzare|replay|inregistrare)\b|\(r\)/;
const LIVE_TITLE_RE = /\blive\b|\bin direct\b|\bdirect\b/;
const LIVE_DESC_RE = /\btransmisiune (in )?direct[a]?\b|\bin direct\b/;
const SEASON_RE = /\b20\d\d\s?[/-]\s?(20)?\d\d\b/;        // „2025/26", „2025-2026": sezon, nu dată
const FULL_DATE_RE = /\b(\d{1,2})[./](\d{1,2})[./]((?:19|20)\d\d)\b/;
const YEAR_RE = /\b((?:19|20)\d\d)\b/g;

// Titlu suficient de specific ca două difuzări să fie același eveniment:
// lung și cu structură („Motocros : Campionatul Mondial - Olanda - MX2").
function isSpecificTitle(titleN) {
  return titleN.length >= 20 && /[:\-–]/.test(titleN);
}

const REPEAT_GAP_MS = 30 * 60_000;

const indexCache = new WeakMap();
// normTitle → cea mai timpurie difuzare din EPG-ul încărcat (orice canal).
export function firstAiringIndex(source) {
  let idx = indexCache.get(source);
  if (idx) return idx;
  idx = new Map();
  for (const ch of source.channels || []) {
    for (const p of ch.programs || []) {
      const key = normalize(p.title || '');
      if (!key) continue;
      const startMs = new Date(p.start).getTime();
      const prev = idx.get(key);
      if (!prev || startMs < prev.startMs) idx.set(key, { startMs, stopMs: new Date(p.stop).getTime(), start: p.start, channel: ch.displayName });
    }
  }
  indexCache.set(source, idx);
  return idx;
}

/**
 * @param {{title?: string, description?: string, start: string}} program
 * @param {Map} [index] rezultatul firstAiringIndex(), pentru semnalul „a mai fost difuzat"
 * @returns {{status: 'live'|'replay'|'unknown', evidence?: string}}
 */
export function liveStatus(program, index = null) {
  const titleN = normalize(program?.title || '');
  const descN = normalize(program?.description || '');
  const startMs = new Date(program.start).getTime();

  const replayWord = titleN.match(REPLAY_TITLE_RE);
  if (replayWord) return { status: 'replay', evidence: `titlul spune „${replayWord[0]}"` };

  if (!SEASON_RE.test(titleN)) {
    const full = titleN.match(FULL_DATE_RE);
    if (full) {
      const eventMs = Date.UTC(Number(full[3]), Number(full[2]) - 1, Number(full[1]));
      if (startMs - eventMs > 36 * 3600_000) return { status: 'replay', evidence: `titlul poartă data evenimentului: ${full[0]}` };
    } else {
      const years = [...titleN.matchAll(YEAR_RE)].map((m) => Number(m[1]));
      if (years.length && Math.max(...years) < new Date(startMs).getUTCFullYear()) {
        return { status: 'replay', evidence: `titlul poartă anul evenimentului: ${Math.max(...years)}` };
      }
    }
  }

  if (LIVE_TITLE_RE.test(titleN)) return { status: 'live', evidence: 'titlul spune „live"/„direct"' };
  const liveDesc = descN.match(LIVE_DESC_RE);
  if (liveDesc) return { status: 'live', evidence: `descrierea spune „${liveDesc[0]}"` };

  const first = index?.get(titleN);
  // Difuzarea anterioară trebuie să se fi ÎNCHEIAT cu cel puțin 30 de minute
  // înainte: EPG-ul listează adesea reprizele unui meci ca intrări consecutive
  // cu același titlu, iar aceea e o continuare, nu o reluare.
  if (first && isSpecificTitle(titleN) && startMs - first.stopMs >= REPEAT_GAP_MS) {
    return { status: 'replay', evidence: `același titlu a mai fost difuzat: ${first.channel}, ${localFromUtc(new Date(first.start)).slice(0, 16)}` };
  }

  return { status: 'unknown' };
}
