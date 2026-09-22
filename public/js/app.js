// 前端路由：按连接状态把视图挂到 #app
import { net, session } from './net.js';
import { toast } from './ui.js';
import { renderAuth, resetAuthMode } from './views/auth.js';
import { renderHome, resetHomeTab } from './views/home.js';
import { renderLobby } from './views/lobby.js';
import { renderGame, resetGameView } from './views/game.js';

function appEl() {
  return document.getElementById('app');
}

// 记录上一个视图，跨视图切换时清理各视图的模块级状态
let lastView = '';

function resetViewState(next) {
  if (next === lastView) return;
  switch (lastView) {
    case 'auth': resetAuthMode(); break;
    case 'home': resetHomeTab(); break;
    case 'game': resetGameView(); break;
  }
  lastView = next;
  window.scrollTo(0, 0);
}

async function logout() {
  await net.logout();
  app.render();
}

export const app = {
  render() {
    const root = appEl();
    if (!root) return;

    const s = net.state;
    const loggedIn = !!session();

    document.body.classList.remove('has-tabbar');

    // 未登录 → 登录页
    if (!loggedIn) {
      resetViewState('auth');
      root.innerHTML = '';
      renderAuth(root, () => app.render());
      return;
    }

    // 已登录但不在房间 → 首页
    if (!s || !s.me) {
      resetViewState('home');
      root.innerHTML = '';
      renderHome(root, { onLogout: logout });
      return;
    }

    // 在房间里
    const view = s.gameStarted ? 'game' : 'lobby';
    resetViewState(view);
    root.innerHTML = '';
    // 只有游戏页有底部 Tab 栏；toast 需要据此避让，否则会被永久遮住
    document.body.classList.toggle('has-tabbar', view === 'game');
    if (view === 'lobby') renderLobby(root);
    else renderGame(root);
  },
};

// 连接状态：顶部细条提示断线，恢复后自动消失
export function wireConnectionBanner() {
  net.on((_s, type) => {
    if (type === 'disconnect') {
      document.body.classList.add('offline');
      toast('连接已断开，正在重连…', true);
    } else if (type === 'connect') {
      document.body.classList.remove('offline');
    }
  });
}
