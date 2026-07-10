import { getEpgFull, getEpgHome, getStreaming } from '../data/store.mjs';

const EPG_REFRESH_UTC_HOURS = [3, 9, 15, 21];
const STREAMING_REFRESH_UTC_HOURS = [2];

function ageMinutes(iso, now) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}

function nextRefresh(now, hoursUtc) {
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  for (const target of hoursUtc) {
    if (target > h || (target === h && m === 0 && now.getUTCSeconds() === 0)) {
      const d = new Date(now);
      d.setUTCHours(target, 0, 0, 0);
      return d.toISOString();
    }
  }
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hoursUtc[0], 0, 0, 0);
  return d.toISOString();
}

function intervalMin(hoursUtc) {
  if (hoursUtc.length === 1) return 24 * 60;
  const sorted = [...hoursUtc].sort((a, b) => a - b);
  let minGap = 24;
  for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
  minGap = Math.min(minGap, 24 - sorted[sorted.length - 1] + sorted[0]);
  return minGap * 60;
}

function sourceStatus(name, file, payload, hoursUtc, now) {
  const generatedAt = payload?.generatedAt ?? null;
  const age = ageMinutes(generatedAt, now);
  const interval = intervalMin(hoursUtc);
  const stale = age !== null && age > 1.5 * interval;
  return {
    file,
    generated_at: generatedAt,
    age_minutes: age,
    expected_refresh_hours_utc: hoursUtc,
    expected_next_refresh_at: nextRefresh(now, hoursUtc),
    expected_interval_min: interval,
    stale,
    warning: stale ? `${name} mai vechi decât ${Math.round(1.5 * interval / 60)}h — verifică cron-ul rotv-guide.` : null,
  };
}

export function computeFreshness(now = new Date()) {
  const sources = {
    epg: sourceStatus('EPG normalizat', 'epg-normalized.json', getEpgFull(), EPG_REFRESH_UTC_HOURS, now),
    epg_home: sourceStatus('EPG homepage', 'epg-homepage.json', getEpgHome(), EPG_REFRESH_UTC_HOURS, now),
    streaming: sourceStatus('Streaming', 'streaming-full.json', getStreaming(), STREAMING_REFRESH_UTC_HOURS, now),
  };
  const overall_stale = Object.values(sources).some((s) => s.stale);
  const epgAge = sources.epg.age_minutes;
  const streamingAge = sources.streaming.age_minutes;
  return { sources, overall_stale, epgAge, streamingAge };
}

export function freshnessEmbed(now = new Date()) {
  const { sources, overall_stale } = computeFreshness(now);
  return {
    epg_age_min: sources.epg.age_minutes,
    streaming_age_min: sources.streaming.age_minutes,
    stale: overall_stale,
  };
}

export function summarizeFreshness(fresh) {
  const parts = [];
  const a = fresh.sources.epg.age_minutes;
  const s = fresh.sources.streaming.age_minutes;
  if (a !== null) {
    if (a < 60) parts.push(`EPG actualizat acum ${a} min`);
    else parts.push(`EPG actualizat acum ${Math.floor(a / 60)}h${a % 60 ? a % 60 + 'min' : ''}`);
  }
  if (s !== null) {
    if (s < 60) parts.push(`streaming acum ${s} min`);
    else parts.push(`streaming acum ${Math.floor(s / 60)}h${s % 60 ? s % 60 + 'min' : ''}`);
  }
  const tail = fresh.overall_stale ? ' — atenție, date învechite.' : ' — toate proaspete.';
  return parts.join(', ') + tail;
}
