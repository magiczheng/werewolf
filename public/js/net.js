// socket.io 客户端封装：连接管理、最新状态存储、事件订阅、emit 承诺化、登录会话
const io = window.io;

let socket = null;
let state = null;
const listeners = new Set();

// ---------- 会话存储 ----------
// 服务端权威：玩家身份 = 账号 game_id。token 仅用于恢复会话。
//
// 两种模式：
//   普通模式（默认）—— 会话存 localStorage。缺点：localStorage 在同源的所有 tab
//     之间共享，两个 tab 登录不同账号会互相覆盖，刷新后静默串号。
//   多账号测试模式 —— 会话存 sessionStorage（每个 tab 独立），于是一个浏览器可以
//     同时登录多个账号，刷新也不会串号。由服务端环境变量 MULTI_ACCOUNT=1 开启，
//     通过 window.__WW_MULTI__ 注入，普通部署下完全不生效。
//
// 测试模式下**不做**跨 tab 继承：新开的 tab 一律是未登录状态，需要自己选账号。
// 这正是测试时要的确定性——否则新 tab 会莫名其妙带着上一个账号和它的房间。
const MULTI = (() => {
  try {
    return !!(typeof window !== 'undefined' && window.__WW_MULTI__);
  } catch (_e) { return false; }
})();

const backend = (() => {
  const pick = (s) => {
    try {
      const k = '__ww_probe__';
      s.setItem(k, '1');
      s.removeItem(k);
      return s;
    } catch (_e) { return null; } // 隐私模式/禁用存储时降级
  };
  if (MULTI) return pick(sessionStorage) || pick(localStorage) || memoryStore();
  return pick(localStorage) || pick(sessionStorage) || memoryStore();
})();

function memoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/** 会话与房间记录统一走这里：多账号测试模式下自动落到每个 tab 独立的空间。 */
export const store = {
  get: (k) => backend.getItem(k),
  set: (k, v) => backend.setItem(k, v),
  remove: (k) => backend.removeItem(k),
};

/** 是否处于多账号测试模式（供界面提示用）。 */
export const multiAccount = MULTI;

const KEY = { token: 'ww_token', name: 'ww_user_name', email: 'ww_user_email', gameId: 'ww_game_id' };

function saveSession(session) {
  if (!session) {
    store.remove(KEY.token);
    store.remove(KEY.name);
    store.remove(KEY.email);
    store.remove(KEY.gameId);
    return;
  }
  if (session.token) store.set(KEY.token, session.token);
  if (session.name) store.set(KEY.name, session.name);
  if (session.email) store.set(KEY.email, session.email);
  if (session.gameId) store.set(KEY.gameId, session.gameId);
}

function sessionToken() {
  return store.get(KEY.token);
}

/** 当前登录账号信息（可能为 null）。 */
export function session() {
  const email = store.get(KEY.email);
  if (!email) return null;
  return {
    name: store.get(KEY.name) || '',
    email,
    gameId: store.get(KEY.gameId) || '',
  };
}

export const net = {
  connect() {
    socket = io({
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2500,
      auth: { token: sessionToken() },
    });

    socket.on('state', (s) => {
      state = s;
      listeners.forEach((fn) => fn(s, 'state'));
    });
    socket.on('connect', () => listeners.forEach((fn) => fn(null, 'connect')));
    socket.on('disconnect', () => listeners.forEach((fn) => fn(null, 'disconnect')));
    socket.on('connect_error', () => {});
  },

  on(fn) {
    listeners.add(fn);
    if (state) fn(state, 'state');
    return () => listeners.delete(fn);
  },

  emit(event, payload = {}) {
    return new Promise((resolve, reject) => {
      socket.emit(event, payload, (res) => {
        if (res && res.error) reject(new Error(res.error));
        else resolve(res || {});
      });
    });
  },

  connected() {
    return socket ? socket.connected : false;
  },

  /** 本地清空状态（如主动离开房间后），并通知界面回到首页。 */
  clear() {
    state = null;
    listeners.forEach((fn) => fn(null, 'clear'));
  },

  get state() {
    return state;
  },

  /** 注册新账号。成功后本连接即登录，并把会话持久化到本地。 */
  async register(email, password, name) {
    const res = await this.emit('register', { email, password, name });
    saveSession(res);
    return res;
  },

  /** 登录已有账号。成功后本连接即登录，并把会话持久化到本地。 */
  async login(email, password) {
    const res = await this.emit('login', { email, password });
    saveSession(res);
    return res;
  },

  /** 退出登录：服务端销毁会话，本地清空；同时离开当前房间（自动重连回房也会失效）。 */
  async logout() {
    try { await this.emit('logout', {}); } catch (_e) { /* 断线时也允许本地登出 */ }
    saveSession(null);
  },
};

/** 本地持久化的玩家身份（服务端对已登录连接一律用账号 gameId 覆盖）。 */
export function playerId() {
  const g = store.get(KEY.gameId);
  if (g) return g;
  let id = store.get('ww_player_id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || ('p' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    store.set('ww_player_id', id);
  }
  return id;
}

export function playerName() {
  return store.get('ww_player_name') || '';
}

export function setPlayerName(n) {
  store.set('ww_player_name', n);
}
