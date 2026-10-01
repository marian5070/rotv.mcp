// node --test test/title-match.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleMatchRank, matchLabel, isMostlyMissed } from '../src/lib/title-match.mjs';

test('exact beats prefix beats partial; diacritics and case are folded', () => {
  assert.equal(titleMatchRank('Amurg', 'amurg'), 0);
  assert.equal(titleMatchRank('Începutul', 'inceputul'), 0);
  assert.equal(titleMatchRank('Inception', 'Începutul', 'Inception'), null, 'neither title matches');
  assert.equal(titleMatchRank('Începutul', 'Inception', 'Inception'), 1, 'exact on the original title');
  assert.equal(titleMatchRank('Amurg: Luna nouă', 'Amurg'), 2, 'prefix at a word boundary');
  assert.equal(titleMatchRank('Saga Amurg: Zori de Zi - Partea I', 'Amurg'), 3, 'partial');
  assert.equal(titleMatchRank("The King's Man: Începutul", 'Începutul'), 3);
  assert.equal(titleMatchRank('Amurgul zeilor', 'Amurg'), 3, 'not a word-boundary prefix');
  assert.equal(titleMatchRank('Occident', 'Amurg'), null);
  assert.equal(titleMatchRank('Amurg', ''), null);
  assert.equal(matchLabel(0), 'exact'); assert.equal(matchLabel(3), 'partial'); assert.equal(matchLabel(null), null);
});

test('an airing that is mostly over is not a "next airing"', () => {
  const p = { start: '2026-10-01T12:25:00Z', stop: '2026-10-01T14:54:00Z' };       // 15:25–17:54 local
  assert.equal(isMostlyMissed(p, Date.parse('2026-10-01T14:42:00Z')), true);      // 17:42
  assert.equal(isMostlyMissed(p, Date.parse('2026-10-01T12:30:00Z')), false);     // 5 minute după start
  assert.equal(isMostlyMissed(p, Date.parse('2026-10-01T11:00:00Z')), false);     // încă nu a început
});
