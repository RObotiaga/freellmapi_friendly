import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ADMIN_SETUP_WINDOW_MS = 5 * 60 * 1000;

export type AdminSetupMode = 'ready' | 'expired' | 'locked' | 'configured';

export interface AdminSetupStatus {
  mode: AdminSetupMode;
  expiresAt: string | null;
  reason?: string;
}

interface AdminControlState {
  host: string;
  startedAt: number;
  setupConsumed: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE_PATH = path.resolve(__dirname, '../../../.env');

let state: AdminControlState = {
  host: process.env.HOST ?? '127.0.0.1',
  startedAt: Date.now(),
  setupConsumed: false,
};

const OBVIOUS_WEAK_TOKENS = new Set([
  'admin',
  'password',
  'changeme',
  'freellmapi',
  '123456',
  'admin_token',
  'administrator',
]);

export function initAdminControl(options?: { host?: string; now?: number }) {
  state = {
    host: options?.host ?? process.env.HOST ?? '127.0.0.1',
    startedAt: options?.now ?? Date.now(),
    setupConsumed: false,
  };

  const status = getAdminSetupStatus();
  if (hasConfiguredAdminToken()) {
    return;
  }

  if (status.mode === 'ready') {
    console.warn(
      '[security] ADMIN_TOKEN is not configured. First-run Admin Setup is available on localhost for 5 minutes.',
    );
    return;
  }

  console.warn(
    `[security] ADMIN_TOKEN is not configured and dashboard setup is ${status.mode}. ` +
      `The proxy may continue serving /v1 traffic, but the admin API is locked. ` +
      `Add ADMIN_TOKEN to .env or deployment secrets and restart.`,
  );
}

export function resetAdminControlForTests(options?: { host?: string; now?: number; adminToken?: string | null }) {
  if (options?.adminToken === null) {
    delete process.env.ADMIN_TOKEN;
  } else if (options?.adminToken !== undefined) {
    process.env.ADMIN_TOKEN = options.adminToken;
  }

  initAdminControl({
    host: options?.host ?? '127.0.0.1',
    now: options?.now ?? Date.now(),
  });
}

export function getAdminToken(): string | null {
  const token = process.env.ADMIN_TOKEN?.trim();
  return token ? token : null;
}

export function hasConfiguredAdminToken(): boolean {
  return getAdminToken() !== null;
}

export function verifyAdminToken(candidate: string | undefined): boolean {
  const token = getAdminToken();
  if (!token || !candidate) return false;

  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);

  if (expected.length !== actual.length) return false;

  return crypto.timingSafeEqual(expected, actual);
}

export function validateNewAdminToken(token: unknown): string[] {
  const errors: string[] = [];

  if (typeof token !== 'string') {
    return ['Admin Token must be a string.'];
  }

  if (token.length < 32) {
    errors.push('Admin Token must be at least 32 characters long.');
  }

  if (token.trim() !== token) {
    errors.push('Admin Token must not have leading or trailing whitespace.');
  }

  if (/\s/.test(token)) {
    errors.push('Admin Token must not contain whitespace because it is sent as a Bearer token.');
  }

  if (/[\x00-\x1F\x7F]/.test(token)) {
    errors.push('Admin Token must not contain control characters.');
  }

  if (OBVIOUS_WEAK_TOKENS.has(token.toLowerCase())) {
    errors.push('Admin Token is too obvious.');
  }

  return errors;
}

export function getAdminSetupStatus(now = Date.now()): AdminSetupStatus {
  if (hasConfiguredAdminToken()) {
    return { mode: 'configured', expiresAt: null };
  }

  const expiresAtMs = state.startedAt + ADMIN_SETUP_WINDOW_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();

  if (state.setupConsumed) {
    return {
      mode: 'locked',
      expiresAt: null,
      reason: 'First-run setup has already been used in this process.',
    };
  }

  if (!isLocalBindHost(state.host)) {
    return {
      mode: 'locked',
      expiresAt: null,
      reason: 'Browser setup is disabled when HOST is not local.',
    };
  }

  if (!isEnvWritable()) {
    return {
      mode: 'locked',
      expiresAt: null,
      reason: '.env is not writable. Set ADMIN_TOKEN manually and restart.',
    };
  }

  if (now > expiresAtMs) {
    return {
      mode: 'expired',
      expiresAt,
      reason: 'First-run setup window expired. Restart or set ADMIN_TOKEN manually.',
    };
  }

  return { mode: 'ready', expiresAt };
}

export function configureAdminTokenFromSetup(token: string): AdminSetupStatus {
  const status = getAdminSetupStatus();
  if (status.mode !== 'ready') {
    return status;
  }

  const errors = validateNewAdminToken(token);
  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    (error as any).status = 400;
    throw error;
  }

  writeAdminTokenToEnv(token);
  process.env.ADMIN_TOKEN = token;
  state.setupConsumed = true;

  return { mode: 'configured', expiresAt: null };
}

function isLocalBindHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isEnvWritable(): boolean {
  try {
    if (fs.existsSync(ENV_FILE_PATH)) {
      fs.accessSync(ENV_FILE_PATH, fs.constants.W_OK);
      return true;
    }

    fs.accessSync(path.dirname(ENV_FILE_PATH), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function writeAdminTokenToEnv(token: string) {
  const existing = fs.existsSync(ENV_FILE_PATH) ? fs.readFileSync(ENV_FILE_PATH, 'utf8') : '';
  const line = `ADMIN_TOKEN=${token}`;

  let next: string;
  if (/^ADMIN_TOKEN=.*$/m.test(existing)) {
    next = existing.replace(/^ADMIN_TOKEN=.*$/m, line);
  } else {
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    next = `${existing}${separator}\n# Admin Token for dashboard/admin API access.\n${line}\n`;
  }

  fs.writeFileSync(ENV_FILE_PATH, next, { mode: 0o600 });
}
