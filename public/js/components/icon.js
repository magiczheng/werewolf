import { el } from '../ui.js';

// Shared, offline line icons. Keep stroke weight consistent across navigation.
const paths = {
  actions: '<path d="m13 2-8 12h6l-1 8 9-13h-6z"/>',
  board: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  news: '<path d="M4 9h4l11-5v16L8 15H4zM8 15l2 6H6l-2-6m17-5v4"/>',
  judge: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  moon: '<path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
};

export function icon(name, className = '') {
  return el('span', { class: 'line-icon ' + className, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.moon}</svg>` });
}
