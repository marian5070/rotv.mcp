#!/usr/bin/env bash
# Smoke tests for rotv-mcp.
#   Local:  BASE=http://127.0.0.1:3010 bash test/smoke.sh
#   Tunnel: BASE=https://tv.madeinro.eu  bash test/smoke.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3010}"
PASS=0
FAIL=0

header() { printf "\n\033[1;36m== %s ==\033[0m\n" "$1"; }
ok()     { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
ko()     { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }

jrpc() {
  curl -fsS -X POST "$BASE/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$1"
}

header "0. Health"
HEALTH=$(curl -fsS "$BASE/mcp/health" 2>/dev/null || true)
if printf '%s' "$HEALTH" | grep -q '"ok":true'; then ok "/mcp/health returns ok:true"; else ko "/mcp/health failed: $HEALTH"; fi

header "1. initialize"
INIT=$(jrpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' 2>/dev/null || true)
if printf '%s' "$INIT" | grep -q '"serverInfo"'; then ok "initialize returns serverInfo"; else ko "initialize failed: $INIT"; fi

header "2. tools/list (expect 14 = 5 v1 + 6 v2 + 1 v3 + 1 v3.1 + 1 v3.2)"
TOOLS=$(jrpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' 2>/dev/null || true)
COUNT=$(printf '%s' "$TOOLS" | grep -oE '"name":"tv_[a-z_]+"' | sort -u | wc -l | tr -d ' ')
if [ "$COUNT" = "14" ]; then ok "14 tools registered"; else ko "expected 14 tools, got $COUNT"; printf '   %s\n' "$TOOLS" | head -c 500; fi

header "3. tv_now_on_tv main, exclude_news"
R=$(jrpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tv_now_on_tv","arguments":{"scope":"main","exclude_news":true,"limit":10}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"channel_id"'; then ok "tv_now_on_tv returns programs"; else ko "tv_now_on_tv failed"; printf '   %s\n' "$R" | head -c 500; fi

header "4. tv_search_program football weekend"
R=$(jrpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"tv_search_program","arguments":{"query":"fotbal","timeframe":"weekend","limit":5}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"count"'; then ok "tv_search_program returns shape"; else ko "tv_search_program failed"; printf '   %s\n' "$R" | head -c 500; fi

header "5. tv_get_prime_time today (exclude_news=true)"
R=$(jrpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"tv_get_prime_time","arguments":{"date":"today","exclude_news":true}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"window_local"'; then ok "tv_get_prime_time returns shape"; else ko "tv_get_prime_time failed"; printf '   %s\n' "$R" | head -c 500; fi

header "6. tv_recommend_today tonight (films + docs)"
R=$(jrpc '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"tv_recommend_today","arguments":{"timeframe":"tonight","prefer":["filme","documentare"],"limit":5}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"why_recommended"'; then ok "tv_recommend_today returns ranked items"; else ko "tv_recommend_today failed"; printf '   %s\n' "$R" | head -c 500; fi

header "7. tv_get_title_details avatar"
R=$(jrpc '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"tv_get_title_details","arguments":{"title":"avatar","include_streaming":true}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"summary"'; then ok "tv_get_title_details returns summary"; else ko "tv_get_title_details failed"; printf '   %s\n' "$R" | head -c 500; fi

header "8. Cache-Control no-store"
HDR=$(curl -fsS -I "$BASE/mcp/health" 2>/dev/null | tr -d '\r' || true)
if printf '%s' "$HDR" | grep -iq '^cache-control: no-store'; then ok "Cache-Control: no-store"; else ko "Cache-Control missing/wrong"; printf '   %s\n' "$HDR"; fi

header "9. v2 tv_recommend_by_mood (obosit, tonight)"
R=$(jrpc '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"tv_recommend_by_mood","arguments":{"mood":"obosit","timeframe":"tonight","limit":5}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"mood_label_ro"' && printf '%s' "$R" | grep -q '"freshness"'; then ok "tv_recommend_by_mood returns mood + freshness"; else ko "tv_recommend_by_mood failed"; printf '   %s\n' "$R" | head -c 600; fi

header "10. v2 tv_plan_evening (20:00, 180 min, captivant)"
R=$(jrpc '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"tv_plan_evening","arguments":{"start":"20:00","duration_min":180,"mood":"captivant","max_segments":3}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"totals"'; then ok "tv_plan_evening returns timeline + totals"; else ko "tv_plan_evening failed"; printf '   %s\n' "$R" | head -c 600; fi

header "11. v2 tv_compare_options (3 titles)"
R=$(jrpc '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"tv_compare_options","arguments":{"options":["John Wick","Avatar","Dune"],"mood":"captivant"}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"winner"' || printf '%s' "$R" | grep -q '"score_breakdown"'; then ok "tv_compare_options returns winner/scores"; else ko "tv_compare_options failed"; printf '   %s\n' "$R" | head -c 600; fi

header "12. v2 tv_find_for_couple (captivant vs romantic, auto-fallback)"
R=$(jrpc '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"tv_find_for_couple","arguments":{"person_a":{"mood":"captivant"},"person_b":{"mood":"romantic"},"timeframe":"tonight","limit":3}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"degraded"' && printf '%s' "$R" | grep -q '"why_for_couple"\|"items":\[\]'; then ok "tv_find_for_couple returns degraded flag + items"; else ko "tv_find_for_couple failed"; printf '   %s\n' "$R" | head -c 600; fi

header "13. v2 tv_explain_recommendation (an actual airing)"
# First grab a real title from now-on-tv to feed explain
ACTUAL=$(jrpc '{"jsonrpc":"2.0","id":131,"method":"tools/call","params":{"name":"tv_now_on_tv","arguments":{"scope":"main","limit":1}}}' 2>/dev/null || true)
TITLE=$(printf '%s' "$ACTUAL" | grep -oE '"title":"[^"]+"' | head -1 | sed 's/"title":"//; s/"$//' | head -c 80)
if [ -z "$TITLE" ]; then TITLE="Avatar"; fi
R=$(jrpc "$(printf '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"tv_explain_recommendation","arguments":{"title":"%s","context":{"mood":"obosit","timeframe":"now"}}}}' "$TITLE")" 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"score_breakdown"'; then ok "tv_explain_recommendation returns score_breakdown"; else ko "tv_explain_recommendation failed (title=$TITLE)"; printf '   %s\n' "$R" | head -c 600; fi

header "14. v2 tv_check_freshness"
R=$(jrpc '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"tv_check_freshness","arguments":{}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"overall_stale"' && printf '%s' "$R" | grep -q '"expected_next_refresh_at"'; then ok "tv_check_freshness returns sources + next refresh"; else ko "tv_check_freshness failed"; printf '   %s\n' "$R" | head -c 600; fi

header "15. version 3.0.3"
H=$(curl -fsS "$BASE/mcp/health" 2>/dev/null || true)
if printf '%s' "$H" | grep -q '"version":"3.0.3"'; then ok "version 3.0.3"; else ko "version mismatch: $H"; fi

header "16. v3 tv_concierge default 2h evening + noise filter ON"
R=$(jrpc '{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"tv_concierge","arguments":{"window":{"start":"20:00","duration_min":120},"mood":"obosit"}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"confidence_pct"' && printf '%s' "$R" | grep -q '"anti_noise"'; then ok "tv_concierge returns confidence + anti_noise"; else ko "tv_concierge failed"; printf '   %s\n' "$R" | head -c 700; fi

header "17. v3 tv_concierge now, 90min, captivant, TV only"
R=$(jrpc '{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"tv_concierge","arguments":{"duration_hours":1.5,"mood":"captivant","sources":["tv"]}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"primary_kind"' && (printf '%s' "$R" | grep -q '"primary_kind":"tv"' || printf '%s' "$R" | grep -q '"degraded":true'); then ok "tv_concierge TV-only returns decision"; else ko "tv_concierge TV-only failed"; printf '   %s\n' "$R" | head -c 700; fi

header "18. v3 tv_concierge streaming-only 100min romantic"
R=$(jrpc '{"jsonrpc":"2.0","id":18,"method":"tools/call","params":{"name":"tv_concierge","arguments":{"window":{"start":"now","duration_min":100},"mood":"romantic","sources":["streaming"]}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"ok":true' && printf '%s' "$R" | grep -q '"sources":\["streaming"\]'; then ok "tv_concierge streaming-only returns ok"; else ko "tv_concierge streaming-only failed"; printf '   %s\n' "$R" | head -c 700; fi

header "19. v3 tv_concierge risk_aversion=high + min_rating 7.5"
R=$(jrpc '{"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"tv_concierge","arguments":{"window":{"start":"20:00","duration_min":120},"mood":"captivant","risk_aversion":"high","min_rating":7.5}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"alternatives":\[\]'; then ok "tv_concierge risk=high → zero alternatives"; else ko "tv_concierge risk=high failed"; printf '   %s\n' "$R" | head -c 700; fi

header "20. v3 tv_concierge edge: 30-min window + mood=captivant"
R=$(jrpc '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"tv_concierge","arguments":{"window":{"start":"now","duration_min":30},"mood":"captivant"}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"confidence_pct"'; then ok "tv_concierge 30-min window returns confidence"; else ko "tv_concierge 30-min failed"; printf '   %s\n' "$R" | head -c 700; fi

header "21. v3.0.3 outputSchema declared on all 12 tools"
TOOLS=$(jrpc '{"jsonrpc":"2.0","id":21,"method":"tools/list"}' 2>/dev/null || true)
SCHEMA_COUNT=$(printf '%s' "$TOOLS" | grep -oE '"outputSchema":\{' | wc -l | tr -d ' ')
if [ "$SCHEMA_COUNT" = "14" ]; then ok "all 14 tools expose outputSchema"; else ko "expected 14 outputSchema, got $SCHEMA_COUNT"; fi

header "22. v3.0.3 /mcp/help serves HTML"
HELP_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/mcp/help" 2>/dev/null || true)
HELP_CT=$(curl -sSI "$BASE/mcp/help" 2>/dev/null | grep -i '^content-type:' | tr -d '\r')
if [ "$HELP_STATUS" = "200" ] && echo "$HELP_CT" | grep -qi 'text/html'; then ok "/mcp/help returns HTML 200"; else ko "/mcp/help failed: status=$HELP_STATUS ct=$HELP_CT"; fi
HELP_BODY=$(curl -fsS "$BASE/mcp/help" 2>/dev/null || true)
if printf '%s' "$HELP_BODY" | grep -q 'rotv-mcp' && printf '%s' "$HELP_BODY" | grep -q 'tv_concierge'; then ok "/mcp/help mentions rotv-mcp + tv_concierge"; else ko "/mcp/help body missing key terms"; fi

header "23. v3.1 tv_important_today shape"
R=$(jrpc '{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"tv_important_today","arguments":{"min_tier":2}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"events"'; then ok "tv_important_today returns events shape"; else ko "tv_important_today failed"; printf '   %s\n' "$R" | head -c 500; fi

header "24. v3.1 tv_concierge exposes important_today"
R=$(jrpc '{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"tv_concierge","arguments":{"duration_hours":2}}}' 2>/dev/null || true)
if printf '%s' "$R" | grep -q '"important_today"'; then ok "tv_concierge includes important_today"; else ko "tv_concierge missing important_today"; printf '   %s\n' "$R" | head -c 500; fi

printf "\n\033[1mResults:\033[0m \033[32m%d pass\033[0m / \033[31m%d fail\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
