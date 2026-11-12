import { el } from '../ui.js';
import { brand } from './brand.js';

export function atmosphere({ compact = false } = {}) {
  return el('aside', { class: 'atmosphere' + (compact ? ' atmosphere-compact' : '') }, [
    el('img', { class: 'forest-art', src: '/images/moonlit-forest.svg', alt: '', 'aria-hidden': 'true' }),
    el('div', { class: 'atmosphere-top' }, [brand({ compact: true, sub: 'WEREWOLF · SOCIAL CLUB' }), el('span', { class: 'edition', title: window.__WW_VERSION__?.revision || '' }, `月夜档案 / v${window.__WW_VERSION__?.version || 'dev'}`)]),
    el('div', { class: 'atmosphere-copy' }, [
      el('div', { class: 'eyebrow' }, 'THE NIGHT IS YOUNG'),
      el('h2', { class: 'hero-title' }, ['天黑了，', el('br'), '好戏才刚开始。']),
      el('p', { class: 'hero-description' }, '一场关于直觉、谎言与信任的游戏。\n叫上朋友，在月光下寻找真相。'),
    ]),
    el('div', { class: 'atmosphere-bottom' }, [el('span', {}, '09—16 人 · 线下相聚'), el('span', {}, '让每一次聚会，都有故事 ↗')]),
  ]);
}

export function pageIntro(kicker, title, description) {
  return el('div', { class: 'page-intro' }, [
    el('div', { class: 'eyebrow' }, kicker),
    el('h2', {}, title),
    el('p', {}, description),
  ]);
}
