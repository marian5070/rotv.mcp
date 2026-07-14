import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { FILES } from './paths.mjs';

const cache = {
  epgFull: null,
  epgHome: null,
  streaming: null,
  tonight: null,
  loadedAt: null,
  fileMtimes: { epgFull: 0, epgHome: 0, streaming: 0, tonight: 0 },
};

const debouncers = new Map();

function logEvent(evt, extra = {}) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), evt, ...extra }) + '\n');
}

async function loadOne(key) {
  const file = FILES[key];
  const raw = await readFile(file, 'utf8');
  cache[key] = JSON.parse(raw);
  const st = await stat(file).catch(() => null);
  if (st) cache.fileMtimes[key] = st.mtimeMs;
  return cache[key];
}

export async function loadAll() {
  const t0 = Date.now();
  await Promise.all(Object.keys(FILES).map((k) => loadOne(k)));
  cache.loadedAt = new Date();
  logEvent('cache.loaded', {
    ms: Date.now() - t0,
    channels_full: cache.epgFull?.channels?.length ?? 0,
    channels_home: cache.epgHome?.channels?.length ?? 0,
    providers: Object.keys(cache.streaming?.providers ?? {}).length,
  });
}

export function startWatchers() {
  for (const [key, file] of Object.entries(FILES)) {
    try {
      watch(file, { persistent: false }, () => {
        const existing = debouncers.get(key);
        if (existing) clearTimeout(existing);
        debouncers.set(
          key,
          setTimeout(() => {
            loadOne(key)
              .then(() => logEvent('cache.reloaded', { key }))
              .catch((err) => logEvent('cache.reload_failed', { key, err: err.message }));
            debouncers.delete(key);
          }, 750),
        );
      });
      logEvent('watch.started', { key, file });
    } catch (err) {
      logEvent('watch.failed', { key, file, err: err.message });
    }
  }

  setInterval(async () => {
    for (const [key, file] of Object.entries(FILES)) {
      const st = await stat(file).catch(() => null);
      if (st && st.mtimeMs > cache.fileMtimes[key]) {
        try {
          await loadOne(key);
          logEvent('cache.safety_reload', { key });
        } catch (err) {
          logEvent('cache.safety_reload_failed', { key, err: err.message });
        }
      }
    }
  }, 5 * 60_000).unref();
}

export const getEpgFull = () => cache.epgFull;
export const getEpgHome = () => cache.epgHome;
export const getStreaming = () => cache.streaming;
export const getTonight = () => cache.tonight;
export const getLoadedAt = () => cache.loadedAt;
