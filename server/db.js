// SQLite 数据库：账号与会话表。聚会规模，同步 API 足够且简单。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

export function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      name       TEXT    NOT NULL,
      pass_salt  TEXT    NOT NULL,
      pass_hash  TEXT    NOT NULL,
      game_id    TEXT    NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
  `);
  return db;
}

// 单例：socket.js 使用；测试可直接 openDb(':memory:')。
export const db = openDb(DB_PATH);
