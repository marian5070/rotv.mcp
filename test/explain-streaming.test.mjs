// node --test test/explain-streaming.test.mjs
// tv_explain_recommendation pentru titluri care există doar în catalogul de
// streaming: aceleași componente și același total ca tv_compare_options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.ROTV_DATA_DIR = fileURLToPath(new URL('./fixtures/explain-streaming/', import.meta.url));
const { loadAll } = await import('../src/data/store.mjs');
const { handleExplain } = await import('../src/tools/explain-recommendation.mjs');
const { handleCompareOptions } = await import('../src/tools/compare-options.mjs');
await loadAll();

test('a streaming-only title is explained instead of "not found"', async () => {
  const { payload } = await handleExplain({ title: 'Proiectul Hail Mary', context: { mood: 'captivant' } });
  assert.equal(payload.ok, true);
  assert.equal(payload.subject.source, 'streaming');
  assert.equal(payload.subject.channel_name, 'Amazon Prime');
  assert.equal(payload.subject.start_utc, null);
  assert.deepEqual(payload.sources_used, ['streaming-full', 'moods']);
  assert.match(payload.score_breakdown.time_proximity.why, /Disponibil oricând pe Amazon Prime/);
  assert.deepEqual(payload.extracted_genres.map((g) => g.genre), ['SF', 'Aventuri']);
});

test('explain and compare give the same total for a streaming-only title', async () => {
  const ctx = { mood: 'captivant', prefer: ['filme'] };
  const e = (await handleExplain({ title: 'Proiectul Hail Mary', context: ctx })).payload;
  const c = (await handleCompareOptions({ options: ['Proiectul Hail Mary', 'Occident'], upcoming_window_hours: 48, ...ctx })).payload;
  assert.equal(e.score_breakdown.total, c.options[0].score_breakdown.total);
  for (const k of ['channel_cat', 'mood_fit', 'time_proximity', 'duration_match', 'prefer_boost', 'xref_boost']) {
    assert.equal(e.score_breakdown[k].value, c.options[0].score_breakdown[k], k);
  }
});

test('unknown runtime earns no duration bonus and says so', async () => {
  const { payload } = await handleExplain({ title: 'Serial Fără Durată', context: {} });
  assert.equal(payload.score_breakdown.duration_match.value, 0);
  assert.match(payload.score_breakdown.duration_match.why, /Durată necunoscută/);
});

test('a TV programme is still explained from the EPG, not from the catalogue', async () => {
  const { payload } = await handleExplain({ title: 'Occident', context: { mood: 'obosit' } });
  assert.equal(payload.subject.channel_name, 'Cinemaraton');
  assert.ok(payload.subject.start_utc);
});

test('a title in neither source is reported as such', async () => {
  const { payload } = await handleExplain({ title: 'Un titlu care nu există', context: {} });
  assert.equal(payload.ok, false);
  assert.match(payload.reason, /nici în grila TV, nici în catalogul de streaming/);
});

test('compare: a streaming-only title is found, and says where', async () => {
  const c = (await handleCompareOptions({ options: ['Proiectul Hail Mary', 'Occident'], upcoming_window_hours: 48 })).payload;
  const hm = c.options[0];
  assert.equal(hm.found, true); assert.equal(hm.tv_found, false); assert.equal(hm.streaming_found, true);
  const oc = c.options[1];
  assert.equal(oc.found, true); assert.equal(oc.tv_found, true); assert.equal(oc.streaming_found, false);
});

test('couple: an impossible strict threshold relaxes in declared steps', async () => {
  const { handleFindForCouple } = await import('../src/tools/find-for-couple.mjs');
  const r = (await handleFindForCouple({ person_a: { mood: 'romantic' }, person_b: { mood: 'captivant' }, fairness: 'strict', min_score: 99, timeframe: 'today', limit: 5, include_streaming_xref: false })).payload;
  assert.equal(r.requested_fairness, 'strict');
  assert.equal(r.requested_min_score, 99);
  assert.equal(r.degraded, true);
  assert.equal(r.threshold_relaxed, true);
  assert.equal(r.min_score, 49.5);
});

test('compare: a tie is called a tie', async () => {
  const c = (await handleCompareOptions({ options: ['Occident', 'Occident'], upcoming_window_hours: 48 })).payload;
  assert.match(c.winner.reason, /scor egal cu/);
  assert.doesNotMatch(c.winner.reason, /cu 0 puncte/);
});
