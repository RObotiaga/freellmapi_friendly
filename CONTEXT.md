# FreeLLMAPI Friendly

FreeLLMAPI Friendly routes OpenAI-compatible chat requests across multiple providers and model routes while preserving operator control over credentials and fallback behavior.

## Language

**Provider**:
An upstream service that can serve model requests through a compatible API. A **Provider** can have many **Provider Keys**.
_Avoid_: platform when discussing the domain; backend when discussing an upstream service.

**Provider Key**:
A credential that allows routing requests through a **Provider**. A **Provider Key** can be usable, invalid, disabled, rate-limited, or unusable without those states meaning the same thing.
_Avoid_: API key when the key belongs to an upstream provider; client key.

**Disabled Provider Key**:
A **Provider Key** that the operator intentionally excludes from routing.
_Avoid_: broken key, invalid key.

**Rate-limited Provider Key**:
A **Provider Key** whose Provider has temporarily refused more requests or tokens for the current quota window. It may become usable again without operator action.
_Avoid_: invalid key, disabled key, broken key.

**Unusable Provider Key**:
A **Provider Key** that cannot currently participate in routing even though the operator did not explicitly disable it. It should be visible to the operator as needing attention, but it should not block the router from trying other keys or model routes.
_Avoid_: disabled key, deleted key.

**Encryption Key**:
The operator-controlled secret used to protect stored **Provider Keys**. It is part of the deployment boundary, not part of the Provider Key data itself.
_Avoid_: provider key, unified key, client key.

**Legacy DB-stored Encryption Key**:
An **Encryption Key** found in an existing local database from older startup behavior. It is a migration state that requires operator action, not a normal runtime source of trust.
_Avoid_: default encryption key, production encryption key.

**Development Encryption Fallback**:
A local-only convenience mode that allows the system to keep an **Encryption Key** in local storage for development or tests. It must be explicitly enabled and is not the normal startup mode.
_Avoid_: default encryption, production fallback.

**First-run Encryption Bootstrap**:
A first-start convenience that creates an **Encryption Key** in the deployment environment when there are no existing **Provider Keys** and no legacy encryption state. It is not a **Development Encryption Fallback** because the Encryption Key is not stored beside Provider Keys in the database.
_Avoid_: development fallback, DB-stored key generation.

**Admin Control Surface**:
Routes and UI actions that let the operator inspect or change Provider Keys, fallback routing, health checks, analytics, or deployment settings. It is separate from the OpenAI-compatible Proxy Surface.
_Avoid_: proxy API, public API.

**Admin Token**:
The operator-controlled `ADMIN_TOKEN` used to unlock the dashboard and protected admin API. It is separate from the unified `/v1` API key and is supplied through `.env` or deployment secrets.
_Avoid_: unified key, provider key, encryption key.

**First-run Admin Setup**:
A Portainer-style first-start convenience for fresh local installs where `ADMIN_TOKEN` is absent. For the first 5 minutes after startup, only on localhost and only when `.env` is writable, the dashboard may let the operator create the initial Admin Token and persist it to `.env`.
_Avoid_: dev bypass, localhost bypass.

**Admin Locked Mode**:
The state used when `ADMIN_TOKEN` is missing and First-run Admin Setup is unavailable, expired, or cannot persist the token. `/v1/*`, `/api/ping`, and public catalog `/api/models` may continue working, but protected admin routes return `503`.
_Avoid_: unauthenticated admin mode.

**Network Exposure Policy**:
The server binds to `127.0.0.1` by default in all runtime modes. Public binding requires explicit `HOST=0.0.0.0`. `DEV_MODE` must not weaken admin authentication, create localhost auth bypasses, or change network exposure defaults.
_Avoid_: public by default.

**Public Model Catalog Policy**:
`GET /api/models` remains public but returns only static/catalog model fields. It must not expose runtime Provider capability, Provider Key availability, fallback priority, or fallback enablement.
_Avoid_: public dashboard state.

**Fallback Chain**:
The ordered set of model routes the router may try for a request. The chain expresses routing preference, not a guarantee that every route is usable at runtime.
_Avoid_: model list, provider list.

## Flagged ambiguities

**Provider Key error**:
An error on a **Provider Key** is not enough to decide whether the key is invalid, disabled, rate-limited, or unusable. Routing decisions must preserve that distinction unless the operator or a later check confirms a narrower state.

