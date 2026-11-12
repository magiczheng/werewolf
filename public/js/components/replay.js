import { el } from '../ui.js';

export function replayPanel(s) {
  const children = [];
  for (const round of s.voteHistory || []) children.push(el('div', { class: 'vote-record' }, [
    el('h3', { class: 'small' }, `第 ${round.day} 天 · ${round.kind}`),
    el('div', { class: 'cfg-chips' }, round.ballots.map(b => el('span', { class: 'cfg-chip' }, `${b.seat || '—'}号 → ${b.target ? b.target + '号' : '弃票'}${b.weight !== 1 ? `（${b.weight}票）` : ''}`))),
  ]));
  if (!s.voteHistory?.length) children.push(el('p', { class: 'hint' }, '本局尚无已完成的投票。投票结束后在这里查看票型。'));
  if (s.gameOver && s.replay?.length) children.push(el('div', { class: 'replay-timeline col' }, [
    el('div', { class: 'panel-title' }, '本局时间线'),
    ...s.replay.map(item => el('div', { class: 'news-item' }, [el('span', { class: 'news-dot' }), el('span', {}, `第 ${item.day || 0} 天 · ${item.text}`)])),
  ]));
  return el('details', { class: 'card glass replay-panel', open: !!s.gameOver }, [
    el('summary', {}, [el('span', { class: 'disclosure-title' }, s.gameOver ? '本局复盘与票型' : '投票记录'), el('span', { class: 'disclosure-meta' }, `${s.voteHistory?.length || 0} 轮投票`), el('span', { class: 'disclosure-chevron', 'aria-hidden': 'true' }, '⌄')]),
    el('div', { class: 'disclosure-body col' }, children),
  ]);
}
