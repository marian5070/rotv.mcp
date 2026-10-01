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
