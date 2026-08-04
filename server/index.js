import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

const env = process.env;
const PORT = env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    console.error("handler error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`webhook server listening on port ${PORT}`);
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = matchRoute(url.pathname);
  if (!route) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (req.method === "GET" && route.verify) {
    const result = await route.verify(url);
    sendRaw(res, result.status, result.body, result.contentType);
    return;
  }

  if (req.method === "POST" && route.receive) {
    const raw = await readBody(req);
    const result = await route.receive(raw, url);
    sendRaw(res, result.status, result.body, result.contentType);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

function matchRoute(path) {
  const routes = {
    "/webhook/instagram-hook": "instagram",
    "/webhook/facebook-hook": "facebook",
    "/webhook/whatsapp-hook": "whatsapp",
    "/webhook/line-hook": "line",
    "/webhook/tiktok-hook": "tiktok",
    "/webhook/wechat-hook": "wechat",
  };
  const key = routes[path];
  if (!key) return null;
  return {
    verify: key === "wechat" ? verifyWeChat : verifyMeta,
    receive: handlers[key],
  };
}

function verifyMeta(url) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = env.VERIFY_TOKEN || env.META_VERIFY_TOKEN;
  if (mode === "subscribe" && token === verifyToken) {
    return { status: 200, body: challenge, contentType: "text/plain" };
  }
  return { status: 403, body: "Verification failed", contentType: "text/plain" };
}

function verifyWeChat(url) {
  const signature = url.searchParams.get("signature");
  const timestamp = url.searchParams.get("timestamp");
  const nonce = url.searchParams.get("nonce");
  const echostr = url.searchParams.get("echostr");
  const sha1 = crypto
    .createHash("sha1")
    .update([env.WECHAT_TOKEN, timestamp, nonce].sort().join(""))
    .digest("hex");
  if (sha1 === signature) {
    return { status: 200, body: echostr, contentType: "text/plain" };
  }
  return { status: 403, body: "verification failed", contentType: "text/plain" };
}

const handlers = {
  instagram: async (raw) => {
    const body = JSON.parse(raw);
    const entry = body.entry && body.entry[0];
    const messaging = entry && entry.messaging && entry.messaging[0];
    const msg = messaging && messaging.message;
    if (msg && !msg.is_echo && msg.text) {
      await postGraph(
        `${entry.id}/messages`,
        env.INSTAGRAM_ACCESS_TOKEN,
        {
          recipient: { id: messaging.sender.id },
          message: { text: env.INSTAGRAM_REPLY_TEXT || "Thanks for your Instagram message!" },
          message_type: "RESPONSE",
        }
      );
    }
    return jsonOk();
  },

  facebook: async (raw) => {
    const body = JSON.parse(raw);
    const entry = body.entry && body.entry[0];
    const messaging = entry && entry.messaging && entry.messaging[0];
    const msg = messaging && messaging.message;
    if (msg && !msg.is_echo && msg.text) {
      await postGraph(
        "me/messages",
        env.FACEBOOK_PAGE_ACCESS_TOKEN,
        {
          recipient: { id: messaging.sender.id },
          message: { text: env.FACEBOOK_REPLY_TEXT || "Thanks for your Facebook message!" },
        }
      );
    }
    return jsonOk();
  },

  whatsapp: async (raw) => {
    const body = JSON.parse(raw);
    const entry = body.entry && body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const messages = value && value.messages;
    const inbound = messages && messages.filter((m) => m.type === "text");
    if (inbound && inbound.length > 0) {
      const message = inbound[0];
      await postGraph(
        `${value.metadata.phone_number_id}/messages`,
        env.WHATSAPP_ACCESS_TOKEN,
        {
          messaging_product: "whatsapp",
          to: message.from,
          type: "text",
          text: { body: env.WHATSAPP_REPLY_TEXT || "Thanks for your message! This is an automated reply from your WhatsApp bot." },
        }
      );
    }
    return jsonOk();
  },

  line: async (raw) => {
    const body = JSON.parse(raw);
    const event = (body.events || []).find(
      (e) => e.type === "message" && e.message.type === "text" && e.replyToken
    );
    if (event) {
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: env.LINE_REPLY_TEXT || "Thanks for your LINE message!" }],
        }),
      });
    }
    return jsonOk();
  },

  tiktok: async (raw) => {
    const body = JSON.parse(raw);
    if (body.challenge_code) {
      return { status: 200, body: JSON.stringify({ challenge_code: body.challenge_code }), contentType: "application/json" };
    }
    const message = body.data && body.data.message;
    const sender = body.data && body.data.sender;
    if (message && sender) {
      await fetch("https://open.tiktokapis.com/v2/message/send/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.TIKTOK_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          message_type: "text",
          text: env.TIKTOK_REPLY_TEXT || "Thanks for your TikTok message!",
          recipient: { open_id: sender.open_id },
        }),
      });
    }
    return jsonOk();
  },

  wechat: async (raw) => {
    const parsed = parseWeChatXml(raw);
    if (parsed.msgType !== "text") {
      return { status: 200, body: "success", contentType: "text/plain" };
    }
    const reply =
      "<xml>" +
      "<ToUserName><![CDATA[" + parsed.from + "]]></ToUserName>" +
      "<FromUserName><![CDATA[" + parsed.to + "]]></FromUserName>" +
      "<CreateTime>" + Math.floor(Date.now() / 1000) + "</CreateTime>" +
      "<MsgType><![CDATA[text]]></MsgType>" +
      "<Content><![CDATA[" + (env.WECHAT_REPLY_TEXT || "Thanks for your WeChat message!") + "]]></Content>" +
      "</xml>";
    return { status: 200, body: reply, contentType: "application/xml" };
  },
};

function parseWeChatXml(xml) {
  function get(tag) {
    const cdata = xml.match(new RegExp("<" + tag + "><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></" + tag + ">"));
    if (cdata) return cdata[1];
    const plain = xml.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
    return plain ? plain[1] : "";
  }
  return {
    to: get("ToUserName"),
    from: get("FromUserName"),
    msgType: get("MsgType"),
    content: get("Content"),
  };
}

async function postGraph(endpoint, token, payload) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`Graph API ${endpoint} failed:`, res.status, await res.text());
  }
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  sendRaw(res, status, JSON.stringify(obj), "application/json");
}

function sendRaw(res, status, body, contentType) {
  res.writeHead(status, { "Content-Type": contentType || "text/plain" });
  res.end(body ?? "");
}

function jsonOk() {
  return { status: 200, body: "{}", contentType: "application/json" };
}
