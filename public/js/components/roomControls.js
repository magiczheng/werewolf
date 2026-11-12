import { el, toast, confirmDialog } from '../ui.js';
import { net, store } from '../net.js';

const expandedRooms = new Set();

export function roomControls(s) {
  const send = (event, payload = {}) => net.emit(event, payload).catch(e => toast(e.message, true));
  const offline = s.offlinePlayers || [];
  const items = [];
  if (s.host) items.push(el('div', { class: 'hint' }, `房主：${s.host.name}${s.host.connected ? ' · 在线' : ' · 离线'}`));
  if (offline.length) items.push(el('div', { class: 'hint' }, `离线成员：${offline.map(p => p.seat ? `${p.seat}号` : p.name).join('、')}。重连会恢复原座位。`));
  if (s.canClaimHost) items.push(el('button', { class: 'btn-ghost', type: 'button', click: async () => {
    if (await confirmDialog('接任房主？', '原房主已离线满 60 秒，接任后由你推进公开阶段。', { danger: false, confirmText: '接任' })) return send('claimHost');
  } }, '接任离线房主'));
  if (s.me.isHost && s.hostCandidates?.length && (!s.judgeMode || !s.gameStarted)) {
    const select = el('select', { class: 'input', 'aria-label': '选择新房主' }, [
      el('option', { value: '' }, s.judgeMode ? '选择新法官' : '选择新房主'),
      ...s.hostCandidates.map(p => el('option', { value: p.playerId }, `${p.seat ? p.seat + '号 ' : ''}${p.name}`)),
    ]);
    items.push(el('div', { class: 'row' }, [select, el('button', { class: 'btn-ghost', type: 'button', click: async () => {
      if (!select.value) return toast('请先选择成员', true);
      if (await confirmDialog('移交房主？', s.judgeMode ? '对方将成为法官并离开玩家座位。' : '对方将获得开始游戏和推进公开阶段的权限。', { danger: false, confirmText: '移交' })) return send('transferHost', { playerId: select.value });
    } }, '移交') ]));
  }
  if (s.me.isHost && offline.length && s.gameStarted && !s.gameOver && !s.judgeMode) items.push(el('button', { class: 'btn-ghost', type: 'button', click: async () => {
    if (await confirmDialog('处理离线操作？', '仅处理离线满 60 秒且尚未操作的成员：确认身份、不上警、弃票或本阶段空过。在线成员的选择不受影响，操作会记入播报。', { confirmText: '确认处理' })) return send('recoverOffline');
  } }, '处理本阶段离线操作'));
  if (s.me.isHost && !s.gameStarted) for (const p of offline) items.push(el('button', { class: 'btn-small btn-ghost', type: 'button', click: async () => {
    if (await confirmDialog('移除离线成员？', `${p.name}离线满 60 秒后可移除，腾出名额。`, { confirmText: '移除' })) return send('removeOffline', { playerId: p.playerId });
  } }, `移除离线成员 ${p.name}`));
  if (s.judgeMode && s.judge && !s.judge.connected) items.push(el('div', { class: 'hint' }, '法官离线中，请等待原法官重连；对局中不向其他玩家转移法官身份。'));
  return el('details', { class: 'card glass room-controls', open: expandedRooms.has(s.roomCode) || offline.length > 0 || !!s.canClaimHost,
    toggle: e => { if (e.target.open) expandedRooms.add(s.roomCode); else expandedRooms.delete(s.roomCode); } }, [
    el('summary', {}, [el('span', { class: 'disclosure-title' }, '房间管理'), el('span', { class: 'disclosure-meta' }, offline.length ? `${offline.length} 人离线` : (s.host ? `房主 · ${s.host.name}` : '成员与权限')), el('span', { class: 'disclosure-chevron', 'aria-hidden': 'true' }, '⌄')]),
    el('div', { class: 'disclosure-body col' }, items),
  ]);
}

export function firstGameGuide() {
  if (store.get('ww_guide_seen')) return null;
  const card = el('div', { class: 'card glass quick-guide' }, [
    el('div', { class: 'spread' }, [el('div', { class: 'panel-title' }, '第一次来？三步开启月夜'),
      el('button', { class: 'link-btn', type: 'button', click: () => { store.set('ww_guide_seen', '1'); card.remove(); toast('引导已收起，随时可以选择座位'); } }, '我知道了')]),
    el('div', { class: 'guide-steps' }, [['01', '邀请入座'], ['02', '确认身份'], ['03', '闭眼行动']].map(([number, text]) => el('div', { class: 'guide-step' }, [el('span', {}, number), el('span', {}, text)]))),
    el('p', { class: 'hint' }, '白天面对面讨论；选择目标立即提交，白天投票不可修改。'),
  ]);
  return card;
}
