# Meta Messaging Automation (n8n)

Automation workflows for n8n covering **WhatsApp (Cloud API)**, **Instagram Messenger** and **Facebook Messenger** — inbound webhook receive + instant auto-reply + broadcast sending.

## Workflows

| File | Purpose | Webhook path |
| --- | --- | --- |
| `workflows/whatsapp-webhook-reply.json` | Receive WhatsApp messages, auto-reply | `/webhook/whatsapp-hook` |
| `workflows/instagram-webhook-reply.json` | Receive Instagram DMs, auto-reply | `/webhook/instagram-hook` |
| `workflows/facebook-webhook-reply.json` | Receive Facebook Page messages, auto-reply | `/webhook/facebook-hook` |
| `workflows/whatsapp-broadcast.json` | Send a message to many recipients (manual trigger) | n/a |

Each inbound workflow contains two webhook nodes on the same path: a `GET` node that answers Meta's subscription verification (echos the `hub.challenge` when the verify token matches) and a `POST` node that receives events.

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

## Configure Meta webhooks

In each product's webhook settings, point the callback URL at your n8n webhook URL and set the same verify token (default `change_me_verify_token` — replace it everywhere).

| Platform | Callback URL | Fields to subscribe |
| --- | --- | --- |
| WhatsApp Cloud API | `https://YOUR_N8N_HOST/webhook/whatsapp-hook` | `messages` |
| Instagram | `https://YOUR_N8N_HOST/webhook/instagram-hook` | `messages` |
| Facebook Messenger | `https://YOUR_N8N_HOST/webhook/facebook-hook` | `messages` |

## Replace placeholder values

Before activating a workflow, replace the placeholders with real values:

- `change_me_verify_token` — verify token (appears in the `Check verify token` IF nodes)
- `change_me_whatsapp_token` — WhatsApp access token (Authorization headers)
- `change_me_instagram_token` — Instagram token (Authorization headers)
- `change_me_facebook_page_token` — Page access token (Authorization headers)
- `YOUR_PHONE_NUMBER_ID` — Phone Number ID in the broadcast workflow URL

Better practice: move these into n8n **HTTP Header Auth** credentials and reference them from each HTTP Request node.

## Flow overview

```
Meta platform  ->  n8n webhook (GET verify / POST events)
                    -> check object/field -> text message?
                         -> HTTP Request to Graph API -> reply sent
```

Note: Meta platforms only allow a reply **within 24 hours** of the user's last message (or a pre-approved message template). The broadcast workflow sends template-safe messages.
