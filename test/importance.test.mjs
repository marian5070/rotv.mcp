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

// Din 1 oct 2026: o competiție numită DOAR în descriere contează numai pe un
// canal de sport. Pe generaliste e o emisiune DESPRE eveniment (decizie
// asumată: studioul pre-meci de pe un generalist nu mai e tier 2).
const STUDIO = {
  title: 'Toata lumea la Antena',
  description: 'Se apropie cel mai spectaculos Campionat Mondial de fotbal din istorie! 104 meciuri...',
  start: '2026-07-10T18:00:00Z',
  stop: '2026-07-10T18:50:00Z',
};

test('competition only in description on a Sport channel is tier 2', () => {
  assert.equal(assessImportance(STUDIO, { category: 'Sport' }).tier, 2);
});

test('competition only in description on a generalist channel is NOT important', () => {
  assert.deepEqual(assessImportance(STUDIO, { category: 'Generaliste' }), { score: 0, tier: 0, reasons: [] });
  assert.equal(assessImportance(STUDIO).tier, 0);
});

test('"Romania face bine" (TVR 2, 2026-10-01) is not an event: description merely mentions a world championship', () => {
  const r = assessImportance({
    title: 'Romania face bine',
    description: 'Sezon Nou. Liceenii Heart of RoBots din Buzău au ajuns să reprezinte România la Campionatul Mondial FIRST Tech Challenge de la Houston.',
    start: '2026-10-01T17:00:00.000Z',
    stop: '2026-10-01T17:59:59.000Z',
  }, { category: 'Generaliste' });
  assert.deepEqual(r, { score: 0, tier: 0, reasons: [] });
});

test('a national-team fixture on a generalist channel still counts (pair path untouched)', () => {
  const r = assessImportance({ title: 'Fotbal: Polonia - Romania', description: 'UEFA Liga Natiunilor' }, { category: 'Generaliste' });
  assert.equal(r.tier, 1);
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

test('cooking show with "marea finala" in description is NOT an event (TLC case)', () => {
  const r = assessImportance({
    title: 'Ingrediente misterioase, rețete delicioase Sezonul 61 - Episodul 7',
    description: '- Marea finală\nÎntr-o finală cu miză mare, chefii primesc sume mari de bani...',
  });
  assert.equal(r.tier, 0);
});

test('country pair combined with named competition in description still boosts', () => {
  const r = assessImportance({ title: 'Spania - Belgia', description: 'optimile Cupei Mondiale FIFA' });
  assert.ok(r.score >= 0.75);
});

test('a film on a film channel is never an event, whatever its title says', () => {
  const film = { title: 'Misiune Finala', description: 'Un agent primește o ultimă misiune.', start: '2026-10-01T23:25:00Z', stop: '2026-10-02T01:15:00Z' };
  assert.deepEqual(assessImportance(film, { category: 'Filme & Seriale' }), { score: 0, tier: 0, reasons: [] });
  assert.deepEqual(assessImportance({ title: 'Campionatul Mondial al dinozaurilor' }, { category: 'Copii' }), { score: 0, tier: 0, reasons: [] });
  assert.equal(assessImportance({ title: 'Finala Cupei Mondiale', start: '2026-07-19T19:00:00Z', stop: '2026-07-19T21:30:00Z' }, { category: 'Generaliste' }).tier, 1);
  assert.equal(assessImportance({ title: 'Finala Cupei Mondiale', start: '2026-07-19T19:00:00Z', stop: '2026-07-19T21:30:00Z' }, { category: 'Sport' }).tier, 1);
});

test('"sferturi de finală" of a minor tournament is not a final', () => {
  const q = { title: 'Snooker: Openul Shenzhen - Sferturi de finală', start: '2026-10-01T05:00:00Z', stop: '2026-10-01T08:00:00Z' };
  assert.equal(assessImportance(q, { category: 'Sport' }).tier, 0);
  assert.equal(assessImportance({ ...q, title: 'Optimile de finală: Cupa Ligii' }, { category: 'Sport' }).tier, 0);
  assert.equal(assessImportance({ ...q, title: 'Finala Cupei Romaniei' }, { category: 'Sport' }).tier, 1);
  assert.equal(assessImportance({ ...q, title: 'Tenis: Roland Garros - sferturi de finala' }, { category: 'Sport' }).tier, 1);
});
