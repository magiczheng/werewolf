// socket.io 客户端封装：连接管理、最新状态存储、事件订阅、emit 承诺化、登录会话
const io = window.io;

let socket = null;
let state = null;
const listeners = new Set();
let syncTimer = null;     // 唤醒后向服务端要快照的等待计时器
let lastPoke = 0;         // 防止 focus / visibilitychange 同时触发两次探测

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

/** 清空本地会话（服务端 token 失效时用）：界面会回到登录页。 */
export function clearSession() {
  saveSession(null);
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
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: 10000,
      // 关键：auth 必须是函数，Socket.IO 每次（重）连都会重新调用它。
      // 之前写成 `auth: { token: sessionToken() }`，只在页面加载时取一次；
      // 登录后再断线重连，携带的仍是登录前的空 token，服务端认不出人，
      // 表现就是「手机一锁屏，回来就得重新登录」。
      auth: (cb) => cb({ token: sessionToken() }),
    });

    socket.on('state', (s) => {
      state = s;
      listeners.forEach((fn) => fn(s, 'state'));
    });
    socket.on('connect', () => {
      clearTimeout(syncTimer);
      syncTimer = null;
      listeners.forEach((fn) => fn(null, 'connect'));
    });
    socket.on('disconnect', () => listeners.forEach((fn) => fn(null, 'disconnect')));
    socket.on('connect_error', () => {});
  },

  on(fn) {
    listeners.add(fn);
    if (state) fn(state, 'state');
    return () => listeners.delete(fn);
  },

  emit(event, payload = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!socket) { reject(new Error('尚未连接')); return; }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('服务器无响应，请检查网络'));
      }, timeoutMs);
      socket.emit(event, payload, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
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

// ---------- 手机息屏 / 切后台后的连接恢复 ----------
// Socket.IO 自带重连，但移动端有两个额外问题：
//   1. 系统冻结页面时，重连定时器也一起被冻结；解锁后不一定马上重连。
//   2. 页面恢复时 socket.connected 可能仍是 true（TCP 已经死了但还没超时），
//      表现为「看起来在线，实际收不到任何推送」。
// 因此：可见 / 联网 / 回到前台时主动探活；探活超时就强制重建连接。

function forceReconnect() {
  if (!socket) return;
  clearTimeout(syncTimer);
  syncTimer = null;
  try { if (typeof socket.disconnect === 'function') socket.disconnect(); } catch (_e) { /* 忽略 */ }
  try { if (typeof socket.connect === 'function') socket.connect(); } catch (_e) { /* 忽略 */ }
}

function pokeConnection() {
  if (!socket) return;
  if (!socket.connected) { forceReconnect(); return; }

  // 多个事件常常一起到达（pageshow + visibilitychange + focus），只探一次。
  // lastPoke 为 0 表示还没探过，不能拿它做差（否则时钟从 0 起算时会漏掉第一次）。
  const now = Date.now();
  if (lastPoke && now - lastPoke < 1500) return;
  lastPoke = now;

  if (typeof socket.emit !== 'function') return;
  clearTimeout(syncTimer);
  // 服务端收到 sync 会把当前房间快照重新推一遍；5 秒没有回应就认为连接是僵尸。
  syncTimer = setTimeout(() => {
    syncTimer = null;
    forceReconnect();
  }, 5000);
  try {
    socket.emit('sync', {}, () => {
      clearTimeout(syncTimer);
      syncTimer = null;
    });
  } catch (_e) {
    clearTimeout(syncTimer);
    syncTimer = null;
    forceReconnect();
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', pokeConnection);
  window.addEventListener('pageshow', pokeConnection);
  window.addEventListener('focus', pokeConnection);
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pokeConnection();
  });
}

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
