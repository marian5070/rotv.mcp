// Golden-diff harness for the ranking tools. Not part of `npm test`: it loads the live
// data files and takes minutes. It answers one question before a push: "what changed in
// the answers, over a fixed matrix of inputs, between two checkouts?"
//
//   npm run golden                       # summary metrics of this checkout only
//   npm run golden -- /path/to/old       # OLD vs NEW (this checkout) diff, same frozen clock
//   npm run golden -- /path/to/old 2026-10-01T18:00:00Z   # freeze "now" (default: now)
//
// OLD is usually a git worktree: `git worktree add /tmp/rotv-old <commit>` (+ `npm ci` there).
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NEW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OLD = process.argv[2] ? path.resolve(process.argv[2]) : null;
const FROZEN = new Date(process.argv[3] || Date.now()).getTime();
const RealDate = Date;
// Both checkouts must see the same "now", otherwise every timeframe differs trivially.
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FROZEN])); }
  static now() { return FROZEN; }
};

const load = async (b) => {
  const st = await import(b + '/src/data/store.mjs'); await st.loadAll();
  return {
    RT: await import(b + '/src/tools/recommend-today.mjs'), RM: await import(b + '/src/tools/recommend-by-mood.mjs'),
    CO: await import(b + '/src/tools/compare-options.mjs'), EX: await import(b + '/src/tools/explain-recommendation.mjs'),
    PE: await import(b + '/src/tools/plan-evening.mjs'), FC: await import(b + '/src/tools/find-for-couple.mjs'),
    C: await import(b + '/src/tools/concierge.mjs'),
  };
};
const P = (sh, a) => z.object(sh).parse(a);
const un = (r) => r.payload ?? r.structuredContent ?? r;

// Fixed input matrix (the one used for the October 2026 test rounds).
const moods = [undefined, 'obosit', 'captivant', 'romantic'];
const tfs = ['tonight', 'now', 'today', 'tomorrow', 'weekend', 'primetime'];
const prefers = [undefined, ['filme'], ['documentare', 'sport']];
const titles = ['Occident', 'Amurg', 'Pasager în trenul terorii', 'Cartea lui Eli', 'Taxi 3', 'Las Fierbinți', 'Inima de mama', 'Stăpânul inelelor: Cele două turnuri', 'Observator', 'FBI: Most Wanted'];
const cases = [];
for (const tf of tfs) for (const pr of prefers) cases.push(['RT', 'handleRecommend', 'RecommendInput', { timeframe: tf, limit: 10, ...(pr ? { prefer: pr } : {}) }]);
for (const m of moods) for (const tf of tfs) for (const pr of prefers) cases.push(['RM', 'handleRecommendByMood', 'RecommendByMoodInput', { timeframe: tf, limit: 10, mood: m ?? 'obosit', ...(pr ? { prefer: pr } : {}) }]);
for (const m of moods) for (const pr of prefers) cases.push(['CO', 'handleCompareOptions', 'CompareOptionsInput', { options: titles.slice(0, 5), upcoming_window_hours: 48, ...(m ? { mood: m } : {}), ...(pr ? { prefer: pr } : {}) }]);
for (const t of titles.slice(0, 5)) for (const m of moods.slice(0, 2)) for (const pr of prefers.slice(0, 2)) cases.push(['EX', 'handleExplain', 'ExplainInput', { title: t, context: { ...(m ? { mood: m } : {}), ...(pr ? { prefer: pr } : {}) } }]);
for (const m of moods) for (const d of [120, 180, 240]) for (const pr of prefers) cases.push(['PE', 'handlePlanEvening', 'PlanEveningInput', { start: '20:00', duration_min: d, ...(m ? { mood: m } : {}), ...(pr ? { prefer: pr } : {}) }]);
for (const a of ['obosit', 'captivant']) for (const b of ['romantic', 'vesel']) for (const tf of tfs.slice(0, 3)) cases.push(['FC', 'handleFindForCouple', 'FindForCoupleInput', { person_a: { mood: a, prefer: ['filme'] }, person_b: { mood: b, dislike_genres: ['Horror'] }, timeframe: tf, limit: 10 }]);
for (const m of moods) for (const d of [120, 240]) for (const src of [['tv'], undefined]) for (const h of [17, 19, 21]) {
  const start = new RealDate(FROZEN); start.setUTCHours(h, 0, 0, 0);
  cases.push(['C', 'handleConcierge', 'ConciergeInput', { window: { start: start.toISOString(), duration_min: d }, ...(src ? { sources: src } : {}), ...(m ? { mood: m } : {}) }]);
}

