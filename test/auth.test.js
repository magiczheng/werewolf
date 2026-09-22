// 账号体系单测：注册 / 登录 / 登出 / 会话校验（内存 SQLite，不依赖网络）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createAuth } from '../server/auth.js';

function setup(opts = {}) {
  const db = openDb(':memory:');
  const auth = createAuth(db, opts);
  return { db, auth };
}

test('注册：成功并返回会话，邮箱小写归一', () => {
  const { auth } = setup();
  const res = auth.register('Alice@Example.com', 'secret1', '小艾', '1.2.3.4');
  assert.ok(!res.error, res.error);
  assert.equal(res.email, 'alice@example.com');
  assert.equal(res.name, '小艾');
  assert.ok(res.token && res.gameId);
  // 会话可认证
  const u = auth.authenticateToken(res.token);
  assert.ok(u);
  assert.equal(u.email, 'alice@example.com');
  assert.equal(u.gameId, res.gameId);
});

test('注册：重复邮箱被拒（含大小写差异）', () => {
  const { auth } = setup();
  assert.ok(!auth.register('a@x.com', 'secret1', 'A', 'ip').error);
  const res = auth.register('A@X.COM', 'secret1', 'B', 'ip');
  assert.ok(res.error && res.error.includes('已注册'));
});

test('注册：邮箱格式与密码长度校验', () => {
  const { auth } = setup();
  assert.ok(auth.register('not-an-email', 'secret1', 'A', 'ip').error.includes('邮箱'));
  assert.ok(auth.register('a@x.com', '123', 'A', 'ip').error.includes('密码'));
  assert.ok(auth.register('', 'secret1', 'A', 'ip').error);
  // 未提供昵称时用邮箱前缀兜底
  const res = auth.register('bob@x.com', 'secret1', '', 'ip');
  assert.ok(!res.error);
  assert.equal(res.name, 'bob');
});

test('登录：正确密码成功，错误密码/未注册被拒', () => {
  const { auth } = setup();
  auth.register('u@x.com', 'secret1', 'UU', 'ip');
  const ok = auth.login('u@x.com', 'secret1', 'ip');
  assert.ok(!ok.error);
  assert.equal(ok.name, 'UU');
  assert.ok(auth.login('u@x.com', 'wrongpw', 'ip').error.includes('邮箱或密码'));
  assert.ok(auth.login('nope@x.com', 'secret1', 'ip').error);
});

test('登出：token 失效', () => {
  const { auth } = setup();
  const res = auth.register('x@x.com', 'secret1', 'X', 'ip');
  assert.ok(auth.authenticateToken(res.token));
  auth.logout(res.token);
  assert.equal(auth.authenticateToken(res.token), null);
});

test('IP 限频：超限被拒', () => {
  const { auth } = setup({ rateLimit: 3 });
  for (let i = 0; i < 3; i++) {
    assert.ok(!auth.register(`r${i}@x.com`, 'secret1', 'N', '8.8.8.8').error);
  }
  const r = auth.register('r3@x.com', 'secret1', 'N', '8.8.8.8');
  assert.ok(r.error && r.error.includes('频繁'));
  // 其他 IP 不受影响
  assert.ok(!auth.register('r4@x.com', 'secret1', 'N', '7.7.7.7').error);
});
