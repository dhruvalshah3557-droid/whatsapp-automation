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

const STATIC_ROOT = env.STATIC_ROOT || path.join(__dirname, "..", "messaging");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

const EVENTS_FILE = env.EVENTS_FILE || path.join(__dirname, "events.json");
const MAX_EVENTS = 200;
let events = loadEvents();

const COLOURDIAM_SEARCH = "https://www.colourdiam.com/Home/SearchProduct?SubMenuName=&FromHome=&PageIndex=1&PageCount=100&SortById=";
const PRODUCT_CACHE_TTL = 10 * 60 * 1000;
let productsCache = { at: 0, list: [] };

const COLOUR_EMOJI = {
  yellow: "💛", green: "💚", pink: "💗", blue: "💙", brown: "🤎", white: "🤍",
  gray: "🩶", grey: "🩶", orange: "🧡", red: "❤️", violet: "💜", purple: "💜",
  black: "🖤",
};
const COLOUR_BG = {
  yellow: "#f7e08a", green: "#cde8c4", pink: "#f5d7de", blue: "#cfdff5", brown: "#d9c5a8",
  white: "#eceae4", gray: "#d9d9d9", grey: "#d9d9d9", orange: "#fbe0c0", red: "#f2c3c3",
  violet: "#ddd2ef", purple: "#ddd2ef", black: "#c9c9c9",
};

function colourDiamondMeta(name) {
  const lower = name.toLowerCase();
  let found = "";
  for (const key of Object.keys(COLOUR_EMOJI)) {
    if (lower.includes(key)) { found = key; break; }
  }
  return { emoji: COLOUR_EMOJI[found] || "💎", bg: COLOUR_BG[found] || "#f3ead7" };
}

function parseColourdiamCarat(name) {
  const m = name.match(/(\d+\.\d+)/);
  return m ? m[1] : "";
}

function normalizeColourdiamProduct(p) {
  const name = String(p.ProdName || "").trim();
  const meta = colourDiamondMeta(name);
  const carat = parseColourdiamCarat(name);
  return {
    id: String(p.ProdId || p.TagNo || "cd-" + Math.random().toString(36).slice(2, 8)),
    name,
    category: (name.match(/Fancy\s+\w+/i) || [])[0] || "Diamond",
    carat,
    price: Number(p.NewPrice || p.OldPrice || 0),
    oldPrice: Number(p.OldPrice || 0),
    stock: "In stock",
    emoji: meta.emoji,
    color: meta.bg,
    img: p.ImgPath ? "https://www.colourdiam.com" + p.ImgPath : null,
  };
}

async function fetchColourdiamProducts() {
  const now = Date.now();
  if (now - productsCache.at < PRODUCT_CACHE_TTL && productsCache.list.length) {
    return productsCache.list;
  }
  const res = await fetch(COLOURDIAM_SEARCH, {
    headers: { "User-Agent": "colourdiam-messaging/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error("ColourDiam API HTTP " + res.status);
  const data = await res.json();
  const raw = Array.isArray(data.searchProductsList) ? data.searchProductsList : [];
  const list = raw.map(normalizeColourdiamProduct).filter((p) => p.name);
  productsCache = { at: now, list };
  return list;
}

function loadEvents() {
  try {
    if (fs.existsSync(EVENTS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"));
      return Array.isArray(arr) ? arr : [];
    }
  } catch (err) {
    console.error("could not load events.json:", err.message);
  }
  return [];
}

function saveEvents() {
  try {
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
  } catch (err) {
    console.error("could not save events.json:", err.message);
  }
}

function recordEvent(platform, from, text) {
  const id = events.length ? events[events.length - 1].id + 1 : 1;
  events.push({ id, platform, from, text, time: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  saveEvents();
}

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
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }
  const route = matchRoute(url.pathname);
  if (!route) {
    await serveStatic(req, res, url);
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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function requireAuth(req) {
  if (!env.API_KEY) return true;
  const header = req.headers.authorization || "";
  return header === "Bearer " + env.API_KEY;
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      name: "messaging-webhooks",
      events: events.length,
      ai: !!(env.USER_LLM_BASE_URL && env.USER_LLM_API_KEY),
    }, corsHeaders());
    return;
  }

  if (url.pathname === "/api/products" && req.method === "GET") {
    try {
      const products = await fetchColourdiamProducts();
      sendJson(res, 200, { products }, corsHeaders());
    } catch (err) {
      console.error("products fetch failed:", err.message);
      sendJson(res, 502, { error: "Could not load products from ColourDiam", detail: String((err && err.message) || err) }, corsHeaders());
    }
    return;
  }

  if (url.pathname === "/api/llm" && req.method === "POST") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
      return;
    }
    const result = await apiLlm(body);
    sendJson(res, result.status, result.body, corsHeaders());
    return;
  }

  if (!requireAuth(req)) {
    sendJson(res, 401, { error: "Unauthorized" }, corsHeaders());
    return;
  }

  if (url.pathname === "/api/events" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const platform = url.searchParams.get("platform");
    const list = events.filter((e) => e.id > since && (!platform || e.platform === platform));
    sendJson(res, 200, { events: list }, corsHeaders());
    return;
  }

  if (url.pathname === "/api/send" && req.method === "POST") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
      return;
    }
    const result = await apiSend(body);
    sendJson(res, result.status, result.body, corsHeaders());
    return;
  }

  sendJson(res, 404, { error: "Not found" }, corsHeaders());
}

