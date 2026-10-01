// node --test test/window-admit.test.mjs
// Ore reale din EPG-ul de 1 oct 2026 (Europe/Bucharest = UTC+3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowAdmits, lateStartBucket, resolveTimeRef } from '../src/lib/time.mjs';

const P = (start, stop) => ({ start, stop });
const at = (hhmm) => new Date(`2026-10-01T${hhmm}:00.000Z`);
const tonight = (now) => resolveTimeRef('tonight', now);                 // 20:00–23:59:59 local = 17:00–20:59:59Z
const range = () => resolveTimeRef('2026-10-01T17:00:00.000Z/2026-10-01T21:00:00.000Z');

test('asked before the window: programmes mostly aired before it are rejected', () => {
  const now = at('12:00'); const w = tonight(now);
  assert.equal(windowAdmits(P('2026-10-01T15:15:00Z', '2026-10-01T17:29:00Z'), w, now), false, 'La bloc 18:15–20:29');
  assert.equal(windowAdmits(P('2026-10-01T16:10:00Z', '2026-10-01T17:05:00Z'), w, now), false, 'FBI 19:10–20:05');
  assert.equal(windowAdmits(P('2026-10-01T17:05:00Z', '2026-10-01T18:00:00Z'), w, now), true, 'FBI 20:05–21:00');
  assert.equal(windowAdmits(P('2026-10-01T16:55:00Z', '2026-10-01T18:55:00Z'), w, now), true, 'started 5 min early');
});

test('asked late: already-ended programmes are rejected, imminent ones kept', () => {
  const now = at('20:35'); const w = tonight(now);                        // 23:35 local
  assert.equal(windowAdmits(P('2026-10-01T18:00:00Z', '2026-10-01T20:00:00Z'), w, now), false, 'ended at 23:00');
  assert.equal(windowAdmits(P('2026-10-01T20:30:00Z', '2026-10-01T22:30:00Z'), w, now), true, 'Ultimul număr 23:30, 5 min in');
  assert.equal(windowAdmits(P('2026-10-01T20:50:00Z', '2026-10-01T22:20:00Z'), w, now), true, '23:50 start — tonight end is not a constraint');
});

test('explicit range: the end IS a constraint', () => {
  const now = at('12:00'); const w = range();
  assert.equal(windowAdmits(P('2026-10-01T20:50:00Z', '2026-10-01T22:20:00Z'), w, now), false, '23:50 start, 10 of 90 min inside');
  assert.equal(windowAdmits(P('2026-10-01T18:30:00Z', '2026-10-01T20:45:00Z'), w, now), true, 'PRO TV film 21:30–23:45');
  assert.equal(windowAdmits(P('2026-10-01T17:00:00Z', '2026-10-01T22:00:00Z'), w, now), true, '300-min programme covering the window');
});

test("'now' windows are unchanged: something on air for an hour is still on now", () => {
  const now = at('18:00'); const w = resolveTimeRef('now', now);
  assert.equal(windowAdmits(P('2026-10-01T17:00:00Z', '2026-10-01T19:00:00Z'), w, now), true);
});

test('whole-day windows: tomorrow evening is not "late"', () => {
  const now = at('11:00'); const w = resolveTimeRef('tomorrow', now);
  assert.equal(lateStartBucket('2026-10-02T18:45:00Z', w, now), 0);
});

test('evening windows: second-half starts sort after first-half starts on a tie', () => {
  const now = at('12:00'); const w = tonight(now);
  assert.equal(lateStartBucket('2026-10-01T17:30:00Z', w, now), 0);      // 20:30
  assert.equal(lateStartBucket('2026-10-01T20:50:00Z', w, now), 1);      // 23:50
  const late = at('20:00'); const w2 = tonight(late);                    // asked 23:00
  assert.equal(lateStartBucket('2026-10-01T20:25:00Z', w2, late), 0);    // 23:25, first half of what is left
});
