export function foldDiacritics(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ŞŞŚŜȘŞ]/g, 'S')
    .replace(/[şśŝșş]/g, 's')
    .replace(/[ŢȚ]/g, 'T')
    .replace(/[ţț]/g, 't');
}

export function normalize(str) {
  return foldDiacritics(String(str || '').toLowerCase()).trim();
}

export function tokenize(str) {
  return normalize(str).split(/[^a-z0-9]+/).filter(Boolean);
}

export function matchesQuery(haystack, query) {
  if (!query) return true;
  const h = normalize(haystack);
  const tokens = tokenize(query);
  return tokens.every((t) => h.includes(t));
}

export function similarTitle(a, b) {
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
}
