// 轻量 DOM 辅助 + 弹窗/提示 + 草稿保持
//
// 关于「草稿保持」：net.on 会在每次服务端推送时触发 app.render()，
// 视图会被整体重建。若用户正在输入（如写遗言），重建会吞掉已输入内容与焦点。
// 给输入元素加 draftKey 即可跨重建保留输入值与光标位置。

// ---------- 草稿表 ----------

const drafts = new Map(); // draftKey -> 已输入的值
let focusKey = null;      // 当前持有焦点的 draftKey
let caretPos = 0;         // 对应的光标位置

/** 主动写入草稿（如程序化清空/预填）。 */
export function setDraft(key, value) {
  if (value == null) drafts.delete(key);
  else drafts.set(key, String(value));
}

/** 清除草稿（提交成功后调用，避免下次进来还是旧内容）。 */
export function clearDraft(key) {
  drafts.delete(key);
  if (focusKey === key) focusKey = null;
}

export function getDraft(key) {
  return drafts.has(key) ? drafts.get(key) : null;
}

// ---------- 元素构造 ----------

// 允许直接以事件名作为键（值必须是函数）。显式列出而非用正则猜，
// 避免将来某个函数型属性被误当成事件监听器绑上去。
const EVENTS = new Set([
  'click', 'dblclick', 'change', 'input', 'submit', 'reset', 'keydown', 'keyup', 'keypress',
  'focus', 'blur', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'scroll', 'contextmenu',
]);

function applyAttr(node, k, v) {
  if (v === false || v == null) return;                 // 条件属性：false/null 视为不设置
  if (v === true) { node.setAttribute(k, ''); return; }
  node.setAttribute(k, String(v));
}

/**
 * 创建元素。
 *   el('div', { class: 'x', click: fn, keydown: fn, dataId: 1 }, [children])
 * 约定：
 *   - 以 on* 形式命名的键、以及 click/change/input/submit/keydown/blur/focus/pointerdown
 *     等事件名，一律当作事件监听器（值是函数）。
 *   - draftKey 用于跨重渲染保持输入值与焦点。
 *   - style 支持字符串或对象。
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  let pendingValue = null; // select 专用：等 option 追加完再赋值
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') { node.className = v || ''; continue; }
    if (k === 'html') { node.innerHTML = v; continue; }
    if (k === 'ref') { if (typeof v === 'function') v(node); continue; }
    if (k === 'style') {
      if (v && typeof v === 'object') Object.assign(node.style, v);
      else applyAttr(node, 'style', v);
      continue;
    }

    // 事件监听：键名是事件名（或 onXxx 形式）且值为函数
    const evName = k.startsWith('on') && k.length > 2 ? k.slice(2).toLowerCase() : k;
    if (typeof v === 'function' && EVENTS.has(evName)) {
      node.addEventListener(evName, v);
      continue;
    }

    if (k === 'draftKey') { node.dataset.draftKey = v == null ? '' : String(v); continue; }
    if (k.startsWith('data-')) { node.dataset[k.slice(5)] = v == null ? '' : String(v); continue; }

    if (k === 'value') {
      // 草稿优先于声明的初始值——用户正在输入的内容不该被初始值覆盖
      const dk = attrs.draftKey;
      const val = (dk && drafts.has(dk)) ? drafts.get(dk) : (v == null ? '' : v);
      // select 的 value 必须在 option 追加之后设置，否则静默失效
      if (tag === 'select') pendingValue = String(val);
      else node.value = val;
      continue;
    }
    applyAttr(node, k, v);
  }

  // 输入元素：绑定草稿记录
  const dk = attrs.draftKey;
  if (dk && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
    if (!node.dataset.draftKey) node.dataset.draftKey = dk;
    if (drafts.has(dk) && tag !== 'select') node.value = drafts.get(dk);

    node.addEventListener('input', () => {
      drafts.set(dk, node.value);
      focusKey = dk;
      caretPos = node.selectionStart != null ? node.selectionStart : node.value.length;
    });
    node.addEventListener('focus', () => { focusKey = dk; });
    node.addEventListener('blur', () => { if (focusKey === dk) focusKey = null; });

    // 重建后恢复焦点与光标：等节点被挂载进文档再执行
    if (focusKey === dk) {
      requestAnimationFrame(() => {
        if (!node.isConnected) return;
        node.focus({ preventScroll: true });
        try {
          const p = Math.min(caretPos, node.value.length);
          node.setSelectionRange(p, p);
        } catch (_e) { /* 部分类型不支持选区，忽略 */ }
      });
    }
  }

  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }

  if (pendingValue !== null) node.value = pendingValue;

  return node;
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- 提示 / 弹窗 ----------

let toastTimer = null;
export function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  // 重新触发入场动画（连续 toast 时也能看到）
  t.classList.remove('err', 'show');
  void t.offsetWidth;
  t.classList.add('show');
  if (isErr) t.classList.add('err');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 2400);
}

/**
 * 复制文本。分三级降级，因为本应用最常见的使用场景是手机通过
 * http://192.168.x.x:3000 访问——那是不安全源，navigator.clipboard 为 undefined。
 * @returns {Promise<boolean>} 是否已成功写入剪贴板
 */
export async function copyText(text) {
  // 1) 标准 API（仅安全上下文可用）
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_e) { /* 继续降级 */ }

  // 2) 已废弃但仍广泛可用的 execCommand（HTTP 下的主要路径）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch (_e) { /* 继续降级 */ }

  // 3) 弹窗让用户长按手动复制。
  //    这里绝不能用 toast——它 2 秒就消失，用户根本来不及选中。
  const root = document.getElementById('modal-root');
  const input = el('input', {
    class: 'input', value: text, readonly: true,
    click: (e) => e.target.select(),
  });
  const close = () => { root.innerHTML = ''; };
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'modal-mask', click: (e) => { if (e.target.classList.contains('modal-mask')) close(); } }, [
    el('div', { class: 'modal glass' }, [
      el('h3', { class: 'modal-title' }, '手动复制链接'),
      el('p', { class: 'modal-body' }, '长按下面的地址选择「复制」'),
      input,
      el('button', { class: 'btn-primary btn-big', click: close }, '完成'),
    ]),
  ]));
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return false;
}

export function confirmDialog(title, body, opts = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (val) => { root.innerHTML = ''; resolve(val); };

    const modal = el('div', { class: 'modal-mask', click: (e) => { if (e.target === modal) close(false); } }, [
      el('div', { class: 'modal glass' }, [
        el('h3', { class: 'modal-title' }, title),
        body ? el('p', { class: 'modal-body' }, body) : null,
        el('div', { class: 'row spread modal-actions' }, [
          el('button', { class: 'btn-ghost grow', click: () => close(false) }, opts.cancelText || '取消'),
          el('button', {
            class: opts.danger === false ? 'btn-primary grow' : 'btn-danger grow',
            click: () => close(true),
          }, opts.confirmText || '确认'),
        ]),
      ]),
    ]);
    root.innerHTML = '';
    root.appendChild(modal);
  });
}
