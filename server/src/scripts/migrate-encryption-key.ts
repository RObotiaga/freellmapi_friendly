import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const KEY_HEX_LEN = 64;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';
const ALGORITHM = 'aes-256-gcm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');
const DEFAULT_ENV_PATH = path.resolve(__dirname, '../../../.env');

interface CliOptions {
  dbPath: string;
  envPath: string;
  dryRun: boolean;
}

interface ProviderKeyRow {
  id: number;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH,
    envPath: DEFAULT_ENV_PATH,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--db-path') {
      const value = argv[++i];
      if (!value) throw new Error('--db-path requires a value');
      options.dbPath = path.resolve(value);
      continue;
    }
    if (arg === '--env-path') {
      const value = argv[++i];
      if (!value) throw new Error('--env-path requires a value');
      options.envPath = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function isValidKeyHex(value: string): boolean {
  return value.length === KEY_HEX_LEN && /^[0-9a-fA-F]+$/.test(value);
}

function readEnvEncryptionKey(envPath: string): string | undefined {
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(/^ENCRYPTION_KEY=(.*)$/m);
  if (!match) return undefined;
  const value = match[1].trim().replace(/^['"]|['"]$/g, '');
  return value.length > 0 ? value : undefined;
}

function writeEnvEncryptionKey(envPath: string, keyHex: string): void {
  const line = `ENCRYPTION_KEY=${keyHex}`;
  const block = `# Migrated from legacy SQLite settings.encryption_key.\n${line}\n`;

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

function decryptWithKey(keyHex: string, encrypted: string, iv: string, authTag: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}

function verifyEnabledProviderKeys(db: Database.Database, keyHex: string): { ok: boolean; total: number; failed: number } {
  const keys = db.prepare(`
    SELECT id, platform, label, encrypted_key, iv, auth_tag
    FROM api_keys
    WHERE enabled = 1
  `).all() as ProviderKeyRow[];

  let failed = 0;
  for (const key of keys) {
    try {
      decryptWithKey(keyHex, key.encrypted_key, key.iv, key.auth_tag);
    } catch {
      failed++;
    }
  }

  return { ok: failed === 0, total: keys.length, failed };
}

function getLegacyKey(db: Database.Database): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
  return row?.value;
}

function deleteLegacyKey(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = 'encryption_key'").run();
}

function info(message: string): void {
  console.log(message);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.dryRun ? '[dry-run] ' : '';

  if (!fs.existsSync(options.dbPath)) {
    info(`${mode}Database not found: ${options.dbPath}`);
    info('No legacy DB-stored encryption key can be migrated. No changes made.');
    return;
  }

  const db = new Database(options.dbPath);
  try {
    const legacyKey = getLegacyKey(db);
    if (!legacyKey) {
      info(`${mode}No legacy DB-stored encryption key found. Nothing to migrate.`);
      return;
    }

    if (!isValidKeyHex(legacyKey)) {
      info(`${mode}Legacy DB-stored encryption key was found, but it is invalid.`);
      info(`Expected ${KEY_HEX_LEN} hex characters. No changes were made.`);
      if (!options.dryRun) process.exitCode = 1;
      return;
    }

    const envKey = readEnvEncryptionKey(options.envPath);
    const hasRealEnvKey = envKey !== undefined && envKey !== PLACEHOLDER_KEY;

    if (hasRealEnvKey && envKey !== legacyKey) {
      info(`${mode}.env already contains an ENCRYPTION_KEY that differs from the legacy DB key.`);
      info('No changes made. Resolve the key mismatch manually before removing the legacy DB key.');
      return;
    }

    const verificationKey = hasRealEnvKey ? envKey : legacyKey;
    const verification = verifyEnabledProviderKeys(db, verificationKey);
    if (!verification.ok) {
      info(`${mode}Migration verification failed for ${verification.failed}/${verification.total} enabled Provider Key(s).`);
      info('Legacy DB-stored encryption key was kept in SQLite. No purge performed.');
      if (!options.dryRun) process.exitCode = 1;
      return;
    }

    if (options.dryRun) {
      if (hasRealEnvKey) {
        info(`${mode}.env already contains the same ENCRYPTION_KEY as the legacy DB key.`);
      } else {
        info(`${mode}Would write ENCRYPTION_KEY to ${options.envPath}.`);
      }
      info(`${mode}Would remove legacy settings.encryption_key from ${options.dbPath}.`);
      info(`${mode}Verified ${verification.total} enabled Provider Key(s).`);
      return;
    }

    if (!hasRealEnvKey) {
      writeEnvEncryptionKey(options.envPath, legacyKey);
      info(`ENCRYPTION_KEY migrated to ${options.envPath}.`);
    } else {
      info('.env already had the same ENCRYPTION_KEY.');
    }

    deleteLegacyKey(db);
    info(`Verified ${verification.total} enabled Provider Key(s).`);
    info('Legacy DB-stored encryption key removed from SQLite. Restart the server.');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
