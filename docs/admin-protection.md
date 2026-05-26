# Dashboard admin protection

The dashboard and management API are protected by a dedicated `ADMIN_TOKEN`. This token is separate from the unified `/v1` API key used by OpenAI-compatible clients.

On a fresh local install, open the dashboard within 5 minutes after startup and create the Admin Token when prompted. The server saves it to `.env` and the dashboard stores it in `sessionStorage` for the current browser session.

For public or deployed instances, set `ADMIN_TOKEN` explicitly in `.env` or deployment secrets before starting the server:

```bash
ADMIN_TOKEN=your-strong-admin-token-at-least-32-characters
```

The server binds to `127.0.0.1` by default. To bind publicly, set `HOST=0.0.0.0` explicitly and keep the instance behind a trusted network boundary.

Public endpoints:

- `GET /api/ping`
- `GET /api/models` as a catalog-only endpoint

Protected endpoints require `Authorization: Bearer <ADMIN_TOKEN>`:

- `/api/keys/*`
- `/api/fallback/*`
- `/api/analytics/*`
- `/api/health/*`
- `/api/settings/*`
- `/api/admin/session`
