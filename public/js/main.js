// 启动：连接、渲染、断线自动重连回房间、Service Worker 注册
import { net, session, playerName, store, multiAccount, clearSession } from './net.js';
import { app, wireConnectionBanner } from './app.js';
import { toast } from './ui.js';

// 渲染订阅要最先注册，保证连接横幅等副作用在渲染之后执行
net.on(() => app.render());
wireConnectionBanner();

// 关键：必须主动渲染一次。
// net.on 的回调只在「已有 state」时才会被触发，而服务端只在玩家处于房间中时才推送
// state——全新访客（未登录、无房间）永远等不到推送，页面会一直空着。
// 这里先同步渲染一帧（登录卡片只依赖 localStorage 中的会话），再建立连接。
app.render();

// 刷新页面 / 断线重连：自动回到之前所在房间
// （服务端以账号身份恢复座位与角色，所以换设备也能回到原位）
//
// 必须注册在 net.connect() 之前：否则连接建立得太快时，第一次 connect
// 事件可能在监听器挂上之前就错过了，用户会停在首页。
let rejoining = false;
net.on(async (_s, type) => {
  if (type !== 'connect') return;
  if (!session()) return; // 未登录不自动重连，首页会显示登录卡片
  const code = store.get('ww_last_room');
  if (!code || rejoining) return;
  rejoining = true;
  try {
    await net.emit('joinRoom', { code, name: playerName() || session().name });
  } catch (e) {
    // 网络抖动导致的超时不作数：保留房间记录，下一次连接恢复时再试。
    if (/无响应|网络/.test(e.message)) {
      toast('网络不稳定，恢复后会自动回到房间', true);
      return;
    }
    store.remove('ww_last_room');
    if (/登录|身份/.test(e.message)) {
      // 服务端明确不认这个会话：本地也必须退出，否则界面会假装还登录着。
      clearSession();
      net.clear();
      toast('登录已失效，请重新登录', true);
    } else {
      net.clear();
      toast(/房间不存在/.test(e.message) ? '房间已失效，请重新加入' : e.message, true);
    }
  } finally {
    rejoining = false;
  }
});

net.connect();

// 多账号测试模式：角标提示，避免误以为会话行为异常
if (multiAccount) {
  document.body.classList.add('multi-account');
  const badge = document.createElement('div');
  badge.className = 'mode-badge';
  const skipReveal = (() => { try { return !!window.__WW_SKIP_REVEAL__; } catch (_e) { return false; } })();
  badge.textContent = '测试模式 · 本标签页独立账号' + (skipReveal ? ' · 已跳过确认身份' : '');
  badge.title = '服务端以 MULTI_ACCOUNT=1 启动：会话按标签页隔离，可在一个浏览器里同时登录多个账号'
    + (skipReveal ? '；并已跳过「确认身份」阶段（正式运行不会跳过，可用 SKIP_ROLE_REVEAL=0 强制保留）' : '');
  document.body.appendChild(badge);
}

// ---------- PWA ----------
// Service Worker 只在安全上下文可用：HTTPS 或 localhost。
// 本项目最常见的用法是手机扫码访问 http://192.168.x.x:3000（局域网 HTTP），
// 那是不安全源，注册必然失败——所以这里显式判断，失败也不影响任何功能。
// manifest / 添加到主屏幕 / 独立窗口显示在 HTTP 下依然可用。
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 注册失败不影响使用 */
    });
  });
}
