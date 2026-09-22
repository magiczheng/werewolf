// 播报面板：战况时间线 + 遗言。倒序展示，最新一条永远在最上面，无需滚动。
import { el, esc } from '../ui.js';

function toneOf(text) {
  if (/获胜|游戏结束/.test(text)) return 'final';
  if (/自爆|死亡|出局|被放逐|殉枪/.test(text)) return 'danger';
  if (/天亮|夜晚|天黑/.test(text)) return 'night';
  if (/警长|警徽|上警|退水/.test(text)) return 'gold';
  if (/验|查验|好人|狼人/.test(text)) return 'info';
  return '';
}

export function newsPanel(s) {
  const items = [];

  // 遗言是线下当场说的，App 不留文字记录，因此播报里只有系统事件
  const news = (s.news || []).map((n) => ({ text: n.text, tone: toneOf(n.text) }));
  const all = [...news, ...items].reverse(); // 最新在前

  if (!all.length) {
    return el('div', { class: 'col' }, [
      el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-icon' }, '🌙'),
        el('div', {}, '还没有播报'),
        el('div', { class: 'hint' }, '游戏开始后，这里会记录每一个关键事件'),
      ]),
    ]);
  }

  return el('div', { class: 'news-list' }, all.map((n, i) => el('div', {
    class: `news-item ${n.tone}${i === 0 ? ' latest' : ''}`,
  }, [
    el('span', { class: 'news-dot' }),
    el('span', { class: 'news-text' }, n.tone === 'words' ? esc(n.text) : esc(n.text)),
  ])));
}
