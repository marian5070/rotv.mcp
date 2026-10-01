// node --test test/live-status.test.mjs
// Titluri reale din EPG-ul de 1 oct 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveStatus, firstAiringIndex } from '../src/lib/live-status.mjs';

const P = (title, start, stop, description = '') => ({ title, start, stop, description });
const src = (rows) => ({ channels: rows.map(([displayName, programs]) => ({ displayName, programs })) });

test('unknown is the default: sport is not assumed to be live', () => {
  assert.deepEqual(liveStatus(P('Nations League: Belgia-Franta', '2026-10-01T13:00:00Z', '2026-10-01T14:45:00Z')), { status: 'unknown' });
});

test('replay when the title says so or carries a past date/year', () => {
  assert.equal(liveStatus(P('RELUARE Argentina - Bolivia (Fotbal amical)', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z')).status, 'replay');
  const dated = liveStatus(P('King of Kings - World Series, Kaunas, 21.09.2019 - Part I', '2026-10-01T05:00:00Z', '2026-10-01T07:50:00Z'));
  assert.equal(dated.status, 'replay'); assert.match(dated.evidence, /21\.09\.2019/);
  assert.equal(liveStatus(P('JOCURILE OLIMPICE : Galeria Vedetelor Londra 2012', '2026-10-01T20:00:00Z', '2026-10-01T21:00:00Z')).status, 'replay');
});

test('a season or a future year in the title is not a past date', () => {
  assert.equal(liveStatus(P('Liga Campionilor 2025/26: Real - Bayern', '2026-10-01T19:00:00Z', '2026-10-01T21:00:00Z')).status, 'unknown');
  assert.equal(liveStatus(P('Preliminarii Euro 2028: Romania - Ungaria', '2026-10-01T18:45:00Z', '2026-10-01T20:45:00Z')).status, 'unknown');
});

test('live only when the EPG text says live', () => {
  assert.equal(liveStatus(P('LIVE Tenis Ziua 2', '2026-10-01T07:00:00Z', '2026-10-01T09:00:00Z')).status, 'live');
  assert.equal(liveStatus(P('Polo feminin', '2026-10-01T07:00:00Z', '2026-10-01T09:00:00Z', 'Cupa Mondială FINALA. Transmisiune directă.')).status, 'live');
});

test('a specific title that already aired, with a real gap, is a replay; the first airing is not', () => {
  const t = 'Mountain Bike: Cupa Mondială - Whistler - Coborâre Masculin';
  const first = P(t, '2026-10-01T13:30:00Z', '2026-10-01T14:30:00Z');
  const second = P(t, '2026-10-01T16:00:00Z', '2026-10-01T17:00:00Z');
  const idx = firstAiringIndex(src([['Eurosport 2', [first]], ['Eurosport 1', [second]]]));
  assert.equal(liveStatus(first, idx).status, 'unknown');
  const r = liveStatus(second, idx);
  assert.equal(r.status, 'replay'); assert.match(r.evidence, /Eurosport 2, 2026-10-01 16:30/);
});

test('two consecutive entries with the same title are halves of one broadcast, not a replay', () => {
  const t = 'etapa 3 UEFA Nations League: Danemarca-Portugalia Grupe';
  const h1 = P(t, '2026-10-01T18:45:00Z', '2026-10-01T19:44:59Z');
  const h2 = P(t, '2026-10-01T19:45:00Z', '2026-10-01T20:45:00Z');
  const idx = firstAiringIndex(src([['Digi Sport 1', [h1, h2]]]));
  assert.equal(liveStatus(h2, idx).status, 'unknown');
});

test('generic titles repeated across the day are never called replays', () => {
  const a = P('Fotbal', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z');
  const b = P('Fotbal', '2026-10-01T18:00:00Z', '2026-10-01T20:00:00Z');
  assert.equal(liveStatus(b, firstAiringIndex(src([['Digi Sport 1', [a, b]]]))).status, 'unknown');
});
