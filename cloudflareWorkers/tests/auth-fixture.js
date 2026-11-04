import { DatabaseSync } from 'node:sqlite'
import worker from '../src/index.js'

// Match the users and sessions tables created through the D1 console
export const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0 CHECK (typeof(credits) = 'integer' AND credits >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX sessions_user_id ON sessions(user_id);
  CREATE INDEX sessions_expires_at ON sessions(expires_at);
`

export function authFixture(t) {
  const database = new DatabaseSync(':memory:')
  database.exec(schema)
  t.after(() => database.close())
  const DB = {
    prepare(sql) {
      let parameters = []
      return {
        bind(...values) { parameters = values; return this },
        async first() { return database.prepare(sql).get(...parameters) ?? null },
        async run() { return { success: true, meta: database.prepare(sql).run(...parameters) } },
        execute() { return { success: true, results: database.prepare(sql).all(...parameters) } },
      }
    },
    async batch(statements) {
      database.exec('BEGIN;')
      try {
        const results = statements.map(statement => statement.execute())
        database.exec('COMMIT;')
        return results
      } catch (error) {
        database.exec('ROLLBACK;')
        throw error
      }
    },
  }
  const limitKeys = []
  const env = { DB, AUTH_RATE_LIMITER: { limit: async ({ key }) => { limitKeys.push(key); return { success: true } } } }
  function request(action, { body, token, method = action === 'me' ? 'GET' : 'POST', raw, headers = {}, bindings = env } = {}) {
    return worker.fetch(new Request(`https://example.com/auth/${action}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
    }), bindings)
  }
  return { database, env, request, limitKeys }
}

export const credentials = { email: 'user@example.com', password: 'Test!123' }
