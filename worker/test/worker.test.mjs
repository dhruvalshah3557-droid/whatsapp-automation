import test from "node:test";
import assert from "node:assert";
import worker from "../src/index.js";

const env = {
  VERIFY_TOKEN: "test_verify",
  INSTAGRAM_ACCESS_TOKEN: "ig_token",
  FACEBOOK_PAGE_ACCESS_TOKEN: "fb_token",
  WHATSAPP_ACCESS_TOKEN: "wa_token",
  WHATSAPP_PHONE_NUMBER_ID: "987654321",
  LINE_CHANNEL_ACCESS_TOKEN: "line_token",
  TIKTOK_ACCESS_TOKEN: "tt_token",
  WECHAT_TOKEN: "wx_token",
};

const ctx = { waitUntil: (p) => p };

function mockKV() {
  let store = {};
  return {
    get: async (k) => store[k] || null,
    put: async (k, v) => { store[k] = v; },
  };
}

async function call(path, options = {}, extraEnv = {}) {
  const req = new Request(`http://example.com${path}`, options);
  return worker.fetch(req, { ...env, ...extraEnv }, ctx);
}

function mockAuthEnv(overrides = {}) {
  return {
    AUTH: mockKV(),
    ADMIN_EMAIL: "admin@colourdiam.com",
    ADMIN_PASSWORD: "Admin2026!",
    AUTH_ITERATIONS: 1000,
    ...overrides,
  };
}

async function login(extraEnv, email, password) {
  const res = await call("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }, extraEnv);
  return { status: res.status, data: await res.json() };
}

async function authCall(path, token, options = {}, extraEnv = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  return call(path, { ...options, headers }, extraEnv);
}

async function adminToken(extraEnv = mockAuthEnv()) {
  const r = await login(extraEnv, "admin@colourdiam.com", "Admin2026!");
  assert.equal(r.status, 200, "admin login should succeed");
  return r.data.token;
}

test("unknown route returns 404", async () => {
  const res = await call("/nope");
  assert.equal(res.status, 404);
});

test("Meta verify returns challenge when token matches", async () => {
  const res = await call("/webhook/instagram-hook?hub.mode=subscribe&hub.verify_token=test_verify&hub.challenge=abc123");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "abc123");
});

test("Meta verify rejects wrong token", async () => {
  const res = await call("/webhook/instagram-hook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123");
  assert.equal(res.status, 403);
});

test("WeChat verify echoes echostr with valid SHA1", async () => {
  const token = "wx_token";
  const timestamp = "1700000000";
  const nonce = "n123";
  const { webcrypto } = await import("node:crypto");
  const buf = await webcrypto.subtle.digest("SHA-1", new TextEncoder().encode([token, timestamp, nonce].sort().join("")));
  const sig = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await call(`/webhook/wechat-hook?signature=${sig}&timestamp=${timestamp}&nonce=${nonce}&echostr=HELLO`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "HELLO");
});

test("WeChat text message gets passive XML reply", async () => {
  const xml =
    "<xml><ToUserName><![CDATA[gh_bot]]></ToUserName><FromUserName><![CDATA[user1]]></FromUserName>" +
    "<CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content></xml>";
  const res = await call("/webhook/wechat-hook", { method: "POST", body: xml });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /<Content><!\[CDATA\[Thanks for your WeChat message!\]\]><\/Content>/);
  assert.match(text, /<ToUserName><!\[CDATA\[user1\]\]><\/ToUserName>/);
});

