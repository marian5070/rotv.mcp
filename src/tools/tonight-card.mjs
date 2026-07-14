import { z } from 'zod';
import { getTonight } from '../data/store.mjs';

const SITE = 'https://tv.madeinro.eu';

// MCP Apps (io.modelcontextprotocol/ui): this tool carries a UI template
// reference in _meta.ui — hosts that support the extension (Claude, ChatGPT,
// VS Code, Goose) render src/resources/tonight-card.html in a sandboxed
// iframe and feed it this tool's result; hosts that do not simply use the
// structured content below. Same data as the tv.madeinro.eu hero
// (tonight-picks.json, regenerated daily by worker-epg Step 2.2).
export const UI_RESOURCE_URI = 'ui://rotv/tonight-card';

const Pick = z.object({}).passthrough();

export const TonightCardOutput = {
  generated_at: z.string().nullable(),
  date: z.string(),
  decision: Pick.nullable(),
  rail: z.object({
    tv: Pick.nullable().optional(),
    streaming: Pick.nullable().optional(),
    teatru: Pick.nullable().optional(),
    cinema: Pick.nullable().optional(),
  }),
  stats: Pick.nullable(),
  page_url: z.string(),
};

export const tonightCardTool = {
  name: 'tv_tonight_card',
  config: {
    title: "Tonight's picks — visual card (MCP Apps)",
    description:
      'The daily "what is worth watching tonight?" card: one main decision (importance-scored major event, or a ' +
      'deterministic prime-time film fallback) plus one pick per vertical — TV, streaming (official Netflix RO top 10), ' +
      'theater (online + stage union), cinema (box office ∩ today\'s real screenings) — and measured stats. ' +
      'Same data as the tv.madeinro.eu homepage hero, regenerated daily. ' +
      'In MCP Apps-capable hosts this renders as an interactive card (ui://rotv/tonight-card).',
    inputSchema: {},
    outputSchema: TonightCardOutput,
  },
  _meta: {
    ui: { resourceUri: UI_RESOURCE_URI, visibility: ['model', 'app'] },
  },
};

export async function handleTonightCard() {
  const data = getTonight();
  if (!data || !data.rail) {
    throw new Error('tonight-picks data not loaded — the daily worker may not have run yet');
  }
  const withUrl = (pick) => (pick ? { ...pick, url: pick.href ? `${SITE}${pick.href}` : SITE } : null);
  return {
    generated_at: data.generatedAt ?? null,
    date: data.date,
    decision: withUrl(data.decision),
    rail: {
      tv: withUrl(data.rail.tv),
      streaming: withUrl(data.rail.streaming),
      teatru: withUrl(data.rail.teatru),
      cinema: withUrl(data.rail.cinema),
    },
    stats: data.stats ?? null,
    page_url: SITE,
  };
}
