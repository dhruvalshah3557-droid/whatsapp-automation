import * as auth from "./auth.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      return handleApi(request, url, env, ctx);
    }

    const route = matchRoute(path);
    if (route) {
      if (request.method === "GET" && route.verify) {
        return route.verify(request, url, env);
      }
      if (request.method === "POST" && route.receive) {
        return route.receive(request, url, env, ctx);
      }
      return new Response("Method not allowed", { status: 405 });
    }

    // Serve the messaging app static assets on the same origin.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function isAuthPath(path) {
  return path.startsWith("/api/auth/") ||
    path === "/api/tasks" || path.startsWith("/api/tasks/") ||
    path === "/api/activity" ||
    path.startsWith("/api/admin/");
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch (err) {
    return null;
  }
}

function requireAuth(request, env) {
  if (!env.API_KEY) return true;
  const header = request.headers.get("authorization") || "";
  return header === "Bearer " + env.API_KEY;
}

async function handleAuthApi(request, url, env) {
  const body = await readJsonBody(request);
  const method = request.method;
  const p = url.pathname;
  await auth.ensureBootstrap(env);
  const user = await auth.sessionUser(request, env);
  const ip = auth.clientIp(request);

  if (p === "/api/auth/login" && method === "POST") {
    if (!body) return json({ error: "Invalid JSON" }, 400, cors());
    const result = await auth.attemptLogin(env, body.email, body.password, ip);
    if (result.error) return json({ error: result.error }, 401, cors());
    return json(result, 200, cors());
  }

  if (p === "/api/auth/forgot" && method === "POST") {
    if (!body) return json({ error: "Invalid JSON" }, 400, cors());
    const result = await auth.issueResetToken(env, body.email);
    if (result.error) return json({ ok: true }, 200, cors());
    return json(result, 200, cors());
  }

  if (p === "/api/auth/reset" && method === "POST") {
    if (!body) return json({ error: "Invalid JSON" }, 400, cors());
    const result = await auth.consumeResetToken(env, body.email, body.token, body.newPassword);
    if (result.error) return json({ error: result.error }, 400, cors());
    return json(result, 200, cors());
  }

  if (!user) return json({ error: "Unauthorized — please log in" }, 401, cors());

  if (p === "/api/auth/logout" && method === "POST") {
    const t = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    await auth.destroySession(env, t);
    await auth.auditLog(env, user.id, "logout", { ip });
    return json({ ok: true }, 200, cors());
  }

  if (p === "/api/auth/me" && method === "GET") {
    return json({ user: auth.publicUser(user) }, 200, cors());
  }

  if (p === "/api/auth/change-password" && method === "POST") {
    if (!body) return json({ error: "Invalid JSON" }, 400, cors());
    const result = await auth.changePassword(env, user, body.oldPassword, body.newPassword);
    if (result.error) return json({ error: result.error }, 400, cors());
    return json(result, 200, cors());
  }

  if (p === "/api/activity" && method === "GET") {
    return json({ activity: await auth.activityFor(env, user.id) }, 200, cors());
  }

  if (p === "/api/tasks" && method === "GET") {
    const opts = {};
    if (url.searchParams.get("status")) opts.status = url.searchParams.get("status");
    if (auth.isAdmin(user) && url.searchParams.get("assignedTo")) opts.assignedTo = url.searchParams.get("assignedTo");
    return json({ tasks: await auth.listTasks(env, user, opts) }, 200, cors());
  }

  if (p === "/api/tasks" && method === "POST") {
    if (!body) return json({ error: "Invalid JSON" }, 400, cors());
    const result = await auth.createTask(env, body, user);
    if (result.error) return json({ error: result.error }, 400, cors());
    return json(result, 201, cors());
  }

  const taskMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);
    if (method === "GET") {
      const result = await auth.getTask(env, id, user);
      if (result.error) return json({ error: result.error }, result.error === "not allowed" ? 403 : 404, cors());
      return json(result, 200, cors());
    }
    if (method === "PATCH") {
      if (!body) return json({ error: "Invalid JSON" }, 400, cors());
      const result = await auth.updateTask(env, id, body, user);
      if (result.error) return json({ error: result.error }, result.error === "not allowed" ? 403 : 400, cors());
      return json(result, 200, cors());
    }
    if (method === "DELETE") {
      const result = await auth.deleteTask(env, id, user);
      if (result.error) return json({ error: result.error }, result.error === "not allowed" ? 403 : 404, cors());
      return json(result, 200, cors());
    }
  }

  if (!auth.isAdmin(user)) {
    return json({ error: "Admin access required" }, 403, cors());
  }

  if (p === "/api/admin/users" && method === "GET") {
    const stats = await auth.adminStats(env);
    return json({ users: stats.users, totals: stats.totals }, 200, cors());
  }

  if (p === "/api/admin/users" && method === "POST") {
    if (!body) return json({ error: "Invalid JSON" }, 400, cors());
    const result = await auth.createUser(env, body);
    if (result.error) return json({ error: result.error }, 400, cors());
    await auth.auditLog(env, user.id, "user_created", { email: result.user.email, role: result.user.role });
    return json(result, 201, cors());
  }

  const userMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/action$/);
  if (userMatch && method === "POST") {
    if (!body) return json({ error: "Invalid JSON" }, 400, cors());
    const id = decodeURIComponent(userMatch[1]);
    let result;
    if (body.action === "activate") result = await auth.setUserActive(env, id, true);
    else if (body.action === "suspend") result = await auth.setUserActive(env, id, false);
    else if (body.action === "promote") result = await auth.setUserRole(env, id, "admin");
    else if (body.action === "demote") result = await auth.setUserRole(env, id, "user");
    else if (body.action === "reset") result = await auth.resetUserPassword(env, id, body.password);
    else return json({ error: "unknown action" }, 400, cors());
    if (result.error) return json({ error: result.error }, 400, cors());
    await auth.auditLog(env, user.id, "user_" + body.action, { email: result.user.email });
    return json(result, 200, cors());
  }

  if (p === "/api/admin/stats" && method === "GET") {
    return json(await auth.adminStats(env), 200, cors());
  }

  if (p === "/api/admin/report" && method === "GET") {
    return json(await auth.adminReport(env), 200, cors());
  }

  if (p === "/api/admin/audit" && method === "GET") {
    const opts = {};
    if (url.searchParams.get("userId")) opts.userId = url.searchParams.get("userId");
    if (url.searchParams.get("action")) opts.action = url.searchParams.get("action");
    if (url.searchParams.get("limit")) opts.limit = Number(url.searchParams.get("limit"));
    return json({ audit: await auth.adminAudit(env, opts) }, 200, cors());
  }

  return json({ error: "Not found" }, 404, cors());
}

