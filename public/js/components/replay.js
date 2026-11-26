import { el } from '../ui.js';

function voteGroup(seat, { voters, total }, nameAt) {
  const abstained = !seat;
  return el('li', { class: 'vote-group' }, [
    el('span', { class: 'vote-voters' }, voters.sort((a, b) => a.seat - b.seat).flatMap((ballot, index) => [
      el('span', { class: 'vote-voter' }, [
        nameAt(ballot.seat),
        !abstained && ballot.weight !== 1 ? el('small', { class: 'vote-weight' }, `（${ballot.weight}票）`) : null,
        index < voters.length - 1 ? '、' : null,
      ]),
      el('wbr'),
    ])),
    el('span', { class: 'vote-arrow' }, '→'),
    el('strong', { class: 'vote-target' }, abstained ? '弃票' : nameAt(seat)),
    el('span', { class: 'vote-total' }, abstained ? `${voters.length} 人` : `${total} 票`),
  ]);
}

export function replayPanel(s) {
  const children = [];
  const currentNames = Object.fromEntries((s.players || []).map(p => [p.seat, p.name]));
  for (const round of [...(s.voteHistory || [])].reverse()) {
    const namesBySeat = round.namesBySeat ?? currentNames;
    const nameAt = seat => namesBySeat[seat] || '未知玩家';
    const groups = new Map();
    for (const ballot of round.ballots) {
      const target = ballot.target || 0;
      if (!groups.has(target)) groups.set(target, { voters: [], total: 0 });
      const group = groups.get(target);
      group.voters.push(ballot);
      group.total += ballot.weight;
    }
    const abstentions = groups.get(0);
    groups.delete(0);
    const rows = [...groups]
      .sort(([seatA, groupA], [seatB, groupB]) => groupB.total - groupA.total || seatA - seatB)
      .map(([seat, group]) => voteGroup(seat, group, nameAt));
    if (abstentions) rows.push(voteGroup(0, abstentions, nameAt));
    children.push(el('section', { class: 'vote-record' }, [
      el('h3', { class: 'small' }, `第 ${round.day} 天 · ${round.kind}`),
      rows.length ? el('ul', { class: 'vote-groups', role: 'list' }, rows) : el('p', { class: 'hint' }, '本轮无有效票'),
    ]));
  }
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
