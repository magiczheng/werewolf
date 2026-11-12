// Authenticated Socket.IO commands, isolated room registry, durable snapshots and bounded delivery receipts.
import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { Server } from 'socket.io';
import { Room, buildSettings } from './engine.js';
import { ROOM_IDLE_TTL, SKIP_ROLE_REVEAL, TRUSTED_PROXIES, MAX_ROOMS } from './config.js';
import { db } from './db.js';
import { createAuth, sanitizeName } from './auth.js';
import { createRoomStore, serializeRoom, restoreRoom } from './roomStore.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
class ClientError extends Error {}

const AUTH_EVENTS = new Set(['login', 'register']);
const normalizeIP = ip => String(ip || '').replace(/^::ffff:/, '');
export function clientIP(socket, trustedProxies = TRUSTED_PROXIES) {
  const trusted = new Set(trustedProxies.map(normalizeIP));
  let peer = normalizeIP(socket.request?.socket?.remoteAddress || socket.handshake.address);
  const chain = String(socket.handshake.headers?.['x-forwarded-for'] || '').split(',').map(s => normalizeIP(s.trim()));
  while (trusted.has(peer) && chain.length) {
    const next = chain.pop();
    if (!isIP(next)) break;
    peer = next;
  }
  return peer;
}

export function initSocket(server, opts = {}) {
  const database = opts.db || db;
  const auth = createAuth(database, opts.auth || {});
  const store = createRoomStore(database);
  const rooms = new Map();
  const roomSockets = new Map();
  const limits = new Map();
  const takeoverNotified = new Map();
  const io = new Server(server, { maxHttpBufferSize: 32768, serveClient: true });
  let batch = null;
  let closing = false;

  function log(event, data = {}, level = 'info') {
    if (opts.logger === false) return;
    (level === 'error' ? console.error : console.log)(JSON.stringify({ level, event, ...data }));
  }
  function limited(key, max, interval = 60000) {
    const now = Date.now();
    if (limits.size > 5000) {
      for (const [k, v] of limits) if (now - v.start >= interval) limits.delete(k);
      if (limits.size > 5000 && !limits.has(key)) return true;
    }
    let entry = limits.get(key);
    if (!entry || now - entry.start >= interval) { entry = { start: now, count: 0 }; limits.set(key, entry); }
    return ++entry.count > max;
  }
  const getRoom = code => rooms.get(String(code || '').trim().toUpperCase());
  const roomOf = socket => getRoom(socket.data.roomCode);
  const hasConnections = code => [...(roomSockets.get(code) || [])].some(s => s.connected);
  function broadcast(room) {
    for (const socket of roomSockets.get(room.code) || []) if (socket.connected) socket.emit('state', room.snapshot(socket.data.playerId));
  }
  function changed(room) {
    if (batch) { batch.add(room); return; }
    store.save(room);
    broadcast(room);
  }
  for (const room of store.load(changed)) {
    if (Date.now() - room.lastActive <= ROOM_IDLE_TTL) {
      rooms.set(room.code, room);
      // Older releases waited for PK candidates too. Re-evaluate committed ballots
      // after registration so an already-complete PK cannot wait forever on restart.
      if (room.phase === 'votePk' && room._allVoted()) database.transaction(() => room._maybeComplete())();
    }
    else store.remove(room.code);
  }
  function detach(socket, { remove = false } = {}) {
    const room = roomOf(socket);
    const code = socket.data.roomCode;
    const pid = socket.data.playerId;
    const set = roomSockets.get(code);
    set?.delete(socket);
    socket.leave(code);
    if (set?.size === 0) roomSockets.delete(code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    if (!room || !pid) return;
    const another = [...(set || [])].some(s => s.connected && s.data.playerId === pid);
    if (!another) {
      room.setConnected(pid, false);
      if (remove && (!room.gameStarted || room.gameOver)) room.leave(pid);
    }
    if (!room.players.size) { rooms.delete(code); store.remove(code); roomSockets.delete(code); }
  }
  function attach(socket, room, pid) {
    if (!roomSockets.has(room.code)) roomSockets.set(room.code, new Set());
    roomSockets.get(room.code).add(socket);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = pid;
    room.setConnected(pid, true);
  }
  function invalidate(token) {
    for (const socket of io.sockets.sockets.values()) if (socket.data.token === token) {
      detach(socket, { remove: true });
      socket.data.user = null;
      socket.data.token = null;
      socket.emit('sessionExpired');
    }
  }
  function requireRoom(socket) {
    const room = roomOf(socket);
    if (!room) throw new ClientError('不在房间中');
    if (!room.players.has(socket.data.playerId) || socket.data.user?.gameId !== socket.data.playerId) throw new ClientError('身份无效，请重新进入房间');
    return room;
  }
  function maySwitch(socket, target) {
    const old = roomOf(socket);
    if (old && old !== target && old.gameStarted && !old.gameOver) throw new ClientError('当前对局尚未结束，请保留本局座位');
  }
  function apply(result) { if (result?.error) throw new ClientError(result.error); return result || { ok: true }; }

  const commands = {
    createRoom(socket, payload) {
      maySwitch(socket);
      if (limited('create:' + socket.data.user.gameId, 6)) throw new ClientError('创建房间过于频繁');
      if (rooms.size >= (opts.maxRooms || MAX_ROOMS)) throw new ClientError('房间数量已达上限，请稍后再试');
      let settings;
      try { settings = buildSettings(payload.settings); } catch (error) { throw new ClientError(error.message); }
      detach(socket, { remove: true });
      let code;
      do { code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(''); } while (rooms.has(code));
      const room = new Room({ code, settings, hostPlayerId: socket.data.user.gameId,
        hostName: sanitizeName(payload.name) || socket.data.user.name, onChange: changed, skipRoleReveal: SKIP_ROLE_REVEAL });
      rooms.set(code, room);
      attach(socket, room, socket.data.user.gameId);
      changed(room);
      log('room_created', { roomCode: code });
      return { ok: true, roomCode: code };
    },
    joinRoom(socket, payload) {
      const room = getRoom(payload.code);
      if (!room) throw new ClientError('房间不存在');
      maySwitch(socket, room);
      const pid = socket.data.user.gameId;
      // Validate admission before detaching from the current room.
      if (!room.players.has(pid)) {
        if (room.gameStarted) throw new ClientError('游戏已开始，无法加入');
        if (room._joinedPlayerCount() >= room.settings.playerCount) throw new ClientError('房间已满');
      }
      if (roomOf(socket) !== room) detach(socket, { remove: true });
      if (!room.players.has(pid)) apply(room.addPlayer(pid, sanitizeName(payload.name) || socket.data.user.name));
      else if (!room.gameStarted) room.players.get(pid).name = sanitizeName(payload.name) || room.players.get(pid).name;
      attach(socket, room, pid);
      changed(room);
      return { ok: true };
    },
    sync(socket) { const room = roomOf(socket); if (room) socket.emit('state', room.snapshot(socket.data.playerId)); return { ok: true }; },
    leaveRoom(socket) {
      const room = roomOf(socket);
      if (room?.gameStarted && !room.gameOver) throw new ClientError('对局进行中，请保留座位；离线后可重新登录回到本局');
      detach(socket, { remove: true });
      return { ok: true };
    },
    logout(socket) {
      auth.logout(socket.data.token);
      invalidate(socket.data.token);
      return { ok: true };
    },
    sit: (s, p) => requireRoom(s).sit(s.data.playerId, Number(p.seat)),
    standUp: s => requireRoom(s).standUp(s.data.playerId),
    startGame(s) {
      const room = requireRoom(s);
      if (s.data.playerId !== room.hostPlayerId && s.data.playerId !== room.judgePlayerId) throw new ClientError('只有房主/法官可以开始游戏');
      return room.start();
    },
    restart: s => requireRoom(s).resetGame(s.data.playerId),
    confirmRole: s => requireRoom(s).roleConfirm(s.data.playerId),
    nightAction: (s, p) => requireRoom(s).submitNightAction(s.data.playerId, p),
    blast: (s, p) => requireRoom(s).blast(s.data.playerId, Number(p.target)),
    declare: (s, p) => requireRoom(s).setDeclaration(s.data.playerId, !!p.onPodium),
    sheriffVote: (s, p) => requireRoom(s).sheriffVote(s.data.playerId, Number(p.target)),
    exileVote: (s, p) => requireRoom(s).exileVote(s.data.playerId, Number(p.target)),
    handoff: (s, p) => requireRoom(s).sheriffHandoff(s.data.playerId, p),
    shoot: (s, p) => requireRoom(s).hunterShoot(s.data.playerId, Number(p.target)),
    setSpeaker: (s, p) => requireRoom(s).setSpeaker(s.data.playerId, Number(p.seat)),
    finishSpeech: s => requireRoom(s).finishSpeech(s.data.playerId),
    endPhase: s => requireRoom(s).endPhase(s.data.playerId),
    judge: (s, p) => requireRoom(s).judgeCommand(s.data.playerId, p.cmd, p),
    transferHost: (s, p) => requireRoom(s).transferHost(s.data.playerId, p.playerId),
    claimHost: s => requireRoom(s).claimHost(s.data.playerId),
    recoverOffline: s => requireRoom(s).recoverOffline(s.data.playerId),
    removeOffline(s, p) {
      const room = requireRoom(s);
      if (s.data.playerId !== room.hostPlayerId || room.gameStarted) throw new ClientError('仅大厅房主可移除离线成员');
      const target = room.players.get(p.playerId);
      if (!target || target.connected || !target.disconnectedAt || Date.now() - target.disconnectedAt < 60000) throw new ClientError('成员离线满 60 秒后才能移除');
      return room.leave(p.playerId);
    },
  };

  io.on('connection', socket => {
    socket.data = { roomCode: null, playerId: null, user: null, token: socket.handshake.auth?.token || null };
    if (socket.data.token) socket.data.user = auth.authenticateToken(socket.data.token);
    let queue = Promise.resolve();
    let pending = 0;
    const fail = (cb, error) => { if (typeof cb === 'function') cb({ error }); };
    const on = (event, handler) => socket.on(event, (...args) => {
      const cb = typeof args.at(-1) === 'function' ? args.pop() : null;
      const payload = args[0] ?? {};
      if (pending >= 32) return fail(cb, '操作过于频繁，请稍后再试');
      pending++;
      queue = queue.then(async () => {
        if (!socket.connected) return;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(cb, '请求格式无效');
        if (AUTH_EVENTS.has(event)) {
          const ip = clientIP(socket, opts.trustedProxies || TRUSTED_PROXIES);
          const res = event === 'login' ? await auth.loginAsync(payload.email, payload.password, ip)
            : await auth.registerAsync(payload.email, payload.password, payload.name, ip);
          if (res.error) return fail(cb, res.error);
          if (!socket.connected) { auth.logout(res.token); return; }
          detach(socket, { remove: true }); // Changing accounts must not retain the previous player's room binding.
          socket.data.user = auth.authenticateToken(res.token);
          socket.data.token = res.token;
          if (cb) cb({ ok: true, ...res });
          return;
        }
        const user = auth.authenticateToken(socket.data.token);
        if (!user) {
          if (socket.data.token) invalidate(socket.data.token);
          return fail(cb, '请先登录，登录已失效');
        }
        socket.data.user = user;
        if (limited('event:' + user.gameId, 300)) return fail(cb, '操作过于频繁，请稍后再试');
        const room = roomOf(socket);
        const context = payload._context;
        const contextual = !['createRoom', 'joinRoom', 'sync', 'logout'].includes(event);
        if (contextual && !context && socket.handshake.auth?.protocol === 2) return fail(cb, '缺少操作上下文，请刷新页面');
        if (contextual && context) {
          if (!room || context.roomCode !== room.code) return fail(cb, '对局已变化，请刷新后重新操作');
          if (typeof context.actionId !== 'string' || context.actionId.length > 80) return fail(cb, '操作编号无效');
          const receipt = room.receipts.get(context.gameId + ':' + user.gameId + ':' + context.actionId);
          if (receipt) { if (cb) cb(receipt); return; }
          if (context.gameId !== room.gameId) return fail(cb, '对局已变化，请刷新后重新操作');
          if (context.phaseId !== room.phaseId) return fail(cb, '阶段已变化，请根据当前页面重新操作');
        }
        // All game mutations and their durable receipts commit together. Broadcast only after commit.
        const before = new Map();
        for (const r of [room, event === 'joinRoom' ? getRoom(payload.code) : null]) if (r && !before.has(r.code)) before.set(r.code, serializeRoom(r));
        const oldBinding = { roomCode: socket.data.roomCode, playerId: socket.data.playerId };
        batch = new Set();
        let result;
        let dirty;
        try {
          database.transaction(() => {
            result = apply(handler(socket, payload));
            if (contextual && context && room) {
              room.receipts.set(context.gameId + ':' + user.gameId + ':' + context.actionId, result);
              while (room.receipts.size > 256) room.receipts.delete(room.receipts.keys().next().value);
              batch.add(room);
            }
            for (const r of batch) if (rooms.has(r.code)) store.save(r);
          })();
          dirty = batch;
        } catch (error) {
          const dirtyCodes = [...batch].map(r => r.code);
          for (const code of dirtyCodes) {
            if (before.has(code)) rooms.set(code, restoreRoom(before.get(code), changed, { disconnected: false }));
            else rooms.delete(code);
          }
          // Restore any changed membership after a failed transaction.
          if (socket.data.roomCode !== oldBinding.roomCode) {
            roomSockets.get(socket.data.roomCode)?.delete(socket);
            socket.leave(socket.data.roomCode);
            socket.data.roomCode = oldBinding.roomCode;
            socket.data.playerId = oldBinding.playerId;
            if (oldBinding.roomCode) {
              if (!roomSockets.has(oldBinding.roomCode)) roomSockets.set(oldBinding.roomCode, new Set());
              roomSockets.get(oldBinding.roomCode).add(socket); socket.join(oldBinding.roomCode);
            }
          }
          throw error;
        } finally { batch = null; }
        for (const r of dirty) if (rooms.has(r.code)) broadcast(r);
        if (cb) cb(result);
      }).catch(error => {
        // No payloads, tokens, passwords or hidden roles in operational logs.
        log('command_failed', { command: event, roomCode: socket.data.roomCode, message: error.message }, 'error');
        fail(cb, error instanceof ClientError ? error.message : '服务器内部错误');
      }).finally(() => { pending--; });
    });
    on('register'); on('login');
    for (const [event, handler] of Object.entries(commands)) on(event, handler);
    socket.on('disconnect', () => {
      try { detach(socket); } catch (error) { log('disconnect_failed', { roomCode: socket.data.roomCode, message: error.message }, 'error'); }
    });
  });

  function sweep() {
    if (closing) return;
    for (const [code, room] of rooms) {
      try {
        if (room.phaseState.masked && room.phaseState.maskUntil <= Date.now()) {
          const checkpoint = serializeRoom(room);
          batch = new Set();
          try {
            database.transaction(() => { room.tick(); for (const dirty of batch) store.save(dirty); })();
          } catch (error) { rooms.set(code, restoreRoom(checkpoint, changed, { disconnected: false })); throw error; }
          finally { batch = null; }
          broadcast(room);
        }
        const host = room.players.get(room.hostPlayerId);
        if (host && !host.connected && host.disconnectedAt && Date.now() - host.disconnectedAt >= 60000 && takeoverNotified.get(code) !== host.disconnectedAt) {
          takeoverNotified.set(code, host.disconnectedAt); broadcast(room);
        }
        if (!hasConnections(code) && Date.now() - room.lastActive > ROOM_IDLE_TTL) {
          rooms.delete(code); roomSockets.delete(code); takeoverNotified.delete(code); store.remove(code);
        }
      } catch (error) { log('room_tick_failed', { roomCode: code, message: error.message }, 'error'); }
    }
  }
  const timer = setInterval(sweep, 1000).unref();
  server.on('close', () => { closing = true; clearInterval(timer); });
  return { io, rooms, roomSockets, sweep };
}