test("TikTok challenge echoes challenge_code", async () => {
  const res = await call("/webhook/tiktok-hook", { method: "POST", body: JSON.stringify({ challenge_code: "ch123" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { challenge_code: "ch123" });
});

test("Instagram inbound text triggers a Graph API reply", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    calls.push({ url: u, body: JSON.parse(o.body) });
    return new Response("{}", { status: 200 });
  };
  try {
    const body = JSON.stringify({
      entry: [{ id: "17841401829934148", messaging: [{ sender: { id: "user123" }, message: { text: "hello" } }] }],
    });
    const res = await call("/webhook/instagram-hook", { method: "POST", body });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://graph.facebook.com/v19.0/17841401829934148/messages");
    assert.equal(calls[0].body.recipient.id, "user123");
    assert.equal(calls[0].body.message.text, "Thanks for your Instagram message!");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Instagram echo messages are ignored", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    calls.push(u);
    return new Response("{}", { status: 200 });
  };
  try {
    const body = JSON.stringify({
      entry: [{ id: "17841401829934148", messaging: [{ sender: { id: "user123" }, message: { text: "hello", is_echo: true } }] }],
    });
    const res = await call("/webhook/instagram-hook", { method: "POST", body });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WhatsApp inbound text triggers reply with phone_number_id endpoint", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    calls.push({ url: u, body: JSON.parse(o.body) });
    return new Response("{}", { status: 200 });
  };
  try {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "12345" }, messages: [{ from: "5511999", type: "text", text: { body: "oi" } }] } }] }],
    });
    const res = await call("/webhook/whatsapp-hook", { method: "POST", body });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://graph.facebook.com/v19.0/12345/messages");
    assert.equal(calls[0].body.to, "5511999");
    assert.equal(calls[0].body.messaging_product, "whatsapp");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/health returns ok", async () => {
  const res = await call("/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test("POST /api/send validates required fields", async () => {
  const res = await call("/api/send", { method: "POST", body: JSON.stringify({ platform: "whatsapp" }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /required/);
});

test("POST /api/send sends a WhatsApp message", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    calls.push({ url: u, body: JSON.parse(o.body) });
    return new Response("{}", { status: 200 });
  };
  try {
    const res = await call("/api/send", {
      method: "POST",
      body: JSON.stringify({ platform: "whatsapp", to: "5511999", text: "hi from app" }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://graph.facebook.com/v19.0/987654321/messages");
    assert.equal(calls[0].body.to, "5511999");
    assert.equal(calls[0].body.text.body, "hi from app");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/send returns 501 for wechat", async () => {
  const res = await call("/api/send", {
    method: "POST",
    body: JSON.stringify({ platform: "wechat", to: "u", text: "hi" }),
  });
  assert.equal(res.status, 501);
});

test("GET /api/events returns recorded inbound events from KV", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    const kv = mockKV();
    const body = JSON.stringify({
      entry: [{ id: "17841401829934148", messaging: [{ sender: { id: "user123" }, message: { text: "hello" } }] }],
    });
    await call("/webhook/instagram-hook", { method: "POST", body }, { EVENTS: kv });
    const res = await call("/api/events", {}, { EVENTS: kv });
    assert.equal(res.status, 200);
    const { events } = await res.json();
    assert.ok(events.some((e) => e.platform === "instagram" && e.from === "user123" && e.text === "hello"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/events supports since filter", async () => {
  const kv = mockKV();
  await kv.put("events", JSON.stringify([{ id: 7, platform: "facebook", from: "u1", text: "hi", time: "t" }]));
  const res = await call("/api/events?since=7", {}, { EVENTS: kv });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).events, []);
});

test("GET /api/events returns empty when no KV bound", async () => {
  const res = await call("/api/events");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).events, []);
});

test("GET /api/health reports event count", async () => {
  const kv = mockKV();
  await kv.put("events", JSON.stringify([{ id: 1 }, { id: 2 }]));
  const res = await call("/api/health", {}, { EVENTS: kv });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).events, 2);
});

