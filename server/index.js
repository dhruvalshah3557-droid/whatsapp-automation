import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ftpList, ftpStore, ftpMkdirs } from "./ftp.js";
import { loadInventoryFromDisk, getInventory, getSyncStatus, syncSite } from "./site-sync.js";
import * as auth from "./auth.js";
import { startWa, waStatus, waLogout, waSend, setWaEventSink, waIsConnected } from "./wa.js";

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
const MEDIA_BASE_URL = String(env.MEDIA_BASE_URL || "https://media.colourdiamhk.com/image").trim().replace(/\/+$/, "");
const PRODUCT_CACHE_TTL = 10 * 60 * 1000;
let productsCache = { at: 0, list: [] };
let mediaFoldersCache = { at: 0, set: null };
const MEDIA_CONFIG_FILE = env.MEDIA_CONFIG_FILE || path.join(__dirname, "media-config.json");
let mediaConfig = loadMediaConfig();

function loadMediaConfig() {
  let file = {};
  try {
    if (fs.existsSync(MEDIA_CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MEDIA_CONFIG_FILE, "utf8"));
      if (parsed && typeof parsed === "object") file = parsed;
    }
  } catch (err) {
    console.error("could not load media-config.json:", err.message);
  }
  return {
    host: String(file.host || env.FTP_HOST || "").trim(),
    port: Number(file.port || env.FTP_PORT || 21),
    user: String(file.user || env.FTP_USER || "").trim(),
    pass: String(file.pass || env.FTP_PASS || ""),
    baseUrl: String(file.baseUrl || env.FTP_BASE_URL || "").trim().replace(/\/+$/, ""),
    remoteRoot: String(file.remoteRoot || env.FTP_REMOTE_ROOT || "").trim().replace(/^\/+|\/+$/g, ""),
  };
}

function saveMediaConfig(cfg) {
  mediaConfig = cfg;
  try {
    fs.writeFileSync(MEDIA_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error("could not save media-config.json:", err.message);
  }
}

function mediaConfigView(cfg, source) {
  return {
    configured: !!(cfg.host && cfg.user && cfg.pass),
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    hasPassword: !!cfg.pass,
    baseUrl: cfg.baseUrl,
    remoteRoot: cfg.remoteRoot,
    source,
  };
}

function productImgBase() {
  if (mediaConfig.baseUrl) return mediaConfig.baseUrl;
  return env.FTP_BASE_URL ? String(env.FTP_BASE_URL).trim().replace(/\/+$/, "") : "https://www.colourdiam.com";
}

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
  return { emoji: COLOUR_EMOJI[found] || "💎", bg: COLOUR_BG[found] || "#f3ead7", colorName: found || "white" };
}

function parseColourdiamCarat(name) {
  const m = name.match(/(\d+\.\d+)/);
  return m ? m[1] : "";
}

async function colourdiamMediaFolders() {
  const now = Date.now();
  if (mediaFoldersCache.set && now - mediaFoldersCache.at < PRODUCT_CACHE_TTL) {
    return mediaFoldersCache.set;
  }
  try {
    const res = await fetch(MEDIA_BASE_URL + "/", {
      headers: { "User-Agent": "colourdiam-messaging/1.0" },
    });
    if (!res.ok) throw new Error("media index HTTP " + res.status);
    const html = await res.text();
    const set = new Set(
      [...html.matchAll(/<a href="([^"]+)\/"[^>]*>([^<]*)\/?<\/a>/g)]
        .map((m) => decodeURIComponent(m[2] || m[1]).trim().replace(/\/+$/, ""))
        .filter(Boolean)
    );
    mediaFoldersCache = { at: now, set };
    return set;
  } catch (err) {
    mediaFoldersCache = { at: now, set: mediaFoldersCache.set || new Set() };
    return mediaFoldersCache.set;
  }
}

function colourdiamProductImg(p) {
  const real = (id) => id && !String(id).startsWith("/assets/");
  const cand = real(p.ImgPath)
    ? p.ImgPath
    : (Array.isArray(p.ImgPathList) ? p.ImgPathList.find(real) : null) || (real(p.ModelImgPath) ? p.ModelImgPath : null);
  return cand || null;
}

