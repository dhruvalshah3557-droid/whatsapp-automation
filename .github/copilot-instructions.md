# GitHub Copilot Instructions

Repository-specific guidance for GitHub Copilot Chat and the Copilot coding
agent when working in this repo.

## What this project is

`meta-messaging-automation` is a WhatsApp/Instagram/Facebook/WeChat/TikTok/Line
messaging automation app for the Colour Diam business:

- `messaging/` — the served web app: `index.html` (chat pane, admin auth,
  WhatsApp Web card), `sw.js` (service worker, cache version `colourdiam-msg-vNN`),
  `manifest.json`, `icons/`. Plain HTML/CSS/JS, no framework.
- `server/` — standalone Node.js (Express-less, plain `http`) API server
  (`index.js`). Connects to WhatsApp Web via Baileys (`wa.js`), serves
  `/api/*` endpoints (products, auth, memory, events, media, sync, wa, llm).
  Auth in `auth.js` + `users.json`; memory in `app-memory.json`.
- `worker/` — Cloudflare Worker (`src/worker.js`) hosting `sw.js`/app shell.
- `scripts/` — operations: `monitor.mjs` (health check, `--fix`),
  `agent.mjs` (60s auto-heal loop), `qa-agent.mjs` (24/7 deep-QA, 180s loop),
  `free-api-hunter.mjs` (probes free LLM/keyless APIs), `health-lib.mjs` (shared
  check library, `PUBLIC` preview URL), `import-workflows.mjs`.
- `dashboard/`, `workflows/`, `docs/` — supporting material.
- `TASKS.md` — single source of truth for task status; keep updated.
- `AGENTS.md` — authoritative operating rules for agents; read it first.

## How to run things

- Server: `node server/index.js` (binds `PORT`, default 8099; requires
  `server/.env` with `VERIFY_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`).
- Full test suite (must pass before finishing work):
  ```bash
  node --test messaging/test/messaging.test.mjs server/test/server.test.mjs server/test/site-sync.test.mjs server/test/auth.test.mjs worker/test/worker.test.mjs
  ```
  Every test file spawns real servers on dedicated ports 3456-3459. Never
  reuse those ports and never start servers on a fixed port shared between
  test files — the suite runs files concurrently and port collisions hang it.
- Health check: `node scripts/monitor.mjs` (exit 0 = healthy) and
  `node scripts/monitor.mjs --fix` (restarts the server if down).
- QA agent: `node scripts/qa-agent.mjs` (loop) or `--once`.
- Code is plain ESM JavaScript (Node `"type": "module"`); no build step, no
  linter config, no TypeScript. Match existing style (2-space indent, no
  semicolons not already present, no comments unless asked).

## Architecture rules to respect

- The service worker must NEVER cache `/api` calls, only static app assets.
  Cache version lives in `messaging/sw.js` (`CACHE`) and `messaging/index.html`
  (`WN_VERSION`) and must be bumped together on every app change.
- The WhatsApp Web connector (`server/wa.js`, Baileys) needs a persistent
  WebSocket + filesystem and therefore CANNOT run on the Cloudflare Worker.
- `server/users.json` and `server/app-memory.json` are ephemeral on the
  preview sandbox and re-bootstrap from `server/.env`; only the cPanel VPS
  (Passenger, Node 22) persists them.
- `restoreMemory()` in `messaging/index.html` only seeds empty local buckets;
  it must never overwrite live data.
- Do not add `content-visibility: auto` to elements inside the chat `.messages`
  scroll container — it breaks scrolling and lazy media.
- The frontend calls `/api/*`; in preview the same port proxies to the server.

## Git workflow

- After completing a task, update `TASKS.md`, then `git add -A`,
  `git commit -m "..."`, and push to both remotes:
  - `git push origin main`
  - `git push backup main:colourdiam-messaging`
- Branch convention: `YYMMDD-(feat|fix|chore|refactor)-short-description`.
- `server/.env` is git-ignored; never commit secrets or API keys.

## Verification expectations

- Any change must keep the full test suite green (137 tests).
- After editing `messaging/` app files, bump `WN_VERSION`/`CACHE` and confirm
  the deployed worker serves the new version.
- Never use emojis in code, commits, or docs.
