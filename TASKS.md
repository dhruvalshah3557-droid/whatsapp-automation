# Task Tracker

This file is the single source of truth for task status. A fresh session reads this file first, picks the first pending task (`- [ ]`), and continues working on it before accepting new work.

- Pending: `- [ ] YYMMDD: <description> — status: pending`
- Finished: `- [x] YYMMDD: <description> — status: finished`
- Always commit and push this file together with code changes so status survives interruption.

## Active Task

_None — no pending task right now._

## History

- [x] 260804: Remove all mock data from the `messaging` app — status: finished
  - Done: removed `SEED` contacts, `PRODUCTS` catalogue, `OLDER_POOL`/`loadOlder` mock history, sample quick replies; `chatData()` now starts with an empty contact list; empty states added for products; bumped chat storage to `mc_chat_v2` (commit `f4d4fcb`)
- [x] 260804: Rewrite `messaging` app as luxury light theme + WhatsApp-Web layout + business features — status: finished
  - Done: light theme rewrite, two-column layout, rich messages, drawer, business views, kept connector/AI/live/biometric/i18n, manifest+SW updates, added `messaging/test/messaging.test.mjs` (commit `246554a`)