function colourdiamType(name, imgPath) {
  const p = String(imgPath || "");
  const n = String(name || "");
  if (/\/Product\/Jewellery\//i.test(p)) return "jewelry";
  if (/\b18K\b/i.test(n) || /\d+(\.\d+)?\s*gm\b/i.test(n)) return "jewelry";
  return "diamond";
}

function normalizeColourdiamProduct(p, folders) {
  const name = String(p.ProdName || "").trim();
  const meta = colourDiamondMeta(name);
  const carat = parseColourdiamCarat(name);
  const id = String(p.ProdId || p.TagNo || "cd-" + Math.random().toString(36).slice(2, 8));
  const feedPath = colourdiamProductImg(p);
  let img = null;
  if (folders && folders.has(id)) {
    img = MEDIA_BASE_URL + "/" + encodeURIComponent(id) + "/still.jpg";
  } else if (feedPath) {
    img = productImgBase() + feedPath;
  }
  return {
    id,
    name,
    type: colourdiamType(name, feedPath),
    category: (name.match(/Fancy\s+\w+/i) || [])[0] || "Diamond",
    carat,
    price: Number(p.NewPrice || p.OldPrice || 0),
    oldPrice: Number(p.OldPrice || 0),
    stock: "In stock",
    emoji: meta.emoji,
    color: meta.bg,
    colorName: meta.colorName,
    img,
  };
}

async function colourdiamSearch(pageIndex, pageCount) {
  const url = "https://www.colourdiam.com/Home/SearchProduct?SubMenuName=&FromHome=&PageIndex="
    + pageIndex + "&PageCount=" + pageCount + "&SortById=";
  const res = await fetch(url, {
    headers: { "User-Agent": "colourdiam-messaging/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error("ColourDiam API HTTP " + res.status);
  const data = await res.json();
  return Array.isArray(data.searchProductsList) ? data.searchProductsList : [];
}

async function fetchColourdiamProducts() {
  const now = Date.now();
  if (now - productsCache.at < PRODUCT_CACHE_TTL && productsCache.list.length) {
    return productsCache.list;
  }
  const PAGE_SIZE = 100;
  const raw = [];
  for (let page = 1; page <= 7; page++) {
    const batch = await colourdiamSearch(page, PAGE_SIZE);
    raw.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  const folders = await colourdiamMediaFolders();
  const list = raw.map((p) => normalizeColourdiamProduct(p, folders)).filter((p) => p.name);
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

const MEMORY_FILE = env.MEMORY_FILE || path.join(__dirname, "app-memory.json");
function loadAppMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const d = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
      return { data: (d && d.data) || {}, at: (d && d.at) || 0 };
    }
  } catch (err) {
    console.error("could not load app-memory.json:", err.message);
  }
  return { data: {}, at: 0 };
}

function saveAppMemory(data, at) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ data, at }));
  } catch (err) {
    console.error("could not save app-memory.json:", err.message);
  }
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

auth.initAuth();