test("GET /api/products proxies and normalizes ColourDiam catalogue", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    return new Response(JSON.stringify({
      searchProductsList: [
        { ProdId: "1003", ProdName: " Fancy Yellow 1.05 SI1 18K 4.072 gm", OldPrice: 17825, NewPrice: 17825, ImgPath: "/Product/Jewellery/1003/CENTER.jpg" },
        { ProdId: "1135", ProdName: "Fancy Intense Yellow 1.02 I1 18K 5.550 gm", OldPrice: 5750, NewPrice: 5750, ImgPath: null },
        { ProdId: "1263", ProdName: "Fancy Green 0.30 VS 18K 5.180 gm", OldPrice: 2070, NewPrice: 2070 },
        { ProdId: "", ProdName: "", OldPrice: 0, NewPrice: 0 },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await call("/api/products", {}, {});
    assert.equal(res.status, 200);
    const { products } = await res.json();
    assert.equal(products.length, 3);
    const yellow = products.find((p) => p.id === "1003");
    assert.equal(yellow.name, "Fancy Yellow 1.05 SI1 18K 4.072 gm");
    assert.equal(yellow.carat, "1.05");
    assert.equal(yellow.price, 17825);
    assert.equal(yellow.emoji, "💛");
    assert.equal(yellow.img, "https://www.colourdiam.com/Product/Jewellery/1003/CENTER.jpg");
    const green = products.find((p) => p.id === "1263");
    assert.equal(green.emoji, "💚");
    assert.equal(yellow.type, "jewelry", "18K/gm jewellery names are typed jewelry");
    assert.equal(green.type, "jewelry", "ImgPath under /Product/Jewellery/ is typed jewelry");
    assert.ok(products.every((p) => p.name && p.id));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/track validates required fields", async () => {
  const res = await call("/api/track", { method: "POST", body: JSON.stringify({ carrier: "fedex" }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /required/);
});

test("POST /api/track rejects unknown carrier", async () => {
  const res = await call("/api/track", {
    method: "POST",
    body: JSON.stringify({ carrier: "ups", trackingNumber: "123" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /carrier/);
});

test("POST /api/track fedex reports missing worker keys", async () => {
  const res = await call("/api/track", {
    method: "POST",
    body: JSON.stringify({ carrier: "fedex", trackingNumber: "999999999999" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /FEDEX_API_KEY/);
});

test("POST /api/track fedex returns normalized status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok123" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        output: {
          completeTrackResults: [
            {
              trackResults: [
                {
                  latestStatusDetail: { code: "DE", description: "Delivered" },
                  scanEvents: [
                    { scanDateTime: "2026-08-01T10:00:00", scanLocation: { city: "Bangkok", countryName: "Thailand" } },
                    { scanDateTime: "2026-08-02T12:00:00", scanLocation: { city: "New York", countryName: "US" } },
                  ],
                },
              ],
            },
          ],
        },
      }),
      { status: 200 }
    );
  };
  try {
    const res = await call(
      "/api/track",
      { method: "POST", body: JSON.stringify({ carrier: "fedex", trackingNumber: "999999999999" }) },
      { FEDEX_API_KEY: "k", FEDEX_API_SECRET: "s" }
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.carrier, "fedex");
    assert.equal(data.status, "Delivered");
    assert.equal(data.delivered, false);
    assert.equal(data.scanCount, 2);
    assert.equal(data.lastScan, "2026-08-02T12:00:00");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/sync/site returns guidance to use the standalone server", async () => {
  const res = await call("/api/sync/site");
  assert.equal(res.status, 501);
  assert.match((await res.json()).error, /standalone server/);
});

test("GET /api/products returns 502 when ColourDiam is unreachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const res = await call("/api/products", {}, {});
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Could not load products/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/llm returns 501 when server LLM not configured", async () => {
  const res = await call("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(res.status, 501);
  assert.match((await res.json()).error, /not configured/);
});

test("POST /api/llm proxies to OpenAI-compatible endpoint", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    calls.push({ url: u, body: JSON.parse(o.body), auth: o.headers.Authorization });
    return new Response(JSON.stringify({ choices: [{ message: { content: "Hello there" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await call("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }, {
      USER_LLM_BASE_URL: "https://api.deepseek.com/v1",
      USER_LLM_MODEL: "deepseek-chat",
      USER_LLM_API_KEY: "llm_secret",
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, "Hello there");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(calls[0].auth, "Bearer llm_secret");
    assert.equal(calls[0].body.model, "deepseek-chat");
    assert.equal(calls[0].body.messages[0].role, "user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/track dhl reports missing worker key", async () => {
  const res = await call("/api/track", {
    method: "POST",
    body: JSON.stringify({ carrier: "dhl", trackingNumber: "9999999999" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /DHL_API_KEY/);
});

test("POST /api/track dhl returns normalized status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        shipments: [
          {
            events: [
              { timestamp: "2026-08-01T09:00:00", description: "Shipment picked up" },
              { timestamp: "2026-08-03T11:00:00", description: "Delivered", location: { address: { addressLocality: "Berlin" } } },
            ],
          },
        ],
      }),
      { status: 200 }
    );
  try {
    const res = await call(
      "/api/track",
      { method: "POST", body: JSON.stringify({ carrier: "dhl", trackingNumber: "9999999999" }) },
      { DHL_API_KEY: "dhlkey" }
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.carrier, "dhl");
    assert.equal(data.status, "Delivered");
    assert.equal(data.delivered, true);
    assert.equal(data.location, "Berlin");
    assert.equal(data.scanCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("POST /api/llm appends /chat/completions when base URL is a host", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    calls.push(u);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await call("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }, {
      USER_LLM_BASE_URL: "https://openai.example.com",
      USER_LLM_API_KEY: "k",
    });
    assert.equal(res.status, 200);
    assert.equal(calls[0], "https://openai.example.com/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/llm returns 502 when the LLM API errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad key", { status: 401 });
  try {
    const res = await call("/api/llm", { method: "POST", body: JSON.stringify({ messages: [] }) }, {
      USER_LLM_BASE_URL: "https://openai.example.com/v1",
      USER_LLM_API_KEY: "wrong",
    });
    assert.equal(res.status, 502);
    assert.match((await res.json()).detail, /bad key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/health reports ai configured", async () => {
  const res = await call("/api/health", {}, { USER_LLM_BASE_URL: "https://api.deepseek.com/v1", USER_LLM_API_KEY: "k" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ai, true);
});

test("GET /api/media/config reflects env FTP settings and masks the password", async () => {
  const res = await call("/api/media/config", {}, {
    FTP_HOST: "ftp.example.com",
    FTP_PORT: "2121",
    FTP_USER: "demo",
    FTP_PASS: "secret123",
    FTP_BASE_URL: "https://files.example.com/",
    FTP_REMOTE_ROOT: "/media/",
  });
  assert.equal(res.status, 200);
  const cfg = await res.json();
  assert.equal(cfg.configured, true);
  assert.equal(cfg.host, "ftp.example.com");
  assert.equal(cfg.port, 2121);
  assert.equal(cfg.user, "demo");
  assert.equal(cfg.hasPassword, true);
  assert.equal(cfg.baseUrl, "https://files.example.com");
  assert.equal(cfg.remoteRoot, "media");
  assert.equal(cfg.source, "env");
  assert.ok(!("pass" in cfg) || cfg.pass === undefined, "password must not be returned");
});

test("GET /api/media/config reports unconfigured without FTP env", async () => {
  const res = await call("/api/media/config", {}, {});
  assert.equal(res.status, 200);
  const cfg = await res.json();
  assert.equal(cfg.configured, false);
  assert.equal(cfg.hasPassword, false);
  assert.equal(cfg.host, "");
});

test("POST /api/media/config returns 501 because worker config comes from secrets", async () => {
  const res = await call("/api/media/config", {
    method: "POST",
    body: JSON.stringify({ host: "ftp.example.com", user: "demo", pass: "x" }),
  }, { FTP_HOST: "ftp.example.com", FTP_USER: "demo", FTP_PASS: "x" });
  assert.equal(res.status, 501);
  const data = await res.json();
  assert.match(data.error, /worker secrets/i);
});

test("GET /api/products rewrites image URLs to FTP_BASE_URL when set", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({
      searchProductsList: [
        { ProdId: "1003", ProdName: "Fancy Yellow 1.05 SI1 18K 4.072 gm", OldPrice: 17825, NewPrice: 17825, ImgPath: "/Product/Jewellery/1003/CENTER.jpg" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await call("/api/products", {}, { FTP_BASE_URL: "https://cdn.example.com/media/" });
    assert.equal(res.status, 200);
    const { products } = await res.json();
    assert.equal(products[0].img, "https://cdn.example.com/media/Product/Jewellery/1003/CENTER.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/products derives images from ImgPathList and ModelImgPath", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({
      searchProductsList: [
        { ProdId: "1263", ProdName: "Fancy Green 0.30 VS 18K 5.180 gm", NewPrice: 2070, ImgPath: null, ImgPathList: ["/Product/Jewellery/Model images/1263/center.jpeg"] },
        { ProdId: "1385", ProdName: "Fancy Yellowish Green 2.00 SI2 18K 7.618 gm", NewPrice: 3000, ImgPath: null, ImgPathList: ["/assets/img/ColorDiam.png"], ModelImgPath: "/Product/Jewellery/Model images/1385/center.jpeg" },
        { ProdId: "1135", ProdName: "Fancy Intense Yellow 1.02 I1 18K 5.550 gm", NewPrice: 5750, ImgPath: null, ImgPathList: ["/assets/img/ColorDiam.png"], ModelImgPath: "" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await call("/api/products", {}, {});
    assert.equal(res.status, 200);
    const { products } = await res.json();
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    assert.equal(byId["1263"].img, "https://www.colourdiam.com/Product/Jewellery/Model images/1263/center.jpeg");
    assert.equal(byId["1385"].img, "https://www.colourdiam.com/Product/Jewellery/Model images/1385/center.jpeg");
    assert.equal(byId["1135"].img, null, "placeholder-only products stay null");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ------------------------- Auth / Tasks / Admin (KV-backed) ------------------------- */

test("auth bootstraps admin and login returns a session token", async () => {
  const aenv = mockAuthEnv();
  const r = await login(aenv, "admin@colourdiam.com", "Admin2026!");
  assert.equal(r.status, 200);
  assert.ok(r.data.token, "token should be present");
  assert.equal(r.data.user.role, "admin");
  assert.equal(r.data.user.mustChangePassword, true);
  assert.equal(r.data.user.active, true);
});

test("auth login rejects wrong password", async () => {
  const aenv = mockAuthEnv();
  const r = await login(aenv, "admin@colourdiam.com", "wrongpass");
  assert.equal(r.status, 401);
  assert.match(r.data.error, /Invalid email or password/);
});

test("auth /api/auth/me returns the user for a valid bearer token", async () => {
  const aenv = mockAuthEnv();
  const t = await adminToken(aenv);
  const res = await authCall("/api/auth/me", t, {}, aenv);
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.equal(user.email, "admin@colourdiam.com");
  assert.equal(user.role, "admin");
});

test("auth /api/auth/me rejects requests without a token", async () => {
  const aenv = mockAuthEnv();
  const res = await call("/api/auth/me", {}, aenv);
  assert.equal(res.status, 401);
});

test("auth change-password updates the password and invalidates the old one", async () => {
  const aenv = mockAuthEnv();
  const t = await adminToken(aenv);
  const res = await authCall("/api/auth/change-password", t, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldPassword: "Admin2026!", newPassword: "NewPass2026!" }),
  }, aenv);
  assert.equal(res.status, 200);
  const old = await login(aenv, "admin@colourdiam.com", "Admin2026!");
  assert.equal(old.status, 401);
  const fresh = await login(aenv, "admin@colourdiam.com", "NewPass2026!");
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.user.mustChangePassword, false);
});

test("auth logout destroys the session", async () => {
  const aenv = mockAuthEnv();
  const t = await adminToken(aenv);
  const out = await authCall("/api/auth/logout", t, { method: "POST" }, aenv);
  assert.equal(out.status, 200);
  const me = await authCall("/api/auth/me", t, {}, aenv);
  assert.equal(me.status, 401);
});

test("auth forgot + reset flow issues a reset token and lets the user log in", async () => {
  const aenv = mockAuthEnv();
  const forgot = await call("/api/auth/forgot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@colourdiam.com" }),
  }, aenv);
  assert.equal(forgot.status, 200);
  const { resetToken } = await forgot.json();
  assert.ok(resetToken, "resetToken should be returned");
  const bad = await call("/api/auth/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@colourdiam.com", token: "nope", newPassword: "ResetPass2026!" }),
  }, aenv);
  assert.equal(bad.status, 400);
  const good = await call("/api/auth/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@colourdiam.com", token: resetToken, newPassword: "ResetPass2026!" }),
  }, aenv);
  assert.equal(good.status, 200);
  const r = await login(aenv, "admin@colourdiam.com", "ResetPass2026!");
  assert.equal(r.status, 200);
});

test("auth forgot hides whether the email exists", async () => {
  const aenv = mockAuthEnv();
  const res = await call("/api/auth/forgot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.com" }),
  }, aenv);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("auth tasks CRUD round-trip", async () => {
  const aenv = mockAuthEnv();
  const t = await adminToken(aenv);
  const create = await authCall("/api/tasks", t, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Ship order #100", status: "in_progress", progress: 40, priority: "high", dueDate: "2026-08-20" }),
  }, aenv);
  assert.equal(create.status, 201);
  const task = (await create.json()).task;
  assert.ok(task.id);
  assert.equal(task.ownerId, task.assignedTo);
  assert.equal(task.title, "Ship order #100");

  const list = await authCall("/api/tasks", t, {}, aenv);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).tasks.length, 1);

  const patch = await authCall(`/api/tasks/${task.id}`, t, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  }, aenv);
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).task.progress, 100);

  const del = await authCall(`/api/tasks/${task.id}`, t, { method: "DELETE" }, aenv);
  assert.equal(del.status, 200);
  const after = await authCall("/api/tasks", t, {}, aenv);
  assert.equal((await after.json()).tasks.length, 0);
});

test("auth task ownership is enforced between users", async () => {
  const aenv = mockAuthEnv();
  const admin = await adminToken(aenv);
  for (const [name, email] of [["Alice", "alice@colourdiam.com"], ["Bob", "bob@colourdiam.com"]]) {
    const r = await authCall("/api/admin/users", admin, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password: "UserPass2026!" }),
    }, aenv);
    assert.equal(r.status, 201);
  }
  const alice = await login(aenv, "alice@colourdiam.com", "UserPass2026!");
  assert.equal(alice.status, 200);
  const bob = await login(aenv, "bob@colourdiam.com", "UserPass2026!");
  assert.equal(bob.status, 200);
  const aliceTok = alice.data.token;
  const bobTok = bob.data.token;

  const create = await authCall("/api/tasks", aliceTok, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Alice private task" }),
  }, aenv);
  assert.equal(create.status, 201);
  const id = (await create.json()).task.id;

  const steal = await authCall(`/api/tasks/${id}`, bobTok, { method: "DELETE" }, aenv);
  assert.equal(steal.status, 403);

  const own = await authCall(`/api/tasks/${id}`, aliceTok, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: "mine" }),
  }, aenv);
  assert.equal(own.status, 200);
});

