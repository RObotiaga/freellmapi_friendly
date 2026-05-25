# FreeLLMAPI

An OpenAI-compatible router that combines multiple free-tier LLM providers behind a single `/v1/chat/completions` endpoint.

## What it does

FreeLLMAPI stores your provider keys locally, ranks available models, and routes each request through a fallback chain. If one model/provider/key is unavailable, the router can move to another configured route.

## Current scope

The scope is deliberately narrow. If a feature isn't on this list and isn't below, assume it isn't there yet.

- **Embeddings** (`/v1/embeddings`)
- **Image generation** (`/v1/images/*`)
- **Audio / speech** (`/v1/audio/*`)
- **Vision / multimodal inputs** — message content is text-only
- **Legacy completions** (`/v1/completions`) — only the chat endpoint is implemented
- **Moderation** (`/v1/moderations`)
- **`n > 1`** (multiple completions per request)
- **Per-user billing / multi-tenant auth** — single-user by design

PRs that add any of these are very welcome. See [Contributing](#contributing).

## Quick start

**Prerequisites:** Node.js 20+, npm.

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install

# Create local env file.
cp .env.example .env

# Option A: generate ENCRYPTION_KEY manually.
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))" >> .env

# Option B: on an empty non-production first install, the server can generate
# ENCRYPTION_KEY into .env automatically before any Provider Keys exist.

# Start server + dashboard together
npm run dev
```

`ENCRYPTION_KEY` protects stored Provider Keys. Normal startup uses the value from `.env` or deployment secrets. The server never stores the normal Encryption Key in SQLite. For local development only, you can explicitly enable the DB-stored fallback by uncommenting `DEV_MODE=true` in `.env`; do not use that mode with real Provider Keys or production deployments.

If you have an older database with a legacy `settings.encryption_key`, normal startup will ask you to migrate it. Run:

```bash
npm run migrate-encryption-key -w server
```

The migration copies the legacy Encryption Key into `.env`, verifies enabled Provider Keys, and removes the legacy SQLite key only after successful verification. Use `--dry-run` to preview:

```bash
npm run migrate-encryption-key -w server -- --dry-run
```

Open http://localhost:5173 (the Vite dev UI), add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

For a production build:

```bash
npm run build
node server/dist/index.js     # server + dashboard both served on :3001
```

## Using the API

Any OpenAI-compatible client works. Examples:

**Python**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # let the router pick; or specify e.g. "gemini-2.5-flash"
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(resp.choices[0].message.content)
print("Routed via:", resp.headers.get("x-routed-via"))
```

**curl**

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```
