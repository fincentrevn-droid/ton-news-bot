# Setting Up a Second Independent Channel

This guide explains how to run a **second, fully independent** Telegram channel bot based on the TONKOFF codebase without touching or risking the existing TONKOFF deployment.

---

## What "Independent" Means

Each channel must have its own:

| Resource | Why separate |
|---|---|
| GitHub fork / repo copy | Code changes don't bleed into TONKOFF |
| Replit project | Separate dev environment |
| Railway project | Separate deployment, logs, restarts |
| PostgreSQL database | Posts, sources, schedules don't mix |
| Telegram Bot (`@BotFather`) | Separate token, separate bot identity |
| `TELEGRAM_CHANNEL_ID` | Publishes to a different channel |
| Telegram Reader account | Different session file, different reader identity |
| Environment variables | All secrets isolated in the new Railway project |

You **can** keep the same owner values if you want review/admin messages to come to you personally:

```
REVIEW_CHAT_ID=312695586
OWNER_TELEGRAM_ID=312695586
```

You **can** share the same `OPENAI_API_KEY` (usage is tracked per deployment via `ai_usage` table), or use a separate one.

---

## Step 1 — Fork / Duplicate the GitHub Repo

### Option A: GitHub Fork (recommended for independent development)

1. Go to `https://github.com/fincentrevn-droid/ton-news-bot`
2. Click **Fork** → choose a new name, e.g. `my-second-channel-bot`
3. Make the fork **private** if you don't want the config public

### Option B: Duplicate (no fork relationship)

```bash
git clone https://github.com/fincentrevn-droid/ton-news-bot my-second-channel-bot
cd my-second-channel-bot
git remote set-url origin https://github.com/YOUR_USERNAME/my-second-channel-bot
git push -u origin main
```

> **Do not push to `fincentrevn-droid/ton-news-bot`** from the second channel repo.

---

## Step 2 — Create a New Replit Project

