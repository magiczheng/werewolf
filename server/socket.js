// Socket.IO 事件层：房间注册、连接管理、事件路由、快照广播、计时循环。
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { Room, buildSettings } from './engine.js';
import { ROOM_IDLE_TTL, SKIP_ROLE_REVEAL } from './config.js';
import { db } from './db.js';
import { createAuth } from './auth.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
const ROOM_CREATE_LIMIT = 6; // 每 socket 每分钟最多创建房间数

const rooms = new Map();          // code -> Room
const roomSockets = new Map();    // code -> Set<socket>

function genCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function genPlayerId() {
  return randomUUID();
}

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/[\x00-\x1f<>]/g, '').slice(0, 12);
}

function getRoom(code) {
  if (!code) return null;
  return rooms.get(String(code).toUpperCase().trim());
}

/** 把某个房间的最新快照推给房间内所有 socket（按观看者分别计算）。 */
function pushRoom(room) {
  const set = roomSockets.get(room.code);
  if (!set) return;
  for (const socket of set) {
    if (!socket.connected) continue;
    socket.emit('state', room.snapshot(socket.data.playerId));
  }
}

function attachSocketToRoom(socket, code) {
  if (!roomSockets.has(code)) roomSockets.set(code, new Set());
  roomSockets.get(code).add(socket);
  socket.join(code);
}

function detachSocketFromRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const set = roomSockets.get(code);
  if (set) {
    set.delete(socket);
    if (set.size === 0) roomSockets.delete(code);
  }
  socket.data.roomCode = null;
}

/** 释放旧房间、断开旧连接标记。 */
function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = getRoom(code);
  if (room && socket.data.playerId) room.setConnected(socket.data.playerId, false);
  detachSocketFromRoom(socket);
}

