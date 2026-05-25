import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, setAutoretryEnabled } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Settings API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    setAutoretryEnabled(false);
  });

  it('GET /api/settings/autoretry returns false by default', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/autoretry');
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false });
  });

  it('PATCH /api/settings/autoretry persists the value', async () => {
    const { status, body } = await request(app, 'PATCH', '/api/settings/autoretry', { enabled: true });
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: true });

    const followUp = await request(app, 'GET', '/api/settings/autoretry');
    expect(followUp.status).toBe(200);
    expect(followUp.body).toEqual({ enabled: true });
  });
});
