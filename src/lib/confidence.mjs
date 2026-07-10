function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

export const CONFIDENCE_WEIGHTS = {
  rating_signal: 0.15,
  mood_fit: 0.20,
  time_fit: 0.20,
  availability: 0.15,
  opportunity_cost: 0.15,
  event_importance: 0.15,
};

export function ratingSignal(candidate) {
  let va = null;
  if (candidate.source === 'streaming') va = candidate.vote_average;
  if (va === null || va === undefined || !Number.isFinite(va)) {
    return { value: 0.5, note: 'fără rating (default 0.5)' };
  }
  const value = clamp((va - 5) / 5, 0, 1);
  const providers = candidate.provider_name ? ` (${candidate.provider_name})` : '';
  return { value, note: `voteAverage ${va.toFixed(1)}${providers}` };
}

export function moodFitAxis(moodScore) {
  const safeScore = Number.isFinite(moodScore) ? moodScore : 0;
  return { value: clamp((safeScore + 3.5) / 7, 0, 1), note: `mood_fit score ${safeScore}` };
}

export function timeFitAxis(candidate, winDurationMin) {
  if (candidate.source === 'tv') {
    const dur = candidate.shaped?.program?.duration_min ?? 0;
    const value = clamp(1 - Math.abs(dur - winDurationMin) / winDurationMin, 0, 1);
    return { value, note: `TV ${dur} min vs window ${winDurationMin} min` };
  }
  const rt = candidate.runtime;
  if (rt === null || rt === undefined) {
    return { value: 0.7, note: 'streaming fără runtime (default 0.7)' };
  }
  return { value: clamp(rt / winDurationMin, 0.5, 1.0), note: `runtime ${rt} min vs window ${winDurationMin} min` };
}

export function availabilityAxis(candidate, winStartUtc) {
  if (candidate.source === 'streaming') {
    return { value: 1.0, note: 'streaming oricând' };
  }
  const startMs = new Date(candidate.shaped.program.start_utc).getTime();
  const dt = Math.abs(startMs - winStartUtc.getTime()) / 60_000;
  return { value: clamp(1 - dt / 30, 0, 1), note: `TV start ±${Math.round(dt)} min vs window start` };
}

// Event-importance axis: fed by assessImportance() (lib/importance.mjs) via
// candidate._importance. A World Cup match must not lose to a filler movie
// just because the EPG gives it no rating, no genre and an empty description.
export function importanceAxis(candidate) {
  const imp = candidate._importance;
  if (!imp || !(imp.score > 0)) {
    return { value: 0, note: 'no event-importance signal' };
  }
  const why = imp.reasons?.[0] ? ` — ${imp.reasons[0]}` : '';
  return { value: imp.score, note: `event importance ${imp.score} (tier ${imp.tier})${why}` };
}

export function opportunityAxis(candidate, windowMaxComposite) {
  if (!windowMaxComposite || windowMaxComposite <= 0) {
    return { value: 0.5, note: 'no composite peer' };
  }
  const value = clamp((candidate._composite ?? 0) / windowMaxComposite, 0, 1);
  return {
    value,
    note: `composite ${(candidate._composite ?? 0).toFixed(2)} vs window max ${windowMaxComposite.toFixed(2)}`,
  };
}

export function computeComposite(c, axes) {
  return 0.25 * axes.mood_fit.value
       + 0.20 * axes.time_fit.value
       + 0.20 * axes.rating_signal.value
       + 0.15 * axes.availability.value
       + 0.20 * (axes.event_importance?.value ?? 0);
}

export function computeConfidence(c, axes) {
  const w = CONFIDENCE_WEIGHTS;
  const total = w.rating_signal * axes.rating_signal.value
              + w.mood_fit * axes.mood_fit.value
              + w.time_fit * axes.time_fit.value
              + w.availability * axes.availability.value
              + w.opportunity_cost * axes.opportunity_cost.value
              + w.event_importance * (axes.event_importance?.value ?? 0);
  const pct = Math.round(total * 100);
  const label = pct >= 75 ? 'high' : pct >= 55 ? 'medium' : 'low';
  return { pct, label, total: round3(total) };
}

export function confidenceBreakdown(axes) {
  const w = CONFIDENCE_WEIGHTS;
  const make = (key) => ({
    weight: w[key],
    value: round2(axes[key].value),
    contribution: round3(w[key] * axes[key].value),
    note: axes[key].note,
  });
  return {
    rating_signal: make('rating_signal'),
    mood_fit: make('mood_fit'),
    time_fit: make('time_fit'),
    availability: make('availability'),
    opportunity_cost: make('opportunity_cost'),
    ...(axes.event_importance ? { event_importance: make('event_importance') } : {}),
  };
}