export function initSocket(server, opts = {}) {
  const io = new Server(server, {
    maxHttpBufferSize: 1e6,
    serveClient: true,
  });
  // 默认用全局单例数据库；测试可注入 :memory: 库与自定义参数。
  const auth = createAuth(opts.db || db, opts.auth || {});

  io.on('connection', (socket) => {
    socket.data.roomCode = null;
    socket.data.playerId = null;
    socket.data.user = null;
    // 握手时携带 token → 恢复登录会话（刷新页面 / 断线重连）
    const handshakeToken = socket.handshake.auth && socket.handshake.auth.token;
    if (handshakeToken) {
      const u = auth.authenticateToken(handshakeToken);
      if (u) socket.data.user = u;
    }

    const fail = (cb, msg) => {
      if (typeof cb === 'function') cb({ error: msg });
    };
    const ok = (cb, extra) => {
      if (typeof cb === 'function') cb({ ok: true, ...extra });
    };
    // 统一取 ack 回调：socket.io 总是把回调作为最后一个参数，
    // 兼容「仅回调」与「(payload, cb)」两种客户端写法。
    const withCb = (fn) => (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      return fn(args[0], cb);
    };

    // 统一包裹事件处理器：任何处理器抛错都不该让整个服务进程退出。
    // 8 个人的牌局共用一台服务器，一个人踩到边界条件不该把所有人踢下线
    // （真实事故：某次 lastWords 处理器调用了一个不存在的方法，进程直接退出）。
    const on = (event, handler) => {
      // 注意这里必须用 socket.on —— 写成 on(...) 会递归调用自己
      socket.on(event, (...args) => {
        try {
          return handler(...args);
        } catch (e) {
          console.error(`[socket] 处理 "${event}" 时抛错：`, e);
          // 尽量用 ack 回调把错误告知客户端，而不是让它一直等
          const cb = args[args.length - 1];
          if (typeof cb === 'function') {
            try { cb({ error: '服务器内部错误' }); } catch (_e2) { /* 回调本身也炸就放弃 */ }
          }
        }
      });
    };
    const roomOf = () => getRoom(socket.data.roomCode);
    const playerOf = (room) => (socket.data.playerId ? room.players.get(socket.data.playerId) : null);

    on('createRoom', (payload, cb) => {
      const user = socket.data.user;
      if (!user) return fail(cb, '请先登录');
      const now = Date.now();
      const recent = (socket.data.createdAt || []).filter(t => now - t < 60_000);
      if (recent.length >= ROOM_CREATE_LIMIT) return fail(cb, '创建房间过于频繁');
      recent.push(now);
      socket.data.createdAt = recent;

      const name = sanitizeName(payload && payload.name) || user.name;
      const playerId = user.gameId; // 服务端权威：账号即游戏身份
      if (!name) return fail(cb, '请输入昵称');
      let settings;
      try { settings = buildSettings(payload && payload.settings); }
      catch (e) { return fail(cb, e.message); }

      leaveCurrentRoom(socket);
      const code = genCode();
      const room = new Room({
        code, settings, hostPlayerId: playerId, hostName: name, onChange: pushRoom,
        skipRoleReveal: SKIP_ROLE_REVEAL,
      });
      rooms.set(code, room);
      socket.data.roomCode = code;
      socket.data.playerId = playerId;
      attachSocketToRoom(socket, code);
      ok(cb, { roomCode: code });
      pushRoom(room);
    });

    on('joinRoom', (payload, cb) => {
      const user = socket.data.user;
      if (!user) return fail(cb, '请先登录');
      const code = String((payload && payload.code) || '').toUpperCase().trim();
      const room = getRoom(code);
      if (!room) return fail(cb, '房间不存在');
      const name = sanitizeName(payload && payload.name) || user.name;
      const playerId = user.gameId; // 服务端权威：账号即游戏身份

      leaveCurrentRoom(socket);
      if (!room.players.has(playerId)) {
        const res = room.addPlayer(playerId, name);
        if (res.error) return fail(cb, res.error);
      } else {
        room.setConnected(playerId, true);
      }
      socket.data.roomCode = code;
      socket.data.playerId = playerId;
      attachSocketToRoom(socket, code);
      ok(cb);
      pushRoom(room);
    });

    // ---------- 账号：注册 / 登录 / 登出 ----------
    on('register', withCb((payload, cb) => {
      const res = auth.register(
        payload && payload.email,
        payload && payload.password,
        payload && payload.name,
        socket.handshake.address,
      );
      if (res.error) return fail(cb, res.error);
      socket.data.user = { token: res.token, email: res.email, name: res.name, gameId: res.gameId };
      ok(cb, res);
    }));

    on('login', withCb((payload, cb) => {
      const res = auth.login(
        payload && payload.email,
        payload && payload.password,
        socket.handshake.address,
      );
      if (res.error) return fail(cb, res.error);
      socket.data.user = { token: res.token, email: res.email, name: res.name, gameId: res.gameId };
      ok(cb, res);
    }));

    on('logout', withCb((_p, cb) => {
      // 会话 token：优先用本连接注册/登录得到的，其次握手携带的
      const token = (socket.data.user && socket.data.user.token)
        || (socket.handshake.auth && socket.handshake.auth.token);
      auth.logout(token);
      socket.data.user = null;
      const room = roomOf();
      if (room) {
        room.leave(socket.data.playerId);
        detachSocketFromRoom(socket);
        if (room.players.size === 0) rooms.delete(room.code);
        pushRoom(room);
      }
      ok(cb);
    }));

    // 纯客户端事件：进入房间后操作（统一守卫：必须在房间中且身份匹配）
    const guard = (cb) => {
      const room = roomOf();
      if (!room) { fail(cb, '不在房间中'); return null; }
      const player = playerOf(room);
      if (!player) { fail(cb, '身份无效，请重新进入房间'); return null; }
      return { room, player };
    };

    on('sit', (payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.sit(socket.data.playerId, Number(payload && payload.seat));
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('standUp', withCb((_p, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.standUp(g.player.playerId);
      if (res.error) return fail(cb, res.error);
      ok(cb);
    }));

    // 手机解锁 / 切回前台时的轻量探活：把当前房间快照重新推一遍。
    // 客户端若 5 秒收不到 ack，就判定连接已僵死并强制重连（见 net.js）。
    on('sync', withCb((_p, cb) => {
      const room = roomOf();
      if (room) socket.emit('state', room.snapshot(socket.data.playerId));
      ok(cb);
    }));

    on('leaveRoom', withCb((_p, cb) => {
      const room = roomOf();
      if (room) {
        room.leave(socket.data.playerId);
        detachSocketFromRoom(socket);
        // 房间空了就清理
        if (room.players.size === 0) rooms.delete(room.code);
        pushRoom(room);
      }
      ok(cb);
    }));

    on('startGame', withCb((_p, cb) => {
      const room = roomOf();
      if (!room) return fail(cb, '不在房间中');
      const pid = socket.data.playerId;
      const isHost = pid === room.hostPlayerId;
      const isJudge = room.settings.judgeMode && pid === room.judgePlayerId;
      if (!isHost && !isJudge) return fail(cb, '只有房主/法官可以开始游戏');
      const res = room.start();
      if (res.error) return fail(cb, res.error);
      ok(cb);
    }));

    on('restart', withCb((_p, cb) => {
      const room = roomOf();
      if (!room) return fail(cb, '不在房间中');
      const res = room.resetGame(socket.data.playerId);
      if (res.error) return fail(cb, res.error);
      ok(cb);
    }));

    on('confirmRole', withCb((_p, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.roleConfirm(g.player.playerId);
      if (res.error) return fail(cb, res.error);
      ok(cb);
    }));

    on('nightAction', (payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.submitNightAction(g.player.playerId, payload || {});
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('blast', (payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.blast(g.player.playerId, Number(payload && payload.target));
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('declare', (payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.setDeclaration(g.player.playerId, !!payload && !!payload.onPodium);
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('sheriffVote', (payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.sheriffVote(g.player.playerId, Number(payload && payload.target));
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('exileVote', (payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.exileVote(g.player.playerId, Number(payload && payload.target));
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('handoff', (payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.sheriffHandoff(g.player.playerId, payload || {});
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('shoot', (payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.hunterShoot(g.player.playerId, Number(payload && payload.target));
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    // 显式结束当前阶段：没有倒计时之后，这是主要的推进方式。
    // 谁有资格结束由引擎判定（夜间角色 / 发言者 / 遗言玩家 / 房主）。
    on('endPhase', (_payload, cb) => {
      const g = guard(cb);
      if (!g) return;
      const res = g.room.endPhase(g.player.playerId);
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('judge', (payload, cb) => {
      const room = roomOf();
      if (!room) return fail(cb, '不在房间中');
      const res = room.judgeCommand(socket.data.playerId, payload && payload.cmd, payload || {});
      if (res.error) return fail(cb, res.error);
      ok(cb);
    });

    on('disconnect', () => {
      const room = roomOf();
      if (room && socket.data.playerId) {
        room.setConnected(socket.data.playerId, false);
        room.touch();
      }
      detachSocketFromRoom(socket);
    });
  });

  // 秒级心跳：回收空闲房间 + 驱动「掩护阶段」。
  // 正常阶段的推进仍然完全由人决定（没有任何倒计时）；
  // tick() 只负责让已出局角色的掩护阶段在随机时长后自动走过。
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      room.tick();
      if (now - room.lastActive > ROOM_IDLE_TTL) rooms.delete(code);
    }
  }, 1000).unref();
}
