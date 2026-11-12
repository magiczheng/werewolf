import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io } from 'socket.io-client';
import { initSocket, clientIP } from '../server/socket.js';
import { openDb } from '../server/db.js';

async function fixture(t, opts = {}) {
  const database = opts.db || openDb(':memory:');
  const clients = [];
  const services = new Set();
  async function start() {
    const http = createServer();
    const runtime = initSocket(http, { db: database, auth: { rateLimit: 1000 }, logger: false, ...opts });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const service = { ...runtime, http, url: `http://127.0.0.1:${http.address().port}` };
    services.add(service); return service;
  }
  async function stop(service) { await new Promise(resolve => service.io.close(resolve)); services.delete(service); }
  let service = await start();
  async function connect(auth = {}) {
    const socket = io(service.url, { transports: ['websocket'], forceNew: true, auth, reconnection: false });
    const client = { socket, state: null }; clients.push(client);
    socket.on('state', state => client.state = state);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return client;
  }
  let id = 0;
  const register = async c => {
    id++; return call(c, 'register', { email: `hardening${id}@test.dev`, password: 'secret123', name: '成员' + id });
  };
  t.after(async () => { clients.forEach(c => c.socket.close()); for (const s of services) await stop(s); if (!opts.db) database.close(); });
  return { connect, register, get runtime() { return service; }, database,
    async restart() { await stop(service); service = await start(); } };
}
function context(c, actionId = crypto.randomUUID()) {
  const s = c.state;
  return { roomCode: s.roomCode, gameId: s.gameId, phaseId: s.phaseId, actionId };
}
function call(c, event, payload = {}) {
  return new Promise((resolve, reject) => c.socket.timeout(4000).emit(event, payload, (err, res) => err ? reject(err) : resolve(res)));
}
const settings = { playerCount: 9 };
async function create(f, protocol = false) {
  const c = await f.connect(protocol ? { protocol: 2 } : {}); const account = await f.register(c);
  const created = await call(c, 'createRoom', { settings, name: '本局昵称' }); assert.equal(created.ok, true);
  return { c, account, code: created.roomCode };
}

test('换房失败保留原房间绑定；成功切房会释放旧大厅名额', async t => {
  const f = await fixture(t); const a = await create(f); const b = await create(f);
  const roomB = f.runtime.rooms.get(b.code); roomB.gameStarted = true;
  assert.match((await call(a.c, 'joinRoom', { code: b.code })).error, /游戏已开始/);
  assert.equal((await call(a.c, 'sit', { seat: 1 })).ok, true);
  roomB.gameStarted = false;
  assert.equal((await call(a.c, 'joinRoom', { code: b.code, name: '新的昵称' })).ok, true);
  assert.equal(a.c.state.me.name, '新的昵称'); assert.equal(f.runtime.rooms.has(a.code), false);
});

test('同账号关闭一个标签页不会让另一条在线连接变成离线', async t => {
  const f = await fixture(t); const { c, account, code } = await create(f);
  const second = await f.connect({ token: account.token }); await call(second, 'joinRoom', { code }); second.socket.close();
  await new Promise(r => setTimeout(r, 20)); await call(c, 'sync');
  assert.equal(c.socket.connected, true); assert.equal(c.state.me.connected, true);
});

test('注销同一令牌会使所有已有连接立即失效', async t => {
  const f = await fixture(t); const { c, account } = await create(f);
  const second = await f.connect({ token: account.token });
  let expired = false; c.socket.on('sessionExpired', () => expired = true);
  await call(second, 'logout'); assert.equal(expired, true);
  assert.match((await call(c, 'createRoom', { settings })).error, /登录/);
});

test('切换账号解除旧玩家绑定，不能操作上个账号的座位', async t => {
  const f = await fixture(t); const first = await create(f); const second = await f.connect(); const other = await f.register(second);
  await call(first.c, 'login', { email: other.email, password: 'secret123' });
  assert.match((await call(first.c, 'sit', { seat: 1 })).error, /不在房间/);
});

test('请求编号去重、拒绝过期阶段，新协议拒绝缺失上下文', async t => {
  const f = await fixture(t); const { c, code } = await create(f, true);
  assert.match((await call(c, 'sit', { seat: 1 })).error, /上下文/);
  const first = context(c); assert.equal((await call(c, 'sit', { seat: 1, _context: first })).ok, true);
  assert.equal((await call(c, 'sit', { seat: 2, _context: context(c) })).ok, true);
  assert.equal((await call(c, 'sit', { seat: 1, _context: first })).ok, true);
  await call(c, 'sync'); assert.equal(c.state.me.seat, 2);
  const stale = context(c); f.runtime.rooms.get(code).phaseId = 'another-phase';
  assert.match((await call(c, 'sit', { seat: 3, _context: stale })).error, /阶段已变化/);
  assert.equal(f.runtime.rooms.get(code).players.get(c.state.me.playerId).seat, 2);
});

