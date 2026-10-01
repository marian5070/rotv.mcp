// node --test test/concierge-replay.test.mjs
// O reluare dovedită a unui eveniment major nu câștigă fereastra prin importanță.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

process.env.ROTV_DATA_DIR = fileURLToPath(new URL('./fixtures/concierge-replay/', import.meta.url));
const { loadAll } = await import('../src/data/store.mjs');
const C = await import('../src/tools/concierge.mjs');
await loadAll();
const call = async (args) => (await C.handleConcierge(z.object(C.ConciergeInput).parse(args))).payload;

test('the first airing of a major event keeps its full importance', async () => {
  const r = await call({ window: { start: '2026-10-01T08:00:00Z', duration_min: 60 }, sources: ['tv'] });
  assert.match(r.decision.primary_title, /Motocros/);
  assert.equal(r.decision.confidence_breakdown.event_importance.value, 0.9);
});

test('the evening repeat has half the importance, says why, and loses to a described film', async () => {
  const r = await call({ window: { start: '2026-10-01T17:00:00Z', duration_min: 120 }, sources: ['tv'] });
  assert.equal(r.decision.primary_title, 'Rețeaua de socializare');
  const alt = r.alternatives.find((a) => /Motocros/.test(a.title));
  assert.ok(alt, 'the replay is still offered as an alternative');
});

test('highlights carry live_status and the reasoning line marks a replay', async () => {
  const r = await call({ window: { start: '2026-10-01T17:00:00Z', duration_min: 120 }, sources: ['tv'] });
  for (const ev of r.important_today) assert.ok(['live', 'replay', 'unknown'].includes(ev.live_status));
  const lines = r.reasoning.filter((l) => l.startsWith('Eveniment major azi'));
  assert.ok(lines.length >= 1);
});
