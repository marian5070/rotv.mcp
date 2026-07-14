// rotv-mcp UI resources — MCP Apps extension (io.modelcontextprotocol/ui).
// Two predeclared templates, rendered by capable hosts in sandboxed iframes
// and fed the tool results over postMessage: the tonight-card
// (tv_tonight_card) and the concierge-card (tv_concierge).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_RESOURCE_URI } from '../tools/tonight-card.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The MIME type is fixed by the extension spec (2026-01-26):
// text/html;profile=mcp-app — other types are reserved.
const MCP_APP_HTML = 'text/html;profile=mcp-app';

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const TONIGHT_TEMPLATE = read('tonight-card.html');
const CONCIERGE_TEMPLATE = read('concierge-card.html');

export function registerResources(server) {
  server.registerResource(
    'tonight-card',
    UI_RESOURCE_URI,
    {
      title: 'Tonight-picks visual card (MCP Apps template)',
      description:
        'Self-contained HTML template for the tv_tonight_card tool. Hosts supporting the MCP Apps ' +
        'extension render it in a sandboxed iframe; the card shows the daily decision, one pick per ' +
        'vertical (TV / streaming / theater / cinema) and measured stats from tonight-picks.json.',
      mimeType: MCP_APP_HTML,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_HTML, text: TONIGHT_TEMPLATE }],
    })
  );

  server.registerResource(
    'concierge-card',
    'ui://rotv/concierge-card',
    {
      title: 'Concierge decision card (MCP Apps template)',
      description:
        'Self-contained HTML template for the tv_concierge tool: the single primary decision with ' +
        'channel/platform, local time, disclosed confidence and reasoning, the important-event banner ' +
        'when present, and up to 3 alternatives with their explicit trade-offs.',
      mimeType: MCP_APP_HTML,
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_HTML, text: CONCIERGE_TEMPLATE }],
    })
  );
}
