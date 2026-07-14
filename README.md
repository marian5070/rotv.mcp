# rotv-mcp

Read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for
[tv.madeinro.eu](https://tv.madeinro.eu) — Romanian TV guide, streaming catalog and an
entertainment concierge, exposed as 14 tools to any MCP-compatible client
(Claude, ChatGPT, or your own agent) — including an
[MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
visual tonight-card.

**Live endpoint:** `https://tv.madeinro.eu/mcp` · no auth · streamable HTTP
**Registry:** [`eu.madeinro/rotv-mcp`](https://registry.modelcontextprotocol.io/?q=rotv) (official MCP registry)
**Human-readable overview:** [tv.madeinro.eu/mcp/help](https://tv.madeinro.eu/mcp/help)

## Quick start

No installation, no key — talk to the live server directly:

```bash
# What's important on Romanian TV today? (World Cup, finals, Romania playing…)
curl -X POST https://tv.madeinro.eu/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"tv_important_today","arguments":{}}}'

# Decide for me: I have 2 free hours tonight
curl -X POST https://tv.madeinro.eu/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"tv_concierge","arguments":{"duration_hours":2,"mood":"captivant"}}}'
```

As an MCP client (e.g. Claude Code):

```bash
claude mcp add --transport http rotv https://tv.madeinro.eu/mcp
```

## Tools

All tools are **read-only** and declare the standard MCP annotations
(`readOnlyHint: true`), so well-behaved clients can run them without
per-call confirmation. Time references accepted throughout: `now`, `tonight`,
`tomorrow`, `weekend`, `primetime`, or ISO 8601 instant/range.

### Core EPG (v1)

| Tool | What it does |
|---|---|
| `tv_now_on_tv` | What's on right now — the 14 main Romanian channels or all ~258 |
| `tv_search_program` | Search the schedule by keywords and timeframe |
| `tv_get_prime_time` | Tonight's 20:00–23:00 (Europe/Bucharest) lineup, grouped by channel |
| `tv_recommend_today` | Ranked picks for today (channel quality, timing, preferences) |
| `tv_get_title_details` | One title across TV airings + streaming providers |

### Decision layer (v2)

| Tool | What it does |
|---|---|
| `tv_recommend_by_mood` | Ranked list matched to a mood (obosit / vesel / concentrat / romantic / familie / captivant) |
| `tv_plan_evening` | A full evening plan across TV + streaming |
| `tv_compare_options` | Side-by-side trade-offs between candidate picks |
| `tv_find_for_couple` | Picks that satisfy two different moods at once |
| `tv_explain_recommendation` | Transparent scoring breakdown for any candidate |
| `tv_check_freshness` | How fresh the underlying EPG/streaming data is |

### Concierge (v3)

| Tool | What it does |
|---|---|
| `tv_concierge` | **One decision, not a list.** A single primary pick for your free-time window with a confidence % and full reasoning, plus up to 3 diverse alternatives with explicit trade-offs. Built-in anti-noise filter (news/politics/reality), title dedup, opportunity-cost lookahead — and event awareness (below). |
| `tv_important_today` | **What actually matters today**: World Cup / Euro / Champions League matches, finals, knockout games, Romania's team and clubs. Every event ships with quoted evidence from the EPG text. |

### MCP Apps (v3.2)

| Tool | What it does |
|---|---|
| `tv_tonight_card` | **Tonight's picks as a visual card.** The daily decision (importance-scored major event, or a deterministic prime-time film fallback) plus one pick per vertical — TV, streaming (official Netflix RO top 10), theater (online + stage), cinema (box office ∩ today's screenings) — and measured stats. Declares `_meta.ui.resourceUri → ui://rotv/tonight-card`; hosts supporting the [MCP Apps extension](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) (Claude, ChatGPT, VS Code, Goose) render it as an interactive card in a sandboxed iframe, everyone else gets the same structured JSON. |

## The importance layer

Romanian EPG data is *diffuse*: every program's genre is literally `"General"`,
descriptions are often empty, and a World Cup knockout match can appear as just
`"Fotbal World Cup"`. There is no structured field that says "this matters".

So importance is detected from **real text, with quoted evidence** (`src/lib/importance.mjs`):

- **Tier 1 — major**: World Cup / Euro / Champions League / Olympics / Grand Slams / finals in the title
- **Tier 2 — notable**: country-vs-country fixtures ("Spania - Belgia"), competition mentions in descriptions
- **Boosts**: Romania playing (national team or clubs in European cups), knockout stages, mainstream national channel
- **Demotions**: recaps, studio/practice shows, broadcasts too short to be the live event

Every result carries `reasons[]` quoting the text that matched — the detector
never claims more than the data supports. The same signal feeds
`tv_concierge` as an `event_importance` confidence axis, so a description-less
World Cup match no longer loses to a well-tagged filler movie, and every
concierge answer lists tier-1 events in an `important_today` field even when
the mood-based pick is something else.

## Architecture

```
MCP client ── POST /mcp (streamable HTTP, stateless: fresh server per request)
                 │
        express (loopback :3010)
        access log → rate limit (60 rpm) → optional bearer auth
                 │
        14 tools over in-memory EPG/streaming caches
        + 1 MCP Apps UI resource (ui://rotv/tonight-card)
                 │
        JSON artifacts produced by the rotv-guide pipeline
        (epg-normalized.json · epg-homepage.json · streaming-full.json
         · tonight-picks.json)
        hot-reloaded via fs.watch (debounced 750 ms)
```

- **Stateless streamable HTTP** (`enableJsonResponse`) — one `McpServer` +
  transport per POST; safe behind any proxy/tunnel.
- **Data** (read-only, produced by the [rotv-guide](https://github.com/marian5070/rotv-guide)
  pipeline, never modified by this service):
  - `epg-normalized.json` — ~258 TV channels, −6h to +72h, ISO 8601 UTC
  - `epg-homepage.json` — 15 main channels, −2h to +36h
  - `streaming-full.json` — Netflix / HBO Max / Prime / Disney+ / Apple TV+ catalogs
  - Paths configurable via `ROTV_DATA_DIR`.
- **Telemetry**: every tool call logs one JSON line
  (`{evt:"tool", tool, ms, ok, q:{…}}`) to stdout for log analysis.

## Running it yourself

Requires Node ≥ 24 and the rotv-guide data artifacts.

```bash
cp .env.example .env        # PORT, RATE_LIMIT_RPM, optional MCP_AUTH_TOKEN
npm install
ROTV_DATA_DIR=/path/to/rotv-guide/public/data npm start
```

Production runs under pm2 behind a Cloudflare tunnel — the path-based ingress
rule routes `tv.madeinro.eu/mcp/*` to `localhost:3010`, above the catch-all of
the main site:

```bash
pm2 start ecosystem.config.cjs && pm2 save
curl https://tv.madeinro.eu/mcp/health
```

## Tests

```bash
node --test test/importance.test.mjs        # importance detector, 12 cases
npm run smoke                               # 26 end-to-end JSON-RPC checks
BASE=https://tv.madeinro.eu npm run smoke   # same suite against production
```

## License

[MIT](LICENSE) © 2026 Marian Matinca. The live server surfaces data from
public EPG sources, refreshed automatically by the rotv-guide pipeline.