test("auth non-admin cannot reassign tasks or read admin endpoints", async () => {
  const aenv = mockAuthEnv();
  const admin = await adminToken(aenv);
  await authCall("/api/admin/users", admin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Carol", email: "carol@colourdiam.com", password: "UserPass2026!" }),
  }, aenv);
  const carol = await login(aenv, "carol@colourdiam.com", "UserPass2026!");
  const ctok = carol.data.token;

  const stats = await authCall("/api/admin/stats", ctok, {}, aenv);
  assert.equal(stats.status, 403);

  const create = await authCall("/api/tasks", admin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "team task" }),
  }, aenv);
  const id = (await create.json()).task.id;
  const reassign = await authCall(`/api/tasks/${id}`, ctok, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignedTo: ctok }),
  }, aenv);
  assert.equal(reassign.status, 403);
});

test("auth admin creates, suspends and reactivates users", async () => {
  const aenv = mockAuthEnv();
  const admin = await adminToken(aenv);
  const create = await authCall("/api/admin/users", admin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Dave", email: "dave@colourdiam.com", password: "UserPass2026!" }),
  }, aenv);
  assert.equal(create.status, 201);
  const { user } = await create.json();
  assert.equal(user.role, "user");
  assert.equal(user.active, true);

  const list = await authCall("/api/admin/users", admin, {}, aenv);
  const users = (await list.json()).users;
  assert.ok(users.some((u) => u.email === "dave@colourdiam.com"));

  const suspend = await authCall(`/api/admin/users/${user.id}/action`, admin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "suspend" }),
  }, aenv);
  assert.equal(suspend.status, 200);
  assert.equal((await suspend.json()).user.active, false);

  const blocked = await login(aenv, "dave@colourdiam.com", "UserPass2026!");
  assert.equal(blocked.status, 401);
  assert.match(blocked.data.error, /suspended/);

  const activate = await authCall(`/api/admin/users/${user.id}/action`, admin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "activate" }),
  }, aenv);
  assert.equal(activate.status, 200);
  assert.equal((await activate.json()).user.active, true);
});

