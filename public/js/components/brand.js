// 品牌标识：血月 + 狼耳剪影。用内联 SVG，不依赖任何外部资源（离线可用）。
import { el } from '../ui.js';

const MARK = `
<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="wwMoon" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a78bfa"/>
      <stop offset="1" stop-color="#4dd4ff"/>
    </linearGradient>
    <radialGradient id="wwGlow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#7c5cff" stop-opacity=".55"/>
      <stop offset="1" stop-color="#7c5cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="32" cy="32" r="30" fill="url(#wwGlow)"/>
  <!-- 狼头剪影：双耳 + 吻部 -->
  <path d="M32 13 L21 8.5 L22.5 19.5 L18 24 L20.5 34 L26 47 L32 52 L38 47 L43.5 34 L46 24 L41.5 19.5 L43 8.5 Z"
        fill="url(#wwMoon)" fill-opacity=".92"/>
  <!-- 双眼 -->
  <ellipse cx="26.5" cy="28" rx="2.6" ry="1.9" fill="#0f1020"/>
  <ellipse cx="37.5" cy="28" rx="2.6" ry="1.9" fill="#0f1020"/>
  <!-- 吻部高光 -->
  <path d="M32 38.5 L29 42 L32 44 L35 42 Z" fill="#0f1020" fill-opacity=".55"/>
</svg>`;

export function brand(opts = {}) {
  return el('div', { class: 'brand' + (opts.compact ? ' compact' : '') }, [
    el('div', { class: 'brand-mark', html: MARK }),
    el('div', { class: 'brand-text' }, [
      el('h1', { class: 'brand-title' }, '狼人杀'),
      el('p', { class: 'brand-sub' }, opts.sub || '聚会助手 · 扫码入房 · 自动发牌'),
    ]),
  ]);
}
