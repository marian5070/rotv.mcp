import { localFromUtc } from './time.mjs';

function makeTvSegment(c, order) {
  return {
    order,
    kind: 'tv',
    channel_id: c.shaped.channel_id,
    channel_name: c.shaped.channel_name,
    channel_category: c.shaped.channel_category,
    title: c.shaped.program.title,
    start_local: c.shaped.program.start_local,
    stop_local: c.shaped.program.stop_local,
    start_utc: c.shaped.program.start_utc,
    stop_utc: c.shaped.program.stop_utc,
    duration_min: c.shaped.program.duration_min,
    extracted_genres: (c._genres || []).map((g) => g.genre),
    confidence_pct: c._confidence?.pct ?? null,
  };
}

function makeStreamingSegment(c, order, startUtc, durationMin) {
  const stopUtc = new Date(startUtc.getTime() + durationMin * 60_000);
  return {
    order,
    kind: 'streaming',
    provider_id: c.provider_id,
    provider_name: c.provider_name,
    media_kind: c.kind,
    tmdb_id: c.tmdb_id,
    title: c.title,
    original_title: c.original_title,
    year: c.year,
    start_local: localFromUtc(startUtc),
    stop_local: localFromUtc(stopUtc),
    start_utc: startUtc.toISOString(),
    stop_utc: stopUtc.toISOString(),
    duration_min: durationMin,
    extracted_genres: (c._genres || []).map((g) => g.genre),
    vote_average: c.vote_average,
    confidence_pct: c._confidence?.pct ?? null,
  };
}

function makePauseSegment(order, startUtc, stopUtc) {
  const durMin = Math.max(0, Math.round((stopUtc.getTime() - startUtc.getTime()) / 60_000));
  return {
    order,
    kind: 'pause',
    start_local: localFromUtc(startUtc),
    stop_local: localFromUtc(stopUtc),
    start_utc: startUtc.toISOString(),
    stop_utc: stopUtc.toISOString(),
    duration_min: durMin,
    note: `pauză ${durMin} min — schimbă-ți poziția / ia o gustare / schimbă canalul`,
  };
}

export function buildTimeline(primary, { windowStart, windowEnd, allowPauses }) {
  const segments = [];
  let order = 1;
  let cursor = new Date(windowStart);

  if (primary.source === 'tv') {
    const segStart = new Date(primary.shaped.program.start_utc);
    if (allowPauses && segStart.getTime() - cursor.getTime() >= 5 * 60_000) {
      segments.push(makePauseSegment(order++, cursor, segStart));
    }
    segments.push(makeTvSegment(primary, order++));
    cursor = new Date(primary.shaped.program.stop_utc);
  } else {
    const fallbackDur = Math.round((windowEnd.getTime() - windowStart.getTime()) / 60_000);
    const dur = primary.runtime ?? fallbackDur;
    const segStart = new Date(windowStart);
    segments.push(makeStreamingSegment(primary, order++, segStart, dur));
    cursor = new Date(segStart.getTime() + dur * 60_000);
  }

  if (allowPauses && cursor.getTime() < windowEnd.getTime()
      && (windowEnd.getTime() - cursor.getTime()) >= 5 * 60_000) {
    segments.push(makePauseSegment(order++, cursor, windowEnd));
  }

  return segments;
}

export function buildDegradedTimeline(primaries, { windowStart, windowEnd, allowPauses }) {
  const segments = [];
  let order = 1;
  let cursor = new Date(windowStart);

  for (const p of primaries) {
    if (cursor >= windowEnd) break;

    if (p.source === 'tv') {
      let segStart = new Date(p.shaped.program.start_utc);
      if (segStart.getTime() < cursor.getTime()) segStart = new Date(cursor);
      if (segStart >= windowEnd) break;

      if (allowPauses && segStart.getTime() - cursor.getTime() >= 5 * 60_000) {
        segments.push(makePauseSegment(order++, cursor, segStart));
      }
      segments.push(makeTvSegment(p, order++));
      cursor = new Date(p.shaped.program.stop_utc);
      if (cursor > windowEnd) cursor = new Date(windowEnd);
    } else {
      const dur = p.runtime ?? 60;
      const segStart = new Date(cursor);
      let stopUtc = new Date(segStart.getTime() + dur * 60_000);
      if (stopUtc > windowEnd) stopUtc = new Date(windowEnd);
      const actualDur = Math.max(0, Math.round((stopUtc.getTime() - segStart.getTime()) / 60_000));
      if (actualDur > 0) {
        segments.push(makeStreamingSegment(p, order++, segStart, actualDur));
        cursor = stopUtc;
      } else {
        break;
      }
    }
  }

  if (allowPauses && cursor.getTime() < windowEnd.getTime()
      && (windowEnd.getTime() - cursor.getTime()) >= 5 * 60_000) {
    segments.push(makePauseSegment(order++, cursor, windowEnd));
  }

  return segments;
}
