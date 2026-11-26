import { el } from '../ui.js';

export function atmosphere({ compact = false } = {}) {
  return el('div', { class: 'atmosphere' + (compact ? ' atmosphere-compact' : ''), 'aria-hidden': 'true' });
}

export function versionBadge() {
  const release = window.__WW_VERSION__;
  return el('span', { class: 'edition', title: release?.revision || '' }, `v${release?.version || 'dev'}`);
}
