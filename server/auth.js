// 账号体系：注册 / 登录 / 登出 / 会话校验。密码 scrypt 加盐哈希，会话 token 存 SQLite。
import {
  scryptSync, randomBytes, randomUUID, timingSafeEqual,
} from 'node:crypto';
import { MIN_PASSWORD_LENGTH, AUTH_RATE_LIMIT, SESSION_TTL_MS } from './config.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// 昵称清洗：与 socket.js sanitizeName 相同规则
export function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/[\x00-\x1f<>]/g, '').slice(0, 12);
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

export function createAuth(db, opts = {}) {
  const minPw = opts.minPasswordLength ?? MIN_PASSWORD_LENGTH;
  const rateLimit = opts.rateLimit ?? AUTH_RATE_LIMIT;
  const ttlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;

  // 每 IP 限频：{ count, start }
  const attempts = new Map();
  function checkRate(ip) {
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || now - a.start > 60_000) {
      attempts.set(ip, { count: 1, start: now });
      return true;
    }
    a.count += 1;
    if (a.count > rateLimit) return false;
    return true;
  }

  const stmts = {
    insertUser: db.prepare(
      'INSERT INTO users (email, name, pass_salt, pass_hash, game_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byGameId: db.prepare('SELECT * FROM users WHERE game_id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)'),
    byToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ?'),
  };

  function newSession(userId) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    stmts.insertSession.run(token, userId, now, now);
    return token;
  }

  function issue(user) {
    const token = newSession(user.id);
    return { token, name: user.name, email: user.email, gameId: user.game_id };
  }

  function register(email, password, name) {
    const em = normalizeEmail(email);
    if (!EMAIL_RE.test(em)) return { error: '邮箱格式不正确' };
    if (typeof password !== 'string' || password.length < minPw) {
      return { error: `密码至少 ${minPw} 位` };
    }
    const cleanName = sanitizeName(name) || em.split('@')[0].slice(0, 12) || '玩家';
    if (stmts.byEmail.get(em)) return { error: '该邮箱已注册，请直接登录' };
    const salt = randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const info = stmts.insertUser.run(em, cleanName, salt, hash, randomUUID(), Date.now());
    const user = stmts.byId.get(info.lastInsertRowid);
    return issue(user);
  }

  function login(email, password) {
    const user = stmts.byEmail.get(normalizeEmail(email));
    if (!user || typeof password !== 'string') return { error: '邮箱或密码错误' };
    const expected = Buffer.from(user.pass_hash, 'hex');
    const actual = Buffer.from(hashPassword(password, user.pass_salt), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { error: '邮箱或密码错误' };
    }
    return issue(user);
  }

  function logout(token) {
    if (token) stmts.deleteSession.run(token);
  }

  /** token → 账号对象（含 game_id），无效/过期返回 null；命中时刷新活跃时间并清理过期会话。 */
  function authenticateToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const row = stmts.byToken.get(token);
    if (!row) return null;
    const now = Date.now();
    if (now - row.last_seen > ttlMs) {
      stmts.deleteSession.run(token);
      return null;
    }
    stmts.touchSession.run(now, token);
    // 顺带清理过期会话（低频，代价可忽略）
    stmts.pruneSessions.run(now - ttlMs);
    const user = stmts.byId.get(row.user_id);
    return user ? { id: user.id, email: user.email, name: user.name, gameId: user.game_id } : null;
  }

  /** 校验某个邮箱当前密码是否就是给定值（不签发会话）。 */
  function passwordMatches(email, password) {
    const user = stmts.byEmail.get(normalizeEmail(email));
    if (!user || typeof password !== 'string') return false;
    const expected = Buffer.from(user.pass_hash, 'hex');
    const actual = Buffer.from(hashPassword(password, user.pass_salt), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  return {
    register: (email, password, name, ip) => {
      if (ip && !checkRate(ip)) return { error: '操作过于频繁，请稍后再试' };
      return register(email, password, name);
    },
    login: (email, password, ip) => {
      if (ip && !checkRate(ip)) return { error: '操作过于频繁，请稍后再试' };
      return login(email, password);
    },
    logout,
    authenticateToken,
    // ---- 以下为测试辅助（生产路径不使用）----
    _byGameId: stmts.byGameId,
    passwordMatches,
    /** 重设密码（重新加盐哈希）。仅测试种子使用，会注销该账号的全部会话。 */
    setPassword(email, password) {
      const em = normalizeEmail(email);
      const user = stmts.byEmail.get(em);
      if (!user) return { error: '账号不存在' };
      if (typeof password !== 'string' || password.length < minPw) {
        return { error: `密码至少 ${minPw} 位` };
      }
      const salt = randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?')
        .run(salt, hashPassword(password, salt), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      return { ok: true };
    },
  };
}
