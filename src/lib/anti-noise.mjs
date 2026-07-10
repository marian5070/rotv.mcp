import { normalize } from './text.mjs';

export const NOISE_CATEGORIES = {
  politica: {
    label: 'Politică / dezbateri',
    title_anchors: [
      'politic', 'dezbatere', 'alegeri', 'parlament', 'comentariu politic',
      'actualitate politic', 'settimana politica', 'jocuri de putere',
    ],
    title_anchors_en: ['politics', 'political', 'parliament', 'election', 'debate'],
    channel_categories: [],
  },
  reality: {
    label: 'Reality show',
    title_anchors: [
      'mireasa', 'survivor', 'insula iubirii', 'x factor', 'vocea romaniei',
      'asia express', 'chefi la cutite', 'ferma', 'fermierul', 'big brother',
      'power couple', 'casa iubirii',
    ],
    title_anchors_en: ['reality', 'big brother'],
    channel_categories: [],
  },
  talkshow: {
    label: 'Talk show',
    title_anchors: [
      'talk show', 'talk-show', 'vorbeste', 'garantat', 'in gura', 'neatza',
      'dragostea vorbeste', 'rai da buni', 'sinteza zilei',
    ],
    title_anchors_en: ['talk show', 'late show'],
    channel_categories: [],
  },
  stiri: {
    label: 'Știri / breaking news',
    title_anchors: [
      'stirile', 'jurnalul', 'observator', 'breaking news', 'editia de',
      'principalele stiri', 'flash news',
    ],
    title_anchors_en: ['news bulletin', 'evening news'],
    channel_categories: ['Știri'],
  },
};

export const NOISE_CATEGORY_KEYS = Object.keys(NOISE_CATEGORIES);

export function detectNoise(candidate, enabledCategories) {
  if (!enabledCategories?.length) {
    return { is_noise: false, category: null, anchors: [] };
  }

  let title = '';
  let channelCategory = null;

  if (candidate.source === 'tv') {
    title = candidate.shaped?.program?.title || '';
    channelCategory = candidate.shaped?.channel_category || null;
  } else if (candidate.source === 'streaming') {
    title = `${candidate.title || ''} ${candidate.original_title || ''}`.trim();
  }

  const normTitle = normalize(title);

  for (const cat of enabledCategories) {
    const def = NOISE_CATEGORIES[cat];
    if (!def) continue;

    if (channelCategory && def.channel_categories.includes(channelCategory)) {
      return {
        is_noise: true,
        category: cat,
        anchors: [`channel_category=${channelCategory}`],
      };
    }

    const hits = [];
    for (const anchor of def.title_anchors) {
      if (normTitle.includes(anchor)) hits.push(anchor);
    }
    for (const anchor of def.title_anchors_en) {
      if (normTitle.includes(anchor)) hits.push(anchor);
    }
    if (hits.length) {
      return { is_noise: true, category: cat, anchors: hits.slice(0, 4) };
    }
  }

  return { is_noise: false, category: null, anchors: [] };
}
