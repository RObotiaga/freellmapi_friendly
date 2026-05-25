import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb, setAutoretryEnabled } from '../../db/index.js';

async function req(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(raw); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

function openAiResponse(model: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function streamResponse(chunks: string[]) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function streamResponseWithMidstreamError(firstChunk: string, error: Error) {
  let step = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (step === 0) {
        controller.enqueue(new TextEncoder().encode(firstChunk));
        step++;
        return;
      }
      controller.error(error);
      step++;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Proxy autoretry', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    setAutoretryEnabled(false);
    vi.restoreAllMocks();
  });

  it('does not hidden-fallback on non-retryable provider errors when autoretry is disabled', async () => {
    await req(app, 'POST', '/api/keys', { platform: 'mistral', key: 'mistral-test-key' });
    await req(app, 'POST', '/api/keys', { platform: 'groq', key: 'groq-test-key' });

    const origFetch = global.fetch;
    let groqCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.mistral.ai')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({ error: { message: 'Bad key' } }),
        } as any;
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalls++;
        return new Response(JSON.stringify(openAiResponse('llama-3.3-70b-versatile')), { status: 200 });
      }
      return origFetch(url, init);
    });

    const result = await req(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(result.status).toBe(502);
    expect(result.body.error.type).toBe('provider_error');
    expect(groqCalls).toBe(0);
  });

  it('hidden-fallbacks to the next provider route when autoretry is enabled for auto model', async () => {
    await req(app, 'POST', '/api/keys', { platform: 'mistral', key: 'mistral-test-key' });
    await req(app, 'POST', '/api/keys', { platform: 'groq', key: 'groq-test-key' });
    setAutoretryEnabled(true);

    const origFetch = global.fetch;
    let mistralCalls = 0;
    let groqCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.mistral.ai')) {
        mistralCalls++;
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({ error: { message: 'Bad key' } }),
        } as any;
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalls++;
        return new Response(JSON.stringify(openAiResponse('llama-3.3-70b-versatile')), { status: 200 });
      }
      return origFetch(url, init);
    });

    const result = await req(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(result.status).toBe(200);
    expect(result.headers.get('x-routed-via')).toContain('groq/');
    expect(Number(result.headers.get('x-fallback-attempts'))).toBeGreaterThan(0);
    expect(mistralCalls).toBeGreaterThan(0);
    expect(groqCalls).toBe(1);

    const logs = getDb().prepare(`
      SELECT status, platform FROM requests ORDER BY id ASC
    `).all() as Array<{ status: string; platform: string }>;
    expect(logs.at(-1)).toEqual({ status: 'success', platform: 'groq' });
    expect(logs.slice(0, -1).every(row => row.status === 'error' && row.platform === 'mistral')).toBe(true);
  });

  it('retries explicit model only across routes with the same exact model_id', async () => {
    await req(app, 'POST', '/api/keys', { platform: 'cerebras', key: 'cerebras-test-key' });
    await req(app, 'POST', '/api/keys', { platform: 'sambanova', key: 'sambanova-test-key' });
    setAutoretryEnabled(true);

    const origFetch = global.fetch;
    let firstFailedProvider: 'cerebras' | 'sambanova' | null = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.cerebras.ai')) {
        if (!firstFailedProvider) {
          firstFailedProvider = 'cerebras';
          return {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: () => Promise.resolve({ error: { message: 'Bad key' } }),
          } as any;
        }
        return new Response(JSON.stringify(openAiResponse('gpt-oss-120b')), { status: 200 });
      }
      if (urlStr.includes('api.sambanova.ai')) {
        if (!firstFailedProvider) {
          firstFailedProvider = 'sambanova';
          return {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: () => Promise.resolve({ error: { message: 'Bad key' } }),
          } as any;
        }
        return new Response(JSON.stringify(openAiResponse('gpt-oss-120b')), { status: 200 });
      }
      return origFetch(url, init);
    });

    const result = await req(app, 'POST', '/v1/chat/completions', {
      model: 'gpt-oss-120b',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(result.status).toBe(200);
    expect(result.headers.get('x-routed-via')).toMatch(/^(cerebras|sambanova)\/gpt-oss-120b$/);
    expect(Number(result.headers.get('x-fallback-attempts'))).toBeGreaterThan(0);
    expect(firstFailedProvider).not.toBeNull();
  });

  it('does not leave explicit model scope when no same-model alternate route exists', async () => {
    await req(app, 'POST', '/api/keys', { platform: 'groq', key: 'groq-test-key' });
    await req(app, 'POST', '/api/keys', { platform: 'mistral', key: 'mistral-test-key' });
    setAutoretryEnabled(true);

    const origFetch = global.fetch;
    let mistralCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({ error: { message: 'Bad key' } }),
        } as any;
      }
      if (urlStr.includes('api.mistral.ai')) {
        mistralCalls++;
        return new Response(JSON.stringify(openAiResponse('mistral-large-latest')), { status: 200 });
      }
      return origFetch(url, init);
    });

    const result = await req(app, 'POST', '/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(result.status).toBe(502);
    expect(result.body.error.type).toBe('provider_error');
    expect(mistralCalls).toBe(0);
  });

  it('retries stream requests invisibly before the first chunk', async () => {
    await req(app, 'POST', '/api/keys', { platform: 'mistral', key: 'mistral-test-key' });
    await req(app, 'POST', '/api/keys', { platform: 'groq', key: 'groq-test-key' });
    setAutoretryEnabled(true);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.mistral.ai')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({ error: { message: 'Bad key' } }),
        } as any;
      }
      if (urlStr.includes('api.groq.com')) {
        return streamResponse([
          `data: ${JSON.stringify({
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'llama-3.3-70b-versatile',
            choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      return origFetch(url, init);
    });

    const result = await req(app, 'POST', '/v1/chat/completions', {
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(result.status).toBe(200);
    expect(result.headers.get('x-routed-via')).toContain('groq/');
    expect(Number(result.headers.get('x-fallback-attempts'))).toBeGreaterThan(0);
    expect(result.raw).toContain('hello');
    expect(result.raw).toContain('[DONE]');
  });

  it('does not hidden-fallback after a stream has already started', async () => {
    await req(app, 'POST', '/api/keys', { platform: 'mistral', key: 'mistral-test-key' });
    await req(app, 'POST', '/api/keys', { platform: 'groq', key: 'groq-test-key' });
    setAutoretryEnabled(true);

    const origFetch = global.fetch;
    let groqCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.mistral.ai')) {
        return streamResponseWithMidstreamError(
          `data: ${JSON.stringify({
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'magistral-medium-latest',
            choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
          })}\n\n`,
          new Error('stream exploded')
        );
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalls++;
        return streamResponse(['data: [DONE]\n\n']);
      }
      return origFetch(url, init);
    });

    const result = await req(app, 'POST', '/v1/chat/completions', {
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(result.status).toBe(200);
    expect(result.raw).toContain('stream_error');
    expect(groqCalls).toBe(0);
  });
});