server.listen(PORT, () => {
  const actualPort = server.address() && server.address().port ? server.address().port : PORT;
  console.log(`webhook server listening on port ${actualPort}`);
  const inv = loadInventoryFromDisk();
  const cached = inv.list.length;
  console.log(`site-sync: loaded ${cached} diamonds from inventory cache (status=${inv.status})`);
  if (env.SYNC_ON_START !== "0" && (!cached || Date.now() - (inv.at || 0) > 12 * 60 * 60 * 1000)) {
    console.log("site-sync: inventory missing or stale — starting background sync");
    syncSite({ enrich: true }).then((r) => {
      console.log(`site-sync: background sync done — ${r.list.length} diamonds (${r.enriched} enriched)`);
    }).catch((err) => {
      console.error("site-sync: background sync failed:", (err && err.message) || err);
    });
  }
  setWaEventSink((platform, from, text) => recordEvent(platform, from, text));
  if (env.WA_AUTO_START !== "0") {
    startWa().then((st) => {
      console.log(`wa: WhatsApp Web ${st.connected ? "connected" : "awaiting QR pairing"} (enabled)`);
    }).catch((err) => {
      console.error("wa: start failed:", (err && err.message) || err);
    });
  } else {
    console.log("wa: WhatsApp Web auto-start disabled (WA_AUTO_START=0)");
  }
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

function isAuthPath(path) {
  return path.startsWith("/api/auth/") ||
    path === "/api/tasks" || path.startsWith("/api/tasks/") ||
    path === "/api/activity" ||
    path.startsWith("/api/admin/");
}

function parseJsonBody(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch (err) { return null; }
}

async function handleAuthApi(req, res, url) {
  const raw = await readBody(req);
  const body = parseJsonBody(raw);
  const method = req.method;
  const p = url.pathname;
  const user = auth.sessionUser(req);
  const ip = auth.clientIp(req);

  if (p === "/api/auth/login" && method === "POST") {
    if (!body) return sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
    const result = auth.attemptLogin(body.email, body.password, ip);
    if (result.error) return sendJson(res, 401, { error: result.error }, corsHeaders());
    return sendJson(res, 200, result, corsHeaders());
  }

  if (p === "/api/auth/forgot" && method === "POST") {
    if (!body) return sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
    const result = auth.issueResetToken(body.email);
    if (result.error) return sendJson(res, 200, { ok: true }, corsHeaders());
    return sendJson(res, 200, result, corsHeaders());
  }

  if (p === "/api/auth/reset" && method === "POST") {
    if (!body) return sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
    const result = auth.consumeResetToken(body.email, body.token, body.newPassword);
    if (result.error) return sendJson(res, 400, { error: result.error }, corsHeaders());
    return sendJson(res, 200, result, corsHeaders());
  }

  if (!user) return sendJson(res, 401, { error: "Unauthorized — please log in" }, corsHeaders());

  if (p === "/api/auth/logout" && method === "POST") {
    const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    auth.destroySession(t);
    auth.auditLog(user.id, "logout", { ip });
    return sendJson(res, 200, { ok: true }, corsHeaders());
  }

  if (p === "/api/auth/me" && method === "GET") {
    return sendJson(res, 200, { user: auth.publicUser(user) }, corsHeaders());
  }

  if (p === "/api/auth/change-password" && method === "POST") {
    if (!body) return sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
    const result = auth.changePassword(user, body.oldPassword, body.newPassword);
    if (result.error) return sendJson(res, 400, { error: result.error }, corsHeaders());
    return sendJson(res, 200, result, corsHeaders());
  }

  if (p === "/api/activity" && method === "GET") {
    return sendJson(res, 200, { activity: auth.activityFor(user.id) }, corsHeaders());
  }

  if (p === "/api/tasks" && method === "GET") {
    const opts = {};
    if (url.searchParams.get("status")) opts.status = url.searchParams.get("status");
    if (auth.isAdmin(user) && url.searchParams.get("assignedTo")) opts.assignedTo = url.searchParams.get("assignedTo");
    return sendJson(res, 200, { tasks: auth.listTasks(user, opts) }, corsHeaders());
  }

  if (p === "/api/tasks" && method === "POST") {
    if (!body) return sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
    const result = auth.createTask(body, user);
    if (result.error) return sendJson(res, 400, { error: result.error }, corsHeaders());
    return sendJson(res, 201, result, corsHeaders());
  }

  const taskMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);
    if (method === "GET") {
      const result = auth.getTask(id, user);
      if (result.error) return sendJson(res, result.error === "not allowed" ? 403 : 404, { error: result.error }, corsHeaders());
      return sendJson(res, 200, result, corsHeaders());
    }
    if (method === "PATCH") {
      if (!body) return sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
      const result = auth.updateTask(id, body, user);
      if (result.error) return sendJson(res, result.error === "not allowed" ? 403 : 400, { error: result.error }, corsHeaders());
      return sendJson(res, 200, result, corsHeaders());
    }
    if (method === "DELETE") {
      const result = auth.deleteTask(id, user);
      if (result.error) return sendJson(res, result.error === "not allowed" ? 403 : 404, { error: result.error }, corsHeaders());
      return sendJson(res, 200, result, corsHeaders());
    }
  }

  if (!auth.isAdmin(user)) {
    return sendJson(res, 403, { error: "Admin access required" }, corsHeaders());
  }

  if (p === "/api/admin/users" && method === "GET") {
    const stats = auth.adminStats();
    return sendJson(res, 200, { users: stats.users, totals: stats.totals }, corsHeaders());
  }

  if (p === "/api/admin/users" && method === "POST") {
    if (!body) return sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
    const result = auth.createUser(body);
    if (result.error) return sendJson(res, 400, { error: result.error }, corsHeaders());
    auth.auditLog(user.id, "user_created", { email: result.user.email, role: result.user.role });
    return sendJson(res, 201, result, corsHeaders());
  }

  const userMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/action$/);
  if (userMatch && method === "POST") {
    if (!body) return sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
    const id = decodeURIComponent(userMatch[1]);
    let result;
    if (body.action === "activate") result = auth.setUserActive(id, true);
    else if (body.action === "suspend") result = auth.setUserActive(id, false);
    else if (body.action === "promote") result = auth.setUserRole(id, "admin");
    else if (body.action === "demote") result = auth.setUserRole(id, "user");
    else if (body.action === "reset") result = auth.resetUserPassword(id, body.password);
    else return sendJson(res, 400, { error: "unknown action" }, corsHeaders());
    if (result.error) return sendJson(res, 400, { error: result.error }, corsHeaders());
    auth.auditLog(user.id, "user_" + body.action, { email: result.user.email });
    return sendJson(res, 200, result, corsHeaders());
  }

  if (p === "/api/admin/stats" && method === "GET") {
    return sendJson(res, 200, auth.adminStats(), corsHeaders());
  }

  if (p === "/api/admin/report" && method === "GET") {
    return sendJson(res, 200, auth.adminReport(), corsHeaders());
  }

  if (p === "/api/admin/audit" && method === "GET") {
    const opts = {};
    if (url.searchParams.get("userId")) opts.userId = url.searchParams.get("userId");
    if (url.searchParams.get("action")) opts.action = url.searchParams.get("action");
    if (url.searchParams.get("limit")) opts.limit = Number(url.searchParams.get("limit"));
    return sendJson(res, 200, { audit: auth.adminAudit(opts) }, corsHeaders());
  }

  sendJson(res, 404, { error: "Not found" }, corsHeaders());
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (isAuthPath(url.pathname)) {
    await handleAuthApi(req, res, url);
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

  if (url.pathname === "/api/memory" && req.method === "GET") {
    const mem = loadAppMemory();
    sendJson(res, 200, { ok: true, memory: mem.data, at: mem.at }, corsHeaders());
    return;
  }

  if (url.pathname === "/api/memory" && req.method === "POST") {
    const raw = await readBody(req);
    const body = parseJsonBody(raw);
    if (!body || typeof body.data !== "object" || body.data === null) {
      sendJson(res, 400, { error: "Expected { data: {...} }" }, corsHeaders());
      return;
    }
    const at = Number(body.at) || Date.now();
    saveAppMemory(body.data, at);
    sendJson(res, 200, { ok: true, at }, corsHeaders());
    return;
  }

  if (url.pathname === "/api/products" && req.method === "GET") {
    const inv = getInventory();
    if (inv.list.length) {
      sendJson(res, 200, { products: inv.list, source: "inventory", count: inv.list.length, syncedAt: inv.at }, corsHeaders());
      return;
    }
    try {
      const products = await fetchColourdiamProducts();
      sendJson(res, 200, { products, source: "live" }, corsHeaders());
    } catch (err) {
      console.error("products fetch failed:", err.message);
      sendJson(res, 502, { error: "Could not load products from ColourDiam", detail: String((err && err.message) || err) }, corsHeaders());
    }
    return;
  }

  if (url.pathname === "/api/sync/site") {
    if (req.method === "GET") {
      sendJson(res, 200, getSyncStatus(), corsHeaders());
      return;
    }
    if (req.method === "POST") {
      const raw = await readBody(req);
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (err) { body = {}; }
      const enrich = body.enrich !== false;
      const now = getSyncStatus();
      if (now.running) {
        sendJson(res, 200, { ...now, message: "sync already in progress" }, corsHeaders());
        return;
      }
      syncSite({ enrich }).catch((err) => {
        console.error("site sync failed:", (err && err.message) || err);
      });
      sendJson(res, 202, { ...getSyncStatus(), message: `sync started (enrich=${enrich})` }, corsHeaders());
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" }, corsHeaders());
    return;
  }

  if (url.pathname === "/api/media/config" && req.method === "GET") {
    const source = fs.existsSync(MEDIA_CONFIG_FILE) ? "file" : (env.FTP_HOST || env.FTP_BASE_URL ? "env" : "none");
    sendJson(res, 200, mediaConfigView(mediaConfig, source), corsHeaders());
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

  if (url.pathname === "/api/media/config" && req.method === "POST") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
      return;
    }
    const next = {
      host: String(body.host || "").trim(),
      port: Number(body.port || 21),
      user: String(body.user || "").trim(),
      pass: String(body.pass || ""),
      baseUrl: String(body.baseUrl || "").trim().replace(/\/+$/, ""),
      remoteRoot: String(body.remoteRoot || "").trim().replace(/^\/+|\/+$/g, ""),
    };
    if (!next.pass) next.pass = mediaConfig.pass;
    saveMediaConfig(next);
    sendJson(res, 200, mediaConfigView(mediaConfig, "file"), corsHeaders());
    return;
  }

  if (url.pathname === "/api/media/test" && req.method === "POST") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
      return;
    }
    const result = await apiMediaTest(body);
    sendJson(res, result.status, result.body, corsHeaders());
    return;
  }

  if (url.pathname === "/api/media/list" && req.method === "GET") {
    const productId = String(url.searchParams.get("productId") || "");
    const result = await apiMediaList(productId);
    sendJson(res, result.status, result.body, corsHeaders());
    return;
  }

  if (url.pathname === "/api/media/upload" && req.method === "POST") {
    const result = await apiMediaUpload(req);
    sendJson(res, result.status, result.body, corsHeaders());
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

  if (url.pathname === "/api/track" && req.method === "POST") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
      return;
    }
    const result = await apiTrack(body);
    sendJson(res, result.status, result.body, corsHeaders());
    return;
  }

  if (url.pathname === "/api/wa/status" && req.method === "GET") {
    sendJson(res, 200, waStatus(), corsHeaders());
    return;
  }

  if (url.pathname === "/api/wa/start" && req.method === "POST") {
    const st = await startWa();
    sendJson(res, 200, st, corsHeaders());
    return;
  }

  if (url.pathname === "/api/wa/logout" && req.method === "POST") {
    const r = await waLogout();
    sendJson(res, 200, r, corsHeaders());
    return;
  }

  if (url.pathname === "/api/wa/send" && req.method === "POST") {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON" }, corsHeaders());
      return;
    }
    const result = await waSend(body.to, body.text);
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

