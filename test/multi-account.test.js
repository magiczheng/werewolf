// 多账号测试模式：验证「一个浏览器多个标签页各登录一个账号」的底层保证。
//
// node --test 会为每个测试文件开独立进程，所以本文件能让 net.js 以
// window.__WW_MULTI__ = true 全新加载，不受其它测试文件影响。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { installDom } = await import('./helpers/dom.js');

const env = installDom({ multi: true });
const netMod = await import('../public/js/net.js');
const { net, store, multiAccount, session, playerId, playerName, setPlayerName } = netMod;

const LS = env.win.localStorage;
const SS = env.win.sessionStorage;

describe('多账号测试模式', () => {
  test('模式标志已开启', () => {
    assert.equal(multiAccount, true);
  });

  test('登录会话写入 sessionStorage，而不是 localStorage', async () => {
    LS.clear(); SS.clear();
    // 走真实的登录路径（伪 socket 会把 ack 立刻回给回调）
    const sock = (net.connect(), env.lastSocket());
    sock.emit = (ev, payload, cb) => {
      if (typeof cb === 'function') {
        cb({ ok: true, token: 'tok-A', email: 'a@t.dev', name: '甲', gameId: 'gid-A' });
      }
    };
    await net.login('a@t.dev', 'pwd123456');

    assert.equal(SS.getItem('ww_token'), 'tok-A', 'token 应在 sessionStorage');
    assert.equal(LS.getItem('ww_token'), null, 'localStorage 必须保持干净——否则会串到别的标签页');
    assert.equal(session().name, '甲');
  });

  test('localStorage 里已有别的账号时，新标签页不继承（保证各标签页独立）', () => {
    // 模拟：另一个标签页/上一次会话在 localStorage 留了账号「乙」
    LS.clear(); SS.clear();
    LS.setItem('ww_token', 'tok-B');
    LS.setItem('ww_user_email', 'b@t.dev');
    LS.setItem('ww_user_name', '乙');
    LS.setItem('ww_game_id', 'gid-B');
    // 本标签页的 sessionStorage 是空的（新标签页）
    assert.equal(session(), null,
      '测试模式下新标签页必须是未登录状态，否则会用错账号和它所在的房间');
  });

  test('每个标签页的房间记录互不干扰', () => {
    LS.clear(); SS.clear();
    store.set('ww_last_room', 'ROOM-A');       // 本标签页
    LS.setItem('ww_last_room', 'ROOM-B');      // 另一个标签页
    assert.equal(store.get('ww_last_room'), 'ROOM-A',
      '自动重连必须只认本标签页的房间，否则两个标签页会互相抢房间');
  });

  test('玩家昵称与本地身份也按标签页隔离', () => {
    LS.clear(); SS.clear();
    setPlayerName('甲');
    assert.equal(playerName(), '甲');
    assert.equal(LS.getItem('ww_player_name'), null, '不应写入共享的 localStorage');

    const id = playerId();
    assert.ok(id && id.length > 0);
    assert.equal(typeof id, 'string');
  });

  test('登出只清本标签页的会话', async () => {
    SS.clear(); LS.clear();
    SS.setItem('ww_token', 'tok-A');
    SS.setItem('ww_user_email', 'a@t.dev');
    // 另一个标签页在 localStorage 的痕迹
    LS.setItem('ww_token', 'tok-B');
    LS.setItem('ww_user_email', 'b@t.dev');

    await net.logout();

    assert.equal(SS.getItem('ww_token'), null, '本标签页会话应被清除');
    assert.equal(LS.getItem('ww_token'), 'tok-B', '不应动到其它标签页的存储');
  });
});

describe('默认模式（未开启开关）的隔离性对照', () => {
  test('installDom 不带 multi 时，模式标志为关闭', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../public/js/net.js', import.meta.url), 'utf8');
    // 默认必须走 localStorage，保证既有用户的登录状态与「关浏览器仍登录」不变
    assert.match(src, /if \(MULTI\) return pick\(sessionStorage\)/);
    assert.match(src, /return pick\(localStorage\)/);
  });

  test('服务端默认不注入开关（未设环境变量时为 false）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../server/config.js', import.meta.url), 'utf8');
    assert.match(src, /MULTI_ACCOUNT\s*=\s*process\.env\.MULTI_ACCOUNT\s*===\s*'1'/,
      '必须显式等于 "1" 才开启，避免任何非空值都误开启');
  });
});
