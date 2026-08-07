# Serverless webhook server (replaces n8n)

A Cloudflare Worker that does everything the n8n workflows did, without n8n —
and serves the messaging app on the same origin so one URL is the whole product:

- **Messaging app** — serves `messaging/` at `/` (Chats + Connector views)
- **WhatsApp Cloud API** — `/webhook/whatsapp-hook`
- **Instagram Messenger** — `/webhook/instagram-hook`
- **Facebook Messenger** — `/webhook/facebook-hook`
- **TikTok Messenger** — `/webhook/tiktok-hook`
- **LINE Official** — `/webhook/line-hook`
- **WeChat Official Account** — `/webhook/wechat-hook`
- **Live API** — `/api/health`, `/api/events` (KV-backed), `/api/send`
- **Products** — `/api/products` proxies the live ColourDiam.com catalogue
  (list-only; `/api/sync/site` on this worker returns 501 — run the full
  742-diamond enriched sync on the standalone server instead)

Each route answers the platform's webhook verification and auto-replies to
inbound text messages by calling the platform API directly. Inbound messages
are stored in a Cloudflare KV namespace (`EVENTS`) and served back to the app
through `/api/events`.

## Deploy to Cloudflare

1. Install wrangler and log in:

```bash
cd worker
npm install -g wrangler
wrangler login
```

2. Set your secrets (one per platform; skip the ones you don't use):

```bash
wrangler secret put VERIFY_TOKEN
wrangler secret put INSTAGRAM_ACCESS_TOKEN
wrangler secret put FACEBOOK_PAGE_ACCESS_TOKEN
wrangler secret put WHATSAPP_ACCESS_TOKEN
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put TIKTOK_ACCESS_TOKEN
wrangler secret put WECHAT_TOKEN
```

Optional FTP media storage (drives the product-image rewrite in `/api/products`
via `FTP_BASE_URL`):

```bash
wrangler secret put FTP_HOST
wrangler secret put FTP_USER
wrangler secret put FTP_PASS
wrangler secret put FTP_BASE_URL   # public base for uploaded product photos
# optional: wrangler secret put FTP_PORT (default 21)
# optional: wrangler secret put FTP_REMOTE_ROOT (default empty)
```

3. Create the KV namespace (used by `/api/events`), then deploy:

```bash
wrangler kv namespace create EVENTS
# paste the returned id into wrangler.toml's [[kv_namespaces]] block
wrangler deploy
```

You get a URL like `https://messaging-webhooks.<your-subdomain>.workers.dev`.

4. Configure each platform's webhook to point at the worker:

| Platform | Callback URL |
| --- | --- |
| Instagram | `https://messaging-webhooks.<subdomain>.workers.dev/webhook/instagram-hook` |
| Facebook Messenger | `https://messaging-webhooks.<subdomain>.workers.dev/webhook/facebook-hook` |
| WhatsApp Cloud API | `https://messaging-webhooks.<subdomain>.workers.dev/webhook/whatsapp-hook` |
| TikTok | `https://messaging-webhooks.<subdomain>.workers.dev/webhook/tiktok-hook` |
| LINE | `https://messaging-webhooks.<subdomain>.workers.dev/webhook/line-hook` |
| WeChat | `https://messaging-webhooks.<subdomain>.workers.dev/webhook/wechat-hook` |

## Use the messaging app against the worker

Open `https://messaging-webhooks.<subdomain>.workers.dev/` in a browser. The
app auto-detects the current origin as the Server URL, so the Chats view polls
`/api/events` and replies go through `/api/send` on the same origin. No extra
configuration needed.

Verify token for Meta apps: the value you set for `VERIFY_TOKEN`. For WeChat,
the `WECHAT_TOKEN` is your WeChat server Token.

## Local development

```bash
cd worker
cp .dev.vars.example .dev.vars   # fill in real values
npm install
npm run dev
```

Run the tests:

```bash
npm test
```
