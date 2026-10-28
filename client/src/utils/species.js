// Species labels come from the server as canonical English keys (e.g. "fruit_fly").
// Older snapshots stored other labels, including Vietnamese names, so those are still
// recognized when reading. Display names live in the i18n files under `species.*`.

const FRUIT_FLY = 'fruit_fly';

// Legacy labels meaning "fruit fly" ('ruồi vàng' / 'ruoi vang' are the Vietnamese name)
const FRUIT_FLY_ALIASES = ['fruit_fly', 'fruit fly', 'fruit-fly', 'bactrocera', 'ruồi vàng', 'ruoi vang'];
// Legacy Vietnamese labels: 'bọ' = bug, 'sâu' = caterpillar
const BUG_ALIASES = ['bug', 'bọ'];
const CATERPILLAR_ALIASES = ['caterpillar', 'sâu'];
const MOTH_ALIASES = ['moth', 'bướm'];

const I18N_KEYS = {
  [FRUIT_FLY]: 'species.fruitFly',
  // Bycatch the detector tells apart from the fruit fly; the server never counts it as a pest
  other_insect: 'species.otherInsect',
  bug: 'species.bug',
  caterpillar: 'species.caterpillar',
  moth: 'species.moth'
};

const matches = (label, aliases) => aliases.some(alias => label.includes(alias));

/**
 * Map any known alias to its canonical key; unknown labels are returned unchanged.
 */
export function normalizeSpecies(label) {
  if (!label) return label;
  const s = String(label).toLowerCase();
  if (matches(s, FRUIT_FLY_ALIASES)) return FRUIT_FLY;
  if (matches(s, BUG_ALIASES)) return 'bug';
  if (matches(s, CATERPILLAR_ALIASES)) return 'caterpillar';
  if (matches(s, MOTH_ALIASES)) return 'moth';
  return label;
}

/**
 * Localized display name for a species label.
 */
export function speciesName(label, t) {
  if (!label) return '--';
  const key = I18N_KEYS[normalizeSpecies(label)];
  return key ? t(key) : label;
}

/**
 * Localize a "label (NN%)" string such as the API's topSpecies value.
 */
export function speciesShare(value, t) {
  if (!value || value === '--') return '--';
  const match = String(value).match(/^(.*?)\s*(\(\d+%\))$/);
  return match ? `${speciesName(match[1], t)} ${match[2]}` : speciesName(value, t);
}

/**
 * Merge a snapshot summary ({ label: count }) by canonical species key.
 */
export function normalizeSummary(summary = {}) {
  const result = {};
  for (const [label, count] of Object.entries(summary)) {
    const key = normalizeSpecies(label);
    result[key] = (result[key] || 0) + (Number(count) || 0);
  }
  return result;
}

/**
 * "Fruit Fly: 3, Bug: 1" for reports.
 */
export function formatSummary(summary, t) {
  return Object.entries(normalizeSummary(summary))
    .map(([key, count]) => `${speciesName(key, t)}: ${count}`)
    .join(', ');
}

export { FRUIT_FLY };
