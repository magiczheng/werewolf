// 大厅：房间号 / 二维码 / 座位 / 本局配置（只读）/ 开始
import { el, esc, toast, confirmDialog, copyText } from '../ui.js';
import { net, store } from '../net.js';
import { seatGrid } from '../components/seats.js';
import { ROLE_META, RULES_LABELS } from '../constants.js';

// 二维码按房间号缓存：每次推送都重新请求会生成一次二维码，
// 且新 <img> 会先闪一下空白。
const qrCache = new Map();

export function renderLobby(root) {
  const s = net.state;
  const me = s.me;
  const code = s.roomCode;
  const shareUrl = `${location.origin}/?room=${code}`;

  const occupied = s.players.filter((p) => p.name).length;
  const empty = s.settings.playerCount - occupied;

  // ---------- 座位 ----------
  const seats = seatGrid(s.players, {
    me,
    onSit: (seat) => net.emit('sit', { seat }).catch((e) => toast(e.message, true)),
    showRole: false,
  });

  // 已入座的人可以「离开座位」：把位置让出来后重新选，或让别人坐。
  // 点了另一个空位也能直接换过去（引擎会自动让出旧座位），这里只是显式的入口。
  const standUp = () => net.emit('standUp').catch((e) => toast(e.message, true));

  const seatCard = el('div', { class: 'card glass col' }, [
    el('div', { class: 'panel-title' }, [
      '座位',
      el('span', { class: 'pill', style: 'margin-left:8px' }, `${occupied}/${s.settings.playerCount}`),
    ]),
    seats,
    el('div', { class: 'hint' }, empty
      ? (me && !me.seat
        ? `还有 ${empty} 个空位，点一个坐下`
        : `还有 ${empty} 个空位，等人入座`)
      : '座位已满，等待开始'),
    me && me.seat
      ? el('div', { class: 'hint' }, '想换座位：直接点别的空位即可；也可以先离开座位')
      : null,
    me && me.seat
      ? el('button', { class: 'btn-ghost', type: 'button', click: standUp }, '离开座位')
      : null,
    s.waiting.length ? el('div', { class: 'waiting-block' }, [
      el('div', { class: 'hint' }, '已加入，等待选座'),
      el('div', { class: 'waiting-row' }, s.waiting.map((w) => el('span', { class: 'waiting-chip' }, esc(w.name)))),
    ]) : null,
  ]);

  // ---------- 房间信息 ----------
  const qrImg = el('img', { class: 'qr', alt: '房间二维码' });
  const cachedQr = qrCache.get(code);
  if (cachedQr) {
    qrImg.src = cachedQr; // 命中缓存直接就位，不闪空白
  } else {
    fetch(`/api/qr?room=${encodeURIComponent(code)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.qr) return;
        qrCache.set(code, d.qr);
        if (qrImg.isConnected) qrImg.src = d.qr;
      })
      .catch(() => { qrImg.alt = '二维码加载失败'; });
  }

  const copyLink = async () => {
    const ok = await copyText(shareUrl);
    toast(ok ? '邀请链接已复制' : '请长按上方地址复制');
  };
  const leaveRoom = async () => {
    const yes = await confirmDialog('离开房间？', '退出后需要重新输入房间号才能回来。', { confirmText: '离开' });
    if (!yes) return;
    try {
      await net.emit('leaveRoom');
      store.remove('ww_last_room');
      net.clear();
    } catch (e) { toast(e.message, true); }
  };
  const startGame = () => net.emit('startGame').catch((e) => toast(e.message, true));

  const shareCard = el('div', { class: 'card glass share-box col' }, [
    el('div', { class: 'spread' }, [
      el('div', { class: 'panel-title', style: 'margin:0' }, '邀请加入'),
      el('span', { class: 'pill' + (s.judgeMode ? ' gold' : '') }, s.judgeMode ? '👨‍⚖️ 法官模式' : '自动模式'),
    ]),
    qrImg,
    el('div', { class: 'room-code' }, code),
    el('div', { class: 'share-link' }, shareUrl),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn-ghost grow', type: 'button', click: copyLink }, '复制链接'),
      el('button', { class: 'btn-ghost', type: 'button', click: leaveRoom }, '离开'),
    ]),
    // 法官本人看到的 s.judge 是完整状态对象（没有 name 字段），
    // 非法官看到的才是 {name, connected}——所以这里要兜底。
    s.judge ? el('div', { class: 'spread judge-row' }, [
      el('span', { class: 'hint' }, '👨‍⚖️ 法官'),
      el('span', {}, esc(s.judge.name || (me.isJudge ? '你' : '—'))),
    ]) : null,
  ]);

  const parts = [
    el('div', { class: 'lobby-head' }, [
      el('div', { class: 'panel-title', style: 'margin:0' }, '房间大厅'),
      el('button', { class: 'link-btn', type: 'button', click: leaveRoom }, '退出'),
    ]),
    shareCard,
    seatCard,
  ];

  // ---------- 开始按钮 ----------
  const canStart = !!(s.canStart && !s.canStart.error);
  const startLabel = canStart ? '开始游戏' : ((s.canStart && s.canStart.error) || '开始游戏');
  parts.push(el('button', {
    class: 'btn-primary btn-big sticky-cta', type: 'button', disabled: !canStart, click: startGame,
  }, startLabel));

  // ---------- 本局配置（只读）----------
  // 配置在创建房间时定好，进入大厅后不再允许修改——服务端也已移除修改入口，
  // 这里只做展示，且所有人都看得到，便于开局前确认板子是否符合预期。
  const cfg = s.settings;
  const roleChips = Object.entries(cfg.roles || {})
    .filter(([, n]) => n > 0)
    .map(([key, n]) => {
      const meta = ROLE_META[key];
      return el('span', {
        class: 'cfg-chip' + (meta && meta.camp === 'wolf' ? ' wolf' : ''),
      }, `${meta ? meta.name : key} ×${n}`);
    });

  const activeRules = RULES_LABELS.filter(([key]) => cfg.rules && cfg.rules[key]);

  parts.push(el('div', { class: 'card glass col' }, [
    el('div', { class: 'panel-title' }, [
      '本局配置',
      el('span', { class: 'cfg-locked' }, '创建后不可修改'),
    ]),
    el('div', { class: 'cfg-chips' }, [
      el('span', { class: 'cfg-chip strong' }, `${cfg.playerCount} 人局`),
      el('span', { class: 'cfg-chip' + (cfg.judgeMode ? ' gold' : '') }, cfg.judgeMode ? '👨‍⚖️ 法官模式' : '自动模式'),
    ]),
    el('div', { class: 'cfg-chips' }, roleChips),
    activeRules.length
      ? el('div', { class: 'cfg-chips' }, activeRules.map(([, label]) => el('span', { class: 'cfg-chip muted-chip' }, label)))
      : null,
  ]));

  root.appendChild(el('div', { class: 'view lobby-view col' }, parts));
}
