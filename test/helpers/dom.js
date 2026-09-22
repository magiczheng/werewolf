// 极简 DOM 垫片：只为在 Node 里真实跑通前端渲染路径，捕获运行时崩溃。
// 这不是视觉测试，也无意模拟浏览器——目标是「页面能不能渲染出来而不抛错」。
// 只实现 public/js 下实际用到的那部分 DOM API。

class ClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
  _sync() { this.node._class = [...this.set].join(' '); }
  add(...cs) { for (const c of cs) if (c) this.set.add(c); this._sync(); }
  remove(...cs) { for (const c of cs) this.set.delete(c); this._sync(); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    this._sync();
    return on;
  }
}

export class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this._class = '';
    this._listeners = {};
    this._innerHTML = '';
    this.textContent = '';
    this._value = '';
    this.hidden = false;
    this.disabled = false;
    this.isConnected = false;
    this.classList = new ClassList(this);
  }

  get className() { return this._class; }
  set className(v) {
    this._class = v == null ? '' : String(v);
    this.classList.set = new Set(this._class.split(/\s+/).filter(Boolean));
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }

  /** 与浏览器一致：select 的 value 由被选中的 option 决定。 */
  get value() {
    if (this.tagName === 'SELECT' && this._value === '') {
      const opts = this.childNodes.filter((c) => c.nodeType === 1 && c.tagName === 'OPTION');
      const chosen = opts.find((o) => o.hasAttribute('selected')) || opts[0];
      return chosen ? chosen.value : '';
    }
    return this._value;
  }
  set value(v) {
    this._value = v == null ? '' : String(v);
    // <option>.value 是反射属性：赋值会同步到 value 特性（浏览器行为）
    if (this.tagName === 'OPTION') this.attributes.value = this._value;
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    if (v === '') this.childNodes = [];
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    if (k === 'class') this.className = v;
    if (k === 'hidden') this.hidden = true;
    if (k === 'disabled') this.disabled = true;
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  hasAttribute(k) { return k in this.attributes; }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    // 标记整棵子树为「已连接」，与浏览器一致
    const mark = (n) => { n.isConnected = true; n.childNodes.forEach(mark); };
    mark(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    const unmark = (n) => { n.isConnected = false; n.childNodes.forEach(unmark); };
    unmark(child);
    return child;
  }
  replaceWith(other) {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    this.parentNode.childNodes[i] = other;
    other.parentNode = this.parentNode;
    this.parentNode = null;
  }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (l) this._listeners[type] = l.filter((f) => f !== fn);
  }
  /** 测试里手动触发事件用 */
  dispatch(type, event = {}) {
    for (const fn of this._listeners[type] || []) fn({ target: this, preventDefault() {}, ...event });
  }

  focus() { doc.activeElement = this; }
  blur() { if (doc.activeElement === this) doc.activeElement = null; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  select() {}
  closest() { return null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  /** 仅支持 [attr] 形式的选择器——updateTimers 只需要这一种 */
  querySelectorAll(sel) {
    const m = /^\[([\w-]+)\]$/.exec(sel);
    if (!m) return [];
    const attr = m[1];
    // 真实浏览器里 dataset.deadline = x 会同时产生 data-deadline 属性；
    // 这里的 dataset 是普通对象，所以要把 data-foo-bar 折算成 camelCase 再查。
    const camel = attr.startsWith('data-')
      ? attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      : null;
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c.hasAttribute(attr) || (attr in c.dataset) || (camel && camel in c.dataset)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/** 全局事件总线：window 与 document 的监听器需要真实可用，
    否则「松手关闭浮层」这类依赖 window 事件的逻辑无法测试。 */
function eventBus() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const l = listeners[type];
      if (l) listeners[type] = l.filter((f) => f !== fn);
    },
    /** 测试用：触发全局事件 */
    fire(type, event = {}) {
      for (const fn of [...(listeners[type] || [])]) fn({ type, preventDefault() {}, ...event });
    },
    listenerCount: (type) => (listeners[type] || []).length,
  };
}