1. Go to [replit.com](https://replit.com) → **Create Repl** → **Import from GitHub**
2. Select your forked/duplicated repo
3. This is now a completely separate Replit project — changes here don't affect TONKOFF's Replit

You do **not** need to run the second channel from Replit long-term — Replit is just the dev/edit environment. Production runs on Railway.

---

## Step 3 — Create a New Telegram Bot

1. Open `@BotFather` in Telegram → `/newbot`
2. Give it a new name and username (e.g. `@mychannel_autobot`)
3. Copy the **bot token** — this is the new `TELEGRAM_BOT_TOKEN`
4. Add the new bot as **Administrator** to your new Telegram channel
5. Grant it: **Post Messages**, **Edit Messages**, **Delete Messages**

> **Never share** the new bot token with TONKOFF's Railway project.

---

## Step 4 — Create a New Telegram Reader Account

The reader account is a **separate Telegram account** (not your main one) used only to read source channels via Telethon.

1. Register a new phone number (or use an existing secondary Telegram account)
2. Get `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org](https://my.telegram.org) for that account
3. Run `python3 generate_session.py` from the repo root to generate `TELEGRAM_STRING_SESSION`
4. Keep this session string **private and separate** — never use TONKOFF's session in the new bot

---

## Step 5 — Create a New Railway Project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select your forked/duplicated repo
3. Add a **PostgreSQL** plugin inside this project (Railway → Add Plugin → PostgreSQL)
4. `DATABASE_URL` will be set automatically by Railway

> This is a **completely separate Railway project** from TONKOFF's. It has its own database, its own deploy pipeline, its own logs.

---

## Step 6 — Set Environment Variables on Railway

Set all of these in the new Railway project's **Variables** tab. **Do not copy from TONKOFF's Railway** — generate fresh values.

### Required — must be different from TONKOFF

```env
TELEGRAM_BOT_TOKEN=          # new bot token from @BotFather
TELEGRAM_CHANNEL_ID=         # new channel ID, e.g. @my_second_channel
TELEGRAM_API_ID=             # from my.telegram.org for the reader account
TELEGRAM_API_HASH=           # from my.telegram.org for the reader account
TELEGRAM_STRING_SESSION=     # generated with generate_session.py for the reader account
DATABASE_URL=                # set automatically by Railway PostgreSQL plugin
SESSION_SECRET=              # generate a new random string: openssl rand -hex 32
```

### Optional — can reuse from TONKOFF or set fresh

```env
OPENAI_API_KEY=              # can share with TONKOFF or use a separate key
REVIEW_CHAT_ID=312695586     # keep your personal ID if you want reviews sent to you
OWNER_TELEGRAM_ID=312695586  # keep your personal ID for cost alerts
```

### Copy as-is from `.env.example` (safe defaults)

```env
OPENAI_MODEL=gpt-4o
AUTO_PUBLISH=true
POSTING_REQUIRES_APPROVAL=false
MIN_AUTO_POSTS_PER_DAY=6
MAX_AUTO_POSTS_PER_DAY=8
TARGET_AUTO_POSTS_PER_DAY=7
POSTING_TIMEZONE=Europe/Kyiv
POSTING_START_TIME=09:00
POSTING_END_TIME=23:30
NIGHT_PAUSE_ENABLED=true
NIGHT_PAUSE_START=00:00
NIGHT_PAUSE_END=08:30
MIN_MINUTES_BETWEEN_POSTS=75
MAX_MINUTES_BETWEEN_POSTS=180
POSTING_RANDOM_DELAY_ENABLED=true
POSTING_RANDOM_DELAY_MINUTES=25
MAX_POSTS_PER_DAY=8
MAX_AI_CALLS_PER_DAY=12
MAX_REWRITE_PER_POST=3
MAX_TOKENS_PER_POST=1500
MAX_SOURCE_POSTS_PER_CHANNEL=20
LOOKBACK_HOURS=24
MAX_SOURCE_AGE_HOURS=48
ENABLE_SECONDARY_SOURCES=false
ENABLE_MEDIA_DOWNLOAD=false
ENABLE_COST_GUARD=true
ENABLE_AI_QUALITY_CHECK=true
QUALITY_CHECK_MIN_SCORE=85
MAX_AUTO_QUALITY_REWRITES=1
TELEGRAM_CUSTOM_EMOJI_ENABLED=true
TELEGRAM_CUSTOM_EMOJI_FALLBACK=true
```

---

## Step 7 — Change Files for the Second Channel

These are the only files you need to edit in your forked repo. **Do not edit any of these in the TONKOFF repo.**

### 7a. Sources — `artifacts/api-server/src/config/sources.json`

Replace the TON-focused channels and keywords with your new channel's topic:

```json
{
  "primary_sources": [
    { "name": "Source Name", "url": "@channel_username", "type": "telegram_channel", "category": "your-topic" }
  ],
  "secondary_sources": [
    { "name": "RSS Source", "url": "https://example.com/rss", "type": "rss", "category": "your-topic" }
  ],
  "keywords": ["keyword1", "keyword2"],
  "blocked_domains": ["bit.ly", "tinyurl.com", "freeclaim", "wallet-connect", "connect-wallet", "airdrop", "claim"]
}
```

### 7b. Writing style prompt — `artifacts/api-server/src/lib/openai.ts`

Three prompts reference the TONKOFF channel name and TON/crypto topic. Update all three for the new channel:

| Constant | Line (approx.) | What to change |
|---|---|---|
| `SOURCE_SYSTEM_PROMPT` | ~67 | Channel name, topic, writing style |
| `FREE_SYSTEM_PROMPT` | ~109 | Channel name, topic, writing style |
| `QUALITY_CHECK_SYSTEM_PROMPT` | ~433 | Channel name and topic for the QC reviewer |

Example — replace:
```
Ты автор Telegram-канала TONKOFF о TON, Telegram-крипте и крипторынке.
```
With:
```
Ты автор Telegram-канала [NEW_CHANNEL_NAME] о [YOUR_TOPIC].
```

Keep the rest of the prompt structure intact (rules, formatting, forbidden phrases) or adapt for your niche.

---

## Step 8 — Register the Webhook on Railway

After the first deploy, register the Telegram webhook so the bot receives button callbacks:

```
POST https://api.telegram.org/bot<NEW_BOT_TOKEN>/setWebhook
  url: https://<your-railway-domain>/api/telegram/webhook
```

Railway provides the public domain under **Settings → Domains** in your new project.

---

## What Must Never Be Shared Between TONKOFF and the Second Channel

| Thing | Why |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Each bot is a separate Telegram identity |
| `TELEGRAM_CHANNEL_ID` | Posts go to the right channel |
| `TELEGRAM_STRING_SESSION` | Each reader account has its own session |
| `DATABASE_URL` | Posts, drafts, sources, AI usage stay separate |
| `SESSION_SECRET` | Dashboard cookie signing is isolated |
| Railway project | Deployments, logs, restarts don't interfere |
| Replit project | Dev environments don't share workflows |

---

## Checklist Before Going Live

- [ ] New GitHub repo forked / duplicated
- [ ] New Replit project created from the new repo
- [ ] New Railway project created with PostgreSQL plugin
- [ ] All required env vars set in the new Railway project
- [ ] `sources.json` updated for the new channel topic
- [ ] Prompts in `openai.ts` updated to reference the new channel name/topic
- [ ] New Telegram bot created via @BotFather, added as admin to the new channel
- [ ] New reader Telegram account session generated and saved to `TELEGRAM_STRING_SESSION`
- [ ] Webhook registered at `https://<new-railway-domain>/api/telegram/webhook`
- [ ] Test: `/generate_now` via Telegram bot → post appears in review or auto-publishes
- [ ] TONKOFF Railway project is untouched and still running normally

---

## Notes

- The TONKOFF Railway project, database, and bot are completely unaffected by anything you do in the second project.
- Both bots can run simultaneously — they use different tokens and databases.
- If you want review messages from both bots to arrive in the same Telegram chat, set `REVIEW_CHAT_ID` to the same value in both projects. The messages will be distinguishable by the source channel name shown in each review caption.
- Never commit `.env` files or session strings to Git.
