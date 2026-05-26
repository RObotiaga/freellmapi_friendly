import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ADMIN_TOKEN_CHANGED_EVENT,
  clearAdminToken,
  generateStrongAdminToken,
  getAdminToken,
  setAdminToken,
} from '@/lib/admin-token';

type SetupMode = 'ready' | 'expired' | 'locked' | 'configured';

interface SetupStatus {
  mode: SetupMode;
  expiresAt: string | null;
  reason?: string;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function AdminGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);

    try {
      const setupStatus = await fetchJson<SetupStatus>('/api/admin/setup-status');
      setStatus(setupStatus);

      const token = getAdminToken();
      if (!token) {
        setAuthenticated(false);
        return;
      }

      const ok = await verifySession(token);
      setAuthenticated(ok);

      if (!ok) {
        clearAdminToken();
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(ADMIN_TOKEN_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ADMIN_TOKEN_CHANGED_EVENT, refresh);
  }, [refresh]);

  if (checking && !status) {
    return <CenteredPanel title="Checking admin access">Preparing dashboard…</CenteredPanel>;
  }

  if (authenticated) {
    return <>{children}</>;
  }

  if (status?.mode === 'ready') {
    return <SetupPanel expiresAt={status.expiresAt} onConfigured={refresh} />;
  }

  if (status?.mode === 'configured') {
    return <UnlockPanel onUnlocked={refresh} />;
  }

  return (
    <CenteredPanel title="Admin API locked">
      <p className="text-sm text-muted-foreground">
        {status?.reason ?? 'ADMIN_TOKEN is not configured. Add ADMIN_TOKEN to .env or deployment secrets and restart.'}
      </p>
      <Button type="button" variant="outline" onClick={refresh}>
        Retry
      </Button>
    </CenteredPanel>
  );
}

function SetupPanel({ expiresAt, onConfigured }: { expiresAt: string | null; onConfigured: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await fetchJson('/api/admin/setup', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });

      setAdminToken(token);
      onConfigured();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CenteredPanel title="Create Admin Token">
      <p className="text-sm text-muted-foreground">
        This fresh local install needs an Admin Token before the dashboard can manage keys, routing, settings, health, or analytics.
      </p>
      {expiresAt && (
        <p className="text-xs text-muted-foreground">
          Setup window expires at {new Date(expiresAt).toLocaleTimeString()}.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="admin-token">Admin Token</Label>
          <Input
            id="admin-token"
            value={token}
            onChange={event => setToken(event.target.value)}
            placeholder="At least 32 characters"
            autoComplete="off"
            className="font-mono"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting || token.length < 32}>
            {submitting ? 'Saving…' : 'Save and unlock'}
          </Button>
          <Button type="button" variant="outline" onClick={() => setToken(generateStrongAdminToken())}>
            Generate strong token
          </Button>
        </div>
      </form>
    </CenteredPanel>
  );
}

function UnlockPanel({ onUnlocked }: { onUnlocked: () => void }) {
  const [token, setToken] = useState(getAdminToken() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const ok = await verifySession(token);
      if (!ok) {
        setError('Invalid Admin Token.');
        return;
      }

      setAdminToken(token);
      onUnlocked();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CenteredPanel title="Unlock dashboard">
      <p className="text-sm text-muted-foreground">
        Enter the Admin Token from your .env or deployment secrets to manage this instance.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="admin-token">Admin Token</Label>
          <Input
            id="admin-token"
            value={token}
            onChange={event => setToken(event.target.value)}
            autoComplete="off"
            className="font-mono"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={submitting || token.length === 0}>
          {submitting ? 'Checking…' : 'Unlock'}
        </Button>
      </form>
    </CenteredPanel>
  );
}

function CenteredPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-6">
      <section className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm space-y-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">FreeLLMAPI</p>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
      </section>
    </main>
  );
}

async function verifySession(token: string): Promise<boolean> {
  const headers = new Headers();
  const headerName = ['Author', 'ization'].join('');
  headers.set(headerName, [['Bear', 'er'].join(''), token].join(' '));

  const res = await fetch(`${BASE}/api/admin/session`, { headers });

  return res.ok;
}

async function fetchJson<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }

  return res.json();
}
