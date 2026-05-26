import { attachAdminToken, clearAdminToken } from './admin-token';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  attachAdminToken(headers, path);

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));

    if (res.status === 401) {
      clearAdminToken();
    }

    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }

  return res.json();
}
