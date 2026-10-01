// node --test test/safe-batch-2026-10-01.test.mjs
// Regresii din testul ChatGPT pe cele 14 unelte (1 oct 2026). Predicate pure,
// fără date live: rândurile sunt copiate din epg-normalized.json de atunci.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMusicGridFiller } from '../src/tools/concierge.mjs';
import { compareCandidates, dropReason } from '../src/tools/plan-evening.mjs';
import { queryMatchReason } from '../src/tools/search-program.mjs';
import { resolvePreferLabel } from '../src/lib/rank.mjs';
import { isNewsProgram } from '../src/lib/anti-noise.mjs';
import { normalize } from '../src/lib/text.mjs';

const MOOZ = { title: 'World Of Mooz', category: 'Muzică', description: '', start: '2026-10-01T17:00:00.000Z', stop: '2026-10-01T20:59:59.000Z' };

test('concierge: a 240-min music-video loop aligned on the hour is grid filler', () => {
  assert.equal(isMusicGridFiller(MOOZ), true);
});

test('concierge: real long programmes are NOT grid filler', () => {
  assert.equal(isMusicGridFiller({ ...MOOZ, description: 'Concert aniversar cu invitați.' }), false, 'has a description');
  assert.equal(isMusicGridFiller({ ...MOOZ, stop: '2026-10-01T18:59:59.000Z' }), false, '120 min music');
  assert.equal(isMusicGridFiller({ title: 'Haendel: Giulio Cesare', category: 'Muzică', description: '', start: '2026-10-01T10:30:00.000Z', stop: '2026-10-01T14:00:00.000Z' }), false, 'opera, 210 min at :30');
  assert.equal(isMusicGridFiller({ ...MOOZ, category: 'Concert' }), false, 'Concert category');
  assert.equal(isMusicGridFiller({ ...MOOZ, category: 'Sport' }), false, 'live sport');
  assert.equal(isMusicGridFiller({ title: 'Casino', category: 'Film', description: '', start: '2026-10-01T17:00:00.000Z', stop: '2026-10-01T20:55:00.000Z' }), false, 'film');
});

const cand = (dur, score) => ({ _score: score, program: { duration_min: dur } });

test('plan_evening: higher score always wins', () => {
  assert.ok(compareCandidates(cand(30, 5), cand(120, 3.5), 240) < 0);
});

test('plan_evening: on a score tie the duration CLOSEST to the remaining budget wins', () => {
  const sorted = [cand(30, 3.5), cand(110, 3.5), cand(60, 3.5)].sort((a, b) => compareCandidates(a, b, 240));
  assert.deepEqual(sorted.map((c) => c.program.duration_min), [110, 60, 30]);
});

test('compare_options: documented prefer words map to channel-category labels', () => {
  assert.equal(resolvePreferLabel('filme'), normalize('Filme & Seriale'));
  assert.equal(resolvePreferLabel('Seriale'), normalize('Filme & Seriale'));
  assert.equal(resolvePreferLabel('documentare'), normalize('Documentare'));
  assert.equal(resolvePreferLabel('Filme & Seriale'), normalize('Filme & Seriale'), 'exact label still works');
});

test('compare_options: unknown words pass through and never match a label (no fuzzy boost)', () => {
  const labels = ['Generaliste', 'Știri', 'Altele', 'Filme & Seriale', 'Sport', 'Copii', 'Documentare', 'Muzică'].map(normalize);
  for (const w of ['thriller', 'comedie', 'film', 'constructor', 'toString']) {
    assert.ok(!labels.includes(resolvePreferLabel(w)), w);
  }
});

test('prime_time: programme-level news label is detected with either diacritic form', () => {
  assert.equal(isNewsProgram({ title: 'Ştirile Pro Tv', category: 'Ştiri' }), true);
  assert.equal(isNewsProgram({ title: 'Observator', category: 'Știri' }), true);
  assert.equal(isNewsProgram({ title: 'Pasager în trenul terorii', category: 'Film' }), false);
  assert.equal(isNewsProgram({ title: 'Last Week Tonight', category: 'Divertisment' }), false);
  assert.equal(isNewsProgram({ title: 'x' }), false);
});

test('search: match_reason names the field that actually matched', () => {
  assert.equal(queryMatchReason({ title: 'Film italian vintage', description: '' }, 'film'), 'title contains "film"');
  assert.equal(queryMatchReason({ title: 'Samson', description: 'Filmul spune povestea lui Samson.' }, 'film'), 'description contains "film"');
});

