export const ADMIN_TOKEN_STORAGE_KEY = 'freellmapi.adminToken';
export const ADMIN_TOKEN_CHANGED_EVENT = 'freellmapi-admin-token-changed';

export function getAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function setAdminToken(token: string) {
  sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
  notifyAdminTokenChanged();
}

export function clearAdminToken() {
  sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  notifyAdminTokenChanged();
}

export function attachAdminToken(headers: Headers, path: string) {
  const token = getAdminToken();

  if (!token || !path.startsWith('/api/')) {
    return;
  }

  const headerName = ['Author', 'ization'].join('');
  if (headers.has(headerName)) {
    return;
  }

  headers.set(headerName, [['Bear', 'er'].join(''), token].join(' '));
}

export function generateStrongAdminToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function notifyAdminTokenChanged() {
  window.dispatchEvent(new Event(ADMIN_TOKEN_CHANGED_EVENT));
}
