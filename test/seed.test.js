// 测试账号种子：确保 1@qq.com … N@qq.com 存在且密码就是 111111（N = TEST_ACCOUNT_COUNT）。
// 用内存库，不触碰真实的 data/werewolf.db。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import { seedTestAccounts } from '../server/seed.js';
import { TEST_ACCOUNT_COUNT, TEST_ACCOUNT_PASSWORD, testAccountEmail } from '../server/config.js';

const fresh = () => openDb(':memory:');

test('全新库：创建全部测试账号，且都能用 111111 登录', () => {
  const db = fresh();
  const r = seedTestAccounts(db);
  assert.equal(r.created.length, TEST_ACCOUNT_COUNT);
  assert.equal(r.reset.length, 0);
  assert.equal(r.failed.length, 0);

  const auth = createAuth(db);
  for (let i = 1; i <= TEST_ACCOUNT_COUNT; i++) {
    const res = auth.login(testAccountEmail(i), TEST_ACCOUNT_PASSWORD);
    assert.ok(!res.error, `${testAccountEmail(i)} 应能登录，实际: ${res.error}`);
  }
});

test('邮箱规则就是 N@qq.com', () => {
  assert.equal(testAccountEmail(1), '1@qq.com');
  assert.equal(testAccountEmail(TEST_ACCOUNT_COUNT), TEST_ACCOUNT_COUNT + '@qq.com');
  assert.equal(TEST_ACCOUNT_PASSWORD, '111111');
});

test('重复执行是幂等的，不会重复建号', () => {
  const db = fresh();
  seedTestAccounts(db);
  const again = seedTestAccounts(db);
  assert.equal(again.created.length, 0, '第二次不应再新建');
  assert.equal(again.reset.length, 0, '密码已正确，不应重置');
  assert.equal(again.ok.length, TEST_ACCOUNT_COUNT, '应全部识别为已就绪');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, TEST_ACCOUNT_COUNT,
    '用户总数不应增长');
});

test('账号已存在但密码不同 → 重置为 111111（核心：否则测试开关会静默说谎）', () => {
  const db = fresh();
  const auth = createAuth(db);
  auth.register('1@qq.com', 'someoneElsesPw', '1');
  assert.ok(auth.login('1@qq.com', TEST_ACCOUNT_PASSWORD).error, '前提：原密码不是 111111');

  const r = seedTestAccounts(db);
  assert.deepEqual(r.reset, ['1@qq.com'], '应报告重置了哪个账号');
  assert.equal(r.created.length, TEST_ACCOUNT_COUNT - 1, '除预置的那个外都应新建');
  assert.ok(!createAuth(db).login('1@qq.com', TEST_ACCOUNT_PASSWORD).error,
    '重置后应能用 111111 登录');
});

test('重置密码会注销该账号既有会话', () => {
  const db = fresh();
  const auth = createAuth(db);
  const reg = auth.register('1@qq.com', 'someoneElsesPw', '1');
  assert.ok(auth.authenticateToken(reg.token), '前提：该会话当前有效');

  seedTestAccounts(db);
  assert.equal(createAuth(db).authenticateToken(reg.token), null,
    '密码都换了，旧会话必须失效');
});

test('resetPassword:false → 只报告不修改既有账号', () => {
  const db = fresh();
  const auth = createAuth(db);
  auth.register('1@qq.com', 'keepThisPw', '1');

  const r = seedTestAccounts(db, { resetPassword: false });
  assert.deepEqual(r.mismatched, ['1@qq.com']);
  assert.equal(r.reset.length, 0, '不应重置');
  assert.ok(!createAuth(db).login('1@qq.com', 'keepThisPw').error, '原密码必须保持不变');
});

test('账号被以正确的密码预先注册时，不触发重置', () => {
  const db = fresh();
  createAuth(db).register('1@qq.com', TEST_ACCOUNT_PASSWORD, '1');
  const r = seedTestAccounts(db);
  assert.equal(r.reset.length, 0);
  assert.ok(r.ok.includes('1@qq.com'));
});

test('昵称用序号，便于在座位表里对上号', () => {
  const db = fresh();
  seedTestAccounts(db);
  const rows = db.prepare('SELECT email, name FROM users ORDER BY id').all();
  // 昵称就是序号，从常量推导而不是写死，避免改账号数量时测试失效
  assert.deepEqual(rows.map((r) => r.name),
    Array.from({ length: TEST_ACCOUNT_COUNT }, (_, i) => String(i + 1)));
});

test('密码以 scrypt 加盐哈希存储，不存明文', () => {
  const db = fresh();
  seedTestAccounts(db);
  const row = db.prepare('SELECT pass_hash, pass_salt FROM users WHERE email = ?').get('1@qq.com');
  assert.ok(row.pass_hash && row.pass_hash.length === 128, 'scrypt 64 字节应编码为 128 位十六进制');
  assert.notEqual(row.pass_hash, TEST_ACCOUNT_PASSWORD, '绝不能是明文');
  assert.ok(row.pass_salt && row.pass_salt.length > 0, '必须有盐');
});

test('每个账号的盐不同（防止彩虹表）', () => {
  const db = fresh();
  seedTestAccounts(db);
  const salts = db.prepare('SELECT pass_salt FROM users').all().map((r) => r.pass_salt);
  assert.equal(new Set(salts).size, salts.length);
});

test('账号的 game_id 各不相同（即座位身份互不冲突）', () => {
  const db = fresh();
  seedTestAccounts(db);
  const ids = db.prepare('SELECT game_id FROM users').all().map((r) => r.game_id);
  assert.equal(new Set(ids).size, ids.length);
});