test('plan_evening: a candidate overlapping the chosen segment is not described as "before the window"', () => {
  const plan = [{ title: 'Inima de mama', stop_utc: '2026-10-01T20:00:00.000Z' }];
  const args = { duration_min: 180, max_gap_min: 30 };
  const occident = { _score: 7.5, program: { title: 'Occident', start_utc: '2026-10-01T17:30:00.000Z', duration_min: 105 } };
  assert.equal(dropReason(occident, plan, args), 'se suprapune cu un segment deja ales în plan');
});

// ── Prior de conținut pentru TV (concierge + plan_evening) ───────────────────
import { tvContentPrior, ratingSignal, capGeometryForUndescribed } from '../src/lib/confidence.mjs';
import { isNonContent } from '../src/lib/anti-noise.mjs';

test('non-content is never a candidate', () => {
  assert.equal(isNonContent({ title: 'Închiderea programului', category: 'Închiderea Programului' }), true);
  assert.equal(isNonContent({ title: 'Fără Emisie', category: 'Sport' }), true);
  assert.equal(isNonContent({ title: 'Teleshoppingsendung', category: 'Diverse' }), true);
  assert.equal(isNonContent({ title: 'Bijuterii TV - teleshopping live', category: 'Diverse' }), true);
  assert.equal(isNonContent({ title: 'Inima de mama', category: 'Serial' }), false);
  assert.equal(isNonContent({ title: 'Emisie specială', category: 'Ştiri' }), false);
});

const LONG = 'Un sinopsis suficient de lung ca să conteze drept descriere reală.';
test('TV content prior reflects what the EPG says about the programme', () => {
  assert.equal(tvContentPrior({ category: 'Film', description: LONG }).value, 0.6);
  assert.equal(tvContentPrior({ category: 'Documentar', description: LONG }).value, 0.55);
  assert.equal(tvContentPrior({ category: 'Sport', description: '' }).value, 0.5);       // titlul e conținutul
  assert.equal(tvContentPrior({ category: 'Serial', description: '' }).value, 0.45);     // Inima de mama
  assert.equal(tvContentPrior({ category: 'Divertisment', description: '' }).value, 0.3); // Punkt 12
  assert.match(tvContentPrior({ category: 'Diverse', description: '' }).note, /fără rating/);
});

test('a measured rating wins over the prior, only via an exact streaming match', () => {
  const tv = { source: 'tv', shaped: { program: { category: 'Film', description: LONG } } };
  assert.equal(ratingSignal(tv).value, 0.6);
  assert.equal(ratingSignal({ ...tv, _xref: { vote_average: 8.5 } }).value, 0.7);
  assert.equal(ratingSignal({ source: 'streaming', vote_average: 8.5 }).value, 0.7);
});

test('geometry is capped only for undescribed, unimportant TV programmes', () => {
  const axes = (rating, imp = 0) => ({ rating_signal: { value: rating, note: '' }, time_fit: { value: 1, note: 't' }, availability: { value: 1, note: 'a' }, event_importance: { value: imp, note: '' } });
  const tv = { source: 'tv' };
  assert.equal(capGeometryForUndescribed(tv, axes(0.3)).time_fit.value, 0.5);
  assert.equal(capGeometryForUndescribed(tv, axes(0.45)).availability.value, 0.5);
  assert.equal(capGeometryForUndescribed(tv, axes(0.5)).time_fit.value, 1, 'sport / described: untouched');
  assert.equal(capGeometryForUndescribed(tv, axes(0.3, 0.9)).time_fit.value, 1, 'important event: untouched');
  assert.equal(capGeometryForUndescribed({ source: 'streaming' }, axes(0.3)).time_fit.value, 1);
});

// ── Axa de disponibilitate (concierge) ───────────────────────────────────────
import { availabilityAxis } from '../src/lib/confidence.mjs';
import { exactTitleRating } from '../src/lib/xref.mjs';

const tvAt = (start) => ({ source: 'tv', shaped: { program: { start_utc: start } } });
const W = new Date('2026-10-01T17:00:00.000Z');                           // 20:00 local

test('availability: a later start inside the window is a wait, scaled to the window', () => {
  assert.equal(availabilityAxis(tvAt('2026-10-01T17:00:00Z'), W, 240).value, 1);
  assert.equal(availabilityAxis(tvAt('2026-10-01T17:30:00Z'), W, 240).value, 0.75);   // 20:30
  assert.equal(availabilityAxis(tvAt('2026-10-01T18:30:00Z'), W, 240).value, 0.25);   // 21:30, filmul PRO TV
  assert.equal(availabilityAxis(tvAt('2026-10-01T19:00:00Z'), W, 240).value, 0);      // 22:00 = jumătatea ferestrei
  assert.equal(availabilityAxis(tvAt('2026-10-01T17:30:00Z'), W, 60).value, 0);       // fereastră scurtă: 30 min, ca înainte
});

