// Minimal A2A (Agent2Agent) endpoint for RoTV — the travel-trends template
// (etl/a2a.py) ported to the two agent-shaped skills of this server:
//
//   plan_evening     tv_concierge — one decision for tonight's TV/streaming
//   important_today  tv_important_today — what actually matters on TV today
//
// Deliberately minimal and honest about it:
//   * message/send only, synchronous — every returned task is already in a
//     terminal or input-required state; no streaming, no push, and the agent
//     card says so (capabilities all false).
//   * tasks/get serves a small in-memory window so clients that poll by
//     contract still work across one process lifetime.
//   * Data parts are validated through the SAME zod schemas the MCP tools
//     use (defaults included), so both transports have identical semantics.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConciergeInput, handleConcierge } from '../tools/concierge.mjs';
import { ImportantTodayInput, handleImportantToday } from '../tools/important-today.mjs';

const SITE = 'https://tv.madeinro.eu';
const A2A_URL = `${SITE}/a2a`;

// ── errors (JSON-RPC + A2A-specific codes) ─────────────────────────────────
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const TASK_NOT_FOUND = -32001;
const TASK_NOT_CANCELABLE = -32002;

// Recent tasks, newest last; enough for a polling client, honest about scope.
const MAX_TASKS = 200;
const tasks = new Map();

const ConciergeSchema = z.object(ConciergeInput);
const ImportantTodaySchema = z.object(ImportantTodayInput);

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function remember(task) {
  tasks.set(task.id, task);
  while (tasks.size > MAX_TASKS) {
    tasks.delete(tasks.keys().next().value);
  }
  return task;
}

function makeTask(state, { artifacts, messageText, contextId } = {}) {
  const task = {
    id: randomUUID(),
    contextId: contextId || randomUUID(),
    kind: 'task',
    status: { state, timestamp: now() },
  };
  if (messageText) {
    task.status.message = {
      role: 'agent',
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: messageText }],
      kind: 'message',
    };
  }
  if (artifacts) task.artifacts = artifacts;
  return remember(task);
}

function makeArtifact(name, headline, data) {
  return {
    artifactId: randomUUID(),
    name,
    parts: [
      { kind: 'text', text: headline },
      { kind: 'data', data },
    ],
  };
}

/** Collect the text and merged data parts of an incoming message.
 *  Accepts both the 0.2 field name (`kind`) and the older `type`. */
function collectParts(message) {
  const chunks = [];
  const data = {};
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const kind = part.kind || part.type;
    if (kind === 'text' && typeof part.text === 'string') chunks.push(part.text);
    else if (kind === 'data' && part.data && typeof part.data === 'object' && !Array.isArray(part.data)) {
      Object.assign(data, part.data);
    }
  }
  return { text: chunks.join(' ').trim(), data };
}

const PLAN_SHAPE =
  'plan_evening accepts an optional data part with tv_concierge fields, e.g. ' +
  '{"mood": "relaxat", "duration_hours": 2, "sources": ["tv"]} — all fields optional; ' +
  'plain text also works (a mood word and a duration like "2h" are picked up). ' +
  'important_today accepts {"date": "YYYY-MM-DD", "min_tier": 1|2, "limit": N} or plain text.';

// Exactly the vocabulary lib/moods.mjs resolves (canonical keys + ALIASES),
// plus relax-family words normalized below to the 'relaxat' alias — anything
// else would silently fall through to the generic fallback mood.
const MOOD_RE =
  /\b(obosit|vesel|concentrat|romantic|familie|captivant|tired|chill|happy|fun|focused|family|thrilling|action|relaxat|relaxant|relaxare|relaxed)\b/i;
const MOOD_NORMALIZE = { relaxant: 'relaxat', relaxare: 'relaxat', relaxed: 'relaxat' };
const DURATION_RE = /\b(\d+(?:[.,]\d+)?)\s*(?:h\b|ore\b|or[aă]\b|hours?\b)/i;
const IMPORTANT_RE = /\bimportant/i;

function unwrapPayload(raw) {
  if (raw && typeof raw === 'object' && 'payload' in raw && '_quality' in raw) return raw.payload;
  return raw;
}