// Summary metrics of one checkout: how full are plans, how often concierge has no description, etc.
async function metrics(t) {
  const epg = (await import(t === n ? NEW + '/src/data/store.mjs' : OLD + '/src/data/store.mjs')).getEpgFull();
  const desc = new Map(); for (const ch of epg.channels) for (const p of ch.programs) desc.set(ch.id + '|' + p.start, p);
  const s = { conciergeWindows: 0, undescribedPrimary: 0, streamingPrimary: 0, degraded: 0, planWindows: 0, planFillPctSum: 0, planFilled90: 0 };
  for (const d of [120, 180, 240]) for (let h = 5; h < 41; h += 3) {
    const start = new RealDate(FROZEN); start.setUTCHours(0, 0, 0, 0); start.setTime(start.getTime() + h * 3600e3);
    const r = un(await t.C.handleConcierge(P(t.C.ConciergeInput, { window: { start: start.toISOString(), duration_min: d } })));
    const seg = (r.decision?.segments || []).find((x) => x.kind === 'tv');
    const prog = seg ? desc.get((seg.channel_id || '') + '|' + (seg.start_utc || '')) : null;
    s.conciergeWindows++; if (!seg) s.streamingPrimary++; if (prog && !(prog.description || '').trim()) s.undescribedPrimary++; if (r.degraded) s.degraded++;
    const p = un(await t.PE.handlePlanEvening(P(t.PE.PlanEveningInput, { start: start.toISOString(), duration_min: d })));
    const filled = p.totals?.total_filled_min ?? p.totals?.filled_min ?? 0;
    s.planWindows++; s.planFillPctSum += filled / d; if (filled >= d * 0.9) s.planFilled90++;
  }
  s.planAvgFillPct = Math.round(100 * s.planFillPctSum / s.planWindows); delete s.planFillPctSum;
  return s;
}

const n = await load(NEW);
if (!OLD) {
  console.log(JSON.stringify({ checkout: NEW, frozen: new RealDate(FROZEN).toISOString(), metrics: await metrics(n) }, null, 1));
  process.exit(0);
}
const o = await load(OLD);
let same = 0, diff = 0, skipped = 0; const diffs = []; const perMod = {};
for (const [mod, fn, shape, args] of cases) {
  let ro, rn;
  try {
    if (!o[mod]?.[shape] || !n[mod]?.[shape]) { skipped++; continue; }
    ro = JSON.stringify(un(await o[mod][fn](P(o[mod][shape], args))));
    rn = JSON.stringify(un(await n[mod][fn](P(n[mod][shape], args))));
  } catch (e) { skipped++; diffs.push(`${mod} ERR ${e.message.slice(0, 140)}`); continue; }
  perMod[mod] = perMod[mod] || { same: 0, diff: 0 };
  if (ro === rn) { same++; perMod[mod].same++; continue; }
  diff++; perMod[mod].diff++;
  if (diffs.length < 12) { let i = 0; while (ro[i] === rn[i]) i++; diffs.push(`${mod} ${JSON.stringify(args).slice(0, 100)}\n   @${i} OLD …${ro.slice(Math.max(0, i - 60), i + 90)}…\n   @${i} NEW …${rn.slice(Math.max(0, i - 60), i + 90)}…`); }
}
console.log(JSON.stringify({ old: OLD, new: NEW, frozen: new RealDate(FROZEN).toISOString(), cases: cases.length, same, diff, skipped, perMod }, null, 1));
for (const d of diffs) console.log(d);
console.log('\nmetrics OLD', JSON.stringify(await metrics(o)));
console.log('metrics NEW', JSON.stringify(await metrics(n)));
