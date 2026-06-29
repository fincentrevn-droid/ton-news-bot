# TON News Bot

Automated Telegram crypto-news channel for the TON/Telegram ecosystem. Generates AI-written posts in Russian via OpenAI, runs a safety filter, sends posts for review via Telegram inline buttons, and publishes to a Telegram channel.

---

## Features

- **AI post generation** — GPT-4o writes short/medium/long posts in Russian, one per topic per run
- **Telegram review flow** — every post is sent to your personal Telegram with ✅ Publish / 🔁 Rewrite / ❌ Skip buttons
- **Safety filter** — blocks scam patterns, suspicious links, and financial advice language before any post reaches review
- **Admin dashboard** — React web UI for managing the post queue, sources, schedule, settings, and AI usage
- **Bot commands** — `/status`, `/generate_now`, `/sources`, `/costs`, `/help` via the Telegram bot
- **Cost guard** — hard daily limits on AI calls, posts, rewrites, and tokens; notifies you when a limit is hit

---

## Local development

### Prerequisites

- Node.js 24+
- pnpm 9+
- PostgreSQL database

### Setup

```bash
# Install dependencies
pnpm install

# Copy the env file and fill in your values
cp .env.example .env

# Push the database schema
pnpm --filter @workspace/db run push

# Start the API server (port 5000)
pnpm --filter @workspace/api-server run dev

# In a separate terminal, start the dashboard (port from PORT env)
PORT=3001 BASE_PATH=/ pnpm --filter @workspace/dashboard run dev
```

### Codegen (after OpenAPI spec changes)

```bash
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `OPENAI_API_KEY` | ✅ | OpenAI API key |
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram Bot API token (from @BotFather) |
| `TELEGRAM_CHANNEL_ID` | ✅ | Target channel ID (e.g. `@yourchannel` or `-100xxxxxxxxx`) |
| `SESSION_SECRET` | ✅ | Random secret for session signing (min 32 chars) |
| `OWNER_TELEGRAM_ID` | ✅ | Your personal Telegram user ID — receives cost alerts and is the fallback review chat |
| `REVIEW_CHAT_ID` | ✅ | Telegram chat ID where review messages with inline buttons are sent (usually same as OWNER_TELEGRAM_ID) |
| `OPENAI_MODEL` | — | Override the AI model at runtime (default: `gpt-4o`) |
| `ENABLE_COST_GUARD` | — | `true` to enforce daily AI limits (default: `true`) |
| `ENABLE_SECONDARY_SOURCES` | — | `true` to enable RSS/web sources (default: `false`) |
| `NODE_ENV` | — | Set to `production` in deployed environments |
| `PORT` | — | Port for the API server (Railway sets this automatically) |

See `.env.example` for the full list with comments.

---

## Deploying to Railway

### 1. Create a Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo** and connect this repository
3. Railway will detect `railway.json` and configure the build automatically

### 2. Add a PostgreSQL database

In your Railway project → **+ New** → **Database** → **PostgreSQL**. Railway will inject `DATABASE_URL` automatically.

### 3. Set environment variables

In your Railway service → **Variables**, add all required variables from the table above. The minimum set to get running:

```
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHANNEL_ID=@yourchannel
SESSION_SECRET=<32+ random characters>
OWNER_TELEGRAM_ID=123456789
REVIEW_CHAT_ID=123456789
NODE_ENV=production
```

### 4. Run the database migration

After the first deploy succeeds, open the Railway shell for your service and run:

```bash
pnpm --filter @workspace/db run push
```

Or set it as a one-off command before the first deploy using Railway's **Pre-deploy commands**.

### 5. Set the Telegram webhook

Once Railway gives you a domain (e.g. `https://your-app.up.railway.app`), register the webhook with Telegram. Run this once from any terminal:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-app.up.railway.app/api/telegram/webhook"}'
```

You should see `{"ok":true,"result":true}`. After this, Telegram will push all bot updates (button presses and commands) to your server in real time.

### 6. Register bot commands (optional)

Send this once to set up the command menu in Telegram:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "status", "description": "Posts and AI usage today"},
      {"command": "generate_now", "description": "Generate a new post now"},
      {"command": "sources", "description": "Active sources"},
      {"command": "costs", "description": "AI costs and limits"},
      {"command": "help", "description": "Command reference"}
    ]
  }'
```

---

## Build details

| Command | What it does |
|---|---|
| `pnpm run build:railway` | Builds libs → API server bundle → Dashboard (for production) |
| `pnpm run start` | Starts the API server in production mode (serves dashboard static files too) |
| `pnpm run typecheck` | Full typecheck across all packages |
| `pnpm --filter @workspace/db run push` | Apply schema changes to the database |

In production the Express server serves both:
- `/api/*` — API routes
- `/*` — React dashboard (static files from `artifacts/dashboard/dist/public`)

---

## Bot commands

| Command | Description |
|---|---|
| `/status` | Posts today, published, pending review, skipped, safety rejected, AI calls |
| `/generate_now` | Manually trigger post generation right now |
| `/sources` | List active Telegram sources |
| `/costs` | AI costs today and limit warnings |
| `/help` | Command reference |

---

## Architecture

```
Telegram Bot API
      │
      ├─ POST /api/telegram/webhook  ←  button presses (✅/🔁/❌) + /commands
      │
      └─ Channel publishing  ←  POST /api/posts/:id/publish
      
OpenAI API  →  /api/posts/generate  →  Safety check  →  Review message to REVIEW_CHAT_ID
```

- Contract-first: OpenAPI spec → Orval codegen → typed React hooks + Zod schemas
- The webhook route is intentionally **not** in the OpenAPI spec (avoids type export collisions)
- All posts start as `draft`; auto-publish is off by default
- AI usage is tracked per UTC calendar day in the `ai_usage` table
