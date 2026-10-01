// node --test test/late-start.test.mjs
// Ancora de proximitate și penalizarea de start târziu — doar pentru ferestre
// de seară (≤ 6 h). Ore din 1 oct 2026, Europe/Bucharest = UTC+3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeProximity, lateStart, proximityAnchor, scoreComponents, sumComponents, PROFILE } from '../src/lib/mood-score.mjs';
import { resolveTimeRef, isEveningWindow } from '../src/lib/time.mjs';
import { resolveMood } from '../src/lib/moods.mjs';

const at = (hhmm) => new Date(`2026-10-01T${hhmm}:00.000Z`);
const RANGE = '2026-10-01T17:00:00.000Z/2026-10-01T21:00:00.000Z';      // 20:00–24:00 local

test('asked at 14:00 for tonight: proximity is measured from 20:00, not from 14:00', () => {
  const now = at('11:00'); const w = resolveTimeRef('tonight', now);
  assert.equal(timeProximity('2026-10-01T17:30:00Z', now, w).value, 2);  // 20:30
  assert.equal(timeProximity('2026-10-01T17:30:00Z', now).value, 0);     // fără fereastră: față de ceas
  assert.equal(timeProximity('2026-10-01T11:30:00Z', now, w).value, 0);  // 14:30 nu mai e „aproape"
  assert.equal(timeProximity('2026-10-01T18:30:00Z', now, w).value, 2);  // 21:30: prima jumătate a serii
  assert.equal(timeProximity('2026-10-01T19:30:00Z', now, w).value, 0);  // 22:30: a doua jumătate
  assert.equal(proximityAnchor(w, now).toISOString(), '2026-10-01T17:00:00.000Z');
});

test('window already in progress: the anchor is the clock', () => {
  const now = at('18:30'); const w = resolveTimeRef('tonight', now);     // 21:30
  assert.equal(proximityAnchor(w, now).getTime(), now.getTime());
  assert.equal(timeProximity('2026-10-01T19:00:00Z', now, w).value, 2);  // 22:00
});

test('whole-day windows keep the clock anchor and get no late penalty (midnight regression)', () => {
  const now = at('11:00');
  for (const tf of ['today', 'tomorrow', 'weekend', '2026-10-02', 'now']) {
    const w = resolveTimeRef(tf, now);
    assert.equal(isEveningWindow(w, now), false, tf);
    assert.equal(proximityAnchor(w, now), now, tf);
    assert.equal(lateStart('2026-10-02T20:50:00Z', now, w), 0, tf);
    assert.equal(lateStart('2026-10-01T21:00:00Z', now, w), 0, tf);
  }
});

test('late start: zero until mid-window, then linear down to -2 at the end', () => {
  const now = at('11:00'); const w = resolveTimeRef(RANGE, now);
  assert.equal(lateStart('2026-10-01T17:00:00Z', now, w), 0);            // 20:00
  assert.equal(lateStart('2026-10-01T18:30:00Z', now, w), 0);            // 21:30 (filmul PRO TV)
  assert.equal(lateStart('2026-10-01T19:00:00Z', now, w), 0);            // 22:00 = jumătate
  assert.equal(lateStart('2026-10-01T20:00:00Z', now, w), -1);           // 23:00
  assert.equal(lateStart('2026-10-01T20:50:00Z', now, w), -1.83);        // 23:50
  assert.equal(lateStart('2026-10-01T23:00:00Z', now, w), -2);           // după fereastră: plafon
});

test('asked late: what is about to start is not punished into oblivion', () => {
  const now = at('20:00'); const w = resolveTimeRef('tonight', now);     // 23:00, rămâne o oră
  const s = '2026-10-01T20:30:00Z';                                       // 23:30
  assert.equal(lateStart(s, now, w), 0);
  assert.equal(timeProximity(s, now, w).value, 2);
});

test('a 23:50 start no longer ties with a 20:30 start of the same kind', () => {
  const now = at('11:00'); const w = resolveTimeRef(RANGE, now); const mood = resolveMood('obosit');
  const mk = (start) => ({ channel_category: 'Filme & Seriale', program: { title: 'x', start_utc: start, duration_min: 100 } });
  const early = sumComponents(scoreComponents(mk('2026-10-01T17:30:00Z'), { mood, now, window: w }), PROFILE.full);
  const late = sumComponents(scoreComponents(mk('2026-10-01T20:50:00Z'), { mood, now, window: w }), PROFILE.full);
  assert.ok(early - late >= 3, `early ${early} vs late ${late}`);        // +2 proximitate, -1.83 start târziu
});

test('without a window nothing changes: compare_options stays clock-relative', () => {
  const now = at('17:00'); const mood = resolveMood('obosit');
  const c = scoreComponents({ channel_category: 'Filme & Seriale', program: { title: 'x', start_utc: '2026-10-01T20:50:00Z', duration_min: 100 } }, { mood, now });
  assert.equal(c.late_start, 0); assert.equal(c.proximityAnchored, false);
});

test('a window that is already over is not anchored (asked at 23:00 for primetime 20–23)', () => {
  const now = at('20:00'); const w = resolveTimeRef('primetime', now);
  assert.equal(isEveningWindow(w, now), false);
  assert.equal(proximityAnchor(w, now), now);
  assert.equal(lateStart('2026-10-01T19:55:00Z', now, w), 0);
});
