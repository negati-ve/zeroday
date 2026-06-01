// Uses Node.js 22+ built-in node:sqlite — no native compilation needed
import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import path from 'path'
import crypto from 'node:crypto'

const DB_PATH = path.join(process.cwd(), 'zeroday.db')

let _db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (_db) return _db
  _db = new DatabaseSync(DB_PATH)
  migrate(_db)
  return _db
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS live_strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      strategy_id INTEGER NOT NULL REFERENCES strategies(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      stopped_at INTEGER,
      UNIQUE(strategy_id)
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      live_strategy_id INTEGER NOT NULL REFERENCES live_strategies(id),
      stock TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('BULL','BEAR')),
      entry_price REAL NOT NULL,
      entry_time INTEGER NOT NULL,
      exit_price REAL,
      exit_time INTEGER,
      exit_reason TEXT,
      peak_move_pct REAL NOT NULL DEFAULT 0,
      opt_type TEXT,
      strike REAL,
      lot_size INTEGER,
      option_pnl REAL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)

  // Add summary/hash columns to strategies (migration for existing DBs)
  try { db.exec('ALTER TABLE strategies ADD COLUMN last_run_summary TEXT') } catch {}
  try { db.exec('ALTER TABLE strategies ADD COLUMN last_run_at INTEGER') } catch {}
  try { db.exec('ALTER TABLE strategies ADD COLUMN config_hash TEXT') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_strategies_hash ON strategies(user_id, config_hash)') } catch {}

  // Add role column to users (migration for existing DBs)
  try { db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'") } catch {}
  // Add active flag and restriction message (migration for existing DBs)
  try { db.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1") } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN restricted_msg TEXT") } catch {}

  // Seed default admin user if not present
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('zee')
  if (!existing) {
    const hash = bcrypt.hashSync('26551753', 10)
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('zee', hash)
  }

  // Seed hima (trial expired — keep account, block login)
  const existingHima = db.prepare('SELECT id FROM users WHERE username = ?').get('hima') as { id: number } | undefined
  if (!existingHima) {
    const himaHash = bcrypt.hashSync('mastersoftheuniverse', 10)
    db.prepare('INSERT INTO users (username, password_hash, role, active, restricted_msg) VALUES (?, ?, ?, ?, ?)')
      .run('hima', himaHash, 'viewer', 0, 'Your 72-hour free trial has expired. Contact us to continue access.')
  } else {
    db.prepare("UPDATE users SET active = 0, restricted_msg = ? WHERE username = 'hima'")
      .run('Your 72-hour free trial has expired. Contact us to continue access.')
  }

  // Seed nitish (trial expired — keep account, block login)
  const existingNitish = db.prepare('SELECT id FROM users WHERE username = ?').get('nitish') as { id: number } | undefined
  if (!existingNitish) {
    const nitishHash = bcrypt.hashSync('26551753', 10)
    db.prepare('INSERT INTO users (username, password_hash, role, active, restricted_msg) VALUES (?, ?, ?, ?, ?)')
      .run('nitish', nitishHash, 'viewer', 0, 'Your 72-hour free trial has expired. Contact us to continue access.')
  } else {
    db.prepare("UPDATE users SET active = 0, restricted_msg = ? WHERE username = 'nitish'")
      .run('Your 72-hour free trial has expired. Contact us to continue access.')
  }
  // Invalidate any active sessions for restricted users
  db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE active = 0)").run()
}

export function getUserByUsername(username: string) {
  return getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as { id: number; username: string; password_hash: string; role: string; active: number; restricted_msg: string | null } | undefined
}

export function createSession(userId: number): string {
  const id = crypto.randomUUID()
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
  getDb()
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(id, userId, expiresAt)
  return id
}

export function getSession(id: string) {
  const now = Math.floor(Date.now() / 1000)
  return getDb()
    .prepare('SELECT s.id, s.user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?')
    .get(id, now) as { id: string; user_id: number; role: string } | undefined
}

export function deleteSession(id: string) {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}
