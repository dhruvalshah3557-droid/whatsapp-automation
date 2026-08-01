# Meta Messaging Automation (n8n)

Automation workflows for n8n covering **WhatsApp (Cloud API)**, **Instagram Messenger**, **Facebook Messenger**, **TikTok Messenger**, **LINE Official** and **WeChat Official Account** — inbound webhook receive + instant auto-reply + broadcast sending.

## Workflows

| File | Purpose | Webhook path |
| --- | --- | --- |
| `workflows/whatsapp-webhook-reply.json` | Receive WhatsApp messages, auto-reply | `/webhook/whatsapp-hook` |
| `workflows/instagram-webhook-reply.json` | Receive Instagram DMs, auto-reply | `/webhook/instagram-hook` |
| `workflows/facebook-webhook-reply.json` | Receive Facebook Page messages, auto-reply | `/webhook/facebook-hook` |
| `workflows/tiktok-webhook-reply.json` | Receive TikTok messages, auto-reply | `/webhook/tiktok-hook` |
| `workflows/line-webhook-reply.json` | Receive LINE messages, auto-reply | `/webhook/line-hook` |
| `workflows/wechat-webhook-reply.json` | Receive WeChat messages, auto-reply | `/webhook/wechat-hook` |
| `workflows/whatsapp-broadcast.json` | Send a message to many recipients (manual trigger) | n/a |

Each inbound workflow contains two webhook nodes on the same path: a `GET` node that answers Meta's subscription verification (echos the `hub.challenge` when the verify token matches) and a `POST` node that receives events. TikTok uses a single `POST` webhook that echoes back `challenge_code` for verification and processes message events in the same request. LINE uses a single `POST` webhook (no GET verification). WeChat uses a `GET` webhook for the SHA1 `echostr` verification and a `POST` webhook that replies with passive XML messages.

## Connection wizard app

The `messaging/` folder contains a standalone web app (`messaging/index.html`) that walks you through connecting every platform:

- Enter your n8n URL, API key and verify token.
- Enter each platform's tokens (WhatsApp, Instagram, Facebook, TikTok, LINE, WeChat).
- It auto-builds the webhook URL for each platform (copy button) and shows per-platform setup steps.
- It generates a ready-to-use `.env` file (copy button) and shows the n8n import command.
- Config is saved locally in your browser — tokens never leave your device.

Open it by serving the `messaging/` folder or via GitHub Pages.

## Deploy to your n8n instance

1. Create an API key in n8n: **Settings -> API -> Create API key**.
2. Copy the env template and fill it in:

```bash
cp .env.example .env
```

3. Import the workflows:

```bash
export N8N_API_KEY=your_n8n_api_key
npm run import
```

Or import the JSON files manually from the n8n UI (**Workflows -> Add workflow -> Import from file**).

## Prerequisites on Meta side

You need a Meta Developer app with three products enabled:

1. **WhatsApp Cloud API** — get a test number, access token and Phone Number ID.
2. **Instagram Graph API** — a Business account connected to the app, token with `instagram_manage_messages`.
3. **Facebook Login / Messenger** — a Page with a Page access token with `pages_messaging`.

For **TikTok Messenger**, use the TikTok Developer Portal:

1. Create an app and enable the **Messaging API** product (approval required).
2. Generate a user access token with the `tiktok.business.messaging.write` scope.
3. Subscribe the `message` webhook event and point it at `/webhook/tiktok-hook`.

For **LINE Official**, use the LINE Developers console:

1. Create a provider/channel (Messaging API channel).
2. Set the webhook URL to `/webhook/line-hook` and generate a **Channel Access Token**.
3. Enable the webhook for the channel.

For **WeChat Official Account** (公众号):

1. Register a 服务号 (Service Account) and get the AppID/AppSecret.
2. In the platform console, configure the server URL `/webhook/wechat-hook` with a Token.
3. Enable the server config so WeChat can verify the URL (SHA1 challenge) and forward messages.

## Configure Meta webhooks

In each product's webhook settings, point the callback URL at your n8n webhook URL and set the same verify token (default `change_me_verify_token` — replace it everywhere).

| Platform | Callback URL | Fields to subscribe |
| --- | --- | --- |
| WhatsApp Cloud API | `https://YOUR_N8N_HOST/webhook/whatsapp-hook` | `messages` |
| Instagram | `https://YOUR_N8N_HOST/webhook/instagram-hook` | `messages` |
| Facebook Messenger | `https://YOUR_N8N_HOST/webhook/facebook-hook` | `messages` |
| TikTok Messenger | `https://YOUR_N8N_HOST/webhook/tiktok-hook` | `message` |
| LINE Official | `https://YOUR_N8N_HOST/webhook/line-hook` | n/a (all events) |
| WeChat Official | `https://YOUR_N8N_HOST/webhook/wechat-hook` | n/a (all message types) |

## Replace placeholder values

Before activating a workflow, replace the placeholders with real values:

- `change_me_verify_token` — verify token (appears in the `Check verify token` IF nodes)
- `change_me_whatsapp_token` — WhatsApp access token (Authorization headers)
- `change_me_instagram_token` — Instagram token (Authorization headers)
- `change_me_facebook_page_token` — Page access token (Authorization headers)
- `change_me_tiktok_token` — TikTok Messaging API token (Authorization header)
- `change_me_line_token` — LINE Channel Access Token (Authorization header)
- `change_me_wechat_token` — WeChat server Token (appears in the `Compute signature` Code node)
- `YOUR_PHONE_NUMBER_ID` — Phone Number ID in the broadcast workflow URL

Better practice: move these into n8n **HTTP Header Auth** credentials and reference them from each HTTP Request node.

## Flow overview

```
Meta platform  ->  n8n webhook (GET verify / POST events)
                    -> check object/field -> text message?
                         -> HTTP Request to Graph API -> reply sent
```

Note: Meta platforms only allow a reply **within 24 hours** of the user's last message (or a pre-approved message template). The broadcast workflow sends template-safe messages.

Note: TikTok's Messaging API payload shape (`data.sender.open_id`, `data.message`) follows the official Messaging API webhook format; if your instance delivers a slightly different structure, adjust the `Is inbound message` IF node and the reply `jsonBody` field paths.

Note: WeChat's passive reply XML must be returned within 5 seconds of the request (the `Build reply XML` Code node handles this directly in the webhook response). LINE replies via the Reply API must use `replyToken` from the inbound event.