const doc = {
  activeElement: null,
  body: new FakeNode('body'),
  documentElement: new FakeNode('html'),
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), childNodes: [], isConnected: false }),
  getElementById: (id) => doc._byId[id] || null,
  querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
  _byId: {},
};
Object.assign(doc, eventBus());

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get size() { return m.size; },
    _map: m,
  };
}

/**
 * 安装全局环境，必须在 import 任何前端模块之前调用。
 * @param {object} opts
 *   multi  是否模拟多账号测试模式（注入 window.__WW_MULTI__）
 */
export function installDom(opts = {}) {
  const roots = {};
  for (const id of ['app', 'toast', 'modal-root']) {
    const n = new FakeNode('div');
    roots[id] = n;
    doc._byId[id] = n;
    doc.body.appendChild(n);
  }
  doc._byId = roots;

  // 伪 socket：记录事件处理器，便于测试注入服务端推送
  const sockets = [];
  const makeSocket = () => {
    const handlers = {};
    const sock = {
      handlers,
      connected: true,
      on(type, fn) { (handlers[type] ||= []).push(fn); },
      emit() {},
      close() {},
      fire(type, ...args) { for (const fn of handlers[type] || []) fn(...args); },
    };
    sockets.push(sock);
    return sock;
  };

  const localStore = memoryStorage();
  const sessionStore = memoryStorage();

  // 语音合成桩：默认不装（这样 supported() 为 false，渲染测试不受影响）。
  // 只有语音专项测试才用 { speech: true } 打开，它记录「实际念了哪些句子」。
  const spoken = [];
  const speechStub = {
    spoken,
    getVoices: () => [{ name: 'Test 中文语音', lang: 'zh-CN' }],
    speak: (u) => { spoken.push(u.text); },
    cancel: () => {},
    addEventListener: () => {},
  };

  const win = {
    io: makeSocket, // net.js 在模块加载时读取
    isSecureContext: false,
    // 服务端以 MULTI_ACCOUNT=1 启动时注入；默认 false，与生产行为一致
    __WW_MULTI__: !!opts.multi,
    scrollTo() {},
    location: { origin: 'http://localhost:3000', search: '', href: 'http://localhost:3000/' },
    navigator: { userAgent: 'node', serviceWorker: undefined },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    localStorage: localStore,
    sessionStorage: sessionStore,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
    setTimeout, clearTimeout, setInterval, clearInterval, console, Math, Date, JSON,
  };
  Object.assign(win, eventBus());

  if (opts.speech) {
    win.speechSynthesis = speechStub;
    win.SpeechSynthesisUtterance = function SpeechSynthesisUtterance(text) { this.text = text; };
  }

  globalThis.window = win;
  globalThis.document = doc;

  // 注意：Node 内置了只读的 navigator / location 等全局对象，
  // Object.assign 会因为「只有 getter」而抛错，必须用 defineProperty 覆盖。
  const define = (k, v) => Object.defineProperty(globalThis, k, {
    value: v, writable: true, configurable: true, enumerable: true,
  });
  define('location', win.location);
  define('navigator', win.navigator);
  define('localStorage', win.localStorage);
  define('sessionStorage', win.sessionStorage);
  define('crypto', win.crypto);
  define('requestAnimationFrame', win.requestAnimationFrame);
  define('isSecureContext', false);
  globalThis.fetch = globalThis.fetch || (() => Promise.reject(new Error('no fetch in shim')));

  return {
    doc, win, roots,
    /** net.connect() 之后取到那个伪 socket，用来注入 state 推送 */
    lastSocket: () => sockets[sockets.length - 1],
    /** 测试用：语音桩记录下的句子 */
    spoken: () => spoken,

    /** 测试用：触发 window 上的全局事件（如 pointerup 松手） */
    fireWindow: (type, event) => win.fire(type, event),
    /** 测试用：触发 document 上的全局事件（如 visibilitychange） */
    fireDocument: (type, event) => doc.fire(type, event),
  };
}