/** Map free text to conservative concierge args: only the documented mood
 *  vocabulary and an explicit duration are picked up — everything else runs
 *  on the tool's own defaults rather than being guessed. */
function textToConciergeArgs(text) {
  const args = {};
  const mood = MOOD_RE.exec(text);
  if (mood) {
    const word = mood[1].toLowerCase();
    args.mood = MOOD_NORMALIZE[word] || word;
  }
  const dur = DURATION_RE.exec(text);
  if (dur) {
    const hours = Number(dur[1].replace(',', '.'));
    if (Number.isFinite(hours)) args.duration_hours = Math.min(6, Math.max(0.5, hours));
  }
  return args;
}

// Skill callables are injectable so tests can exercise the protocol without
// the EPG data artifacts (same pattern as travel-trends' a2a.py).
const defaultSkills = {
  plan_evening: async (args) => unwrapPayload(await handleConcierge(args)),
  important_today: async (args) => unwrapPayload(await handleImportantToday(args)),
};

async function handleMessageSend(params, skills) {
  const message = params.message || {};
  const { text, data } = collectParts(message);
  // Client-supplied, stored in the task window — accept only a modest string.
  const contextId =
    typeof message.contextId === 'string' && message.contextId.length <= 128
      ? message.contextId
      : undefined;

  // Skill routing: explicit hint wins; else important_today-shaped data or
  // an "important…" question routes to the ranking, everything else is the
  // concierge (the general "what do I watch tonight?" case).
  let skill = (message.metadata || {}).skill;
  if (!skill) {
    const dataKeys = Object.keys(data);
    const importantShaped =
      dataKeys.length > 0 &&
      dataKeys.every((k) => k === 'date' || k === 'min_tier' || k === 'limit');
    skill = importantShaped || (dataKeys.length === 0 && IMPORTANT_RE.test(text))
      ? 'important_today'
      : 'plan_evening';
  }

  if (skill === 'plan_evening') {
    const parsed = ConciergeSchema.safeParse(
      Object.keys(data).length ? data : textToConciergeArgs(text)
    );
    if (!parsed.success) {
      return makeTask('input-required', { contextId, messageText: `plan_evening: ${parsed.error.issues[0]?.message || 'invalid input'}. ${PLAN_SHAPE}` });
    }
    const result = await skills.plan_evening(parsed.data);
    // Real tv_concierge payload shape: decision.primary_title / primary_summary
    // / confidence_label (see concierge.mjs outputs) — no nested primary object.
    const d = result?.decision;
    const headline = d?.primary_title
      ? `Tonight's pick: ${d.primary_title}${d.confidence_label ? ` (confidence: ${d.confidence_label})` : ''} — alternatives and reasoning in the data part.`
      : 'Evening plan computed — see the data part for the decision and alternatives.';
    return makeTask('completed', { contextId, artifacts: [makeArtifact('evening-plan', headline, result)] });
  }

  if (skill === 'important_today') {
    const parsed = ImportantTodaySchema.safeParse(data);
    if (!parsed.success) {
      return makeTask('input-required', { contextId, messageText: `important_today: ${parsed.error.issues[0]?.message || 'invalid input'}. ${PLAN_SHAPE}` });
    }
    const result = await skills.important_today(parsed.data);
    // Real tv_important_today payload has `count` + `events` (no `items`).
    const count =
      typeof result?.count === 'number'
        ? result.count
        : Array.isArray(result?.events) ? result.events.length : null;
    const headline = count === null
      ? 'Today\'s importance ranking — see the data part.'
      : `${count} broadcast${count === 1 ? '' : 's'} matter${count === 1 ? 's' : ''} on Romanian TV today — details in the data part.`;
    return makeTask('completed', { contextId, artifacts: [makeArtifact('important-today', headline, result)] });
  }

  return makeTask('failed', { contextId, messageText: `Unknown skill "${skill}". Available: plan_evening, important_today.` });
}

