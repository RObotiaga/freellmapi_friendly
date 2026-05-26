import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';

import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { resetAdminControlForTests } from '../../services/adminToken.js';

async function request(app: Express, method: string, pathName: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${pathName}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

describe('First-run Admin Setup', () => {
  let app: Express;

  beforeEach(() => {
    delete process.env.ADMIN_TOKEN;
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    initDb(':memory:');
    resetAdminControlForTests({ host: '127.0.0.1', adminToken: null });
    app = createApp();
  });

  it('reports setup ready on local bind while no ADMIN_TOKEN exists', async () => {
    const { status, body } = await request(app, 'GET', '/api/admin/setup-status');

    expect(status).toBe(200);
    expect(body.mode).toBe('ready');
    expect(body.expiresAt).toBeTruthy();
  });

  it('rejects weak Admin Tokens', async () => {
    const { status, body } = await request(app, 'POST', '/api/admin/setup', { token: 'password' });

    expect(status).toBe(400);
    expect(body.error.message).toContain('at least 32 characters');
  });

  it('locks setup on public bind', async () => {
    resetAdminControlForTests({ host: '0.0.0.0', adminToken: null });
    app = createApp();

    const { status, body } = await request(app, 'GET', '/api/admin/setup-status');

    expect(status).toBe(200);
    expect(body.mode).toBe('locked');
  });
});