test('重启恢复对局身份、投票和回执，重复请求不会再次执行', async t => {
  const f = await fixture(t); const { c, account, code } = await create(f, true);
  const first = context(c); await call(c, 'sit', { seat: 1, _context: first });
  await call(c, 'sit', { seat: 2, _context: context(c) });
  const room = f.runtime.rooms.get(code);
  room.players.get(account.gameId).role = 'seer'; room.gameStarted = true; room.phase = 'nightSeer';
  room.night = { day: 1, wolfVotes: {}, seerTarget: null }; room.pendingDay = [{ type: 'hunterShoot', seat: 3 }]; room.touch();
  await f.restart();
  const again = await f.connect({ token: account.token, protocol: 2 });
  assert.equal((await call(again, 'joinRoom', { code })).ok, true);
  assert.equal(again.state.me.role, 'seer'); assert.equal(again.state.me.seat, 2);
  assert.deepEqual(f.runtime.rooms.get(code).pendingDay, [{ type: 'hunterShoot', seat: 3 }]);
  assert.equal((await call(again, 'sit', { seat: 1, _context: first })).ok, true);
  await call(again, 'sync'); assert.equal(again.state.me.seat, 2);
});

test('存档写入失败时回滚内存，客户端不会收到虚假的成功状态', async t => {
  const f = await fixture(t); const { c, code } = await create(f);
  f.database.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON room_snapshots BEGIN SELECT RAISE(ABORT, 'SQLITE simulated failure'); END");
  assert.ok((await call(c, 'sit', { seat: 1 })).error);
  assert.equal(f.runtime.rooms.get(code).players.get(c.state.me.playerId).seat, null);
  f.database.exec('DROP TRIGGER reject_snapshot');
  assert.equal((await call(c, 'sit', { seat: 1 })).ok, true);
});

test('账号创建限额跨连接生效，全局房间容量有上限', async t => {
  const f = await fixture(t, { maxRooms: 2 }); const a = await create(f); const b = await create(f);
  const newcomer = await f.connect(); await f.register(newcomer);
  assert.match((await call(newcomer, 'createRoom', { settings })).error, /数量已达上限/);
  assert.equal(f.runtime.rooms.size, 2); assert.ok(a.code && b.code);
});

test('反向代理只接受可信代理传递的合法客户端地址', () => {
  const socket = { request: { socket: { remoteAddress: '::ffff:127.0.0.1' } }, handshake: { headers: { 'x-forwarded-for': '198.51.100.8, 10.0.0.2' } } };
  assert.equal(clientIP(socket, []), '127.0.0.1');
  assert.equal(clientIP(socket, ['127.0.0.1', '10.0.0.2']), '198.51.100.8');
  socket.handshake.headers['x-forwarded-for'] = 'spoofed'; assert.equal(clientIP(socket, ['127.0.0.1']), '127.0.0.1');
});

test('创建限额按账号统计，重新建立连接不能绕过', async t => {
  const f = await fixture(t, { maxRooms: 20 }); const c = await f.connect(); const account = await f.register(c);
  for (let i = 0; i < 6; i++) assert.equal((await call(c, 'createRoom', { settings })).ok, true);
  const second = await f.connect({ token: account.token });
  assert.match((await call(second, 'createRoom', { settings })).error, /过于频繁/);
});

test('空闲回收不会删除仍有连接的房间，完全离线后同步清理存档', async t => {
  const f = await fixture(t); const { c, code } = await create(f);
  const old = Date.now() - 6 * 60 * 60 * 1000;
  f.runtime.rooms.get(code).lastActive = old; f.runtime.sweep(); assert.equal(f.runtime.rooms.has(code), true);
  f.runtime.io.sockets.sockets.get(c.socket.id).disconnect(true);
  f.runtime.rooms.get(code).lastActive = old; f.runtime.sweep();
  assert.equal(f.runtime.rooms.has(code), false); assert.equal(f.runtime.roomSockets.has(code), false);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM room_snapshots WHERE code = ?').get(code).n, 0);
});

test('回到大厅的重复请求仍返回原回执，不会再次重置新对局', async t => {
  const f = await fixture(t); const { c } = await create(f, true);
  const original = context(c); assert.equal((await call(c, 'restart', { _context: original })).ok, true);
  const game = c.state.gameId; assert.notEqual(game, original.gameId);
  assert.equal((await call(c, 'restart', { _context: original })).ok, true);
  await call(c, 'sync'); assert.equal(c.state.gameId, game);
});