/** One JSON-RPC request → one JSON-RPC response (object, ready for JSON). */
export async function handleA2ARpc(body, skills = defaultSkills) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || !('method' in body)) {
    return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 request' } };
  }
  const rpcId = 'id' in body ? body.id : null;
  const method = body.method;
  const params = body.params || {};

  try {
    if (method === 'message/send') {
      if (!params.message || typeof params.message !== 'object') {
        return { jsonrpc: '2.0', id: rpcId, error: { code: INVALID_PARAMS, message: 'params.message required' } };
      }
      return { jsonrpc: '2.0', id: rpcId, result: await handleMessageSend(params, skills) };
    }

    if (method === 'tasks/get') {
      const task = tasks.get(String(params.id ?? ''));
      if (!task) {
        return { jsonrpc: '2.0', id: rpcId, error: { code: TASK_NOT_FOUND, message: 'Task not found' } };
      }
      return { jsonrpc: '2.0', id: rpcId, result: task };
    }

    if (method === 'tasks/cancel') {
      const task = tasks.get(String(params.id ?? ''));
      if (!task) {
        return { jsonrpc: '2.0', id: rpcId, error: { code: TASK_NOT_FOUND, message: 'Task not found' } };
      }
      return { jsonrpc: '2.0', id: rpcId, error: { code: TASK_NOT_CANCELABLE, message: 'Tasks complete synchronously; nothing to cancel' } };
    }

    return {
      jsonrpc: '2.0', id: rpcId,
      error: { code: METHOD_NOT_FOUND, message: `Method not supported: ${method}. Supported: message/send, tasks/get, tasks/cancel` },
    };
  } catch (err) { // honest failure beats a hung client
    return { jsonrpc: '2.0', id: rpcId, error: { code: INTERNAL_ERROR, message: `Internal error: ${err?.message || err}` } };
  }
}

/** The A2A agent card. Every capability flag reflects shipped behavior. */
export function agentCard() {
  return {
    protocolVersion: '0.2.6',
    name: 'RoTV — Romanian TV evening concierge',
    description:
      'Answers "what do I watch tonight?" for Romanian TV and streaming: one ' +
      'ranked decision with alternatives, confidence and anti-noise filtering ' +
      '(tv_concierge), and a daily importance ranking of what actually matters ' +
      'on Romanian TV (tv_important_today). Built on the live EPG of 260+ ' +
      'channels plus official streaming tops. Synchronous skills only — no ' +
      'streaming, no push notifications.',
    url: A2A_URL,
    preferredTransport: 'JSONRPC',
    // 0.3.x-style interface lists, additive next to the 0.2.6 url/
    // preferredTransport pair so older clients keep working (same as the
    // travel-trends card, which validators accept).
    supportedInterfaces: [{ url: A2A_URL, transport: 'JSONRPC' }],
    additionalInterfaces: [{ url: A2A_URL, transport: 'JSONRPC' }],
    provider: { organization: 'Marian Matinca', url: 'https://mmatinca.eu' },
    version: '0.1.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: 'plan_evening',
        name: 'Plan my TV evening',
        description:
          'One decision for tonight: the best thing to watch now or in a chosen ' +
          'window, across Romanian TV and streaming, with alternatives, labelled ' +
          'confidence and anti-noise filtering. Optional data part with ' +
          'tv_concierge fields, e.g. {"mood": "relaxat", "duration_hours": 2}; ' +
          'plain text works too (mood word and "2h"-style duration are picked up).',
        tags: ['tv', 'streaming', 'recommendation', 'romania'],
        examples: [
          'Ce mă uit diseară? Ceva relaxant, vreo 2 ore.',
          'data part: {"mood": "familie", "sources": ["tv"], "max_alternatives": 2}',
        ],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json', 'text/plain'],
      },
      {
        id: 'important_today',
        name: 'What matters on Romanian TV today',
        description:
          'The day\'s importance ranking: broadcasts that actually matter (live ' +
          'sport finals, major events, premieres) with cited evidence per pick, ' +
          'reruns demoted. Optional data part {"date": "YYYY-MM-DD", "min_tier": 1|2, "limit": N}.',
        tags: ['tv', 'importance', 'events', 'romania'],
        examples: [
          'Ce e important azi la TV?',
          'data part: {"date": "2026-08-21", "min_tier": 1}',
        ],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json', 'text/plain'],
      },
    ],
    documentationUrl: `${SITE}/mcp/help`,
  };
}
