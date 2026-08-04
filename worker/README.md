# Serverless webhook server (replaces n8n)

A Cloudflare Worker that does everything the n8n workflows did, without n8n:

- **WhatsApp Cloud API** — `/webhook/whatsapp-hook`
- **Instagram Messenger** — `/webhook/instagram-hook`
- **Facebook Messenger** — `/webhook/facebook-hook`
- **TikTok Messenger** — `/webhook/tiktok-hook`
- **LINE Official** — `/webhook/line-hook`
- **WeChat Official Account** — `/webhook/wechat-hook`

Each route answers the platform's webhook verification and auto-replies to
inbound text messages by calling the platform API directly.

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

Optional: override the default reply texts:

```bash
wrangler secret put INSTAGRAM_REPLY_TEXT
wrangler secret put FACEBOOK_REPLY_TEXT
wrangler secret put WHATSAPP_REPLY_TEXT
wrangler secret put LINE_REPLY_TEXT
wrangler secret put TIKTOK_REPLY_TEXT
wrangler secret put WECHAT_REPLY_TEXT
```

3. Deploy:

```bash
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
