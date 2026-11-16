const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Intentos fallidos de login por cuenta (para alertas de seguridad).
db.exec(`
  CREATE TABLE IF NOT EXISTS failed_attempts (
    key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seguridad de inicio de sesion: 3 intentos fallidos seguidos, bloqueo de 15 min y codigo de verificacion
db.exec(`
  CREATE TABLE IF NOT EXISTS login_security (
    user_id INTEGER PRIMARY KEY,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    requires_verification INTEGER NOT NULL DEFAULT 0,
    verification_code TEXT,
    code_expires_at TEXT,
    code_attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Migraciones de columnas
const secCols = db.prepare('PRAGMA table_info(login_security)').all().map((c) => c.name);
if (!secCols.includes('requires_verification')) {
  try {
    db.exec('ALTER TABLE login_security ADD COLUMN requires_verification INTEGER NOT NULL DEFAULT 0');
  } catch (_) {}
}

const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('full_name')) {
  db.exec('ALTER TABLE users ADD COLUMN full_name TEXT');
}

// Unicidad sin distinguir mayusculas/minusculas
for (const [name, expr] of [
  ['idx_users_username_nocase', 'lower(username)'],
  ['idx_users_email_nocase', 'lower(email)'],
]) {
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON users(${expr})`);
  } catch (err) {
    console.warn(`No se pudo crear el indice ${name}: ${err.message}`);
  }
}

module.exports = db;
