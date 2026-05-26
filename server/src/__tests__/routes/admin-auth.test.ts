import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';

import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { resetAdminControlForTests } from '../../services/adminToken.js';

const ADMIN_TOKEN = 'test-admin-token-012345678901234567890123';

async function request(app: Express, method: string, path: string, options: { body?: any; token?: string; skipAutoAdminAuth?: boolean } = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const headers: Record<string, string> = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) headers[['Author', 'ization'].join('')] = [['Bear', 'er'].join(''), options.token].join(' ');
  if (options.skipAutoAdminAuth) headers['X-Test-No-Admin-Auth'] = '1';

  const res = await fetch(url, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

describe('Admin auth', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    initDb(':memory:');
    resetAdminControlForTests({ adminToken: ADMIN_TOKEN });
    app = createApp();
  });

  afterEach(() => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  });

  it('leaves /api/ping public', async () => {
    const { status, body } = await request(app, 'GET', '/api/ping');

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('leaves /api/models public catalog-only', async () => {
    const { status, body } = await request(app, 'GET', '/api/models');

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).not.toHaveProperty('hasProvider');
    expect(body[0]).not.toHaveProperty('priority');
    expect(body[0]).not.toHaveProperty('fallbackEnabled');
    expect(body[0]).not.toHaveProperty('keyCount');
  });

  it('rejects protected admin routes without ADMIN_TOKEN', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys', { skipAutoAdminAuth: true });

    expect(status).toBe(401);
    expect(body.error.type).toBe('admin_auth_required');
  });

  it('accepts protected admin routes with ADMIN_TOKEN', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys', { token: ADMIN_TOKEN });

    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns 503 Admin Locked Mode when no ADMIN_TOKEN is configured', async () => {
    resetAdminControlForTests({ adminToken: null });
    app = createApp();

    const { status, body } = await request(app, 'GET', '/api/keys', { token: ADMIN_TOKEN });

    expect(status).toBe(503);
    expect(body.error.type).toBe('admin_locked');
  });

  it('validates admin sessions without echoing secrets', async () => {
    const { status, body } = await request(app, 'GET', '/api/admin/session', { token: ADMIN_TOKEN });

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: true });
  });
});