async function apiTrack(body) {
  const { carrier, trackingNumber } = body || {};
  if (!carrier || !trackingNumber) {
    return { status: 400, body: { error: "carrier and trackingNumber are required" } };
  }
  try {
    if (carrier === "fedex") return await trackFedEx(trackingNumber);
    if (carrier === "dhl") return await trackDHL(trackingNumber);
    return { status: 400, body: { error: "Unsupported carrier (use fedex or dhl)" } };
  } catch (err) {
    return { status: 502, body: { error: "Tracking lookup failed: " + String((err && err.message) || err) } };
  }
}

async function trackFedEx(trackingNumber) {
  if (!env.FEDEX_API_KEY || !env.FEDEX_API_SECRET) {
    return { status: 400, body: { error: "FEDEX_API_KEY and FEDEX_API_SECRET env not set on the server" } };
  }
  const tokenRes = await fetch("https://apis.fedex.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(env.FEDEX_API_KEY)}&client_secret=${encodeURIComponent(env.FEDEX_API_SECRET)}`,
  });
  if (!tokenRes.ok) return { status: 502, body: { error: "FedEx auth failed: HTTP " + tokenRes.status } };
  const token = (await tokenRes.json()).access_token;
  const trackRes = await fetch("https://apis.fedex.com/track/v1/trackingnumbers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "X-locale": "en_US" },
    body: JSON.stringify({
      trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
      includeDetailedScans: true,
    }),
  });
  if (!trackRes.ok) return { status: 502, body: { error: "FedEx track failed: HTTP " + trackRes.status } };
  const data = await trackRes.json();
  const t = data.output && data.output.completeTrackResults && data.output.completeTrackResults[0]
    && data.output.completeTrackResults[0].trackResults && data.output.completeTrackResults[0].trackResults[0];
  if (!t) return { status: 404, body: { error: "No tracking data found" } };
  const detail = t.latestStatusDetail || {};
  const scans = t.scanEvents || [];
  const latest = scans[scans.length - 1] || null;
  const loc = latest && latest.scanLocation
    ? [latest.scanLocation.city, latest.scanLocation.countryName].filter(Boolean).join(", ")
    : "";
  return {
    status: 200,
    body: {
      carrier: "fedex",
      trackingNumber,
      status: detail.description || detail.statusByLocale || "Unknown",
      delivered: String(detail.code) === "DL",
      location: loc,
      scanCount: scans.length,
      lastScan: latest ? latest.scanDateTime : null,
    },
  };
}

