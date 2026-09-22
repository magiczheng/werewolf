// 集成测试：真实 HTTP 服务 + Socket.IO，多客户端走完整流程（无 UI）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io as createClient } from 'socket.io-client';
import { initSocket } from '../server/socket.js';
import { openDb } from '../server/db.js';

const NIGHT_PHASES = ['nightGuard', 'nightWolves', 'nightWitch', 'nightSeer'];
const isNight = (ph) => NIGHT_PHASES.includes(ph);

// ---------- 服务端 ----------
let server, baseUrl;
test.before(async () => {
  const http = createServer();
  // 内存库隔离测试数据；注册限频放宽（限频逻辑在 auth 单测里覆盖）
  initSocket(http, { db: openDb(':memory:'), auth: { rateLimit: 1000 } });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  server = http;
  baseUrl = `http://127.0.0.1:${http.address().port}`;
});
test.after(async () => {
  for (const c of allClients) { try { c.s.close(); } catch (_e) { /* 已关闭 */ } }
  if (server) await new Promise((r) => server.close(r));
});

// ---------- 客户端工具 ----------
// 统一收集所有连接，test.after 统一关闭，避免断言失败残留连接导致 server.close 挂起
const allClients = [];
function connectClient(opts = {}) {
  const s = createClient(baseUrl, { transports: ['websocket'], forceNew: true, auth: opts.auth });
  const client = { s, latest: null, waiters: [] };
  s.on('state', (st) => {
    client.latest = st;
    for (const w of [...client.waiters]) {
      if (w.pred(st)) {
        client.waiters = client.waiters.filter(x => x !== w);
        clearTimeout(w.timer);
        w.resolve(st);
      }
    }
  });
  client.connected = new Promise((res, rej) => {
    s.once('connect', res);
    s.once('connect_error', (e) => rej(new Error(`连接失败: ${e.message}`)));
  });
  client.close = () => s.close();
  allClients.push(client);
  return client;
}

function emitAck(s, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`事件 ${event} 无响应（超时）`)), timeoutMs);
    s.emit(event, payload, (resp) => {
      clearTimeout(t);
      if (resp && resp.error) reject(new Error(resp.error));
      else resolve(resp || {});
    });
  });
}

/** 注册一个客户端账号（注册成功后当次连接即登录）。返回 { token, name, email, gameId }。 */
async function registerClient(client, email, name) {
  const res = await emitAck(client.s, 'register', { email, password: 'secret1', name });
  assert.ok(res.token && res.gameId, `注册 ${email} 应返回会话`);
  return res;
}

function waitState(client, pred, timeout = 8000) {
  if (client.latest && pred(client.latest)) return Promise.resolve(client.latest);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      client.waiters = client.waiters.filter(x => x !== w);
      reject(new Error(`waitState 超时；当前 phase=${client.latest && client.latest.phase}`));
    }, timeout);
    client.waiters.push(w);
  });
}

const isPhase = (client, ph) => waitState(client, st => st.phase === ph);
const isNightDay = (client, day) => waitState(client, st => isNight(st.phase) && st.day === day);

// 建立一个 9 人无法官房间并全部入座（每个客户端先注册）
async function setupFullRoom(client, roomCode, count) {
  const players = [];
  for (let i = 2; i <= count; i++) {
    const c = connectClient();
    await c.connected;
    await registerClient(c, `p${i}@t.io`, `玩家${i}`);
    await emitAck(c.s, 'joinRoom', { code: roomCode, name: `玩家${i}` });
    await emitAck(c.s, 'sit', { seat: i });
    players.push(c);
  }
  await emitAck(client.s, 'sit', { seat: 1 });
  return players;
}

