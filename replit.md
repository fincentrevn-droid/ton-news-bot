# TON News Bot

Admin dashboard for automating a Telegram crypto-news channel focused on TON, Telegram ecosystem, and crypto markets. Generates AI-written posts via OpenAI and publishes them to Telegram.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- See `.env.example` for full list of required environment variables

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + shadcn/ui + TanStack Query

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI contract (source of truth)
- `lib/db/src/schema/` — Drizzle table definitions (posts, sources, schedules, settings, aiUsage)
- `artifacts/api-server/src/routes/` — Express route handlers (posts, sources, schedule, stats, settings, webhook)
- `artifacts/api-server/src/lib/openai.ts` — AI post generation + cost guard
- `artifacts/api-server/src/lib/telegram.ts` — Telegram Bot API: channel publish, review messages, bot commands, webhook
- `artifacts/api-server/src/lib/safety.ts` — Safety check: suspicious links, scam patterns, domain blocklist
- `artifacts/api-server/src/config/sources.json` — Seed config for primary (Telegram) and secondary (RSS) sources
- `artifacts/dashboard/src/pages/` — React pages (dashboard, posts, sources, schedule, settings, ai-usage)

## Architecture decisions

- Contract-first OpenAPI: spec gates codegen which gates the frontend — never write raw fetch calls
- Cost guard: ENABLE_COST_GUARD=true blocks AI calls when daily limits reached, notifies owner via Telegram
- Posts always created as "draft" — never auto-published without approval (unless autoPublish=true in settings)
- AI model configurable via OPENAI_MODEL env var (default gpt-4o); also overridable per-request via Settings
- DB is source of truth for AI usage counters — one row per calendar day in ai_usage table
- Telegram review flow: every generated post is sent to REVIEW_CHAT_ID with ✅/🔁/❌ inline buttons
- Safety check runs on all generated content — scam patterns → rejected, suspicious links → stripped with warning
- Telegram sources are PRIMARY — RSS/web sources are secondary (ENABLE_SECONDARY_SOURCES=false by default)
- Webhook route at POST /api/telegram/webhook handles callback queries and bot commands

## Product

- Dashboard: AI model, auto-publish status, Telegram sources count, pending review, safety rejected, AI quota
- Posts: full post queue with status/format/source-type/safety-status, inline edit, approve/publish/regenerate/skip
- Sources: separated primary (Telegram) vs secondary (RSS/web) sources with star toggle
- Schedule: configure auto-generation interval, max posts/day, auto-publish toggle
- Settings: OpenAI model, approval flow, auto-publish (with warning), cost guard, custom emoji, Telegram IDs
- AI Usage: daily quota tracker with progress bars and limit-reached warnings

## Bot commands (via Telegram)

- `/status` — posts today, published, pending review, skipped, safety rejected, AI calls
- `/generate_now` — manually trigger post generation
- `/sources` — show active sources
- `/costs` — AI costs and limit warnings
- `/help` — command reference

## User preferences

- AI model: gpt-4o (default), configurable via OPENAI_MODEL env
- Cost guard enabled by default — daily limits: 12 AI calls, 6 posts, 3 rewrites per post, 1500 tokens
- Posts are in Russian — channel targets Russian-speaking crypto audience
- No "all in", "иксы", "летим", "покупай/продавай" — no financial advice ever
- Production deployment target: Railway (not Replit)

## Gotchas

- After any `lib/*` schema change, run `pnpm run typecheck:libs` before artifact typechecks (stale declarations)
- After OpenAPI spec changes, always re-run codegen before writing routes
- Do NOT add the webhook path to the OpenAPI spec — it causes duplicate type exports (TelegramWebhookBody conflict)
- The ai_usage table tracks by calendar date (UTC) — one row per day, upserted on first use
- OPENAI_MODEL env var overrides the stored settings model at runtime
- sources route PATCH must include isPrimary in updateData to avoid "No values to set" error

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
