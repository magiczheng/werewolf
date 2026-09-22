// 「按住查看身份」浮层 + 触发按钮。
//
// 为什么是按住而不是点击切换：点击切换很容易忘记关掉，手机往桌上一放就一直在展示身份。
// 按住则在松手瞬间自动收起，不需要任何自律。
//
// 浮层挂在 document.body 上而不是 #app 里——每次服务端推送都会重建 #app，
// 若挂在里面，别人随手一操作就会把你正在看的身份牌弄没了。
import { el } from '../ui.js';
import { roleLines } from './roleCard.js';

let active = null; // 当前打开的浮层，同一时刻只允许一个

export function hidePeek() {
  if (!active) return;
  active.cleanup();
  active = null;
}

export function isPeeking() {
  return !!active;
}

export function showPeek(s) {
  hidePeek();

  const overlay = el('div', { class: 'peek-mask' }, [
    el('div', { class: 'peek-panel' }, roleLines(s)),
    el('div', { class: 'peek-hint' }, '松手即可收起'),
  ]);
  document.body.appendChild(overlay);

  const hide = () => hidePeek();
  const onKey = (e) => { if (e.key === 'Escape') hide(); };

  // 松手/取消都可能落在屏幕任意位置，所以监听 window 而不是按钮本身——
  // 手指滑出按钮范围时按钮收不到 pointerup。
  window.addEventListener('pointerup', hide);
  window.addEventListener('pointercancel', hide);
  window.addEventListener('blur', hide);
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', hide);

  // 兜底：万一 pointerup 丢了（来电、切后台、系统手势），也不能一直亮着
  const timer = setTimeout(hide, 12000);

  active = {
    cleanup() {
      clearTimeout(timer);
      window.removeEventListener('pointerup', hide);
      window.removeEventListener('pointercancel', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', hide);
      overlay.remove();
    },
  };
}

/**
 * 生成「按住查看身份」按钮。
 * 只绑定指针事件：pointerdown/up 是一对，若再挂 click 兜底，
 * 鼠标下会变成 down(显示) → up(隐藏) → click(又显示)，浮层卡在打开状态。
 */
export function peekButton(s) {
  const btn = el('button', {
    class: 'peek-btn', type: 'button', 'aria-label': '按住查看身份牌',
    pointerdown: (e) => { e.preventDefault(); showPeek(s); },
    contextmenu: (e) => e.preventDefault(), // 长按不要弹出系统菜单
    keydown: (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !isPeeking()) { e.preventDefault(); showPeek(s); }
    },
    keyup: (e) => { if (e.key === ' ' || e.key === 'Enter') hidePeek(); },
  }, [
    el('span', { class: 'peek-icon' }, '👁'),
    el('span', { class: 'peek-label' }, '身份'),
  ]);
  return btn;
}
