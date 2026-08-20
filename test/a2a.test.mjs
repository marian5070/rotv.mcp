// node --test test/a2a.test.mjs
// Protocol tests for the A2A endpoint — fake skills injected so the JSON-RPC
// layer is exercised without the EPG data artifacts (travel-trends pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleA2ARpc, agentCard } from '../src/a2a/index.mjs';

// Shapes mirror the REAL tool payloads (concierge.mjs / important-today.mjs):
// decision.primary_title + confidence_label, and count + events — the A2A
// headline builders read exactly these fields.
const FAKE_PLAN = {
  ok: true,
  decision: { primary_title: 'Test Film', primary_summary: 'Pro TV, 21:30', confidence_label: 'high' },
};
const FAKE_IMPORTANT = { ok: true, count: 2, events: [{ title: 'Finala' }, { title: 'Meci' }] };

const calls = [];
const skills = {
  plan_evening: async (args) => { calls.push(['plan_evening', args]); return FAKE_PLAN; },
  important_today: async (args) => { calls.push(['important_today', args]); return FAKE_IMPORTANT; },
};

function send(text, { data, metadata } = {}) {
  const parts = [];
  if (text) parts.push({ kind: 'text', text });
  if (data) parts.push({ kind: 'data', data });
  return handleA2ARpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { role: 'user', messageId: 'm1', parts, metadata, kind: 'message' } },
    },
    skills
  );
}

test('invalid JSON-RPC envelope is rejected with -32600', async () => {
  const r = await handleA2ARpc({ hello: 'world' }, skills);
  assert.equal(r.error.code, -32600);
});

test('unknown method returns -32601', async () => {
  const r = await handleA2ARpc({ jsonrpc: '2.0', id: 7, method: 'message/stream' }, skills);
  assert.equal(r.error.code, -32601);
  assert.equal(r.id, 7);
});

test('message/send without params.message returns -32602', async () => {
  const r = await handleA2ARpc({ jsonrpc: '2.0', id: 2, method: 'message/send', params: {} }, skills);
  assert.equal(r.error.code, -32602);
});

test('plain text routes to plan_evening and completes with artifact', async () => {
  const r = await send('Ce mă uit diseară? Ceva relaxant, vreo 2 ore.');
  const task = r.result;
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  assert.equal(task.artifacts[0].name, 'evening-plan');
  assert.match(task.artifacts[0].parts[0].text, /Test Film/);
  assert.match(task.artifacts[0].parts[0].text, /confidence: high/);
  assert.deepEqual(task.artifacts[0].parts[1].data, FAKE_PLAN);
  // 'relaxant' from the card's own example must reach the concierge as the
  // resolver-known alias 'relaxat', with the duration picked up too.
  const [skill, args] = calls.at(-1);
  assert.equal(skill, 'plan_evening');
  assert.equal(args.mood, 'relaxat');
  assert.equal(args.duration_hours, 2);
});

test('"important" question routes to important_today with real count in headline', async () => {
  const r = await send('Ce e important azi la TV?');
  const task = r.result;
  assert.equal(task.status.state, 'completed');
  assert.equal(task.artifacts[0].name, 'important-today');
  assert.match(task.artifacts[0].parts[0].text, /2 broadcasts matter/);
});

test('data part {date} routes to important_today; bad date → input-required', async () => {
  const ok = await send(null, { data: { date: '2026-08-21' } });
  assert.equal(ok.result.artifacts[0].name, 'important-today');

  const bad = await send(null, { data: { date: 'mâine' } });
  assert.equal(bad.result.status.state, 'input-required');
  assert.match(bad.result.status.message.parts[0].text, /important_today/);
});

test('data part {date, limit} still routes to important_today', async () => {
  const r = await send(null, { data: { date: '2026-08-21', limit: 5 } });
  assert.equal(r.result.artifacts[0].name, 'important-today');
});

test('degenerate parts (non-array) do not crash — falls back to default plan', async () => {
  const r = await handleA2ARpc(
    { jsonrpc: '2.0', id: 9, method: 'message/send', params: { message: { parts: 42 } } },
    skills
  );
  assert.equal(r.result.status.state, 'completed');
  assert.equal(r.result.artifacts[0].name, 'evening-plan');
});

test('explicit metadata.skill hint wins over routing heuristics', async () => {
  const r = await send('Ce e important azi?', { metadata: { skill: 'plan_evening' } });
  assert.equal(r.result.artifacts[0].name, 'evening-plan');
});

test('tasks/get returns a remembered task; unknown id → -32001; cancel → -32002', async () => {
  const sent = await send('diseară ceva de familie');
  const id = sent.result.id;

  const got = await handleA2ARpc({ jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id } }, skills);
  assert.equal(got.result.id, id);

  const missing = await handleA2ARpc({ jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { id: 'nope' } }, skills);
  assert.equal(missing.error.code, -32001);

  const cancel = await handleA2ARpc({ jsonrpc: '2.0', id: 5, method: 'tasks/cancel', params: { id } }, skills);
  assert.equal(cancel.error.code, -32002);
});

test('skill failure surfaces as internal error, not a hang', async () => {
  const r = await handleA2ARpc(
    { jsonrpc: '2.0', id: 6, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'seara' }] } } },
    { plan_evening: async () => { throw new Error('boom'); }, important_today: skills.important_today }
  );
  assert.equal(r.error.code, -32603);
  assert.match(r.error.message, /boom/);
});

test('agent card is honest: capabilities all false, both skills, JSONRPC interface', () => {
  const card = agentCard();
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.skills.map((s) => s.id), ['plan_evening', 'important_today']);
  assert.equal(card.supportedInterfaces[0].url, 'https://tv.madeinro.eu/a2a');
  assert.equal(card.supportedInterfaces[0].transport, 'JSONRPC');
});
