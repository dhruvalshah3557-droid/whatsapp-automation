# Easy deployment (free hosting)

The easiest way to run the whole stack without managing a server:

| Piece | Where it runs | URL |
| --- | --- | --- |
| Messaging app UI | GitHub Pages | `https://<user>.github.io/<repo>/messaging/` |
| Webhooks + auto-reply | Cloudflare Worker | `https://messaging-webhooks.<account-subdomain>.workers.dev` |

Both deploy automatically on every push to `main` — no manual steps after the one-time setup below.

## 1. One-time: enable GitHub Pages

1. Repo → **Settings → Pages**.
2. Source: **GitHub Actions**.
3. Push to `main` (or run the *Deploy Apps to GitHub Pages* workflow manually) — it serves:
   - Dashboard at `https://<user>.github.io/<repo>/`
   - Messaging app at `https://<user>.github.io/<repo>/messaging/`

## 2. One-time: set Cloudflare secrets in GitHub

1. Create an API token in Cloudflare → **My Profile → API Tokens** → *Edit Cloudflare Workers* template (or a token with `Workers Scripts:Edit`).
2. Repo → **Settings → Secrets and variables → Actions** and add:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard URL: `https://dash.cloudflare.com/<ACCOUNT_ID>`
3. Push to `main` (or run *Deploy Cloudflare Worker* manually) — the worker deploys to `messaging-webhooks` and you get `https://messaging-webhooks.<account-subdomain>.workers.dev`.

## 3. Set the platform secrets on the worker (once)

```bash
cd worker
npx wrangler secret put VERIFY_TOKEN
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
npx wrangler secret put FACEBOOK_PAGE_ACCESS_TOKEN
npx wrangler secret put TIKTOK_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put WECHAT_TOKEN
```

Optional reply-text overrides: `INSTAGRAM_REPLY_TEXT`, `FACEBOOK_REPLY_TEXT`,
`WHATSAPP_REPLY_TEXT`, `LINE_REPLY_TEXT`, `TIKTOK_REPLY_TEXT`, `WECHAT_REPLY_TEXT`.

> If your repo has multiple collaborators, `wrangler secret put` only works for
> people with the right Cloudflare permissions — do this once per environment.

## 4. Point the app at your URLs

Open `https://<user>.github.io/<repo>/messaging/` → **Marketplace** tab:

1. Set **Webhook Server URL** to your worker URL
   (`https://messaging-webhooks.<account-subdomain>.workers.dev`).
2. Set the verify token to the `VERIFY_TOKEN` you used in step 3.
3. Fill in each platform's tokens in **STEP 2**.
4. In each platform console, set the webhook callback URL to
   `https://messaging-webhooks.<account-subdomain>.workers.dev/webhook/<platform>-hook`.

## Alternative: standalone Node server

Prefer your own hosting? Deploy `server/` to any Node.js 18+ host (cPanel
**Node.js App**, Render, Railway, a VPS). It also exposes the live API
(`/api/health`, `/api/events`, `/api/send`) that the messaging app polls to
show inbound chats and reply in real time. See `server/README.md`.

## URLs summary

| App | GitHub Pages | `https://<user>.github.io/<repo>/messaging/` |
| --- | --- | --- |
| Dashboard | GitHub Pages | `https://<user>.github.io/<repo>/` |
| Webhook base | Cloudflare | `https://messaging-webhooks.<account-subdomain>.workers.dev` |
