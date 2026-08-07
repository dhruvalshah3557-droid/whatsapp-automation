# Standalone webhook server (replaces n8n)

A single Node.js app that does everything the n8n workflows did, without n8n.
Runs on cPanel shared hosting via the **Node.js App** feature (Passenger).

Handles all six platforms:

| Platform | Route |
| --- | --- |
| WhatsApp Cloud API | `/webhook/whatsapp-hook` |
| Instagram Messenger | `/webhook/instagram-hook` |
| Facebook Messenger | `/webhook/facebook-hook` |
| TikTok Messenger | `/webhook/tiktok-hook` |
| LINE Official | `/webhook/line-hook` |
| WeChat Official Account | `/webhook/wechat-hook` |

Each route answers the platform's webhook verification and auto-replies to
inbound text messages by calling the platform API directly.

## Deploy on cPanel

### 1. Upload the files

Create a folder under `home/<user>/` (e.g. `messaging-webhooks`) and upload
everything inside `server/` (index.js, package.json, .env.example).

### 2. Create the Node.js app

1. cPanel → **Setup Node.js App**
2. Click **Create Application**
3. Node.js version: any 18+ (e.g. 20.x)
4. Application root: `messaging-webhooks`
5. Application URL: your chosen domain/subdomain
6. Application startup file: `index.js`
7. **Save**

### 3. Set the environment variables

1. In the app list, click **Edit** next to your app
2. Under **Environment variables**, add each value from `.env.example`:
   - `VERIFY_TOKEN`
   - `INSTAGRAM_ACCESS_TOKEN`
   - `FACEBOOK_PAGE_ACCESS_TOKEN`
   - `WHATSAPP_ACCESS_TOKEN`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `TIKTOK_ACCESS_TOKEN`
   - `WECHAT_TOKEN`
   (plus any `*_REPLY_TEXT` overrides)
3. Click **Save**, then **Restart** the app.

The app reads `PORT` automatically — cPanel/Passenger provides it, so you don't
need to set it.

### 4. Point each platform's webhook at the app

| Platform | Callback URL |
| --- | --- |
| Instagram | `https://YOUR-DOMAIN/webhook/instagram-hook` |
| Facebook Messenger | `https://YOUR-DOMAIN/webhook/facebook-hook` |
| WhatsApp Cloud API | `https://YOUR-DOMAIN/webhook/whatsapp-hook` |
| TikTok | `https://YOUR-DOMAIN/webhook/tiktok-hook` |
| LINE | `https://YOUR-DOMAIN/webhook/line-hook` |
| WeChat | `https://YOUR-DOMAIN/webhook/wechat-hook` |

Verify token for Meta apps: your `VERIFY_TOKEN`. For WeChat, `WECHAT_TOKEN` is
your WeChat server Token.

## Local development

```bash
cd server
cp .env.example .env   # fill in real values
npm install
npm start
```

### Colourdiam diamond inventory sync

The server keeps the full ColourDiam diamond catalogue (742 loose stones) synced
to `server/inventory.json` and serves it from memory through `/api/products`:

- **Startup** — loads the cached inventory from disk immediately, then starts a
  background re-sync when the cache is missing or older than 12 hours.
- **`GET /api/sync/site`** — returns sync status (`status`, `total`, `count`,
  `enriched`, `lastSync`).
- **`POST /api/sync/site`** — triggers a fresh sync (body `{"enrich":false}` for a
  list-only run). `GET /api/products` serves the memory cache in ~10ms and only
  falls back to the live colourdiam.com search when nothing is cached yet.
- Standalone CLI: `node site-sync.js --enrich` (full sync with detail-page specs),
  `node site-sync.js` (list only), `node site-sync.js --status`.

Each diamond is enriched from its `/diamonddetails/...` page with shape, clarity,
color grade, lab, polish, symmetry, fluorescence, measurements (L×W×D, depth%,
table%, ratio), certificate PDF, image gallery and HTTPS media URLs, all mapped to
the app's product model (`id`, `name`, `carat`, `price`, `colorName`, `img`, …).

Run the tests:

```bash
npm test
```
