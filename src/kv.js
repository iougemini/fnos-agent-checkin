/**
 * Cloudflare KV 的本地替代：SQLite 一张表。
 * get / put / delete / list 的形状与 Worker 里用到的子集一致，
 * put 的 expirationTtl（秒）和 expiration（Unix 秒）会真正过期。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'checkin.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(Date.now());

  const selectStmt = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?');
  const deleteStmt = db.prepare('DELETE FROM kv WHERE key = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO kv(key, value, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      expires_at = excluded.expires_at
  `);
  const listStmt = db.prepare(
    "SELECT key, expires_at FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key"
  );
  const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMetaStmt = db.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const deleteMetaStmt = db.prepare('DELETE FROM meta WHERE key = ?');

  function expired(row, now) {
    return row.expires_at != null && Number(row.expires_at) <= now;
  }

  const kv = {
    async get(key) {
      const row = selectStmt.get(String(key));
      if (!row) return null;
      if (expired(row, Date.now())) {
        deleteStmt.run(String(key));
        return null;
      }
      return row.value;
    },

    async put(key, value, opts) {
      let expires = null;
      if (opts && typeof opts === 'object') {
        if (opts.expirationTtl != null && opts.expirationTtl !== '') {
          expires = Date.now() + Number(opts.expirationTtl) * 1000;
        } else if (opts.expiration != null && opts.expiration !== '') {
          expires = Number(opts.expiration) * 1000;
        }
      }
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      upsertStmt.run(String(key), text, expires);
    },

    async delete(key) {
      deleteStmt.run(String(key));
    },

    async list(opts = {}) {
      const prefix = String(opts.prefix || '');
      const like = prefix.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
      const now = Date.now();
      const rows = listStmt.all(like);
      const keys = [];
      for (const row of rows) {
        if (expired(row, now)) {
          deleteStmt.run(row.key);
          continue;
        }
        const item = { name: row.key };
        if (row.expires_at != null) item.expiration = Math.floor(Number(row.expires_at) / 1000);
        keys.push(item);
      }
      let limited = keys;
      const limit = Number(opts.limit || 0);
      if (limit > 0) limited = keys.slice(0, limit);
      return { keys: limited, list_complete: limited.length === keys.length, cursor: '' };
    },
  };

  return {
    file,
    kv,
    getMeta(key) {
      const row = getMetaStmt.get(String(key));
      return row ? row.value : null;
    },
    setMeta(key, value) {
      setMetaStmt.run(String(key), String(value));
    },
    deleteMeta(key) {
      deleteMetaStmt.run(String(key));
    },
    close() {
      db.close();
    },
  };
}
