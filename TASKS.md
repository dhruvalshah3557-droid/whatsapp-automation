# Task Tracker

This file is the single source of truth for task status. A fresh session reads this file first, picks the first pending task (`- [ ]`), and continues working on it before accepting new work.

- Pending: `- [ ] YYMMDD: <description> — status: pending`
- Finished: `- [x] YYMMDD: <description> — status: finished`
- Always commit and push this file together with code changes so status survives interruption.

## Active Task

_None — no pending task right now._

## History

- [x] 260806: Upgrade Cloudflare Worker to a full replacement server — status: finished
  - Done: worker now serves the messaging app via an ASSETS binding, stores inbound events in a KV namespace (`EVENTS`, created idempotently via Cloudflare REST API in the deploy workflow), and exposes `/api/events`; all six webhook handlers record events; 17 worker tests + 39 total pass; verified live: app 200, `/api/events` returns recorded events, event push recorded (commit `0ac4975`)
- [x] 260806: Appoint an auto-solving standing agent — status: finished
  - Done: created `scripts/agent.mjs` (continuous self-healing loop: checks server, preview API, Meta webhook handshakes, SW cache guard, served app freshness, test suite every 60s; auto-restarts the server and kills stale port processes; logs to `logs/agent.log`); updated `scripts/monitor.mjs` preview URL to the current live host; documented the agent in `AGENTS.md`; started it in a background terminal (terminal `term_1786003652958_1`)
- [x] 260804: Appoint a self-healing monitoring agent — status: finished
  - Done: created `scripts/monitor.mjs` (checks local server, public preview API, SW `/api` cache guard, served app freshness, full test suite; `--fix` restarts a down server); documented the monitoring duty in `AGENTS.md` so every session runs it; started a 60s background monitor loop (commit `ddaa4f5`)
- [x] 260804: Connect Facebook and Instagram webhooks — status: finished (server side)
  - Done: restarted preview server with `VERIFY_TOKEN=change_me_verify_token`; verified Instagram and Facebook webhook handshake returns the challenge through the live preview URL; pushed a Facebook test message (event 4). Remaining: user must paste real Instagram/Facebook tokens in the app's Connector view (commit `ddaa4f5`)
- [x] 260804: Fix chats not syncing in the messaging app — status: finished
  - Done: service worker was cache-first for `/api/*` and served a stale empty events list to the poller; made API requests network-only and bumped SW to `colourdiam-msg-v10`; pushed 3 demo inbound events (instagram/whatsapp/line) through the live server to verify the sync pipeline (commit `0b45839`)
- [x] 260804: Fix connection in the messaging app (client refresh) — status: finished
  - Done: bump SW cache to `colourdiam-msg-v9` and config storage to `mc_cfg_v2` so clients drop the stale page/config and pick up the same-origin server URL; verified `/api/events` and `/api/health` reachable via the public preview URL (commit `9829f08`)
- [x] 260804: Fix connection issue in the messaging app — status: finished
  - Done: webhook server now serves the messaging app + API on one origin (static serving added in `server/index.js`); app defaults `server_url` to the current origin when none is set, so live events/send/test connection work in the preview; added static-serving server tests (commit `e7397cc`)
- [x] 260804: Remove all mock data from the `messaging` app — status: finished
  - Done: removed `SEED` contacts, `PRODUCTS` catalogue, `OLDER_POOL`/`loadOlder` mock history, sample quick replies; `chatData()` now starts with an empty contact list; empty states added for products; bumped chat storage to `mc_chat_v2` (commit `f4d4fcb`)
- [x] 260804: Rewrite `messaging` app as luxury light theme + WhatsApp-Web layout + business features — status: finished
  - Done: light theme rewrite, two-column layout, rich messages, drawer, business views, kept connector/AI/live/biometric/i18n, manifest+SW updates, added `messaging/test/messaging.test.mjs` (commit `246554a`)
