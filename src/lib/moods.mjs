import { normalize } from './text.mjs';

const FALLBACK_MOOD = {
  key: 'oricine',
  label_ro: 'Oricine',
  pref_channel_cats: [],
  pref_genres: [],
  excl_channel_cats: ['Știri'],
  excl_genres: [],
  duration_min: 30,
  duration_max: 180,
  pref_keywords: [],
  excl_keywords: [],
};

export const MOODS = {
  obosit: {
    key: 'obosit',
    label_ro: 'Obosit / Relaxat',
    pref_channel_cats: ['Filme & Seriale', 'Generaliste', 'Documentare'],
    pref_genres: ['Comedie', 'Familie', 'Romantic', 'Animaţie', 'Muzică'],
    excl_channel_cats: ['Știri', 'Sport'],
    excl_genres: ['Horror', 'Thriller', 'Război', 'Mister'],
    duration_min: 30,
    duration_max: 110,
    pref_keywords: ['comedie', 'comedy', 'sitcom', 'feel-good', 'usor', 'light', 'familie', 'family', 'relax'],
    excl_keywords: ['razboi', 'crima', 'oroare', 'terror', 'brutal', 'intens'],
  },
  vesel: {
    key: 'vesel',
    label_ro: 'Vesel / Energic',
    pref_channel_cats: ['Filme & Seriale', 'Muzică', 'Generaliste'],
    pref_genres: ['Comedie', 'Familie', 'Animaţie', 'Muzică', 'Aventuri'],
    excl_channel_cats: ['Știri'],
    excl_genres: ['Horror', 'Război', 'Dramă', 'Crimă'],
    duration_min: 30,
    duration_max: 150,
    pref_keywords: ['comedie', 'comedy', 'fun', 'party', 'muzica', 'music', 'show', 'divertisment', 'amuzant'],
    excl_keywords: ['trist', 'drama', 'tragic', 'razboi', 'doliu'],
  },
  concentrat: {
    key: 'concentrat',
    label_ro: 'Concentrat / Curios',
    pref_channel_cats: ['Documentare', 'Filme & Seriale'],
    pref_genres: ['Dramă', 'Mister', 'Crimă', 'Thriller', 'SF'],
    excl_channel_cats: ['Muzică', 'Copii', 'Știri'],
    excl_genres: ['Animaţie', 'Familie'],
    duration_min: 60,
    duration_max: 240,
    pref_keywords: ['documentar', 'documentary', 'dosar', 'case', 'ancheta', 'investigation', 'istoric', 'history', 'biografie', 'biography', 'stiinta', 'science'],
    excl_keywords: ['reality', 'talk-show', 'telenovela'],
  },
  romantic: {
    key: 'romantic',
    label_ro: 'Romantic / Date-night',
    pref_channel_cats: ['Filme & Seriale'],
    pref_genres: ['Romantic', 'Dramă', 'Comedie', 'Muzică'],
    excl_channel_cats: ['Știri', 'Sport', 'Copii'],
    excl_genres: ['Horror', 'Război', 'Crimă'],
    duration_min: 75,
    duration_max: 140,
    pref_keywords: ['dragoste', 'love', 'romantic', 'cuplu', 'couple', 'nunta', 'wedding', 'povestea'],
    excl_keywords: ['crima', 'oroare', 'sange', 'brutal', 'masacru'],
  },
  familie: {
    key: 'familie',
    label_ro: 'În familie',
    pref_channel_cats: ['Copii', 'Filme & Seriale', 'Generaliste', 'Documentare'],
    pref_genres: ['Familie', 'Animaţie', 'Aventuri', 'Comedie', 'Muzică'],
    excl_channel_cats: ['Știri'],
    excl_genres: ['Horror', 'Thriller', 'Crimă', 'Război', 'Mister'],
    duration_min: 45,
    duration_max: 130,
    pref_keywords: ['familie', 'family', 'copii', 'kids', 'animatie', 'animation', 'aventura', 'adventure', 'povestea', 'disney', 'pixar'],
    excl_keywords: ['violenta', 'crima', 'oroare', 'nud', 'sange', 'razboi'],
  },
  captivant: {
    key: 'captivant',
    label_ro: 'Captivant / Intens',
    pref_channel_cats: ['Filme & Seriale', 'Sport'],
    pref_genres: ['Thriller', 'Acțiune', 'Crimă', 'Mister', 'SF', 'Război'],
    excl_channel_cats: ['Știri', 'Muzică', 'Copii'],
    excl_genres: ['Familie', 'Animaţie', 'Romantic'],
    duration_min: 60,
    duration_max: 180,
    pref_keywords: ['actiune', 'action', 'thriller', 'suspans', 'urmarire', 'chase', 'agent', 'misiune', 'mission'],
    excl_keywords: ['comedie usoara', 'telenovela', 'slice-of-life'],
  },
};