async function handleApi(request, url, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  if (isAuthPath(url.pathname)) {
    return handleAuthApi(request, url, env);
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    const count = await eventCount(env);
    return json({ ok: true, name: "messaging-webhooks", events: count, ai: !!(env.USER_LLM_BASE_URL && env.USER_LLM_API_KEY) }, 200, cors());
  }

  if (url.pathname === "/api/memory" && request.method === "GET") {
    const mem = await getMemory(env);
    return json({ ok: true, memory: mem.data, at: mem.at }, 200, cors());
  }

  if (url.pathname === "/api/memory" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json({ error: "Invalid JSON" }, 400, cors());
    }
    if (!body || typeof body.data !== "object" || body.data === null) {
      return json({ error: "Expected { data: {...} }" }, 400, cors());
    }
    const at = Number(body.at) || Date.now();
    await putMemory(env, body.data, at);
    return json({ ok: true, at }, 200, cors());
  }

  if (url.pathname === "/api/products" && request.method === "GET") {
    try {
      const products = await fetchColourdiamProducts(env);
      return json({ products, source: "live" }, 200, cors());
    } catch (err) {
      return json({ error: "Could not load products from ColourDiam", detail: String((err && err.message) || err) }, 502, cors());
    }
  }

  if (url.pathname === "/api/sync/site") {
    return json({
      error: "Full site sync (742-diamond inventory) runs on the standalone server — it caches to local JSON and serves from memory",
      hint: "Point the app's Server URL at the standalone server and POST /api/sync/site there",
    }, 501, cors());
  }

  if (url.pathname === "/api/media/config") {
    const pass = env.FTP_PASS || "";
    const cfg = {
      configured: !!(env.FTP_HOST && env.FTP_USER && pass),
      host: env.FTP_HOST || "",
      port: Number(env.FTP_PORT || 21),
      user: env.FTP_USER || "",
      hasPassword: !!pass,
      baseUrl: (env.FTP_BASE_URL || "").trim().replace(/\/+$/, ""),
      remoteRoot: (env.FTP_REMOTE_ROOT || "").trim().replace(/^\/+|\/+$/g, ""),
      source: "env",
    };
    if (request.method === "GET") {
      return json(cfg, 200, cors());
    }
    return json({
      error: "FTP config is set via worker secrets/env on Cloudflare — save it with the standalone server instead",
      configured: cfg.configured,
    }, 501, cors());
  }

  if (url.pathname === "/api/media/list") {
    return json({
      error: "FTP media listing is only available on the standalone server — point the app's Server URL at it to see product media",
    }, 501, cors());
  }

  if (url.pathname === "/api/llm" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json({ error: "Invalid JSON" }, 400, cors());
    }
    const result = await apiLlm(body, env);
    return json(result.body, result.status, cors());
  }

  if (!requireAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401, cors());
  }

  if (url.pathname === "/api/events" && request.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const platform = url.searchParams.get("platform");
    const all = await getEvents(env);
    const list = all.filter((e) => e.id > since && (!platform || e.platform === platform));
    return json({ events: list }, 200, cors());
  }

  if (url.pathname === "/api/send" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json({ error: "Invalid JSON" }, 400, cors());
    }
    const result = await apiSend(body, env);
    return json(result.body, result.status, cors());
  }

  if (url.pathname === "/api/track" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json({ error: "Invalid JSON" }, 400, cors());
    }
    const result = await apiTrack(body, env);
    return json(result.body, result.status, cors());
  }

  return json({ error: "Not found" }, 404, cors());
}

