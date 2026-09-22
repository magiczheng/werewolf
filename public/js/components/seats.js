// 座位网格：大厅（可点击入座）与游戏内（存活/出局/翻牌）共用。
import { el, esc } from '../ui.js';

/**
 * @param {Array} players  snapshot 的 players（座位号 1..N）
 * @param {object} opts
 *   me        当前玩家快照（s.me），用于标记「我的座位」
 *   onSit     (seat) => void，给出则空位可点击入座
 *   showRole  是否展示已翻牌角色的身份标签
 */
export function seatGrid(players, opts = {}) {
  const grid = el('div', { class: 'seat-grid' });
  const me = opts.me;

  for (const seat of players) {
    const isMine = me && seat.seat === me.seat;

    if (!seat.name) {
      // 空位：大厅里可点。**已入座的人也能点**——直接换到新座位，
      // 引擎会自动让出旧座位，不需要先「起立」。
      const canSit = !!opts.onSit && !!me;
      const sitting = !!me && !!me.seat;
      const card = el('div', { class: 'seat empty' }, [
        el('span', { class: 'seat-no' }, String(seat.seat)),
        el('span', { class: 'seat-vacant' }, '空位'),
        canSit ? el('span', { class: 'seat-cta' }, sitting ? '换到这里' : '点击入座') : null,
      ]);
      if (canSit) {
        card.classList.add('tappable');
        card.addEventListener('click', () => opts.onSit(seat.seat));
      }
      grid.appendChild(card);
      continue;
    }

    const cls = ['seat', 'taken'];
    if (isMine) cls.push('mine');
    if (!seat.alive) cls.push('dead');

    const bits = [
      el('span', { class: 'seat-no' }, String(seat.seat)),
      seat.isSheriff ? el('span', { class: 'sheriff-mark', title: '警长' }, '🛡') : null,
      el('span', { class: 'name' }, esc(seat.name)),
    ];

    if (seat.alive) {
      bits.push(el('span', { class: 'dot' + (seat.connected ? '' : ' off'), title: seat.connected ? '在线' : '掉线' }));
    } else {
      bits.push(el('span', { class: 'seat-dead' }, '出局'));
    }

    if (opts.showRole && seat.revealed && seat.roleName) {
      const camp = seat.role === 'wolf' || seat.role === 'whiteWolfKing' ? 'wolf' : 'good';
      bits.push(el('span', { class: 'role-tag ' + camp }, seat.roleName));
    }
    if (seat.idiotFlipped) bits.push(el('span', { class: 'idiot-tag' }, '翻牌免投'));

    grid.appendChild(el('div', { class: cls.join(' ') }, bits));
  }

  return grid;
}
