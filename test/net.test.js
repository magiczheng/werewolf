// 客户端连接层：重连时必须重新读取最新 token，唤醒时主动探活。
//
// 回归背景：auth 曾经写成对象 `{ token: sessionToken() }`，只在页面加载时求值一次。
// 用户先打开页面（未登录，token 为空）再登录，之后锁屏断线重连携带的仍是空 token，
// 服务端认不出人，表现为「每次都要重新登录」。

import test from 'node:test';
import assert from 'node:assert/strict';

const { installDom } = await import('./helpers/dom.js');

const env = installDom();
const { net, store } = await import('../public/js/net.js');

const authToken = (sock) => new Promise((resolve) => sock.opts.auth(resolve));

test('Socket.IO 的 auth 是函数：每次（重）连都读取当前 token', async () => {
  store.set('ww_token', 'token-before-login');
  net.connect();
  const sock = env.lastSocket();

  assert.equal(typeof sock.opts.auth, 'function',
    'auth 必须是函数，否则 token 只会在页面加载时读取一次');
  assert.deepEqual(await authToken(sock), { token: 'token-before-login' });

  // 模拟登录后 token 变化，同一条连接再次握手（重连）时应带上新 token
  store.set('ww_token', 'token-after-login');
  assert.deepEqual(await authToken(sock), { token: 'token-after-login' });
});

test('回到前台 sync 探活：有 ack 保持连接，无 ack 则强制重连', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  net.connect();
  const sock = env.lastSocket();

  env.fireDocument('visibilitychange', {});

  assert.equal(sock.emitted.filter(e => e.event === 'sync').length, 1,
    '页面恢复可见时应向服务端要一次快照');
  assert.equal(sock.connected, true, 'ack 正常时不应误判为断线');

  // 模拟 TCP 已死但 socket.connected 仍为 true 的僵尸连接
  let disconnects = 0;
  let reconnects = 0;
  sock.emit = () => {};
  sock.disconnect = () => {
    disconnects++;
    sock.connected = false;
    sock.fire('disconnect', 'io client disconnect');
  };
  sock.connect = () => {
    reconnects++;
    sock.connected = true;
    sock.fire('connect');
  };

  t.mock.timers.tick(1600);      // 越过 1.5 秒的探活防抖
  env.fireWindow('pageshow');
  assert.equal(disconnects, 0, '刚发出探活时还不能断定断线');

  t.mock.timers.tick(5000);
  assert.equal(disconnects, 1, '5 秒无 ack 后应强制断开');
  assert.equal(reconnects, 1, '并立即重建连接，让 Socket.IO 重新握手');
});
