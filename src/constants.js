// Design tokens (Nocturne) — see README.md "Design tokens" section
export const T = {
  ground: '#161826',
  chrome: '#191c2b',
  card: '#1e2130',
  surface: '#232532',
  elevated: '#2b2741',
  text: '#e9e9ed',
  textSecondary: '#9397ab',
  textMuted: '#75798c',
  textDim: '#b2b6ca',
  placeholder: '#595d6c',
  accent: '#9184d9',
  accentLight: '#d2cefd',
  warn: '#d8a24f',
  danger: '#e07566',
};

export const CATEGORIES = ['Beer', 'Cider', 'Wine', 'Spirits', 'Soft Drinks', 'Other'];
export const UNITS = ['Keg', 'Bottle', 'Can', 'Bag-in-box', 'Other'];
export const CASE_SIZES = [6, 8, 12, 18, 24];
export const DEFAULT_SITES = [
  { id: 'lc', name: 'Louis Container' },
  { id: 'kc', name: 'Kingscote' },
  { id: 'pw', name: 'Paintworks' },
];
export const STORE = 'lc';
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

export function fmt(d) {
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch {
    return d;
  }
}

export function monthKey(d) {
  return String(d).slice(0, 7);
}

export function stockAt(p, v) {
  return (p.stock && p.stock[v]) || 0;
}