test('availability: a programme already running keeps the strict 30-minute scale', () => {
  assert.equal(availabilityAxis(tvAt('2026-10-01T16:45:00Z'), W, 240).value, 0.5);    // început la 19:45
  assert.equal(availabilityAxis(tvAt('2026-10-01T16:30:00Z'), W, 240).value, 0);      // 19:30: am pierdut jumătate de oră
  assert.equal(availabilityAxis(tvAt('2026-10-01T15:15:00Z'), W, 240).value, 0);      // „La bloc" 18:15
});

test('availability: streaming is always available', () => {
  assert.equal(availabilityAxis({ source: 'streaming' }, W, 240).value, 1);
});

test('exact-title rating index: exact matches only, camelCase or snake_case rating', () => {
  const streaming = { providers: { 8: { name: 'Netflix', movies: [{ title: 'Casino', original_title: 'Casino', voteAverage: 8.0 }], tv: [{ title: 'Dark', vote_average: 8.4 }] } } };
  assert.equal(exactTitleRating('Casino', streaming).vote_average, 8.0);
  assert.equal(exactTitleRating('DARK', streaming).vote_average, 8.4);
  assert.equal(exactTitleRating('Casino Royale', streaming), null);
  assert.equal(exactTitleRating('Casino', null), null);
});

// ── Rutare concierge ↔ plan_evening ─────────────────────────────────────────
import { longWindowPlanHint, conciergeTool } from '../src/tools/concierge.mjs';
import { planEveningTool } from '../src/tools/plan-evening.mjs';

test('concierge says when one pick leaves a long window mostly empty', () => {
  const film = { source: 'tv', shaped: { program: { duration_min: 120 } } };
  assert.match(longWindowPlanHint(film, 240), /120 din 240 min.*tv_plan_evening/);
  assert.equal(longWindowPlanHint(film, 150), null, 'short window: one pick is the answer');
  assert.equal(longWindowPlanHint({ source: 'streaming', runtime: 201 }, 240), null, 'the pick already fills the window');
  assert.match(longWindowPlanHint({ source: 'streaming', runtime: 110 }, 180), /110 din 180/);
});

test('tool descriptions route long windows to plan_evening and single picks to concierge', () => {
  const c = conciergeTool.config.description; const p = planEveningTool.config.description;
  assert.ok(!/over tv_recommend_by_mood, tv_plan_evening/.test(c), 'concierge must not claim precedence over plan_evening');
  assert.ok(!/a plan for a specific window/.test(c));
  assert.match(c, /use tv_plan_evening instead/);
  assert.match(p, /TV only/); assert.match(p, /use tv_concierge/);
});

// ── Filtrul de zgomot folosește și eticheta EPG a programului ────────────────
import { detectNoise } from '../src/lib/anti-noise.mjs';

const tvCand = (title, category, channel_category = 'Generaliste') => ({ source: 'tv', shaped: { channel_category, program: { title, category } } });
const ALL = ['politica', 'reality', 'talkshow', 'stiri'];

test('a talk show is noise even when its title does not say so', () => {
  const r = detectNoise(tvCand('Acces direct', 'Talk show'), ALL);
  assert.equal(r.is_noise, true); assert.equal(r.category, 'talkshow');
  assert.deepEqual(r.anchors, ['program_category=Talk show']);
  assert.equal(detectNoise(tvCand('Telemedika', 'Talk show'), ALL).category, 'talkshow');
});

test('a news bulletin on a generalist channel is noise by its programme label', () => {
  assert.equal(detectNoise(tvCand('Focus', 'Ştiri'), ALL).category, 'stiri');
  assert.equal(detectNoise(tvCand('Bloomberg Open Interest', 'Știri', 'Altele'), ALL).category, 'stiri');
});

test('films, sport and documentaries are untouched, and disabled categories stay off', () => {
  assert.equal(detectNoise(tvCand('Rețeaua de socializare', 'Film', 'Filme & Seriale'), ALL).is_noise, false);
  assert.equal(detectNoise(tvCand('Nations League: Spania-Croatia', 'Sport', 'Sport'), ALL).is_noise, false);
  assert.equal(detectNoise(tvCand('Acces direct', 'Talk show'), ['politica', 'reality']).is_noise, false);
  assert.equal(detectNoise({ source: 'streaming', title: 'The Talk Show Murders' }, ['stiri']).is_noise, false);
});
