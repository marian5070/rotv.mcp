import { nowOnTvTool, handleNowOnTv } from './now-on-tv.mjs';
import { searchProgramTool, handleSearch } from './search-program.mjs';
import { primeTimeTool, handlePrimeTime } from './prime-time.mjs';
import { recommendTool, handleRecommend } from './recommend-today.mjs';
import { titleDetailsTool, handleTitleDetails } from './title-details.mjs';

import { recommendByMoodTool, handleRecommendByMood } from './recommend-by-mood.mjs';
import { planEveningTool, handlePlanEvening } from './plan-evening.mjs';
import { compareOptionsTool, handleCompareOptions } from './compare-options.mjs';
import { findForCoupleTool, handleFindForCouple } from './find-for-couple.mjs';
import { explainTool, handleExplain } from './explain-recommendation.mjs';
import { checkFreshnessTool, handleCheckFreshness } from './check-freshness.mjs';

import { conciergeTool, handleConcierge } from './concierge.mjs';
import { importantTodayTool, handleImportantToday } from './important-today.mjs';

import { freshnessEmbed } from '../lib/freshness.mjs';

const TOOL_HANDLERS = {
  // v1
  tv_now_on_tv: handleNowOnTv,
  tv_search_program: handleSearch,
  tv_get_prime_time: handlePrimeTime,
  tv_recommend_today: handleRecommend,
  tv_get_title_details: handleTitleDetails,
  // v2
  tv_recommend_by_mood: handleRecommendByMood,
  tv_plan_evening: handlePlanEvening,
  tv_compare_options: handleCompareOptions,
  tv_find_for_couple: handleFindForCouple,
  tv_explain_recommendation: handleExplain,
  tv_check_freshness: handleCheckFreshness,
  // v3
  tv_concierge: handleConcierge,
  // v3.1
  tv_important_today: handleImportantToday,
};

const V2_TOOLS = new Set([
  'tv_recommend_by_mood',
  'tv_plan_evening',
  'tv_compare_options',
  'tv_find_for_couple',
  'tv_explain_recommendation',
  'tv_check_freshness',
  'tv_concierge',
]);

const TOOL_DEFS = [
  nowOnTvTool, searchProgramTool, primeTimeTool, recommendTool, titleDetailsTool,
  recommendByMoodTool, planEveningTool, compareOptionsTool, findForCoupleTool, explainTool, checkFreshnessTool,
  conciergeTool,
  importantTodayTool,
];

function emitLog(line) {
  process.stdout.write(JSON.stringify(line) + '\n');
}

function wrap(name, handler) {
  return async (args) => {
    const t0 = Date.now();
    let quality = null;
    let ok = true;
    try {
      const raw = await handler(args ?? {});
      let payload;
      if (raw && typeof raw === 'object' && 'payload' in raw && '_quality' in raw) {
        payload = raw.payload;
        quality = raw._quality;
      } else {
        payload = raw;
      }

      if (V2_TOOLS.has(name) && payload && typeof payload === 'object' && payload.freshness === undefined) {
        payload.freshness = freshnessEmbed();
      }

      const text = JSON.stringify(payload, null, 2);
      return {
        content: [{ type: 'text', text }],
        structuredContent: payload,
      };
    } catch (err) {
      ok = false;
      const errBody = { error: true, tool: name, message: err?.message || 'Unknown error' };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(errBody) }],
        structuredContent: errBody,
      };
    } finally {
      const line = {
        t: new Date().toISOString(),
        evt: 'tool',
        tool: name,
        ms: Date.now() - t0,
        ok,
      };
      if (quality) line.q = quality;
      emitLog(line);
    }
  };
}

// All tools are read-only over public data — declared explicitly through the
// standard MCP annotations; clients (e.g. ChatGPT connectors) use them to
// decide whether a tool may run without per-call confirmation.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function registerTools(server) {
  for (const def of TOOL_DEFS) {
    const handler = wrap(def.name, TOOL_HANDLERS[def.name]);
    server.registerTool(
      def.name,
      { ...def.config, annotations: { title: def.config.title, ...READ_ONLY_ANNOTATIONS } },
      handler
    );
  }
}

export { TOOL_HANDLERS, TOOL_DEFS };
