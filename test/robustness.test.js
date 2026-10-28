// 健壮性回归：防止「一个玩家操作搞崩整个服务器」这一类事故。
//
// 背景（真实事故）：构造函数里的数据字段 this.lastWords = {} 遮蔽了原型上的
// 同名方法 lastWords()，于是 socket 事件处理器调用 g.room.lastWords(...) 时抛
// TypeError。该异常未被捕获，Node 直接退出——8 个人的牌局同时掉线。
//
// 这里锁两件事：
//   1. 数据字段与方法不得同名（扫描全部属性，防止同类问题再出现）
//   2. socket 事件处理器抛错不得杀掉进程

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io as createClient } from 'socket.io-client';
import { initSocket } from '../server/socket.js';
import { openDb } from '../server/db.js';
import { Room, buildSettings } from '../server/engine.js';

// ---------- 1. 命名冲突扫描 ----------

/** 收集原型链上的全部方法名 */
function prototypeMethods(cls) {
  const names = new Set();
  let p = cls.prototype;
  while (p && p !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k !== 'constructor' && typeof cls.prototype[k] === 'function') names.add(k);
    }
    p = Object.getPrototypeOf(p);
  }
  return names;
}

test('Room 的实例字段不得与原型方法同名（会静默遮蔽方法）', () => {
  const settings = buildSettings({ playerCount: 9 });
  const room = new Room({
    code: 'T', settings, hostPlayerId: 'H', hostName: '房主', onChange() {},
  });

  const methods = prototypeMethods(Room);
  const collisions = Object.getOwnPropertyNames(room).filter((k) => methods.has(k));

  assert.deepEqual(collisions, [],
    `以下实例字段遮蔽了同名原型方法，调用时会抛 "is not a function"：${collisions.join('、')}`);
});

test('事故方法已彻底移除，同类遮蔽不可能再发生', () => {
  const settings = buildSettings({ playerCount: 9 });
  const room = new Room({
    code: 'T', settings, hostPlayerId: 'H', hostName: '房主', onChange() {},
  });
  // 事故的根因是「数据字段 lastWords」与「方法 lastWords」撞名。
  // 现在字段与方法都不存在了：遗言改成线下发言、由 endPhase 推进。
  assert.equal(room.lastWords, undefined, 'lastWords 数据字段已移除');
  assert.equal(room.submitLastWords, undefined, 'submitLastWords 方法已移除');
});

// ---------- 2. 遗言流程可用 ----------

test('遗言阶段：遗言者点结束即推进，别人不行', () => {
  const settings = buildSettings({ playerCount: 9 });
  const room = new Room({
    code: 'T', settings, hostPlayerId: 'H', hostName: '房主', onChange() {},
  });
  for (let i = 2; i <= 9; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  room.start();
  for (const p of room._livePlayers()) room.roleConfirm(p.playerId);

  // 直接构造遗言阶段，避免跑完整局
  room.phase = 'lastWords';
  room.phaseState = { seat: 3 };

  assert.ok(room.endPhase(room._playerAt(4).playerId).error, '抢麦应被拒绝');
  assert.equal(room.phase, 'lastWords', '被拒绝后阶段不变');

  const res = room.endPhase(room._playerAt(3).playerId);
  assert.ok(!res.error, `遗言者结束发言不应报错，实际: ${res.error}`);
  assert.notEqual(room.phase, 'lastWords', '结束后应离开遗言阶段');
});

// ---------- 3. 事件处理器抛错不得杀掉进程 ----------

test('socket 处理器抛错被隔离，进程存活且客户端收到错误应答', async () => {
  const http = createServer();
  initSocket(http, { db: openDb(':memory:'), auth: { rateLimit: 1000 } });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${http.address().port}`;

  const s = createClient(baseUrl, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => s.once('connect', r));

  const call = (ev, payload) => new Promise((r) => s.emit(ev, payload, r));
  await call('register', { email: 'boom@t.dev', password: 'pwd123456', name: '测试' });
  await call('createRoom', { name: '测试', settings: { playerCount: 9 } });
  await call('sit', { seat: 1 });

  // 制造一个必然抛错的处理器：把引擎方法临时换成会抛的实现。
  // socket.js 与这里 import 的是同一个模块实例，原型改动会作用到运行中的服务。
  const original = Room.prototype.sit;
  Room.prototype.sit = () => { throw new Error('故意注入的故障'); };

  let res;
  try {
    res = await call('sit', { seat: 2 });
  } finally {
    Room.prototype.sit = original; // 务必还原，否则影响其它测试
  }

  assert.ok(res && res.error, '客户端应收到错误应答，而不是一直干等');

  // 关键：服务仍然活着 —— 旧代码在这里已经整个进程退出了
  const health = await call('leaveRoom', {});
  assert.ok(health && !health.error, '出错之后服务必须仍能正常处理后续请求');

  s.close();
  await new Promise((r) => http.close(r));
});

test('故障演示：字段遮蔽方法确实会抛错（确认碰撞扫描测的是真问题）', () => {
  // 用一个临时类复现当初的事故形态，确保上面那条扫描不是空转
  class Demo {
    constructor() { this.thing = {}; }
    thing() { return 'method'; }
  }
  const d = new Demo();
  assert.throws(() => d.thing(), /is not a function/,
    '这正是当初把服务器搞崩的那一行：构造函数里的字段遮蔽了同名原型方法');
});
