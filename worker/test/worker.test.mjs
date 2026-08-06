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
    assert.ok(products.every((p) => p.name && p.id));
  } finally {
    globalThis.fetch = originalFetch;
  }
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
