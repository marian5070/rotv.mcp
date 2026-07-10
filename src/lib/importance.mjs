// Event-importance detector. The EPG carries no structured genre or event
// metadata (program.category is "General" everywhere, descriptions are often
// empty), so the ONLY importance signal is text in title/description — e.g.
// "Fotbal World Cup" on Antena 1 or "Spania - Belgia" on a sport channel.
// Every returned reason quotes the text that matched: nothing is invented.
import { normalize } from './text.mjs';
import { programDurationMin } from './time.mjs';

// Major competitions (tier 1 when the broadcast is the event itself).
const MAJOR_RE =
  /\b(world cup|cupa mondiala|campionat(ul)? mondial|fifa|euro 20\d\d|campionat(ul)? european|uefa euro|liga campionilor|champions league|europa league|jocuri(le)? olimpice|olympic|finala|grand slam|roland garros|wimbledon|us open|australian open)\b/;

// Description-only variant: named competitions only — no bare stage words.
const MAJOR_DESC_RE =
  /\b(world cup|cupa mondiala|campionat(ul)? mondial|fifa|euro 20\d\d|campionat(ul)? european|uefa euro|liga campionilor|champions league|europa league|jocuri(le)? olimpice|olympic|grand slam|roland garros|wimbledon|us open|australian open)\b/;

// Knockout / decisive stages.
const KNOCKOUT_RE = /\b(optimi(le)?|sferturi(le)?|semifinala?|semifinale(le)?|finala mica|marea finala|baraj)\b/;

// Romania playing (national team or Romanian clubs) — always notable here.
const ROMANIA_RE =
  /\b(romania|romaniei|nationala|tricolorii|fcsb|cfr cluj|universitatea cluj|u cluj|universitatea craiova|rapid bucuresti|dinamo bucuresti|otelul|farul constanta)\b/;

// Recap / studio / magazine / practice shows about a competition are NOT the event.
const NOT_THE_EVENT_RE =
  /\b(rezumat(e|ul)?|magazin|studio|avancronica|retrospectiva|stiri(le)? sport|jurnal|antrenament(e|ul)?|calificari(le)?|galeria|gazda jocurilor)\b/;

// Country names as they appear in Romanian EPG listings (folded, lowercase).
const COUNTRIES = [
  'romania', 'spania', 'belgia', 'franta', 'germania', 'italia', 'anglia',
  'portugalia', 'olanda', 'tarile de jos', 'argentina', 'brazilia', 'croatia',
  'elvetia', 'polonia', 'ungaria', 'serbia', 'turcia', 'grecia', 'bulgaria',
  'ucraina', 'austria', 'cehia', 'slovacia', 'slovenia', 'danemarca', 'suedia',
  'norvegia', 'scotia', 'irlanda', 'tara galilor', 'mexic', 'sua',
  'statele unite', 'japonia', 'coreea de sud', 'maroc', 'senegal', 'nigeria',
  'egipt', 'ghana', 'camerun', 'algeria', 'tunisia', 'australia', 'canada',
  'columbia', 'uruguay', 'chile', 'ecuador', 'peru', 'paraguay', 'venezuela',
];
const COUNTRY_ALT = COUNTRIES.join('|');
// "Spania - Belgia", "Spania – Belgia", "Spania vs Belgia"
const COUNTRY_PAIR_RE = new RegExp(`\\b(${COUNTRY_ALT})\\s*(?:-|–|—|vs\\.?|v\\.)\\s*(${COUNTRY_ALT})\\b`);

const cap = (v) => Math.min(1, Math.round(v * 100) / 100);

/**
 * Assess how important a program is as a broadcast EVENT.
 * @param {{title?: string, description?: string, start?: string, stop?: string}} program
 * @param {{category?: string}} [channel]
 * @returns {{score: number, tier: 0|1|2, reasons: string[]}}
 *   tier 1 = major event (World Cup / Euro / CL / final...), tier 2 = notable,
 *   tier 0 = no importance signal. reasons quote the matched text.
 */
export function assessImportance(program, channel = {}) {
  const title = program?.title ?? '';
  const description = program?.description ?? '';
  const titleN = normalize(title);
  const allN = normalize(`${title} ${description}`);

  let score = 0;
  const reasons = [];

  const majorInTitle = titleN.match(MAJOR_RE);
  // In descriptions, generic words like "finala" are false-positive magnets
  // (cooking shows have "marea finala" too) — the description-only path
  // requires a NAMED competition, not just a stage word.
  const majorInDesc = allN.match(MAJOR_DESC_RE);
  if (majorInTitle) {
    score = 0.9;
    reasons.push(`major competition in title: "${majorInTitle[0]}"`);
  } else if (majorInDesc) {
    score = 0.55;
    reasons.push(`major competition mentioned in description: "${majorInDesc[0]}"`);
  }

  const pair = allN.match(COUNTRY_PAIR_RE);
  if (pair) {
    score = Math.max(score, 0.65);
    if (majorInTitle || majorInDesc) score = cap(score + 0.1);
    reasons.push(`national teams match: "${pair[0]}"`);
  }

  const knockout = allN.match(KNOCKOUT_RE);
  if (knockout && score > 0) {
    score = cap(score + 0.1);
    reasons.push(`knockout stage: "${knockout[0]}"`);
  }

  const romania = allN.match(ROMANIA_RE);
  if (romania && score > 0) {
    score = cap(score + 0.2);
    reasons.push(`Romania involved: "${romania[0]}"`);
  }

  // A major event carried by a mainstream national channel (Antena 1, PRO TV…)
  // is marquee programming — niche reruns on sport channels are not.
  if (score >= 0.8 && channel?.category === 'Generaliste') {
    score = cap(score + 0.05);
    reasons.push('airs on a mainstream national channel');
  }

  // Demotions — honest guards against flagging shows ABOUT the event.
  const notEvent = titleN.match(NOT_THE_EVENT_RE);
  if (notEvent && score > 0.45) {
    score = 0.45;
    reasons.push(`recap/studio show, not the event itself: "${notEvent[0]}"`);
  }
  if (score >= 0.8 && program?.start && program?.stop) {
    const dur = programDurationMin(program);
    if (dur > 0 && dur < 60) {
      score = 0.5;
      reasons.push(`only ${dur} min — too short to be the live event`);
    }
  }

  const tier = score >= 0.8 ? 1 : score >= 0.55 ? 2 : 0;
  return { score: cap(score), tier, reasons };
}