const EVENTS_KEY = "events";
const MEMORY_KEY = "app-memory";

async function getMemory(env) {
  if (!env.EVENTS) return { data: {}, at: 0 };
  try {
    const raw = await env.EVENTS.get(MEMORY_KEY, { type: "text" });
    if (!raw) return { data: {}, at: 0 };
    const d = JSON.parse(raw);
    return { data: (d && d.data) || {}, at: (d && d.at) || 0 };
  } catch (err) {
    return { data: {}, at: 0 };
  }
}

async function putMemory(env, data, at) {
  if (!env.EVENTS) return;
  try {
    await env.EVENTS.put(MEMORY_KEY, JSON.stringify({ data, at }));
  } catch (err) {
    // ignore KV write failures
  }
}


const COLOURDIAM_SEARCH = "https://www.colourdiam.com/Home/SearchProduct?SubMenuName=&FromHome=&PageIndex=1&PageCount=100&SortById=";
const PRODUCT_CACHE_TTL = 10 * 60 * 1000;

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

function productImgBase(env) {
  return (env.FTP_BASE_URL || "").trim().replace(/\/+$/, "") || "https://www.colourdiam.com";
}

function colourdiamProductImg(p) {
  const real = (id) => id && !String(id).startsWith("/assets/");
  const cand = real(p.ImgPath)
    ? p.ImgPath
    : (Array.isArray(p.ImgPathList) ? p.ImgPathList.find(real) : null) || (real(p.ModelImgPath) ? p.ModelImgPath : null);
  return cand || null;
}

function parseColourdiamCarat(name) {
  const m = name.match(/(\d+\.\d+)/);
  return m ? m[1] : "";
}

