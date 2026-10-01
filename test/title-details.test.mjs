// node --test test/title-details.test.mjs
// tv_get_title_details: fragmentele TV dispar când titlul exact există undeva.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rotv-td-'));
const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const P = (title, fromH, durMin) => ({ id: title + fromH, title, start: at(fromH), stop: new Date(Date.now() + fromH * 3600_000 + durMin * 60_000).toISOString(), description: '', category: '' });
const ch = (id, name, category, programs) => ({ id, displayName: name, category, aliases: [], programs });
const epg = { generatedAt: new Date().toISOString(), channels: [
  ch('tv-tlc', 'TLC', 'Lifestyle', [P('90 de zile până la nuntă: Începutul poveştii', 2, 60), P('Saga Amurg: Zori de Zi', 3, 120)]),
  ch('tv-nat-geo-wild', 'National Geographic Wild', 'Documentare', [P('Fight Club', 2, 60)]),
  ch('tv-pro-cinema', 'Pro Cinema', 'Filme & Seriale', [P('Fight Club', 5, 165), P('Amurg', 4, 150)]),
] };
const streaming = { providers: { 1: { name: 'HBO Max', movies: [
  { id: 1, title: 'Începutul', original_title: 'Inception', runtime: 148, voteAverage: 8.4, genres: [] },
  { id: 2, title: 'Fight Club – Sala de lupte', original_title: 'Fight Club', runtime: 139, voteAverage: 8.4, genres: [] },
], tv: [] } } };
for (const [f, v] of [['epg-normalized.json', epg], ['epg-homepage.json', epg], ['streaming-full.json', streaming], ['tonight-picks.json', { decision: null, rail: {}, stats: {} }]]) writeFileSync(join(dir, f), JSON.stringify(v));
process.env.ROTV_DATA_DIR = dir;
const { loadAll } = await import('../src/data/store.mjs');
const { handleTitleDetails } = await import('../src/tools/title-details.mjs');
await loadAll();
const run = async (title) => { const r = await handleTitleDetails({ title, include_streaming: true, upcoming_window_hours: 48 }); return r.payload ?? r; };

test('exact title in the catalogue: TV fragments of other titles are left out, and the summary says so', async () => {
  const r = await run('Începutul');
  assert.equal(r.tv_airings_count, 0);
  assert.equal(r.streaming[0].match, 'exact');
  assert.match(r.summary, /1 TV airing\(s\) that only contain the words/);
});

test('exact title on TV: the longer title that contains it is left out', async () => {
  const r = await run('Amurg');
  assert.deepEqual(r.tv_airings.map((a) => a.program.title), ['Amurg']);
});

test('no exact match anywhere: fragments stay, they are all we have', async () => {
  const r = await run('Zori de Zi');
  assert.equal(r.tv_airings_count, 1);
  assert.equal(r.tv_airings[0].match, 'partial');
});

test('same title, different work: the short airing is flagged, the film-length one is not', async () => {
  const r = await run('Fight Club');
  const doc = r.tv_airings.find((a) => a.channel_name === 'National Geographic Wild');
  const film = r.tv_airings.find((a) => a.channel_name === 'Pro Cinema');
  assert.equal(doc.streaming_same_work, false);
  assert.equal('streaming_same_work' in film, false);
});