async function apiLlm(body) {
  const base = (env.USER_LLM_BASE_URL || "").replace(/\/+$/, "");
  const key = env.USER_LLM_API_KEY || "";
  const model = env.USER_LLM_MODEL || "gpt-4o-mini";
  if (!base || !key) {
    return { status: 501, body: { error: "AI not configured on the server (set USER_LLM_BASE_URL / USER_LLM_API_KEY)" } };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const endpoint = /\/chat\/completions$/i.test(base) ? base : base + "/chat/completions";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: body.model || model, messages, temperature: typeof body.temperature === "number" ? body.temperature : 0.4 }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { status: 502, body: { error: "LLM API error " + res.status, detail } };
  }
  const data = await res.json();
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  return { status: 200, body: { text } };
}

async function apiSend(body) {
  const { platform, to, text } = body || {};
  if (!platform || !to || !text) {
    return { status: 400, body: { error: "platform, to and text are required" } };
  }
  try {
    let res;
    switch (platform) {
      case "whatsapp": {
        const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
        if (!phoneNumberId) return { status: 400, body: { error: "WHATSAPP_PHONE_NUMBER_ID env not set on the server" } };
        res = await postGraph(`${phoneNumberId}/messages`, env.WHATSAPP_ACCESS_TOKEN, {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        });
        break;
      }
      case "instagram": {
        const senderId = env.INSTAGRAM_SENDER_ID;
        if (!senderId) return { status: 400, body: { error: "INSTAGRAM_SENDER_ID env not set on the server" } };
        res = await postGraph(`${senderId}/messages`, env.INSTAGRAM_ACCESS_TOKEN, {
          recipient: { id: to },
          message: { text },
          message_type: "RESPONSE",
        });
        break;
      }
      case "facebook": {
        res = await postGraph("me/messages", env.FACEBOOK_PAGE_ACCESS_TOKEN, {
          recipient: { id: to },
          message: { text },
        });
        break;
      }
      case "tiktok": {
        res = await fetch("https://open.tiktokapis.com/v2/message/send/", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TIKTOK_ACCESS_TOKEN}` },
          body: JSON.stringify({ message_type: "text", text, recipient: { open_id: to } }),
        });
        break;
      }
      case "line": {
        res = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
          body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
        });
        break;
      }
      case "wechat":
        return { status: 501, body: { error: "WeChat sending via /api/send is not supported yet (use passive XML replies)" } };
      default:
        return { status: 400, body: { error: "Unknown platform" } };
    }
    if (!res.ok) {
      return { status: 502, body: { error: "Platform API rejected the message", detail: await res.text() } };
    }
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: String((err && err.message) || err) } };
  }
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
      recordEvent("instagram", messaging.sender.id, msg.text);
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
      recordEvent("facebook", messaging.sender.id, msg.text);
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
      recordEvent("whatsapp", message.from, (message.text && message.text.body) || "");
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
      recordEvent("line", (event.source && event.source.userId) || "", event.message.text);
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
      const text = typeof message === "string" ? message : (message && message.text) || "";
      if (text) recordEvent("tiktok", sender.open_id, text);
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
    recordEvent("wechat", parsed.from, parsed.content);
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
    try {
      const copy = res.clone();
      console.error(`Graph API ${endpoint} failed:`, res.status, await copy.text());
    } catch (err) {}
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

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (err) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }
  if (rel === "/") rel = "/index.html";
  const filePath = path.normalize(path.join(STATIC_ROOT, rel));
  if (!filePath.startsWith(STATIC_ROOT)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  let target = filePath;
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) target = path.join(target, "index.html");
  } catch (err) {}
  try {
    const data = fs.readFileSync(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (err) {
    sendJson(res, 404, { error: "Not found" });
  }
}

function sendJson(res, status, obj, extraHeaders) {
  sendRaw(res, status, JSON.stringify(obj), "application/json", extraHeaders);
}

function sendRaw(res, status, body, contentType, extraHeaders) {
  res.writeHead(status, { "Content-Type": contentType || "text/plain", ...extraHeaders });
  res.end(body ?? "");
}

function jsonOk() {
  return { status: 200, body: "{}", contentType: "application/json" };
}
