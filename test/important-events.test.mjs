// node --test test/important-events.test.mjs
// tv_important_today: un eveniment, mai multe difuzări.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rotv-imp-'));
const P = (title, start, stop) => ({ id: title + start, title, start, stop, description: '', category: 'Sport' });
const ch = (id, name, programs) => ({ id, displayName: name, category: 'Sport', aliases: [], programs });
const epg = { generatedAt: '2026-10-01T12:00:00.000Z', channels: [
  ch('tv-digi-sport-1', 'Digi Sport 1', [
    P('etapa 3 UEFA Nations League: Danemarca-Portugalia Grupe', '2026-10-01T18:45:00.000Z', '2026-10-01T19:44:59.000Z'),
    P('etapa 3 UEFA Nations League: Danemarca-Portugalia Grupe', '2026-10-01T19:45:00.000Z', '2026-10-01T20:45:00.000Z'),
  ]),
  ch('tv-prima-sport-1', 'Prima Sport 1', [P('Danemarca – Portugalia', '2026-10-01T18:45:00.000Z', '2026-10-01T20:45:00.000Z')]),
  ch('tv-digi-sport-3', 'Digi Sport 3', [P('Etapa 3 Nations League: Grecia-Tarile de Jos Grupe', '2026-10-01T18:40:00.000Z', '2026-10-01T20:40:00.000Z')]),
  ch('tv-prima-sport-3', 'Prima Sport 3', [P('Grecia – Olanda', '2026-10-01T18:45:00.000Z', '2026-10-01T20:45:00.000Z')]),
] };
for (const [f, v] of [['epg-normalized.json', epg], ['epg-homepage.json', epg], ['streaming-full.json', { providers: {} }], ['tonight-picks.json', { decision: null, rail: {}, stats: {} }]]) writeFileSync(join(dir, f), JSON.stringify(v));
process.env.ROTV_DATA_DIR = dir;
const { loadAll } = await import('../src/data/store.mjs');
const { handleImportantToday } = await import('../src/tools/important-today.mjs');
await loadAll();

test('the same match on two channels, under different titles, is one event with its broadcasts', async () => {
  const r = await handleImportantToday({ date: '2026-10-01', min_tier: 2, limit: 25 });
  const { events, count } = r.payload ?? r;
  assert.equal(count, 2);
  const dk = events.find((e) => /Danemarca/.test(e.program.title));
  assert.equal(dk.broadcast_count, 3);
  assert.deepEqual(dk.broadcasts.map((b) => b.channel_name), ['Digi Sport 1', 'Prima Sport 1', 'Digi Sport 1']);
});

test('team name synonyms merge: Țările de Jos = Olanda', async () => {
  const r = await handleImportantToday({ date: '2026-10-01', min_tier: 2, limit: 25 });
  const gr = (r.payload ?? r).events.find((e) => /Grecia/.test(e.program.title));
  assert.equal(gr.broadcast_count, 2);
});

test('every event keeps the fields it had before grouping', async () => {
  const r = await handleImportantToday({ date: '2026-10-01', min_tier: 2, limit: 25 });
  for (const e of (r.payload ?? r).events) {
    for (const k of ['channel_id', 'channel_name', 'program', 'tier', 'score', 'reasons', 'live_status']) assert.ok(k in e, k);
  }
});