const ALIASES = {
  tired: 'obosit', chill: 'obosit', relaxat: 'obosit', 'low-energy': 'obosit', lazy: 'obosit',
  happy: 'vesel', fun: 'vesel', upbeat: 'vesel', energic: 'vesel',
  focused: 'concentrat', deep: 'concentrat', serios: 'concentrat', curios: 'concentrat',
  'date-night': 'romantic', datenight: 'romantic', cuplu: 'romantic',
  family: 'familie', 'kids-friendly': 'familie',
  thrilling: 'captivant', intens: 'captivant', palpitant: 'captivant', suspans: 'captivant', adrenalina: 'captivant', action: 'captivant',
};

export function resolveMood(raw) {
  if (!raw) return { ...FALLBACK_MOOD };
  const norm = normalize(raw);
  if (MOODS[norm]) return { ...MOODS[norm] };
  const aliasKey = ALIASES[norm];
  if (aliasKey && MOODS[aliasKey]) return { ...MOODS[aliasKey] };
  for (const [k, mood] of Object.entries(MOODS)) {
    if (norm.includes(k) || k.includes(norm)) return { ...mood };
  }
  return { ...FALLBACK_MOOD };
}

function pickStrings(arr) {
  return Array.isArray(arr) ? arr.map((s) => normalize(String(s || ''))).filter(Boolean) : [];
}

function containsAny(haystack, needles) {
  if (!needles?.length) return false;
  const h = normalize(haystack);
  return needles.some((n) => h.includes(n));
}

export function moodFit(shapedItem, extractedGenres, mood) {
  const parts = [];
  let score = 0;
  const cat = shapedItem.channel_category;
  const dur = shapedItem.program.duration_min;
  const title = shapedItem.program.title || '';
  const desc = shapedItem.program.description || '';
  const haystack = `${title} ${desc}`;

  if (mood.pref_channel_cats.includes(cat)) { score += 1; parts.push(`canal preferat (+1) — ${cat}`); }
  if (mood.excl_channel_cats.includes(cat)) { score -= 2; parts.push(`canal exclus (-2) — ${cat}`); }

  const prefGenres = pickStrings(mood.pref_genres);
  const exclGenres = pickStrings(mood.excl_genres);
  let genreHits = 0;
  let exclHit = false;
  for (const g of (extractedGenres || [])) {
    const gnorm = normalize(g.genre || g);
    if (prefGenres.includes(gnorm)) genreHits++;
    if (exclGenres.includes(gnorm)) exclHit = true;
  }
  if (genreHits > 0) {
    const v = Math.min(1.5, genreHits * 1.0);
    score += v;
    parts.push(`genuri preferate +${v} — ${genreHits} match`);
  }
  if (exclHit) { score -= 1.5; parts.push('gen exclus -1.5'); }

  if (dur >= mood.duration_min && dur <= mood.duration_max) {
    score += 0.5;
    parts.push(`durata în band +0.5 (${dur} min)`);
  }

  if (containsAny(haystack, mood.pref_keywords)) {
    score += 0.5;
    parts.push('keyword preferat +0.5');
  }
  if (containsAny(haystack, mood.excl_keywords)) {
    score -= 1;
    parts.push('keyword exclus -1');
  }

  return { score: Math.round(score * 100) / 100, parts };
}

export function moodLabels() {
  return Object.values(MOODS).map((m) => ({ key: m.key, label_ro: m.label_ro }));
}
