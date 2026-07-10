// node --test test/importance.test.mjs
// Cases use real titles from the 2026-07-10 EPG (epg-normalized.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessImportance } from '../src/lib/importance.mjs';

test('World Cup match with empty description is tier 1 (the Antena 1 case)', () => {
  const r = assessImportance({
    title: 'Fotbal World Cup',
    description: '',
    start: '2026-07-10T18:50:00Z',
    stop: '2026-07-10T21:00:00Z',
  });
  assert.equal(r.tier, 1);
  assert.ok(r.score >= 0.8);
  assert.ok(r.reasons.some((x) => x.includes('world cup')));
});

test('country pair "Spania - Belgia" is at least tier 2', () => {
  const r = assessImportance({ title: 'Spania - Belgia', description: '' });
  assert.ok(r.tier >= 1 && r.tier <= 2);
  assert.ok(r.reasons.some((x) => x.includes('spania - belgia')));
});

test('country pair + knockout stage scores higher than pair alone', () => {
  const pair = assessImportance({ title: 'Spania - Belgia', description: '' });
  const knockout = assessImportance({ title: 'Spania - Belgia', description: 'optimile de finala' });
  assert.ok(knockout.score > pair.score);
});

test('Romania playing gets the boost to tier 1', () => {
  const r = assessImportance({
    title: 'Romania - Franta',
    description: 'Campionatul Mondial, optimi',
    start: '2026-07-11T18:00:00Z',
    stop: '2026-07-11T20:15:00Z',
  });
  assert.equal(r.tier, 1);
  assert.ok(r.reasons.some((x) => x.includes('Romania involved')));
});

test('recap show is NOT tier 1 despite the competition keyword', () => {
  const r = assessImportance({
    title: 'Rezumat World Cup',
    description: '',
    start: '2026-07-10T21:30:00Z',
    stop: '2026-07-10T21:50:00Z',
  });
  assert.notEqual(r.tier, 1);
});

test('too-short broadcast with a major keyword is demoted (not a live match)', () => {
  const r = assessImportance({
    title: 'World Cup flash',
    description: '',
    start: '2026-07-10T12:00:00Z',
    stop: '2026-07-10T12:20:00Z',
  });
  assert.notEqual(r.tier, 1);
  assert.ok(r.reasons.some((x) => x.includes('too short')));
});

test('competition only in description is tier 2 (pre-match studio show)', () => {
  const r = assessImportance({
    title: 'Toata lumea la Antena',
    description: 'Se apropie cel mai spectaculos Campionat Mondial de fotbal din istorie! 104 meciuri...',
    start: '2026-07-10T18:00:00Z',
    stop: '2026-07-10T18:50:00Z',
  });
  assert.equal(r.tier, 2);
});

test('practice session is not the event (WorldSBK antrenament case)', () => {
  const r = assessImportance({
    title: 'WorldSBK – Antrenament 1 Moto: Campionatul Mondial de Superbike Anglia',
    description: '',
    start: '2026-07-10T09:15:00Z',
    stop: '2026-07-10T10:15:00Z',
  });
  assert.notEqual(r.tier, 1);
});

test('Romanian club in a European cup gets the Romania boost', () => {
  const r = assessImportance({
    title: 'Europa League: Dinamo Kiev-Universitatea Cluj',
    description: '',
    start: '2026-07-10T19:00:00Z',
    stop: '2026-07-10T21:00:00Z',
  });
  assert.equal(r.tier, 1);
  assert.ok(r.reasons.some((x) => x.includes('Romania involved')));
});

test('mainstream national channel gives a marquee edge over a niche rerun', () => {
  const onAntena = assessImportance(
    { title: 'Fotbal World Cup', description: '', start: '2026-07-10T18:50:00Z', stop: '2026-07-10T21:00:00Z' },
    { category: 'Generaliste' }
  );
  const onEurosport = assessImportance(
    { title: 'Mountain Bike: Cupa Mondială - La Thuile', description: '', start: '2026-07-10T09:00:00Z', stop: '2026-07-10T10:00:00Z' },
    { category: 'Sport' }
  );
  assert.ok(onAntena.score > onEurosport.score);
});

test('ordinary sport talk has no importance signal', () => {
  const r = assessImportance({ title: 'Fotbal Club', description: '' });
  assert.equal(r.tier, 0);
  assert.equal(r.score, 0);
});

test('ordinary movie has no importance signal', () => {
  const r = assessImportance({ title: 'Un film oarecare', description: 'drama, doi oameni' });
  assert.equal(r.tier, 0);
});
