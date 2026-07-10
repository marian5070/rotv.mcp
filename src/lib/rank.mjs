const CHANNEL_CAT_SCORE = {
  'Filme & Seriale': 3,
  'Documentare': 3,
  'Generaliste': 1,
  'Copii': 1,
  'Sport': 0.5,
  'Muzică': 0.25,
  'Altele': 0,
  'Știri': -10,
  'General': 0,
};

const PREFERENCE_TO_CATEGORY = {
  filme: 'Filme & Seriale',
  seriale: 'Filme & Seriale',
  documentare: 'Documentare',
  sport: 'Sport',
  copii: 'Copii',
  muzica: 'Muzică',
};

export function scoreShaped(item, { prefer = [], excludeNews = true, now = new Date() } = {}) {
  let score = 0;
  const cat = item.channel_category;

  if (excludeNews && cat === 'Știri') return null;

  score += CHANNEL_CAT_SCORE[cat] ?? 0;

  if (prefer.length) {
    const preferredCats = prefer.map((p) => PREFERENCE_TO_CATEGORY[p]).filter(Boolean);
    if (preferredCats.includes(cat)) score += 2;
  }

  const programCat = item.program.category;
  if (programCat && programCat !== 'General') score += 0.5;

  const startMs = new Date(item.program.start_utc).getTime();
  const deltaMin = (startMs - now.getTime()) / 60_000;
  if (deltaMin >= -5 && deltaMin <= 60) score += 2;

  if (item.program.duration_min >= 45 && item.program.duration_min <= 180) score += 0.5;

  return score;
}

export function buildWhy(item) {
  const startMs = new Date(item.program.start_utc).getTime();
  const deltaMin = Math.round((startMs - Date.now()) / 60_000);
  let when;
  if (deltaMin <= 0 && deltaMin > -120) when = 'în desfășurare';
  else if (deltaMin > 0 && deltaMin <= 90) when = `începe în ${deltaMin} min`;
  else when = item.program.start_local;

  const catNote = {
    'Filme & Seriale': 'Film/serial',
    'Documentare': 'Documentar',
    'Generaliste': 'Program generalist',
    'Copii': 'Pentru copii',
    'Sport': 'Sport',
    'Muzică': 'Muzică',
    'Altele': 'Program',
    'Știri': 'Știri',
    'General': 'Program',
  }[item.channel_category] || 'Program';

  return `${catNote} pe ${item.channel_name}, ${when}`;
}

export function dedupByTitle(items) {
  const seen = new Map();
  for (const it of items) {
    const key = (it.program.title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const prev = seen.get(key);
    if (!prev || (it._score ?? 0) > (prev._score ?? 0)) seen.set(key, it);
  }
  return [...seen.values()];
}

export { CHANNEL_CAT_SCORE, PREFERENCE_TO_CATEGORY };
