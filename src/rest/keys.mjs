// API key store pentru REST (/api/v1). Complet separat de MCP.
// Fișier: data/api-keys.json — { "<key>": { email, note, created_at, disabled } }
// Scriere atomică (tmp + rename), mode 600. Cache în memorie, reîncărcat la
// schimbarea mtime-ului (permite editare manuală: disabled: true).
import { randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = join(ROOT, 'data');
const KEYS_FILE = join(DATA_DIR, 'api-keys.json');

export const MAX_KEYS_PER_EMAIL = 3;

let cache = {};
let cacheMtimeMs = -1;

function readKeys() {
  if (!existsSync(KEYS_FILE)) {
    cache = {};
    cacheMtimeMs = -1;
    return cache;
  }
  let st;
  try { st = statSync(KEYS_FILE); } catch { return cache; }
  if (st.mtimeMs === cacheMtimeMs) return cache;
  try {
    const parsed = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
    cacheMtimeMs = st.mtimeMs;
  } catch {
    // fișier corupt / scriere concurentă — păstrează cache-ul anterior
  }
  return cache;
}

/** Returnează înregistrarea cheii dacă există și nu e disabled, altfel null. */
export function lookupKey(key) {
  if (typeof key !== 'string' || !key.startsWith('rotv_pk_')) return null;
  const rec = readKeys()[key];
  if (!rec || rec.disabled === true) return null;
  return rec;
}

/** Prefix sigur pentru loguri: "rotv_pk_" + primele 8 hex (nereversibil). */
export function keyPrefix(key) {
  return String(key).slice(0, 16);
}

function atomicWrite(obj) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${KEYS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, KEYS_FILE);
  try { chmodSync(KEYS_FILE, 0o600); } catch { /* mode-ul din tmp e deja 600 */ }
}

/**
 * Emite o cheie nouă pentru email (max MAX_KEYS_PER_EMAIL per email).
 * @returns {{ok:true, key:string} | {ok:false, reason:'key_limit_reached'}}
 */
export function issueKey(email, note) {
  const all = { ...readKeys() };
  const owned = Object.values(all).filter((r) => r && r.email === email).length;
  if (owned >= MAX_KEYS_PER_EMAIL) return { ok: false, reason: 'key_limit_reached' };
  const key = 'rotv_pk_' + randomBytes(16).toString('hex');
  all[key] = {
    email,
    note: note || null,
    created_at: new Date().toISOString(),
    disabled: false,
  };
  atomicWrite(all);
  cache = all;
  try { cacheMtimeMs = statSync(KEYS_FILE).mtimeMs; } catch { cacheMtimeMs = -1; }
  return { ok: true, key };
}