function colourdiamType(name, imgPath) {
  const p = String(imgPath || "");
  const n = String(name || "");
  if (/\/Product\/Jewellery\//i.test(p)) return "jewelry";
  if (/\b18K\b/i.test(n) || /\d+(\.\d+)?\s*gm\b/i.test(n)) return "jewelry";
  return "diamond";
}

function normalizeColourdiamProduct(p, env) {
  const name = String(p.ProdName || "").trim();
  const meta = colourDiamondMeta(name);
  const carat = parseColourdiamCarat(name);
  const imgPath = colourdiamProductImg(p);
  return {
    id: String(p.ProdId || p.TagNo || "cd-" + Math.random().toString(36).slice(2, 8)),
    name,
    type: colourdiamType(name, imgPath),
    category: (name.match(/Fancy\s+\w+/i) || [])[0] || "Diamond",
    carat,
    price: Number(p.NewPrice || p.OldPrice || 0),
    oldPrice: Number(p.OldPrice || 0),
    stock: "In stock",
    emoji: meta.emoji,
    color: meta.bg,
    colorName: meta.colorName,
    img: colourdiamProductImg(p) ? productImgBase(env) + colourdiamProductImg(p) : null,
  };
}

async function fetchColourdiamProducts(env) {
  const now = Date.now();
  if (env._productsCache && now - env._productsCache.at < PRODUCT_CACHE_TTL && env._productsCache.list.length) {
    return env._productsCache.list;
  }
  const res = await fetch(COLOURDIAM_SEARCH, {
    headers: { "User-Agent": "colourdiam-messaging/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error("ColourDiam API HTTP " + res.status);
  const data = await res.json();
  const raw = Array.isArray(data.searchProductsList) ? data.searchProductsList : [];
  const list = raw.map((p) => normalizeColourdiamProduct(p, env)).filter((p) => p.name);
  env._productsCache = { at: now, list };
  return list;
}

async function getEvents(env) {
  try {
    if (!env.EVENTS) return [];
    const raw = await env.EVENTS.get(EVENTS_KEY, { type: "text" });
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function eventCount(env) {
  return (await getEvents(env)).length;
}

async function recordEvent(env, platform, from, text) {
  try {
    if (!env.EVENTS) return;
    const events = await getEvents(env);
    const id = events.length ? events[events.length - 1].id + 1 : 1;
    events.push({ id, platform, from, text, time: new Date().toISOString() });
    const trimmed = events.length > 200 ? events.slice(-200) : events;
    await env.EVENTS.put(EVENTS_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.error("recordEvent failed:", err && err.message);
  }
}

async function apiLlm(body, env) {
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

async function apiTrack(body, env) {
  const { carrier, trackingNumber } = body || {};
  if (!carrier || !trackingNumber) {
    return { status: 400, body: { error: "carrier and trackingNumber are required" } };
  }
  try {
    if (carrier === "fedex") return await trackFedEx(trackingNumber, env);
    if (carrier === "dhl") return await trackDHL(trackingNumber, env);
    return { status: 400, body: { error: "Unsupported carrier (use fedex or dhl)" } };
  } catch (err) {
    return { status: 502, body: { error: "Tracking lookup failed: " + String((err && err.message) || err) } };
  }
}

async function trackFedEx(trackingNumber, env) {
  if (!env.FEDEX_API_KEY || !env.FEDEX_API_SECRET) {
    return { status: 400, body: { error: "FEDEX_API_KEY and FEDEX_API_SECRET env not set on the worker" } };
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

async function trackDHL(trackingNumber, env) {
  if (!env.DHL_API_KEY) {
    return { status: 400, body: { error: "DHL_API_KEY env not set on the worker" } };
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

async function apiSend(body, env) {
  const { platform, to, text } = body || {};
  if (!platform || !to || !text) {
    return { status: 400, body: { error: "platform, to and text are required" } };
  }
  try {
    let res;
    switch (platform) {
      case "whatsapp": {
        const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
        if (!phoneNumberId) return { status: 400, body: { error: "WHATSAPP_PHONE_NUMBER_ID env not set on the worker" } };
        res = await postGraph(env, `${phoneNumberId}/messages`, env.WHATSAPP_ACCESS_TOKEN, {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        });
        break;
      }
      case "instagram": {
        const senderId = env.INSTAGRAM_SENDER_ID;
        if (!senderId) return { status: 400, body: { error: "INSTAGRAM_SENDER_ID env not set on the worker" } };
        res = await postGraph(env, `${senderId}/messages`, env.INSTAGRAM_ACCESS_TOKEN, {
          recipient: { id: to },
          message: { text },
          message_type: "RESPONSE",
        });
        break;
      }
      case "facebook": {
        res = await postGraph(env, "me/messages", env.FACEBOOK_PAGE_ACCESS_TOKEN, {
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

function verifyMeta(request, url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Verification failed", { status: 403 });
}

async function verifyWeChat(request, url, env) {
  const { signature, timestamp, nonce, echostr } = Object.fromEntries(url.searchParams);
  const arr = [env.WECHAT_TOKEN, timestamp, nonce].sort();
  const sha1 = await cryptoDigest("SHA-1", arr.join(""));
  if (sha1 === signature) {
    return new Response(echostr, { status: 200 });
  }
  return new Response("verification failed", { status: 403 });
}

const handlers = {
  instagram: async (request, url, env, ctx) => {
    const body = await request.json();
    const entry = body.entry && body.entry[0];
    const messaging = entry && entry.messaging && entry.messaging[0];
    const msg = messaging && messaging.message;
    if (!msg || msg.is_echo) {
      return json({});
    }
    if (!msg.text) {
      return json({});
    }
    await recordEvent(env, "instagram", messaging.sender.id, msg.text);
    ctx.waitUntil(
      postGraph(env, `${entry.id}/messages`, env.INSTAGRAM_ACCESS_TOKEN, {
        recipient: { id: messaging.sender.id },
        message: { text: env.INSTAGRAM_REPLY_TEXT || "Thanks for your Instagram message!" },
        message_type: "RESPONSE",
      })
    );
    return json({});
  },

  facebook: async (request, url, env, ctx) => {
    const body = await request.json();
    const entry = body.entry && body.entry[0];
    const messaging = entry && entry.messaging && entry.messaging[0];
    const msg = messaging && messaging.message;
    if (!msg || msg.is_echo) {
      return json({});
    }
    if (!msg.text) {
      return json({});
    }
    await recordEvent(env, "facebook", messaging.sender.id, msg.text);
    ctx.waitUntil(
      postGraph(env, "me/messages", env.FACEBOOK_PAGE_ACCESS_TOKEN, {
        recipient: { id: messaging.sender.id },
        message: { text: env.FACEBOOK_REPLY_TEXT || "Thanks for your Facebook message!" },
      })
    );
    return json({});
  },

  whatsapp: async (request, url, env, ctx) => {
    const body = await request.json();
    const entry = body.entry && body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;
    const messages = value && value.messages;
    const inbound = messages && messages.filter((m) => m.type !== "text" || m.from);
    if (!inbound || inbound.length === 0) {
      return json({});
    }
    const message = inbound[0];
    if (message.type !== "text") {
      return json({});
    }
    await recordEvent(env, "whatsapp", message.from, (message.text && message.text.body) || "");
    ctx.waitUntil(
      postGraph(env, `${value.metadata.phone_number_id}/messages`, env.WHATSAPP_ACCESS_TOKEN, {
        messaging_product: "whatsapp",
        to: message.from,
        type: "text",
        text: { body: env.WHATSAPP_REPLY_TEXT || "Thanks for your message! This is an automated reply from your WhatsApp bot." },
      })
    );
    return json({});
  },

  line: async (request, url, env, ctx) => {
    const body = await request.json();
    const events = (body.events || []).filter((e) => e.type === "message" && e.message.type === "text" && e.replyToken);
    if (events.length === 0) {
      return json({});
    }
    const event = events[0];
    await recordEvent(env, "line", (event.source && event.source.userId) || "", event.message.text);
    ctx.waitUntil(
      fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: env.LINE_REPLY_TEXT || "Thanks for your LINE message!" }],
        }),
      })
    );
    return json({});
  },

  tiktok: async (request, url, env, ctx) => {
    const body = await request.json();
    if (body.challenge_code) {
      return json({ challenge_code: body.challenge_code });
    }
    const message = body.data && body.data.message;
    const sender = body.data && body.data.sender;
    if (!message || !sender) {
      return json({});
    }
    const text = typeof message === "string" ? message : (message && message.text) || "";
    await recordEvent(env, "tiktok", sender.open_id, text);
    ctx.waitUntil(
      fetch("https://open.tiktokapis.com/v2/message/send/", {
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
      })
    );
    return json({});
  },

  wechat: async (request, url, env, ctx) => {
    const xml = await request.text();
    const parsed = parseWeChatXml(xml);
    if (parsed.msgType !== "text") {
      return textResponse("success");
    }
    await recordEvent(env, "wechat", parsed.from, parsed.content);
    const reply =
      "<xml>" +
      "<ToUserName><![CDATA[" + parsed.from + "]]></ToUserName>" +
      "<FromUserName><![CDATA[" + parsed.to + "]]></FromUserName>" +
      "<CreateTime>" + Math.floor(Date.now() / 1000) + "</CreateTime>" +
      "<MsgType><![CDATA[text]]></MsgType>" +
      "<Content><![CDATA[" + (env.WECHAT_REPLY_TEXT || "Thanks for your WeChat message!") + "]]></Content>" +
      "</xml>";
    return textResponse(reply);
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

async function postGraph(env, endpoint, token, payload) {
  return fetch(`https://graph.facebook.com/v19.0/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}

async function cryptoDigest(algo, text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest(algo, data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}
