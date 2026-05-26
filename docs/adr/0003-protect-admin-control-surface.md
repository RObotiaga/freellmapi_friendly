# Protect the admin control surface

FreeLLMAPI has two different security boundaries:

- the OpenAI-compatible Proxy Surface (`/v1/*`), which is used by clients and keeps its existing unified Bearer-token behavior;
- the Admin Control Surface, which lets the operator inspect or change Provider Keys, fallback routing, health checks, analytics, and settings.

The Admin Control Surface must not reuse the proxy credential. It is protected by a dedicated `ADMIN_TOKEN` supplied through the deployment environment.

## Decision

Admin routes require `Authorization: Bearer <ADMIN_TOKEN>`. The token is separate from the unified `/v1` API key. There is no localhost bypass, no `DEV_MODE` bypass, and no fallback to the unified key.

The server binds to `127.0.0.1` by default in all modes. Public binding requires an explicit `HOST=0.0.0.0` operator setting. `DEV_MODE` may support local bootstrap convenience, but it must not weaken admin authentication or network exposure defaults.

On a fresh local installation where `ADMIN_TOKEN` is absent, the dashboard may offer a Portainer-style first-run setup window. During the first five minutes after startup, only when the server is bound locally and `.env` is writable, the operator may create the initial Admin Token through the dashboard. The token must pass server-side validation and is written to `.env`. The setup endpoint closes immediately after a token is configured.

If `ADMIN_TOKEN` is missing and setup is unavailable, expired, or cannot persist the token, the server enters Admin Locked Mode. The proxy may continue serving existing `/v1/*` traffic, but protected admin routes return `503` until the operator configures `ADMIN_TOKEN` and restarts.

`GET /api/ping` remains public. `GET /api/models` remains public, but only as a static model catalog. It must not reveal runtime provider capability, Provider Key availability, fallback priority, or fallback enablement.

## Protected routes

- `/api/keys/*`
- `/api/fallback/*`
- `/api/analytics/*`
- `/api/health/*`
- `/api/settings/*`
- `/api/admin/session`

## Public admin bootstrap routes

- `GET /api/admin/setup-status`
- `POST /api/admin/setup`, only while First-run Admin Setup is active

## Consequences

The dashboard loads as static SPA assets, but it shows a setup or lock screen until the operator supplies a valid Admin Token. The dashboard stores the token in `sessionStorage` and sends it as `Authorization: Bearer <ADMIN_TOKEN>` on protected `/api/*` requests.

This intentionally differs from upstream PR54 by not reusing the unified `/v1` API key, not allowing localhost auth bypass, and not storing the dashboard credential in persistent browser storage.
