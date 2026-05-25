import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * AES-256-GCM uses a 32-byte key, hex-encoded as 64 chars.
 * A typo'd ENCRYPTION_KEY (e.g. "abc") would historically fall through
 * the placeholder check, get truncated to 1.5 bytes, and only fail at
 * the first encrypt() call with a cryptic node:crypto error. Validate
 * the length up front and fail fast with an actionable message.
 */
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_PATH = path.resolve(__dirname, '../../../.env');

interface InitEncryptionKeyOptions {
  envPath?: string;
}

function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

function isPlaceholder(value: string | undefined): boolean {
  return value === PLACEHOLDER_KEY;
}

function isDevFallbackAllowed(): boolean {
  return process.env.DEV_MODE === 'true' && process.env.NODE_ENV !== 'production';
}

function isFirstRunBootstrapAllowed(): boolean {
  return process.env.DEV_MODE !== 'true'
    && process.env.NODE_ENV !== 'production'
    && process.env.NODE_ENV !== 'test';
}

function getLegacyDbKey(db: Database.Database): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
  return row?.value;
}

function countProviderKeys(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM api_keys').get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}

function generateKeyHex(): string {
  return crypto.randomBytes(KEY_BYTES).toString('hex');
}

function upsertEnvEncryptionKey(envPath: string, keyHex: string, comment: string): void {
  const line = `ENCRYPTION_KEY=${keyHex}`;
  const block = `${comment}\n${line}\n`;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, block, { encoding: 'utf8', mode: 0o600 });
    return;
  }

  const original = fs.readFileSync(envPath, 'utf8');
  const envLinePattern = /^ENCRYPTION_KEY=.*$/m;

  if (envLinePattern.test(original)) {
    const updated = original.replace(envLinePattern, line);
    fs.writeFileSync(envPath, updated, 'utf8');
    return;
  }

  const separator = original.length > 0 && !original.endsWith('\n') ? '\n\n' : '\n';
  fs.writeFileSync(envPath, `${original}${separator}${block}`, 'utf8');
}

function missingKeyError(): Error {
  return new Error(
    'ENCRYPTION_KEY is required for Provider Key encryption.\n\n' +
    'Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n\n' +
    'Then set it in .env or your deployment secrets as:\n' +
    '  ENCRYPTION_KEY=<generated-key>',
  );
}

function legacyDbKeyError(): Error {
  return new Error(
    'ENCRYPTION_KEY is required.\n\n' +
    'A legacy DB-stored encryption key was found. It will not be used automatically outside explicit DEV_MODE=true.\n' +
    'Run this command to migrate it into .env:\n\n' +
    '  npm run migrate-encryption-key -w server\n\n' +
    'The migration verifies enabled Provider Keys and removes the legacy DB-stored key only after successful verification.',
  );
}

function bootstrapFailedError(envPath: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `ENCRYPTION_KEY is required, and first-run bootstrap could not write to ${envPath}.\n` +
    `Cause: ${message}\n\n` +
    'Generate one manually with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n\n' +
    'Then set it in .env or your deployment secrets as:\n' +
    '  ENCRYPTION_KEY=<generated-key>',
  );
}

/**
 * Initialize encryption key from env, an explicit local-dev fallback, or a safe
 * first-run bootstrap into .env before any Provider Keys exist.
 * Must be called after DB is initialized.
 */
export function initEncryptionKey(db: Database.Database, options: InitEncryptionKeyOptions = {}): void {
  const envPath = options.envPath ?? DEFAULT_ENV_PATH;

  // 1. Check env var. The .env.example placeholder is treated as missing.
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && !isPlaceholder(envKey)) {
    cachedKey = parseHexKey(envKey, 'env');
    return;
  }

  const legacyDbKey = getLegacyDbKey(db);

  // 2. Explicit local development/test fallback. Never allowed in production.
  if (isDevFallbackAllowed()) {
    if (legacyDbKey) {
      cachedKey = parseHexKey(legacyDbKey, 'db');
      return;
    }

    cachedKey = crypto.randomBytes(KEY_BYTES);
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(cachedKey.toString('hex'));
    return;
  }

  // 3. Legacy DB keys are migration state, not a normal runtime source.
  if (legacyDbKey) {
    throw legacyDbKeyError();
  }

  // 4. Empty non-production first install: create a real env key in .env, not DB.
  if (isFirstRunBootstrapAllowed() && countProviderKeys(db) === 0) {
    const generatedKey = generateKeyHex();
    try {
      upsertEnvEncryptionKey(
        envPath,
        generatedKey,
        '# Generated during first-run encryption bootstrap.',
      );
    } catch (err) {
      throw bootstrapFailedError(envPath, err);
    }

    process.env.ENCRYPTION_KEY = generatedKey;
    cachedKey = parseHexKey(generatedKey, 'env');
    return;
  }

  // 5. Normal startup without a deployment-controlled key is not allowed.
  throw missingKeyError();
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}