async function trackDHL(trackingNumber) {
  if (!env.DHL_API_KEY) {
    return { status: 400, body: { error: "DHL_API_KEY env not set on the server" } };
  }
  const res = await fetch(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}`, {
    headers: { "DHL-API-Key": env.DHL_API_KEY },
  });
  if (!res.ok) return { status: 502, body: { error: "DHL track failed: HTTP " + res.status } };
  const data = await res.json();
  const shipment = data.shipments && data.shipments[0];
  if (!shipment) return { status: 404, body: { error: "No tracking data found" } };
  const events = shipment.events || [];
  const latest = events[events.length - 1] || null;
  const statusTxt = latest ? latest.description || latest.statusCode || "Unknown" : "Unknown";
  const loc = latest && latest.location
    ? (latest.location.address && latest.location.address.addressLocality) || latest.location.rawLocation || ""
    : "";
  return {
    status: 200,
    body: {
      carrier: "dhl",
      trackingNumber,
      status: statusTxt,
      delivered: /delivered/i.test(statusTxt),
      location: loc,
      scanCount: events.length,
      lastScan: latest ? latest.timestamp : null,
    },
  };
}

function sanitizeMediaName(name) {
  return String(name || "media.bin")
    .replace(/\\/g, "/")
    .split("/").pop()
    .replace(/^\s+|\s+$/g, "")
    .replace(/[\x00-\x1f<>:"|?*]/g, "")
    .slice(0, 120) || "media.bin";
}

function parseListEntry(line) {
  const m = String(line).match(/^([d-])[rwxStTs-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\d+\s+[\d:]+)\s+(.+)$/);
  if (!m) return null;
  return { dir: m[1] === "d", size: Number(m[2]), date: m[3], name: m[4] };
}

async function apiMediaTest(body) {
  const cfg = {
    host: String((body && body.host) || mediaConfig.host || "").trim(),
    port: Number((body && body.port) || mediaConfig.port || 21),
    user: String((body && body.user) || mediaConfig.user || "").trim(),
    pass: String((body && body.pass) || mediaConfig.pass || ""),
  };
  if (!cfg.host || !cfg.user || !cfg.pass) {
    return { status: 400, body: { error: "FTP not configured — set host, user and password" } };
  }
  try {
    const listing = await ftpList(cfg, "/");
    const entries = String(listing).split(/\r?\n/).filter(Boolean);
    return {
      status: 200,
      body: {
        ok: true,
        host: cfg.host,
        message: `Connected to ${cfg.host} (${entries.length} entries in /)`,
        entries: entries.slice(0, 20),
      },
    };
  } catch (err) {
    return { status: 502, body: { error: "FTP test failed: " + String((err && err.message) || err) } };
  }
}

let mediaListCache = { at: 0, key: "", data: null };

function mediaDirFiles(listing) {
  return String(listing)
    .split(/\r?\n/)
    .map(parseListEntry)
    .filter((f) => f && !f.dir && !f.name.startsWith("."));
}

async function mediaListFor(remoteDir) {
  const listing = await ftpList(mediaConfig, remoteDir || "/");
  return mediaDirFiles(listing).map((f) => ({
    name: f.name,
    size: f.size,
    url: [mediaConfig.baseUrl, remoteDir, f.name].filter(Boolean).join("/"),
  }));
}

async function apiMediaList(productId) {
  if (!mediaConfig.host || !mediaConfig.user || !mediaConfig.pass) {
    return { status: 400, body: { error: "FTP not configured on the server" } };
  }
  const batch = !productId;
  if (batch) {
    const cacheKey = mediaConfig.remoteRoot;
    if (mediaListCache.key === cacheKey && Date.now() - mediaListCache.at < 60_000 && mediaListCache.data) {
      return { status: 200, body: mediaListCache.data };
    }
    try {
      const root = await ftpList(mediaConfig, mediaConfig.remoteRoot || "/");
      const dirs = mediaDirFiles(root).filter((f) => f.dir);
      const media = {};
      for (const d of dirs) {
        const dir = [mediaConfig.remoteRoot, d.name].filter(Boolean).join("/");
        try {
          media[d.name] = await mediaListFor(dir);
        } catch (err) {
          media[d.name] = [];
        }
      }
      const data = { ok: true, media };
      mediaListCache = { at: Date.now(), key: cacheKey, data };
      return { status: 200, body: data };
    } catch (err) {
      return { status: 502, body: { error: "FTP listing failed: " + String((err && err.message) || err) } };
    }
  }
  const remoteDir = [mediaConfig.remoteRoot, productId].filter(Boolean).join("/") || "/";
  try {
    const items = await mediaListFor(remoteDir);
    return { status: 200, body: { ok: true, productId, files: items } };
  } catch (err) {
    return { status: 502, body: { error: "FTP listing failed: " + String((err && err.message) || err) } };
  }
}

function parseMultipart(raw, contentType) {
  const m = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (m && (m[1] || m[2])) || "";
  const delim = Buffer.from("--" + boundary);
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const parts = [];
  let pos = 0;
  for (;;) {
    const idx = buf.indexOf(delim, pos);
    if (idx === -1) break;
    let start = idx + delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const headerEnd = buf.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const bodyEnd = buf.indexOf(Buffer.from("\r\n" + delim), headerEnd + 4);
    if (bodyEnd === -1) break;
    const headers = {};
    for (const line of buf.slice(start, headerEnd).toString("utf8").split("\r\n")) {
      const ci = line.indexOf(":");
      if (ci !== -1) headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    }
    const disposition = headers["content-disposition"] || "";
    const name = (disposition.match(/name="([^"]*)"/) || [])[1] || "";
    const filename = (disposition.match(/filename="([^"]*)"/) || [])[1] || "";
    parts.push({ name, filename, type: headers["content-type"] || "", data: buf.slice(headerEnd + 4, bodyEnd) });
    pos = bodyEnd + 2 + delim.length;
  }
  return parts;
}

async function apiMediaUpload(req) {
  if (!mediaConfig.host || !mediaConfig.user || !mediaConfig.pass) {
    return { status: 400, body: { error: "FTP not configured on the server (save it via /api/media/config or set FTP_* env vars)" } };
  }
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return { status: 400, body: { error: "multipart/form-data is required" } };
  }
  const raw = await readBodyBuffer(req);
  const parts = parseMultipart(raw, contentType);
  const productId = String((parts.find((p) => p.name === "productId") || {}).data || "").trim();
  const files = parts.filter((p) => p.filename);
  if (!productId) return { status: 400, body: { error: "productId is required" } };
  if (!files.length) return { status: 400, body: { error: "no file provided" } };
  const uploaded = [];
  for (const f of files) {
    const name = sanitizeMediaName(f.filename);
    const remoteDir = [mediaConfig.remoteRoot, productId].filter(Boolean).join("/");
    const remotePath = [remoteDir, name].filter(Boolean).join("/");
    try {
      if (remoteDir) await ftpMkdirs(mediaConfig, remoteDir);
      await ftpStore(mediaConfig, remotePath, f.data);
    } catch (err) {
      return { status: 502, body: { error: "FTP upload failed: " + String((err && err.message) || err) } };
    }
    uploaded.push({
      name,
      path: remotePath,
      url: [mediaConfig.baseUrl, remoteDir, name].filter(Boolean).join("/"),
    });
  }
  return { status: 200, body: { ok: true, productId, files: uploaded } };
}

async function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
      case "whatsapp-web": {
        return waSend(to, text);
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      try {
        const copy = res.clone();
        console.error(`Graph API ${endpoint} failed:`, res.status, await copy.text());
      } catch (err) {}
    }
    return res;
  } catch (err) {
    console.error(`Graph API ${endpoint} error:`, (err && err.message) || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
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
