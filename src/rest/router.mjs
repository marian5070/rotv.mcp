// REST API dinamic (/api/v1) — strat aditiv peste handlerele MCP existente.
// NU atinge contractul MCP: reutilizează handleSearch/handleConcierge și
// schemele lor zod exact așa cum sunt exportate din src/tools/*.
// Montat în server.mjs ÎNAINTE de rateLimit-ul global MCP — are propriile limite.
import { Router } from 'express';
import { appendFile, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { handleSearch, SearchInput } from '../tools/search-program.mjs';
import { handleConcierge, ConciergeInput } from '../tools/concierge.mjs';
import { getLoadedAt } from '../data/store.mjs';
import { issueKey, lookupKey, keyPrefix, MAX_KEYS_PER_EMAIL } from './keys.mjs';
import { anonLimiter, keyedLimiter, issuanceLimiter } from './limits.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOGS_DIR = join(ROOT, 'logs');
const USAGE_FILE = join(LOGS_DIR, 'rest-usage.jsonl');

const META = Object.freeze({
  source: 'https://tv.madeinro.eu',
  docs: 'https://tv.madeinro.eu/api',
});
const RATE_HINT = 'Get a free API key at https://tv.madeinro.eu/api for higher limits';

const SearchSchema = z.object(SearchInput);
const ConciergeSchema = z.object(ConciergeInput);

// ---------------------------------------------------------------- identitate

/** Cheia API din Authorization: Bearer rotv_pk_… sau X-Api-Key. */
function extractKey(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const k = auth.slice(7).trim();
    if (k.startsWith('rotv_pk_')) return k;
  }
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim().startsWith('rotv_pk_')) return x.trim();
  return null;
}

/**
 * IP-ul ORIGINAR al clientului. Cererile vin proxied de pe 127.0.0.1
 * (aplicația principală), deci cheia anonimă e primul hop din
 * X-Forwarded-For, apoi CF-Connecting-IP, apoi req.ip — niciodată un
 * singur bucket comun 127.0.0.1 pentru toți utilizatorii externi.
 */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------- telemetrie

// v2 — oglindă exactă a classifyUa din
// /opt/apps/rotv-guide/server/middleware/api-usage.mjs (păstrează-le sincron).
// Clase: openai|google|anthropic|xai|meta|crawler|script|browser|other.
// Potrivire pe cuvinte (\b), nu substring-uri: fără 'gpt' gol, fără 'meta' gol.
// Google e împărțit după intenție: gemini/google-extended = agenți AI ->
// 'google'; googlebot/googleother/apis-google = crawlere de indexare ->
// 'crawler'. Token-urile generice bot/crawler/spider vin DUPĂ cele specifice,
// ca GPTBot/ClaudeBot să ajungă la platforma lor.
const UA_CLASSES = [
  ['openai', /\b(openai|chatgpt|gptbot|oai-searchbot)/],
  ['google', /\b(gemini|google-extended)/],
  ['anthropic', /\b(anthropic|claude)/],
  ['xai', /\b(xai\b|grok)/],
  ['meta', /\b(facebookexternalhit|meta-externalagent|meta-externalfetcher)/],
  ['crawler', /\b(googlebot|googleother|apis-google|bingbot|duckduckbot|yandex|applebot|petalbot|ahrefsbot|semrushbot|mj12bot)|(bot|crawler|spider)\b/],
  ['script', /\b(curl|wget|python|go-http|node-fetch|axios|okhttp|libwww)/],
  ['browser', /\bmozilla/],
];

function uaClass(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return 'other';
  for (const [cls, rx] of UA_CLASSES) {
    if (rx.test(s)) return cls;
  }
  return 'other';
}

let logsDirReady = false;
function logUsage(entry) {
  try {
    if (!logsDirReady) {
      mkdirSync(LOGS_DIR, { recursive: true });
      logsDirReady = true;
    }
    // Fără IP-uri, emailuri sau chei complete — doar prefixul cheii.
    appendFile(USAGE_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 }, () => {});
  } catch { /* telemetria nu blochează niciodată răspunsul */ }
}

// ------------------------------------------------------------------- erorile

function sendValidationError(res, zodError) {
  res.status(400).json({
    error: 'invalid_input',
    details: zodError.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  });
}

function sendInternal(res, err) {
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(),
    evt: 'rest.error',
    err: (err?.message || 'unknown').slice(0, 200),
  }) + '\n');
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
}

// -------------------------------------------------- coerciție query-string

function unwrapType(schema) {
  let s = schema;
  while (s?._def && ['ZodOptional', 'ZodDefault', 'ZodNullable'].includes(s._def.typeName)) {
    s = s._def.innerType;
  }
  return s;
}

