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

// Priorul de conținut pentru TV, când nu există un rating măsurat. Până la
// 1 oct 2026 orice program TV primea 0,5 constant, deci între programele TV
// decidea doar geometria ferestrei (durată + oră de start) și câștigau blocuri
// despre care ghidul nu spune nimic. Valorile NU sunt un rating: spun cât de
// mult descrie EPG-ul programul (categorie de conținut + sinopsis), iar nota
// din breakdown o spune explicit.
const NARRATIVE_CATS = new Set(['film', 'film de scurt metraj', 'concert']);
const SERIES_CATS = new Set(['serial', 'documentar']);
const TITLE_CARRIES_CATS = new Set(['film', 'film de scurt metraj', 'concert', 'serial', 'documentar']);
const foldCat = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[şș]/g, 's').replace(/[ţț]/g, 't').trim();

export function tvContentPrior(program) {
  const cat = foldCat(program?.category);
  const described = (program?.description || '').trim().length >= 40;
  if (described && NARRATIVE_CATS.has(cat)) return { value: 0.6, note: `fără rating; EPG: ${program.category} cu sinopsis` };
  if (described && SERIES_CATS.has(cat)) return { value: 0.55, note: `fără rating; EPG: ${program.category} cu sinopsis` };
  // La sport titlul E conținutul („LIVE Tenis", „Nations League: Spania-Croatia"):
  // lipsa sinopsisului nu spune nimic despre transmisie.
  if (cat === 'sport') return { value: 0.5, note: 'fără rating; EPG: transmisie sportivă' };
  if (described) return { value: 0.5, note: 'fără rating; EPG: program cu descriere' };
  if (TITLE_CARRIES_CATS.has(cat)) return { value: 0.45, note: `fără rating; EPG: ${program.category} fără descriere` };
  return { value: 0.3, note: 'fără rating; EPG nu descrie programul' };
}

export const MIN_VOTES_FOR_RATING = 50;