test("auth admin cannot suspend the last active admin", async () => {
  const aenv = mockAuthEnv();
  const admin = await adminToken(aenv);
  const me = await authCall("/api/auth/me", admin, {}, aenv);
  const { user } = await me.json();
  const res = await authCall(`/api/admin/users/${user.id}/action`, admin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "suspend" }),
  }, aenv);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /last active admin/);
});

test("auth activity, stats, report and audit endpoints work for admins", async () => {
  const aenv = mockAuthEnv();
  const admin = await adminToken(aenv);
  const created = await authCall("/api/tasks", admin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Order #42 follow-up", status: "completed", progress: 100 }),
  }, aenv);
  assert.equal(created.status, 201);

  const activity = await authCall("/api/activity", admin, {}, aenv);
  const acts = (await activity.json()).activity;
  assert.ok(acts.some((a) => a.action === "login"));
  assert.ok(acts.some((a) => a.action === "task_created"));

  const stats = await authCall("/api/admin/stats", admin, {}, aenv);
  const s = (await stats.json());
  assert.equal(s.totals.users, 1);
  assert.equal(s.totals.tasks, 1);
  assert.equal(s.totals.tasksCompleted, 1);
  assert.equal(s.totals.audit > 0, true);
  assert.equal(s.users[0].total, 1);
  assert.equal(s.users[0].avgProgress, 100);

  const report = await authCall("/api/admin/report", admin, {}, aenv);
  assert.equal((await report.json()).users.length, 1);

  const audit = await authCall("/api/admin/audit?limit=5", admin, {}, aenv);
  const entries = (await audit.json()).audit;
  assert.ok(entries.length >= 3);
  assert.ok(entries.every((e) => e.userId && e.action && e.at));
});
