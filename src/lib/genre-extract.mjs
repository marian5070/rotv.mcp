import { normalize } from './text.mjs';

export const GENRE_ANCHORS = {
  'Acțiune': ['actiune', 'urmarire', 'explozie', 'agent', 'comando', 'lupta', 'misiune', 'mercenar', 'action', 'fight', 'chase', 'mission', 'gunfight', 'special forces'],
  'Aventuri': ['aventura', 'aventuri', 'expeditie', 'calatorie', 'descoperire', 'jungla', 'comoara', 'adventure', 'quest', 'expedition', 'voyage', 'treasure', 'journey', 'explorer'],
  'Dramă': ['drama', 'sentimente', 'tragedie', 'doliu', 'pierdere', 'familie destramata', 'tragedy', 'life story', 'grief', 'loss', 'biopic', 'struggle'],
  'SF': ['science', 'viitor', 'robot', 'extraterestri', 'planeta', 'galactic', 'spatial', 'sci-fi', 'science fiction', 'future', 'alien', 'space', 'cyborg', 'dystopia'],
  'Thriller': ['thriller', 'suspans', 'conspiratie', 'urmarit', 'amenintare', 'fugar', 'suspense', 'conspiracy', 'manhunt', 'pursuit', 'hostage'],
  'Comedie': ['comedie', 'comic', 'amuzant', 'hazliu', 'sitcom', 'parodie', 'satira', 'gluma', 'comedy', 'parody', 'satire', 'funny', 'hilarious', 'stand-up'],
  'Fantasy': ['fantezie', 'fantastic', 'vrajitor', 'magie', 'dragon', 'regat', 'mit', 'legenda', 'fantasy', 'magic', 'wizard', 'kingdom', 'myth', 'legend', 'enchanted'],
  'Familie': ['familie', 'copii', 'animatie usoara', 'poveste', 'basm', 'family', 'kids', 'friendly', 'heartwarming', 'all-ages', 'holiday'],
  'Animaţie': ['animatie', 'desen animat', 'animat', 'anime', 'animation', 'animated', 'cartoon', 'cgi', 'pixar', 'dreamworks'],
  'Crimă': ['crima', 'ucigas', 'detectiv', 'ancheta', 'criminal', 'mafia', 'dosar', 'omor', 'crime', 'killer', 'detective', 'murder', 'heist', 'gangster', 'noir'],
  'Romantic': ['dragoste', 'romantica', 'iubire', 'cuplu', 'nunta', 'sarut', 'romance', 'romantic', 'love story', 'wedding', 'kiss', 'dating', 'rom-com'],
  'Horror': ['horror', 'oroare', 'terifiant', 'demonic', 'fantoma', 'supranatural', 'masacru', 'scary', 'terrifying', 'ghost', 'haunted', 'slasher', 'supernatural'],
  'Mister': ['mister', 'misterios', 'enigma', 'disparitie', 'secret', 'neelucidat', 'mystery', 'mysterious', 'disappearance', 'unsolved', 'whodunit'],
  'Muzică': ['muzica', 'concert', 'live', 'recital', 'festival', 'melodie', 'cantec', 'music', 'song', 'musical', 'band'],
  'Război': ['razboi', 'front', 'soldat', 'batalie', 'militar', 'ostasi', 'ww2', 'wwii', 'holocaust', 'war', 'soldier', 'battle', 'military', 'normandy'],
};

const memoStore = new WeakMap();

export function extractGenres(progTitle, progDesc, memoKey) {
  if (memoKey && memoStore.has(memoKey)) return memoStore.get(memoKey);

  const title = normalize(progTitle || '');
  const haystack = `${title} ${normalize(progDesc || '')}`;
  if (!haystack.trim()) {
    if (memoKey) memoStore.set(memoKey, []);
    return [];
  }

  const results = [];
  for (const [genre, anchors] of Object.entries(GENRE_ANCHORS)) {
    const hits = [];
    for (const anchor of anchors) {
      if (haystack.includes(anchor)) hits.push(anchor);
    }
    if (hits.length === 0) continue;
    const inTitle = hits.some((a) => title.includes(a));
    const score = hits.length + (inTitle ? 0.5 : 0);
    const confidence = Math.min(1, score / 3);
    results.push({ genre, confidence: Math.round(confidence * 100) / 100, anchors: hits.slice(0, 4) });
  }

  results.sort((a, b) => b.confidence - a.confidence);
  const top = results.slice(0, 3);
  if (memoKey) memoStore.set(memoKey, top);
  return top;
}

export function genreNames(extracted) {
  return (extracted || []).map((g) => g.genre);
}
