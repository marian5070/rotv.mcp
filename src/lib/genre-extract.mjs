import { normalize } from './text.mjs';

export const GENRE_ANCHORS = {
  'Acțiune': ['actiune', 'urmarire', 'explozie', 'agent', 'comando', 'lupta', 'misiune', 'mercenar', 'action', 'fight', 'chase', 'mission', 'gunfight', 'special forces', 'terorist'],
  'Aventuri': ['aventura', 'aventuri', 'expeditie', 'calatorie', 'descoperire', 'jungla', 'comoara', 'adventure', 'quest', 'expedition', 'voyage', 'treasure', 'journey', 'explorer', 'pirat'],
  'Dramă': ['drama', 'sentimente', 'tragedie', 'doliu', 'pierdere', 'familie destramata', 'tragedy', 'life story', 'grief', 'loss', 'biopic', 'struggle', 'biografic', 'evenimente reale', 'poveste adevarata'],
  'SF': ['science', 'viitor', 'robot', 'extraterestr', 'planeta', 'galactic', 'intergalactic', 'spatial', 'sci-fi', 'science fiction', 'future', 'alien', 'space', 'cyborg', 'dystopia'],
  'Thriller': ['thriller', 'suspans', 'conspiratie', 'urmarit', 'amenintare', 'fugar', 'suspense', 'conspiracy', 'manhunt', 'pursuit', 'hostage', 'ostatic', 'complot', 'santaj', 'razbun'],
  'Comedie': ['comedie', 'comic', 'amuzant', 'hazliu', 'sitcom', 'parodie', 'satira', 'gluma', 'comedy', 'parody', 'satire', 'funny', 'hilarious', 'stand-up', 'ghinionist'],
  'Fantasy': ['fantezie', 'fantastic', 'vrajitor', 'magie', 'dragon', 'regat', 'mit', 'legenda', 'fantasy', 'magic', 'wizard', 'kingdom', 'myth', 'legend', 'enchanted'],
  'Familie': ['familie', 'copii', 'animatie usoara', 'poveste', 'basm', 'family', 'kids', 'friendly', 'heartwarming', 'all-ages', 'holiday'],
  'Animaţie': ['animatie', 'desen animat', 'animat', 'anime', 'animation', 'animated', 'cartoon', 'cgi', 'pixar', 'dreamworks'],
  'Crimă': ['crima', 'ucigas', 'detectiv', 'ancheta', 'criminal', 'mafia', 'dosar', 'omor', 'crime', 'killer', 'detective', 'murder', 'heist', 'gangster', 'noir', 'omucidere', 'politist', 'politie', 'comisar', 'jaf', 'mafi', 'asasin', 'infractor', 'traficant', 'hoti', 'ucider'],
  'Romantic': ['dragoste', 'indragost', 'romantica', 'iubire', 'cuplu', 'nunta', 'sarut', 'romance', 'romantic', 'love story', 'wedding', 'kiss', 'dating', 'rom-com'],
  'Horror': ['horror', 'oroare', 'terifiant', 'demonic', 'fantoma', 'supranatural', 'masacru', 'scary', 'terrifying', 'ghost', 'haunted', 'slasher', 'supernatural', 'vampir', 'zombi'],
  'Mister': ['mister', 'misterios', 'enigma', 'disparitie', 'secret', 'neelucidat', 'mystery', 'mysterious', 'disappearance', 'unsolved', 'whodunit'],
  'Muzică': ['muzica', 'concert', 'live', 'recital', 'festival', 'melodie', 'cantec', 'music', 'song', 'musical', 'band'],
  'Război': ['razboi', 'front', 'soldat', 'batalie', 'militar', 'ostasi', 'ww2', 'wwii', 'holocaust', 'war', 'soldier', 'battle', 'military', 'normandy', 'nazist'],
};

// Potrivire pe cuvânt, nu pe subșir. Până la 1 oct 2026 se folosea includes()
// și „contrabandă" dădea Muzică (band), „emisiune" Acțiune (misiune),
// „intimitatea" Fantasy (mit), „Edward" Război (war).
//  - implicit: limită de cuvânt la ÎNCEPUT, sufix liber — păstrează flexiunile
//    românești (misterioasă, războinic, aventurile, muzical);
//  - STRICT: ancore scurte/ambigue, doar formele listate (cuvânt întreg) —
//    altfel „frontieră", „bandits", „Warner", „questions", „lived" ar trece.
// Ancorele românești adăugate la 1 oct 2026 seara au fost măsurate pe grila
// zilei, una câte una, cu context: au rămas doar cele fără potriviri false.
// Respinse la măsurătoare: inspector (inspectori de animale), ucis, periculos,
// anchet / investiga (jurnale de știri), demon (demonstreze), arme (armenii),
// iubit (iubitor de folclor), salbatic, adolescent, supravietui, monstru.
const STRICT_FORMS = {
  band: 'bands?',
  front: 'front(?:ul|ului|uri|urile|urilor|line|lines)?',
  war: 'wars?',
  live: 'live',
  mit: 'mit(?:ul|ului|uri|urile|urilor)?',
  quest: 'quests?',
  action: 'actions?',
  song: 'songs?',
  noir: 'noir',
  alien: 'aliens?',
  loss: 'loss(?:es)?',
  hoti: 'hoti(?:i|lor)?',
  jaf: 'jaf(?:ul|ului|uri|urile|urilor)?',
};
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';
const ANCHOR_RX = Object.entries(GENRE_ANCHORS).map(([genre, anchors]) => [
  genre,
  [...anchors]
    .sort((a, b) => b.length - a.length)
    .map((anchor) => ({
      anchor,
      rx: new RegExp(
        Object.hasOwn(STRICT_FORMS, anchor) ? `${B}${STRICT_FORMS[anchor]}${E}` : `${B}${escapeRx(anchor)}`,
        'g',
      ),
    })),
]);

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
  for (const [genre, compiled] of ANCHOR_RX) {
    // Ancorele lungi întâi: o ancoră care se potrivește DOAR pe cuvinte deja
    // acoperite de alta (legend ⊂ legenda, detectiv ⊂ detective) nu se numără
    // a doua oară.
    const covered = new Set();
    const hitSet = new Set();
    for (const { anchor, rx } of compiled) {
      let fresh = false;
      for (const m of haystack.matchAll(rx)) {
        if (!covered.has(m.index)) fresh = true;
        covered.add(m.index);
      }
      if (fresh) hitSet.add(anchor);
    }
    if (hitSet.size === 0) continue;
    const hits = GENRE_ANCHORS[genre].filter((a) => hitSet.has(a));
    const inTitle = compiled.some(({ anchor, rx }) => hitSet.has(anchor) && title.search(rx) !== -1);
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
