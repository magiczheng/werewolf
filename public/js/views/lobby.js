// 房间大厅：座位、入座进度，以及按需展开的邀请与房间详情。
import { el, toast, confirmDialog, copyText } from '../ui.js';
import { net, store } from '../net.js';
import { seatGrid } from '../components/seats.js';
import { roomControls, firstGameGuide } from '../components/roomControls.js';
import { roleArt } from '../components/roleArt.js';
import { ROLE_META, RULES_LABELS } from '../constants.js';

const qrRequests = new Map();

function inviteQRCode(code) {
  if (!qrRequests.has(code)) {
    const request = fetch(`/api/qr?room=${encodeURIComponent(code)}`)
      .then(async response => {
        if (!response.ok) throw new Error('二维码加载失败');
        const { qr } = await response.json();
        if (!qr) throw new Error('二维码加载失败');
        return qr;
      })
      .catch(error => {
        qrRequests.delete(code);
        throw error;
      });
    qrRequests.set(code, request);
  }
  return qrRequests.get(code);
}

export function renderLobby(root) {
  const s = net.state;
  const me = s.me;
  const code = s.roomCode;
  const shareUrl = `${location.origin}/?room=${code}`;
  const old = root.children[0];
  const sameRoom = old?.dataset.room === code;
  const reopenInvite = sameRoom && old.querySelector?.('.lobby-invitation')?.open;
  const detailsOpen = sameRoom && old.querySelector?.('.lobby-details')?.open;

  const cfg = s.settings;
  const occupied = s.players.filter(p => p.name).length;
  const empty = cfg.playerCount - occupied;
  const permitted = !!(me?.isHost || me?.isJudge);
  const canStart = !!(permitted && s.canStart && !s.canStart.error);

  const seats = seatGrid(s.players, {
    me,
    onSit: seat => net.emit('sit', { seat }).catch(e => toast(e.message, true)),
    showRole: false,
  });
  const table = el('section', {
    class: 'lobby-table felt-table' + (cfg.playerCount > 9 ? ' dense' : ''),
    'aria-label': '选择你的座位',
  }, seats);

  const qr = el('img', { class: 'qr', alt: '房间二维码', hidden: true, width: 176, height: 176 });
  const qrStatus = el('p', { class: 'hint invite-status', role: 'status' }, '正在加载二维码…');
  const copyFeedback = el('p', { class: 'hint', role: 'status', hidden: true });
  const invite = el('button', {
    class: 'btn-ghost lobby-invite', type: 'button', 'aria-haspopup': 'dialog',
    click: showInvite,
  }, '邀请好友');
  const dialog = el('dialog', {
    class: 'lobby-invitation game-sheet glass', 'aria-label': '邀请好友',
    click: event => { if (event.target === dialog) dialog.close(); },
  }, [
    el('header', { class: 'sheet-heading' }, [
      el('h2', {}, '邀请好友'),
      el('button', { class: 'btn-ghost sheet-close', type: 'button', click: () => dialog.close() }, '关闭'),
    ]),
    el('div', { class: 'sheet-content col' }, [
      qrStatus,
      qr,
      el('p', { class: 'invite-room' }, `房间号 ${code}`),
      el('p', { class: 'share-link' }, shareUrl),
      el('button', { class: 'btn-primary btn-big', type: 'button', click: async () => {
        const ok = await copyText(shareUrl, dialog);
        copyFeedback.textContent = ok ? '邀请链接已复制' : '请长按邀请链接复制';
        copyFeedback.hidden = false;
      } }, '复制链接'),
      copyFeedback,
    ]),
  ]);
  dialog.addEventListener('close', () => invite.focus({ preventScroll: true }));

  function showInvite() {
    if (dialog.open) return;
    dialog.showModal();
    if (!qr.hidden) return;
    qrStatus.textContent = '正在加载二维码…';
    inviteQRCode(code).then(data => {
      qr.src = data;
      qr.hidden = false;
      qrStatus.hidden = true;
    }).catch(() => {
      qrStatus.textContent = '二维码加载失败，可以复制邀请链接';
    });
  }

  const leaveRoom = async (event) => {
    const yes = await confirmDialog('离开房间？', '退出后需要重新输入房间号才能回来。', { confirmText: '离开', returnFocus: event?.currentTarget });
    if (!yes) return;
    try {
      await net.emit('leaveRoom');
      store.remove('ww_last_room');
      net.clear();
    } catch (e) { toast(e.message, true); }
  };

  const roles = Object.entries(cfg.roles || {}).filter(([, n]) => n > 0).map(([key, n]) => {
    const meta = ROLE_META[key];
    return el('span', { class: 'cfg-chip cfg-role' + (meta?.camp === 'wolf' ? ' wolf' : '') }, [
      roleArt(key, { className: 'cfg-role-art' }), el('span', {}, `${meta?.name || key} ×${n}`),
    ]);
  });
  const activeRules = RULES_LABELS.filter(([key]) => cfg.rules?.[key]);
  const details = el('details', { class: 'lobby-details', open: detailsOpen }, [
    el('summary', {}, '房间详情'),
    el('div', { class: 'lobby-details-content col' }, [
      s.waiting.length ? el('div', { class: 'waiting-block' }, [
        el('p', { class: 'hint' }, '已加入，等待选座'),
        el('div', { class: 'waiting-row' }, s.waiting.map(w => el('span', { class: 'waiting-chip' }, w.name))),
      ]) : null,
      el('section', { class: 'card glass col lobby-config' }, [
        el('h2', { class: 'panel-title' }, '本局配置'),
        el('div', { class: 'cfg-chips' }, [
          el('span', { class: 'cfg-chip strong' }, `${cfg.playerCount} 人局`),
          el('span', { class: 'cfg-chip' + (s.judgeMode ? ' gold' : '') }, s.judgeMode ? '法官模式' : '自动模式'),
          s.judge ? el('span', { class: 'cfg-chip' }, `法官 · ${s.judge.name || (me.isJudge ? '你' : '—')}`) : null,
        ]),
        el('div', { class: 'cfg-chips' }, roles),
        activeRules.length ? el('div', { class: 'cfg-chips' }, activeRules.map(([, label]) => el('span', { class: 'cfg-chip muted-chip' }, label))) : null,
      ]),
      roomControls(s),
      firstGameGuide(),
    ]),
  ]);

  const view = el('div', {
    class: 'view lobby-view' + (sameRoom ? '' : ' view-enter'), 'data-room': code,
  }, [
    el('header', { class: 'lobby-head' }, [
      el('h1', { class: 'screen-title lobby-title' }, '房间大厅'),
      el('p', { class: 'lobby-room' }, ['房间号 ', el('strong', { class: 'room-code' }, code)]),
      invite,
      el('button', { class: 'link-btn lobby-exit', type: 'button', click: leaveRoom }, '离开'),
    ]),
    table,
    el('section', { class: 'lobby-launch', 'aria-label': '开局进度' }, [
      el('p', { class: 'launch-caption', role: 'status' }, `已入座 ${occupied} / ${cfg.playerCount}`),
      el('p', { class: 'launch-detail' }, canStart ? '全员已入座' : empty ? `还差 ${empty} 人` : (permitted && s.canStart?.error) || '等待房主开局'),
      permitted ? el('button', {
        class: 'btn-primary btn-big lobby-start', type: 'button', disabled: !canStart,
        click: () => net.emit('startGame').catch(e => toast(e.message, true)),
      }, '开始游戏') : null,
    ]),
    el('footer', { class: 'lobby-utilities' }, [
      details,
      me?.seat ? el('button', {
        class: 'link-btn lobby-stand', type: 'button',
        click: () => net.emit('standUp').catch(e => toast(e.message, true)),
      }, '离开座位') : null,
    ]),
    dialog,
  ]);
  if (sameRoom) old.replaceWith(view);
  else {
    root.innerHTML = '';
    root.appendChild(view);
  }
  if (reopenInvite) showInvite();
}