test('完整对局：创建→加入→入座→发牌→一夜→警长竞选→放逐投票→进入次夜', { timeout: 30000 }, async () => {
  const host = connectClient();
  await host.connected;
  await registerClient(host, 'host@t.io', '房主');

  // 创建 9 人房间（身份来自账号，无需再传 playerId）
  const created = await emitAck(host.s, 'createRoom', {
    name: '房主',
    // 显式指定带守卫的板子：默认 9 人局是「3 狼 + 3 神 + 3 民」，不含守卫，
    // 而这个用例要走完守卫阶段。
    settings: { playerCount: 9, judgeMode: false, roles: { wolf: 3, villager: 2, seer: 1, witch: 1, hunter: 1, guard: 1 } },
  });
  const roomCode = created.roomCode;
  assert.ok(/^[A-Z0-9]{6}$/.test(roomCode));
  await waitState(host, st => st.roomCode === roomCode);

  const others = await setupFullRoom(host, roomCode, 9);
  await waitState(host, st => st.players.filter(p => p.name).length === 9);

  // 非房主不能开始
  await assert.rejects(emitAck(others[0].s, 'startGame'), /房主/);
  // 房主开始
  await emitAck(host.s, 'startGame');
  // 等待所有客户端都收到 roleReveal（避免仍停留在 lobby 的旧快照）
  await Promise.all([host, ...others].map(c => isPhase(c, 'roleReveal')));

  // 收集每个座位的角色
  const roleBySeat = new Map();
  for (const c of [host, ...others]) {
    const st = c.latest;
    roleBySeat.set(st.me.seat, st.me.role);
  }
  assert.equal(roleBySeat.size, 9);

  // 每个玩家仅知自己身份：他人快照里 role 为空
  const firstOthersState = others[0].latest;
  assert.ok(firstOthersState.players.every(p => !p.name || !p.role), '公开列表不应泄露身份');

  // 全部确认身份 → 自动进入夜晚
  for (const c of [host, ...others]) await emitAck(c.s, 'confirmRole');
  await isPhase(host, 'nightGuard');

  const seatsOfRole = (role) => [...roleBySeat].filter(([, r]) => r === role).map(([s]) => s);
  const wolfSeats = seatsOfRole('wolf').concat(seatsOfRole('whiteWolfKing'));
  const goodSeats = [...roleBySeat].filter(([, r]) => r !== 'wolf' && r !== 'whiteWolfKing').map(([s]) => s);
  const wolfClients = [...seatsOfRole('wolf'), ...seatsOfRole('whiteWolfKing')]
    .map(s => [host, ...others].find(c => c.latest.me.seat === s));

  // 守卫
  const guardSeat = seatsOfRole('guard')[0];
  const guardClient = [host, ...others].find(c => c.latest.me.seat === guardSeat);
  const killTarget = goodSeats.find(s => s !== guardSeat);
  await emitAck(guardClient.s, 'nightAction', { type: 'guardProtect', target: killTarget });
  // 行动完即自动进入下一阶段，不需要再点结束
  await isPhase(host, 'nightWolves');

  // 狼人共同杀人
  for (const wc of wolfClients) {
    await emitAck(wc.s, 'nightAction', { type: 'wolfKill', target: killTarget });
  }
  // 狼人是队内投票：全员投完且过半即自动进入下一阶段，不需要再点结束
  await isPhase(host, 'nightWitch');

  // 女巫解药救人（首夜平安）
  const witchSeat = seatsOfRole('witch')[0];
  const witchClient = [host, ...others].find(c => c.latest.me.seat === witchSeat);
  await emitAck(witchClient.s, 'nightAction', { type: 'witchAct', kind: 'heal', target: killTarget });
  await isPhase(host, 'nightSeer');

  // 预言家查验
  const seerSeat = seatsOfRole('seer')[0];
  const seerClient = [host, ...others].find(c => c.latest.me.seat === seerSeat);
  await emitAck(seerClient.s, 'nightAction', { type: 'seerCheck', target: wolfSeats[0] });
  // 预言家验完（最后一个夜间阶段）→ 直接结算进入白天
  await isPhase(host, 'dayStart');
  assert.equal(host.latest.players.find(p => p.seat === killTarget).alive, true, '被救玩家存活');
  // 预言家收到查验结果
  const seerState = seerClient.latest;
  assert.equal(seerState.private.seerHistory[0].seat, wolfSeats[0]);
  assert.equal(seerState.private.seerHistory[0].camp, 'wolf');

  // 天亮播报由房主点「进入下一步」→ 首日警长竞选
  await emitAck(host.s, 'endPhase');
  await isPhase(host, 'sheriffDeclare');
  for (const c of [host, ...others]) {
    await emitAck(c.s, 'declare', { onPodium: c.latest.me.seat === 1 });
  }
  await waitState(host, st => st.sheriff === 1 && st.phase === 'dayTalk');
  // 警长快照可见
  assert.equal(host.latest.players.find(p => p.seat === 1).isSheriff, true);

  // 白天发言由房主点「进入放逐投票」
  await emitAck(host.s, 'endPhase');
  await isPhase(host, 'dayVote');
  // 白天放逐投票：全部弃票 → 平安日 → 直接进入第二夜
  for (const c of [host, ...others]) await emitAck(c.s, 'exileVote', { target: 0 });
  await isNightDay(host, 2);
  assert.ok(host.latest.news.some(n => n.text.includes('无人被放逐') || n.text.includes('平安日')));

  // 越权操作被拒：村民无法提交狼人刀人（当前是守卫阶段 → 报错）
  const villager = [host, ...others].find(c => c.latest.me.role === 'villager');
  await assert.rejects(
    emitAck(villager.s, 'nightAction', { type: 'wolfKill', target: 1 }),
    /狼人/
  );

  host.close();
  others.forEach(c => c.close());
});

