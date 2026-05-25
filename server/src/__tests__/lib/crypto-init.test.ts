import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );
  `);
  return db;
}

const ORIGINAL_ENV = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  DEV_MODE: process.env.DEV_MODE,
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function tempEnvPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-env-'));
  return path.join(dir, '.env');
}

describe('initEncryptionKey — input validation and startup policy', () => {
  beforeEach(() => {
    restoreEnv();
    delete process.env.ENCRYPTION_KEY;
    delete process.env.DEV_MODE;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    restoreEnv();
  });

  it('accepts a valid 64-char hex env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const db = freshDb();
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).not.toThrow();
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('throws on too-short env key (typo guard)', () => {
    process.env.ENCRYPTION_KEY = 'abc';
    const db = freshDb();
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).toThrow(/Invalid ENCRYPTION_KEY \(env\).+expected 64 hex chars/);
  });

  it('throws on too-long env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(80);
    const db = freshDb();
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('throws on non-hex env key of correct length', () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64);
    const db = freshDb();
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('requires ENCRYPTION_KEY when dev fallback is disabled and first-run bootstrap is not allowed', () => {
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).toThrow(/ENCRYPTION_KEY is required/);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get();
    expect(row).toBeUndefined();
  });

  it('does not load a legacy DB-stored key when dev fallback is disabled', () => {
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).toThrow(/legacy DB-stored encryption key/i);
  });

  it('requires ENCRYPTION_KEY in production even when DEV_MODE is set', () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'production';
    const db = freshDb();
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).toThrow(/ENCRYPTION_KEY is required/);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get();
    expect(row).toBeUndefined();
  });

  it('allows explicit dev fallback generation outside production', () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a corrupted DB-stored key in explicit dev fallback mode', () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('not-hex');
    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).toThrow(/Invalid ENCRYPTION_KEY \(db\)/);
  });

  it('bootstraps ENCRYPTION_KEY into .env for an empty non-production first install', () => {
    const envPath = tempEnvPath();
    const db = freshDb();
    expect(() => initEncryptionKey(db, { envPath })).not.toThrow();

    const envContent = fs.readFileSync(envPath, 'utf8');
    expect(envContent).toMatch(/ENCRYPTION_KEY=[0-9a-f]{64}/);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get();
    expect(row).toBeUndefined();
  });

  it('does not first-run bootstrap when provider keys already exist', () => {
    const db = freshDb();
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'existing', 'encrypted', 'iv', 'tag', 'unknown', 0);

    expect(() => initEncryptionKey(db, { envPath: tempEnvPath() })).toThrow(/ENCRYPTION_KEY is required/);
  });
});
