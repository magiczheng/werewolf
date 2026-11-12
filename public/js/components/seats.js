// 座位网格：大厅（可点击入座）与游戏内（存活/出局/翻牌）共用。
import { roleArt } from './roleArt.js';
import { el, setPending } from '../ui.js';

/**
 * @param {Array} players  snapshot 的 players（座位号 1..N）
 * @param {object} opts
 *   me        当前玩家快照（s.me），用于标记「我的座位」
 *   onSit     (seat) => void，给出则空位可点击入座
 *   showRole  是否展示已翻牌角色的身份标签
 */
export function seatGrid(players, opts = {}) {
  const grid = el('div', { class: 'seat-grid' + (players.length > 9 ? ' dense' : '') });
  const me = opts.me;
  const activity = new Map((opts.activity?.seats || []).map(item => [item.seat, item]));
  const eligible = new Set(opts.selection?.targets.map(item => item.seat) || []);

  for (const seat of players) {
    const isMine = me && seat.seat === me.seat;

    if (!seat.name) {
      // 空位：大厅里可点。**已入座的人也能点**——直接换到新座位，
      // 引擎会自动让出旧座位，不需要先「起立」。
      const canSit = !!opts.onSit && !!me;
      const sitting = !!me && !!me.seat;
      const card = el(canSit ? 'button' : 'div', { class: 'seat empty', ...(canSit ? { type: 'button', 'aria-label': `${seat.seat}号座位，${sitting ? '换到这里' : '点击入座'}` } : {}) }, [
        el('span', { class: 'seat-no' }, String(seat.seat)),
        el('span', { class: 'seat-avatar vacant-avatar', 'aria-hidden': 'true' }, '+'),
        el('span', { class: 'seat-vacant' }, '空位'),
        canSit ? el('span', { class: 'seat-cta' }, sitting ? '换到这里' : '点击入座') : null,
      ]);
      if (canSit) {
        card.classList.add('tappable');
        card.addEventListener('click', async () => {
          if (card.disabled) return;
          setPending(card, true);
          const label = card.querySelector?.('.seat-cta');
          if (label) label.textContent = '正在入座…';
          try { await opts.onSit(seat.seat); }
          finally { setPending(card, false); if (label) label.textContent = sitting ? '换到这里' : '点击入座'; }
        });
      }
      grid.appendChild(card);
      continue;
    }

    const cls = ['seat', 'taken'];
    const status = activity.get(seat.seat);
    const canChoose = !!opts.selection && eligible.has(seat.seat);
    if (canChoose) cls.push('selectable');
    if (status) cls.push('activity-' + status.state);
    if (isMine) cls.push('mine');
    if (!seat.alive) cls.push('dead');

    const bits = [
      el('span', { class: 'seat-no' }, String(seat.seat)),
      seat.isSheriff ? el('span', { class: 'sheriff-mark', title: '警长', 'aria-label': '警长' }, '♜') : (isMine ? el('span', { class: 'seat-mine-mark' }, '我') : null),
      (opts.showRole && seat.revealed && seat.roleName && roleArt(seat.role, { className: 'seat-role-art' }))
        || el('span', { class: 'seat-avatar', 'aria-hidden': 'true' }, [...seat.name][0]),
      el('span', { class: 'name' }, seat.name),
    ];

    if (seat.alive) {
      bits.push(el('span', { class: 'seat-status' }, [el('span', { class: 'dot' + (seat.connected ? '' : ' off'), 'aria-hidden': 'true' }), el('span', {}, seat.connected ? '在线' : '离线')]));
    } else {
      bits.push(el('span', { class: 'seat-dead' }, '出局'));
    }

    if (opts.showRole && seat.revealed && seat.roleName) {
      const camp = seat.role === 'wolf' || seat.role === 'whiteWolfKing' ? 'wolf' : 'good';
      bits.push(el('span', { class: 'role-tag ' + camp }, seat.roleName));
    }
    if (status) bits.push(el('span', { class: 'seat-activity', 'data-state': status.state }, status.label));
    if (canChoose) bits.push(el('span', { class: 'seat-pick-hint', 'aria-hidden': 'true' }, '点击选择'));
    if (seat.idiotFlipped) bits.push(el('span', { class: 'idiot-tag' }, '翻牌免投'));

    grid.appendChild(el(canChoose ? 'button' : 'div', { class: cls.join(' '), 'data-seat': seat.seat, ...(canChoose ? { type: 'button', 'aria-label': `${seat.seat}号 ${seat.name}，选择目标`, 'aria-pressed': 'false', click: event => opts.selection.choose(seat.seat, event.currentTarget) } : {}) }, bits));
  }

  if (opts.selection) opts.selection.subscribe(({ selected, submitting }) => {
    for (const card of grid.children) {
      const chosen = Number(card.dataset.seat) === selected;
      card.classList.toggle('selected', chosen);
      if (eligible.has(Number(card.dataset.seat))) {
        card.disabled = submitting; card.setAttribute('aria-pressed', String(chosen));
        card.setAttribute('aria-busy', String(submitting && chosen));
      }
    }
  });
  return grid;
}