/** GET: coerce query params (string) către tipurile din schema zod. */
function coerceQuery(shape, query) {
  const out = {};
  for (const [k, raw] of Object.entries(query)) {
    if (!(k in shape)) continue; // z.object() oricum ignoră cheile necunoscute
    const v = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (typeof v !== 'string') continue;
    const t = unwrapType(shape[k])?._def?.typeName;
    if (t === 'ZodNumber') {
      const n = Number(v);
      out[k] = v.trim() !== '' && !Number.isNaN(n) ? n : v;
    } else if (t === 'ZodBoolean') {
      out[k] = v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v;
    } else if (t === 'ZodArray') {
      if (v.startsWith('[')) {
        try { out[k] = JSON.parse(v); } catch { out[k] = v; }
      } else {
        out[k] = v.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else if (t === 'ZodObject') {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------- rate limiting

function dataRateLimit(req, res, next) {
  const key = extractKey(req);
  const rec = key ? lookupKey(key) : null; // cheie invalidă/disabled → anonim
  const tier = rec
    ? { limiter: keyedLimiter, id: `k:${key}`, limit: 300, actor: keyPrefix(key) }
    : { limiter: anonLimiter, id: `ip:${clientIp(req)}`, limit: 60, actor: 'anon' };
  req._restActor = tier.actor;
  const r = tier.limiter.take(tier.id);
  res.setHeader('X-RateLimit-Limit', String(tier.limit));
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  if (!r.ok) {
    res.setHeader('Retry-After', String(r.retryAfterSeconds));
    return res.status(429).json({
      error: 'rate_limited',
      hint: RATE_HINT,
      retry_after_seconds: r.retryAfterSeconds,
    });
  }
  next();
}

// ------------------------------------------------------------------- router

export const restRouter = Router();

// CORS + preflight + telemetrie pe tot /api/v1/*
restRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Api-Key, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  const endpoint = req.path.replace(/^\/+/, '').split('/')[0] || '(root)';
  res.on('finish', () => {
    logUsage({
      ts: new Date().toISOString(),
      endpoint,
      key_prefix: req._restActor || 'anon',
      ua_class: uaClass(req.headers['user-agent']),
      status: res.statusCode,
    });
  });
  next();
});

async function runSearch(args, res) {
  const parsed = SearchSchema.safeParse(args);
  if (!parsed.success) return sendValidationError(res, parsed.error);
  try {
    const result = await handleSearch(parsed.data);
    res.json({ ...result, _meta: META });
  } catch (err) {
    sendInternal(res, err);
  }
}

async function runConcierge(args, res) {
  const parsed = ConciergeSchema.safeParse(args);
  if (!parsed.success) return sendValidationError(res, parsed.error);
  try {
    const result = await handleConcierge(parsed.data);
    // handlerul returnează { payload, _quality }; REST expune doar payload-ul
    // de date pur (fără telemetrie internă, fără câmpuri de card MCP).
    res.json({ ...result.payload, _meta: META });
  } catch (err) {
    sendInternal(res, err);
  }
}

restRouter.get('/search', dataRateLimit, (req, res) => runSearch(coerceQuery(SearchInput, req.query), res));
restRouter.post('/search', dataRateLimit, (req, res) => runSearch(req.body ?? {}, res));

restRouter.get('/concierge', dataRateLimit, (req, res) => runConcierge(coerceQuery(ConciergeInput, req.query), res));
restRouter.post('/concierge', dataRateLimit, (req, res) => runConcierge(req.body ?? {}, res));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

restRouter.post('/keys', (req, res) => {
  const r = issuanceLimiter.take(`ip:${clientIp(req)}`);
  if (!r.ok) {
    res.setHeader('Retry-After', String(r.retryAfterSeconds));
    return res.status(429).json({
      error: 'rate_limited',
      hint: 'Key issuance is limited to 5 per hour per client',
      retry_after_seconds: r.retryAfterSeconds,
    });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({
      error: 'invalid_input',
      details: [{ path: 'email', message: 'A valid email address is required' }],
    });
  }
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
  try {
    const out = issueKey(email, note);
    if (!out.ok) {
      return res.status(409).json({
        error: 'key_limit_reached',
        hint: `Maximum ${MAX_KEYS_PER_EMAIL} API keys per email`,
      });
    }
    res.status(201).json({ key: out.key, rate_limit_rpm: 300, docs: META.docs });
  } catch (err) {
    sendInternal(res, err);
  }
});

restRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    generated_at: new Date().toISOString(),
    data_as_of: getLoadedAt()?.toISOString() ?? null,
  });
});

// /api/v1/* necunoscut se oprește AICI — nu cade în middleware-urile MCP.
restRouter.use((_req, res) => {
  res.status(404).json({ error: 'not_found', docs: META.docs });
});