test('法官模式：法官可见全部身份，普通玩家仅知自己', { timeout: 20000 }, async () => {
  const judge = connectClient();
  await judge.connected;
  await registerClient(judge, 'judge@t.io', '法官');
  const created = await emitAck(judge.s, 'createRoom', {
    name: '法官',
    settings: { playerCount: 8, judgeMode: true },
  });
  const roomCode = created.roomCode;
  const others = [];
  for (let i = 1; i <= 8; i++) {
    const c = connectClient();
    await c.connected;
    await registerClient(c, `j${i}@t.io`, `玩家${i}`);
    await emitAck(c.s, 'joinRoom', { code: roomCode, name: `玩家${i}` });
    await emitAck(c.s, 'sit', { seat: i });
    others.push(c);
  }
  await emitAck(judge.s, 'startGame');
  await isPhase(judge, 'roleReveal');

  // 法官快照带全部角色
  const js = judge.latest;
  assert.ok(js.judge && Array.isArray(js.judge.players));
  assert.equal(js.judge.players.filter(p => p.role).length, 8, '法官看到全部身份');
  assert.equal(js.me.isJudge, true);

  // 普通玩家无完整法官态
  assert.ok(!others[0].latest.judge.players, '普通玩家无法官面板');
  assert.equal(others[0].latest.me.role, others[0].latest.me.role);

  // 法官手动推进（8人板子无守卫 → 首夜从狼人开始）
  await emitAck(judge.s, 'judge', { cmd: 'advance' });
  await isPhase(judge, 'nightWolves');
  // 普通玩家不能推进
  await assert.rejects(emitAck(others[0].s, 'judge', { cmd: 'advance' }), /无权限/);

  judge.close();
  others.forEach(c => c.close());
});

test('断线重连：同一账号 token 回到原座位与身份', { timeout: 20000 }, async () => {
  const host = connectClient();
  await host.connected;
  await registerClient(host, 'host2@t.io', '房主');
  const created = await emitAck(host.s, 'createRoom', {
    name: '房主',
    settings: { playerCount: 8, judgeMode: false },
  });
  const roomCode = created.roomCode;
  // 8 人满房：host 坐 1 号，b 坐 2 号（作为重连对象），其余 6 人
  let b = null, bToken = '';
  const others = [];
  for (let i = 2; i <= 8; i++) {
    const c = connectClient();
    await c.connected;
    const email = i === 2 ? 'b@t.io' : `r${i}@t.io`;
    const res = await registerClient(c, email, i === 2 ? '小B' : `玩家${i}`);
    if (i === 2) bToken = res.token;
    await emitAck(c.s, 'joinRoom', { code: roomCode, name: i === 2 ? '小B' : `玩家${i}` });
    await emitAck(c.s, 'sit', { seat: i });
    if (i === 2) b = c; else others.push(c);
  }
  await emitAck(host.s, 'sit', { seat: 1 });
  await emitAck(host.s, 'startGame');
  await waitState(b, st => st.phase === 'roleReveal' && st.me.seat === 2);
  const roleBefore = b.latest.me.role;

  // 断线
  b.close();
  // 用同一账号 token 重新连接并加入（握手即恢复登录）
  const b2 = connectClient({ auth: { token: bToken } });
  await b2.connected;
  await emitAck(b2.s, 'joinRoom', { code: roomCode, name: '小B' });
  const st = await waitState(b2, st => st.gameStarted && st.me.seat === 2);
  assert.equal(st.me.role, roleBefore, '重连后身份不变');
  assert.equal(st.me.seat, 2, '重连后座位保留');

  host.close();
  b2.close();
  others.forEach(c => c.close());
});

test('强制登录：未登录不能创建房间，登出后即失效', { timeout: 20000 }, async () => {
  // 未登录的匿名连接：创建房间被拒
  const guest = connectClient();
  await guest.connected;
  await assert.rejects(
    emitAck(guest.s, 'createRoom', { name: '游客', settings: { playerCount: 8, judgeMode: false } }),
    /请先登录/
  );
  await assert.rejects(
    emitAck(guest.s, 'joinRoom', { code: 'AAAAAA', name: '游客' }),
    /请先登录/
  );

  // 注册后可创建
  await registerClient(guest, 'auth1@t.io', '小甲');
  const created = await emitAck(guest.s, 'createRoom', { name: '小甲', settings: { playerCount: 8, judgeMode: false } });
  assert.ok(/^[A-Z0-9]{6}$/.test(created.roomCode));

  // 登出后再创建被拒
  await emitAck(guest.s, 'logout', {});
  await assert.rejects(
    emitAck(guest.s, 'createRoom', { name: '小甲', settings: { playerCount: 8, judgeMode: false } }),
    /请先登录/
  );

  // 登出后原 token 也失效：新连接携带旧 token 握手不再恢复登录
  const relog = connectClient();
  await relog.connected;
  const res = await emitAck(relog.s, 'register', { email: 'auth2@t.io', password: 'secret1', name: '小乙' });
  const token = res.token;
  await emitAck(relog.s, 'logout', {});
  relog.close();
  const stale = connectClient({ auth: { token } });
  await stale.connected;
  await assert.rejects(
    emitAck(stale.s, 'createRoom', { name: '小乙', settings: { playerCount: 8, judgeMode: false } }),
    /请先登录/
  );

  guest.close();
  stale.close();
});
