import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { loadAll, startWatchers, getLoadedAt } from './data/store.mjs';
import { registerTools, toolsCatalog } from './tools/index.mjs';
import { rateLimit } from './middleware/rate-limit.mjs';
import { authOptional } from './middleware/auth.mjs';
import { accessLog } from './middleware/log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tabelul de unelte din help.html se generează la startup din toolsCatalog()
// (aceleași definiții pe care clienții le văd la tools/list — zero drift).
// Rândurile statice dintre markeri rămân fallback dacă markerii lipsesc.
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function renderHelp(raw) {
  const catalog = toolsCatalog();
  const rows = catalog
    .map(
      (t) =>
        `      <tr>\n        <td class="tool-name">${t.name} <span class="badge">${t.version}</span></td>\n        <td><strong>${escapeHtml(t.title)}.</strong> ${escapeHtml(t.description)}</td>\n      </tr>`
    )
    .join('\n');
  return raw
    .replace(
      /<!-- tools-rows:start -->[\s\S]*?<!-- tools-rows:end -->/,
      `<!-- tools-rows:start -->\n${rows}\n      <!-- tools-rows:end -->`
    )
    .replace(
      /<span class="tool-count">\d+<\/span>/g,
      `<span class="tool-count">${catalog.length}</span>`
    );
}
const HELP_HTML = renderHelp(
  readFileSync(join(__dirname, '..', 'public', 'help.html'), 'utf8')
);

await loadAll();
startWatchers();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(accessLog);
app.use(rateLimit({ rpm: Number(process.env.RATE_LIMIT_RPM || 60) }));
app.use(authOptional);

app.get('/mcp/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'rotv-mcp',
    version: '3.0.3',
    uptime_s: Math.round(process.uptime()),
    cache_loaded_at: getLoadedAt()?.toISOString() ?? null,
  });
});

app.get('/mcp/help', (_req, res) => {
  res.removeHeader('X-Robots-Tag');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('html').send(HELP_HTML);
});

app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'rotv-mcp', version: '3.0.3' });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    try { transport.close(); } catch {}
    try { server.close(); } catch {}
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    process.stderr.write(JSON.stringify({
      t: new Date().toISOString(),
      evt: 'mcp.fatal',
      err: err?.message,
      stack: (err?.stack || '').slice(0, 500),
    }) + '\n');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal error' },
      });
    }
  }
});

app.all('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'Method not allowed — use POST' },
  });
});

const PORT = Number(process.env.PORT) || 3010;
app.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({
    t: new Date().toISOString(),
    evt: 'listening',
    host: '127.0.0.1',
    port: PORT,
  }) + '\n');
});

process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), evt: 'sigterm' }) + '\n');
  process.exit(0);
});
