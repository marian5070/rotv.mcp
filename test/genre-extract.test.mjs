// node --test test/genre-extract.test.mjs
// Cazuri reale din EPG-ul de 1 oct 2026 (testele ChatGPT pe cele 14 unelte).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGenres, genreNames } from '../src/lib/genre-extract.mjs';

const g = (t, d = '') => genreNames(extractGenres(t, d));

test('substring false positives are gone', () => {
  assert.deepEqual(g('contrabandă'), []);                       // band → Muzică
  assert.deepEqual(g('Frontieră'), []);                         // front → Război
  assert.deepEqual(g('Focus', 'O emisiune de știri.'), []);     // misiune → Acțiune
  assert.deepEqual(g('x', 'intimitatea unui om uimitor, numit Dumitru'), []); // mit → Fantasy
  assert.deepEqual(g('x', 'Edward Stewart și Warner'), []);     // war → Război
  assert.deepEqual(g('x', 'italieni abandonați anunță întrebări: questions'), []); // alien/band/nunta/quest
  assert.deepEqual(g('Monsters of God', 'Documentar despre lumea contrabandei cu reptile.'), []);
});

test('Romanian inflections still match at word start', () => {
  assert.deepEqual(g('Insula misterioasă'), ['Mister']);
  assert.deepEqual(g('Destinul unui războinic'), ['Război']);
  assert.deepEqual(g('Program muzical'), ['Muzică']);
  assert.deepEqual(g('Aventurierii spaţiului'), ['Aventuri']);
  assert.ok(g('x', 'copiilor le plac aventurile').includes('Aventuri'));
  assert.ok(g('x', 'copiilor le plac aventurile').includes('Familie'));
  assert.ok(g('x', 'se îndrăgostește de un vampir').includes('Romantic'));
});

test('short ambiguous anchors match only their listed word forms', () => {
  assert.deepEqual(g('pe frontul de est'), ['Război']);
  assert.deepEqual(g('Star Wars'), ['Război']);
  assert.deepEqual(g('x', 'a rock band on tour'), ['Muzică']);
  assert.deepEqual(g('x', 'bandits and banda de hoți'), []);
  assert.deepEqual(g('x', 'mitul lui Sisif'), ['Fantasy']);
  assert.deepEqual(g('x', 'Mitch și Mitică la Mittagsmagazin'), []);
});

test('overlapping anchors are not double counted', () => {
  const [crime] = extractGenres('un detective privat', '');
  assert.deepEqual(crime.anchors, ['detective']);
  const [fantasy] = extractGenres('legenda regatului', '');
  assert.deepEqual(fantasy.anchors, ['regat', 'legenda']);
});

test('output shape is unchanged: genre, confidence, anchors; top 3', () => {
  const r = extractGenres('Concert live', 'Un festival de muzică, dragoste, crimă și război pe front.');
  assert.ok(r.length <= 3);
  for (const x of r) assert.deepEqual(Object.keys(x), ['genre', 'confidence', 'anchors']);
});
