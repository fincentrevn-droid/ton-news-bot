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

## Two Telegram identities

This bot uses **two completely separate Telegram identities**. Keep them distinct.

### 1. Telegram Bot (publisher)

Created via [@BotFather](https://t.me/BotFather). This is the **only** identity that publishes.

Used for:
- Sending review messages to your main account
- The ✅ Publish / 🔁 Rewrite / ❌ Skip buttons
- Publishing approved posts to the channel

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=@tonkoff_crypto
REVIEW_CHAT_ID=312695586      # your MAIN Telegram ID
OWNER_TELEGRAM_ID=312695586   # your MAIN Telegram ID
```

### 2. Telegram Reader account (read-only)

A **separate Telegram account** created only for this bot. Used **only** to read source Telegram channels via Telethon. It **never publishes anything**.

```
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_STRING_SESSION=
```

> ⚠️ **Use a separate Telegram reader account for `TELEGRAM_STRING_SESSION`.** This account only needs to join/read the source channels. **Do not use your main personal account** if you want better security — the session string grants full access to whatever account generated it.

---

## Generating the Telegram String Session

The `TELEGRAM_STRING_SESSION` lets the reader account read source channels via Telethon. Generate it **once** from the **separate reader account** (never your main account) and store it as an environment variable.

### Prerequisites

- A **separate** Telegram reader account (not your main personal account)
- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org](https://my.telegram.org/apps) → **API development tools**

### Setup checklist

1. **Create a separate Telegram account** to act as the reader (do not use your main account).
2. **Log in to Telegram** with that reader account.
3. **Join all source channels** with the reader account so it can read them. Current sources from `artifacts/api-server/src/config/sources.json`:
   - `@ton_blockchain` (TON Blockchain)
   - `@durov` (Durov)
   - `@telegram` (Telegram)
   - `@toncoin` (TON Community)
   - `@the_open_network` (TON Foundation)
4. **Generate `TELEGRAM_STRING_SESSION`** using that reader account (steps below).
5. **Paste `TELEGRAM_STRING_SESSION` into Railway** → Variables.
6. **Keep `REVIEW_CHAT_ID` and `OWNER_TELEGRAM_ID` as your main owner ID** (`312695586`) — these stay on your main account.

### Steps

```bash
# 1. Install Telethon (Python 3.8+)
pip install telethon

# 2. Run the generator script
python generate_session.py

# 3. Enter the API ID, API HASH, and the READER account's phone number
#    (NOT your main account) when prompted
# 4. Complete the Telegram login (SMS or app code, 2FA if enabled)
# 5. Copy the printed session string
```

The script prints a long base64-like string. Copy it and set it as:
- **Railway:** Variables → `TELEGRAM_STRING_SESSION`
- **Local:** add `TELEGRAM_STRING_SESSION=<value>` to your `.env` file

> **Security:** The session string grants full access to the reader Telegram account. It is **never** saved to a file by the script — it is only printed to the terminal. Never commit it to version control, share it, or store it anywhere public. The `.gitignore` already excludes `.env`, `*.session`, and `*.session-journal` files.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `OPENAI_API_KEY` | ✅ | OpenAI API key |
| `TELEGRAM_BOT_TOKEN` | ✅ | **Bot identity.** Telegram Bot API token (from @BotFather) — publishes posts and sends review messages |
| `TELEGRAM_CHANNEL_ID` | ✅ | **Bot identity.** Target channel the bot publishes to (e.g. `@yourchannel` or `-100xxxxxxxxx`) |
| `TELEGRAM_API_ID` | ✅ | **Reader identity.** From my.telegram.org/apps — used by Telethon to read source channels |
| `TELEGRAM_API_HASH` | ✅ | **Reader identity.** From my.telegram.org/apps — used by Telethon to read source channels |
| `TELEGRAM_STRING_SESSION` | ✅ | **Reader identity.** Generated by `generate_session.py` from the **separate reader account** — read-only |
| `SESSION_SECRET` | ✅ | Random secret for session signing (min 32 chars) |
| `OWNER_TELEGRAM_ID` | ✅ | **Bot identity.** Your MAIN Telegram user ID — receives cost alerts and is the fallback review chat |
| `REVIEW_CHAT_ID` | ✅ | **Bot identity.** Your MAIN Telegram chat ID where review messages with inline buttons are sent (usually same as OWNER_TELEGRAM_ID) |
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