**Development mode**:
Development mode means the operator explicitly opted into local-only conveniences. It is not an implicit runtime default and must not silently weaken normal startup behavior.

## Implementation status

**PR87 encryption-key storage hardening**:
Implemented in this fork. Normal startup uses `ENCRYPTION_KEY` from `.env` or deployment secrets. The normal Encryption Key is no longer generated into SQLite. Legacy `settings.encryption_key` is treated as migration state and is not used silently outside explicit `DEV_MODE=true` outside production.

The migration command is:

```bash
npm run migrate-encryption-key -w server
```

The command supports `--dry-run`, `--db-path`, and `--env-path`. It does not print the Encryption Key, verifies enabled Provider Keys locally, and removes the legacy SQLite key only after successful verification.

An empty non-production first install may create `ENCRYPTION_KEY` in `.env` before any Provider Keys exist. Tests were verified after implementation: root `npm test` passes; server test suite reports 153/153 tests passing; client participates through its `test` script, which runs build. The remaining Vite large chunk warning is non-blocking and unrelated to PR87.

**PR54-style admin protection**:
Implemented in this fork with a stricter friendly policy. Protected admin routes require a dedicated `ADMIN_TOKEN`; the unified `/v1` API key is not accepted as an admin credential. There is no localhost bypass and no `DEV_MODE` bypass. Fresh local installs may use First-run Admin Setup for 5 minutes when bound to localhost and when `.env` is writable. Public `/api/models` is catalog-only. `/api/ping` remains public. The server binds to `127.0.0.1` by default; public binding requires explicit `HOST=0.0.0.0`.

## Example dialogue

Developer: “A Provider Key failed locally before the request reached the Provider. Should the router stop?”

Domain expert: “No. Treat that key as an Unusable Provider Key for routing and continue through the Fallback Chain. Do not turn it into a Disabled Provider Key unless the operator chooses that explicitly.”

Developer: “A Provider Key hit a quota window. Should the router stop trying it forever?”

Domain expert: “No. Treat it as a Rate-limited Provider Key. It may become usable again when the quota window resets.”

Developer: “Should local development automatically mean the Encryption Key can live beside Provider Keys?”

Domain expert: “Only when the operator explicitly enables the Development Encryption Fallback. Normal startup should require an operator-controlled Encryption Key.”

Developer: “If an older database already contains an Encryption Key, should the system keep using it silently?”

Domain expert: “No. Treat it as a Legacy DB-stored Encryption Key and require the operator to migrate it into the deployment environment.”

Developer: “Can an empty first install create its own Encryption Key?”

Domain expert: “Yes, through First-run Encryption Bootstrap, but only into the deployment environment and only before Provider Keys exist.”

Developer: “Can localhost dashboard requests skip Admin Token authentication?”

Domain expert: “No. Localhost may allow first-run setup for a short window, but protected admin routes must still require the dedicated Admin Token.”

## Local run in current environment

This repository is currently used from WSL, but the reliable runtime is the
Windows Node.js installation at `C:\Program Files\nodejs\node.exe`.

The fastest working local start from this environment is:

```bash
NPMSCRIPT=$(wslpath -w '/mnt/c/Program Files/nodejs/node_modules/npm/bin/npm-cli.js')
'/mnt/c/Program Files/nodejs/node.exe' "$NPMSCRIPT" run dev
```

If `npm run dev` is unstable in the background, start server and client
separately from WSL with Windows paths:

```bash
# server
cd server
SCRIPT=$(wslpath -w ../node_modules/tsx/dist/cli.mjs)
'/mnt/c/Program Files/nodejs/node.exe' "$SCRIPT" watch src/index.ts

# client
cd client
SCRIPT=$(wslpath -w ../node_modules/vite/bin/vite.js)
'/mnt/c/Program Files/nodejs/node.exe' "$SCRIPT"
```

Expected local addresses:

- Dashboard: `http://localhost:5173/playground`
- API ping: `http://localhost:3001/api/ping`
- OpenAI-compatible proxy: `http://localhost:3001/v1/chat/completions`

Current local logs are usually written to:

- `.codex-run/server.log`
- `.codex-run/client.log`

Important local caveat:

- WSL HTTP checks to `localhost:5173` may time out even when Vite is healthy.
  When that happens, verify the dashboard from Windows-side HTTP tooling or a
  browser instead of assuming the frontend failed to start.
