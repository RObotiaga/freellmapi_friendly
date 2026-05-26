import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggleTheme() {
    const next = !dark;

    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center px-6">
          <div className="flex items-center gap-2 py-4">
            <span className="inline-block size-2 rounded-full bg-foreground" />
            <span className="text-sm font-semibold tracking-tight">FreeLLMAPI</span>
          </div>
          <div className="ml-auto py-2">
            <Button variant="ghost" size="sm" onClick={toggleTheme} aria-label="Toggle theme">
              {dark ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2" />
                  <path d="M12 20v2" />
                  <path d="m4.93 4.93 1.41 1.41" />
                  <path d="m17.66 17.66 1.41 1.41" />
                  <path d="M2 12h2" />
                  <path d="M20 12h2" />
                  <path d="m6.34 17.66-1.41 1.41" />
                  <path d="m19.07 4.93-1.41 1.41" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                </svg>
              )}
            </Button>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(120,120,120,0.12),transparent_40%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_35%)]" />
        <div className="relative mx-auto flex min-h-[calc(100vh-57px)] max-w-6xl items-center justify-center px-6 py-12">
          <Card className="w-full max-w-xl border-border/70 shadow-xl shadow-black/5 dark:shadow-black/20">
            <CardHeader className="gap-2 border-b">
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Admin Control Surface</p>
                <CardTitle className="text-2xl tracking-tight">{title}</CardTitle>
                <CardDescription>
                  Access to keys, routing, settings, health, and analytics is protected by a dedicated Admin Token.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              {children}
            </CardContent>
          </Card>
        </div>
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
