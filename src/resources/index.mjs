// rotv-mcp UI resources — MCP Apps extension (io.modelcontextprotocol/ui).
// One predeclared template: the tonight-card, rendered by capable hosts in a
// sandboxed iframe and fed the tv_tonight_card tool result over postMessage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_RESOURCE_URI } from '../tools/tonight-card.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The MIME type is fixed by the extension spec (2026-01-26):
// text/html;profile=mcp-app — other types are reserved.
const MCP_APP_HTML = 'text/html;profile=mcp-app';

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'tonight-card.html'), 'utf8');

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
      contents: [{ uri: uri.href, mimeType: MCP_APP_HTML, text: TEMPLATE }],
    })
  );
}
