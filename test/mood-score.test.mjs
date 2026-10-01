// node --test test/mood-score.test.mjs
// Scorerul comun: o componentă are O singură definiție; uneltele diferă doar
// prin profil (ce componente însumează).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  scoreComponents, sumComponents, PROFILE, CHANNEL_SCORE,
  timeProximity, durationMatch, preferBoost,
} from '../src/lib/mood-score.mjs';
import { resolveMood } from '../src/lib/moods.mjs';
import { resolvePreferLabel } from '../src/lib/rank.mjs';

const NOW = new Date('2026-10-01T17:00:00.000Z');                       // 20:00 local
const occident = {
  channel_category: 'Filme & Seriale',
  program: { title: 'Occident', start_utc: '2026-10-01T17:30:00.000Z', duration_min: 105 },
};

test('components are computed once and are deterministic', () => {
  const opts = { genres: [], mood: resolveMood('obosit'), preferLabels: ['filme'].map(resolvePreferLabel), now: NOW };
  assert.deepEqual(scoreComponents(occident, opts), scoreComponents(occident, opts));
  const c = scoreComponents(occident, opts);
  assert.equal(c.channel_cat, 3);
  assert.equal(c.time_proximity, 2);
  assert.equal(c.duration_match, 0.5);
  assert.equal(c.prefer_boost, 1);
  assert.equal(c.xref_boost, 0);
});

test('compare and explain share one profile, so their totals cannot diverge', () => {
  const opts = { genres: [], mood: resolveMood('obosit'), preferLabels: ['filme', 'documentare'].map(resolvePreferLabel), now: NOW };
  const c = scoreComponents(occident, opts);
  const total = sumComponents(c, PROFILE.full);
  assert.equal(total, c.channel_cat + c.mood_fit + c.time_proximity + c.duration_match + c.prefer_boost + c.xref_boost);
});

test('profiles are nested: base ⊂ plan ⊂ full', () => {
  for (const k of PROFILE.base) assert.ok(PROFILE.plan.includes(k));
  for (const k of PROFILE.plan) assert.ok(PROFILE.full.includes(k));
});

test('primitive bands', () => {
  assert.equal(timeProximity('2026-10-01T16:55:00Z', NOW).value, 2);    // -5 min
  assert.equal(timeProximity('2026-10-01T18:00:00Z', NOW).value, 2);    // +60 min
  assert.equal(timeProximity('2026-10-01T18:01:00Z', NOW).value, 0);
  assert.equal(timeProximity('2026-10-01T16:54:00Z', NOW).value, 0);
  assert.equal(durationMatch(44), 0); assert.equal(durationMatch(45), 0.5);
  assert.equal(durationMatch(180), 0.5); assert.equal(durationMatch(181), 0);
  assert.equal(preferBoost('Filme & Seriale', [resolvePreferLabel('seriale')]), 1);
  assert.equal(preferBoost('Generaliste', [resolvePreferLabel('filme')]), 0);
  assert.equal(preferBoost('Sport', []), 0);
});

test('no tool keeps a private copy of the channel table or of the bonus bands', () => {
  const dir = new URL('../src/tools/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/'Filme & Seriale':\s*3/.test(src), `${f} redefines the channel score table`);
    assert.ok(!/deltaMin >= -5 && deltaMin <= 60\) \? 2|deltaMin <= 60\) score \+= 2/.test(src), `${f} recomputes the proximity bonus`);
  }
  assert.equal(CHANNEL_SCORE['Știri'], -10);
});
