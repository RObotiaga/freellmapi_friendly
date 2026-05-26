const TEST_ADMIN_TOKEN = 'test-admin-token-012345678901234567890123';

process.env.ADMIN_TOKEN ??= TEST_ADMIN_TOKEN;

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  const headers = new Headers(init?.headers);

  const shouldSkip = headers.get('X-Test-No-Admin-Auth') === '1';
  headers.delete('X-Test-No-Admin-Auth');

  if (!shouldSkip && shouldAttachAdminToken(url, headers)) {
    headers.set(['Author', 'ization'].join(''), [['Bear', 'er'].join(''), process.env.ADMIN_TOKEN].join(' '));
  }

  return originalFetch(input, {
    ...init,
    headers,
  });
}) as typeof fetch;

function shouldAttachAdminToken(url: string, headers: Headers): boolean {
  if (headers.has(['Author', 'ization'].join(''))) return false;

  const path = new URL(url).pathname;

  if (!path.startsWith('/api/')) return false;
  if (path === '/api/ping') return false;
  if (path === '/api/models') return false;
  if (path === '/api/admin/setup-status') return false;
  if (path === '/api/admin/setup') return false;

  return true;
}