// Mediana notelor IMDb per categorie EPG, din grila încărcată. Sub 30 de
// titluri notate într-o categorie nu există mediană (nota nu se folosește).
const medianMemo = new WeakMap();
export function imdbMedians(epg) {
  if (!epg) return {};
  if (medianMemo.has(epg)) return medianMemo.get(epg);
  const byCat = new Map();
  const seen = new Set();
  for (const ch of (epg.channels || [])) {
    for (const p of (ch.programs || [])) {
      if (!(p.imdbRating > 0)) continue;
      const key = `${p.category}|${p.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byCat.has(p.category)) byCat.set(p.category, []);
      byCat.get(p.category).push(p.imdbRating);
    }
  }
  const out = {};
  for (const [cat, list] of byCat) {
    if (list.length < 30) continue;
    list.sort((a, b) => a - b);
    out[cat] = list[Math.floor(list.length / 2)];
  }
  medianMemo.set(epg, out);
  return out;
}

// NU unifica scara TV cu cea de streaming fără o decizie de produs. O notă egală
// valorează azi cu ~0,34 mai mult la TV (un film TV cu 7,5 → 0,84; unul din
// catalog cu 7,5 → 0,5), adică ~5 puncte de încredere. Unificarea a fost
// măsurată la 1 oct 2026 și respinsă: streamingul câștiga 36 din 36 de ferestre
// mixte, cu ACELAȘI titlu la orice oră (catalogul e mereu disponibil și e
// selectat pe note mari), deci răspunsul nu mai depindea de ce e la TV.
// Decalajul funcționează ca primă pentru „e acum, nu oricând".
export function ratingSignal(candidate) {
  // Rating măsurat: catalogul de streaming, sau — pentru TV — același titlu
  // găsit în catalog (xref), când potrivirea e sigură.
  let va = null;
  let via = '';
  if (candidate.source === 'streaming') {
    // Un rating din câteva voturi nu e o măsurătoare: 7,9 din 9 voturi bătea
    // filme cu zeci de mii de voturi. Sub prag rămâne neutru și o spune.
    const votes = candidate.vote_count;
    if (Number.isFinite(votes) && votes < MIN_VOTES_FOR_RATING) {
      return { value: 0.5, note: `rating din ${votes} voturi — prea puține ca să conteze (default 0.5)` };
    }
    va = candidate.vote_average;
  }
  // TV: nota IMDb pe care sursa EPG o atașează chiar acestui program e cea mai
  // sigură — nu depinde de potrivirea unui titlu cu catalogul.
  // Se măsoară FAȚĂ DE mediana categoriei din grila curentă: un program fără
  // notă primește valoarea implicită a categoriei, deci unul cu nota mediană
  // trebuie să primească exact atât. Legarea directă pe scara (notă − 5) / 5
  // pedepsea orice film cu notă măsurată (mediana filmelor TV e 6,3 → 0,26)
  // față de unul fără notă (0,6): la măsurătoare, 32 din 144 de ferestre
  // treceau pe transmisii sportive nedescrise.
  else if (candidate.shaped?.program?.imdb_rating > 0 && Number.isFinite(candidate._imdbMedian)) {
    const r = candidate.shaped.program.imdb_rating;
    const base = tvContentPrior(candidate.shaped.program).value;
    const value = clamp(base + (r - candidate._imdbMedian) / 5, 0, 1);
    return { value, note: `IMDb ${r.toFixed(1)} din ghidul TV (mediana categoriei azi: ${candidate._imdbMedian.toFixed(1)})` };
  }
  else if (Number.isFinite(candidate._xref?.vote_average) && candidate._xref.vote_average > 0) {
    va = candidate._xref.vote_average;
    via = ' (același titlu în catalogul de streaming)';
  }
  if (va === null || va === undefined || !Number.isFinite(va)) {
    if (candidate.source === 'tv' && candidate.shaped?.program) {
      return tvContentPrior(candidate.shaped.program);
    }
    return { value: 0.5, note: 'fără rating (default 0.5)' };
  }
  const value = clamp((va - 5) / 5, 0, 1);
  const providers = candidate.provider_name ? ` (${candidate.provider_name})` : '';
  return { value, note: `voteAverage ${va.toFixed(1)}${providers}${via}` };
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

// Disponibilitate pentru TV. Până la 1 oct 2026 scădea la 0 pentru orice start
// la peste 30 de minute de începutul ferestrei, în ambele direcții, deci într-o
// seară 20:00–24:00 filmul de la 21:30 nu putea fi niciodată alegerea
// principală. Cele două direcții nu sunt simetrice:
//  - început ÎNAINTE de fereastră = minute pierdute din program: scara strictă
//    de 30 de minute rămâne;
//  - început DUPĂ = timp de așteptat, pe care cronologia îl arată ca pauză:
//    toleranța e jumătate din fereastră (cel puțin 30 de minute).
export const AVAILABILITY_MISSED_TOLERANCE_MIN = 30;
export function availabilityAxis(candidate, winStartUtc, winDurationMin = 60) {
  if (candidate.source === 'streaming') {
    return { value: 1.0, note: 'streaming oricând' };
  }
  const startMs = new Date(candidate.shaped.program.start_utc).getTime();
  const delta = (startMs - winStartUtc.getTime()) / 60_000;
  if (delta < 0) {
    const missed = -delta;
    return {
      value: clamp(1 - missed / AVAILABILITY_MISSED_TOLERANCE_MIN, 0, 1),
      note: `TV început cu ${Math.round(missed)} min înainte de fereastră (toleranță ${AVAILABILITY_MISSED_TOLERANCE_MIN} min)`,
    };
  }
  const tolerance = Math.max(AVAILABILITY_MISSED_TOLERANCE_MIN, winDurationMin / 2);
  return {
    value: clamp(1 - delta / tolerance, 0, 1),
    note: `TV începe la +${Math.round(delta)} min în fereastră (toleranță ${Math.round(tolerance)} min)`,
  };
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

// Plafon de geometrie: pentru un program TV pe care EPG-ul nu îl descrie
// (prior de conținut sub 0,5) și care nu e eveniment important, „durata se
// potrivește cu fereastra" și „începe exact la ora cerută" nu pot valora mai
// mult de jumătate. Altfel un bloc de 180 de minute despre care nu știm nimic
// bate un film descris doar pentru că umple mai bine intervalul.
export const UNDESCRIBED_GEOMETRY_CAP = 0.5;
export function capGeometryForUndescribed(candidate, axes) {
  if (candidate.source !== 'tv') return axes;
  if (!(axes.rating_signal.value < 0.5)) return axes;
  if ((axes.event_importance?.value ?? 0) > 0) return axes;
  const cap = (axis) => (axis.value > UNDESCRIBED_GEOMETRY_CAP
    ? { value: UNDESCRIBED_GEOMETRY_CAP, note: `${axis.note} — plafonat la ${UNDESCRIBED_GEOMETRY_CAP}: EPG nu descrie programul` }
    : axis);
  return { ...axes, time_fit: cap(axes.time_fit), availability: cap(axes.availability) };
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
