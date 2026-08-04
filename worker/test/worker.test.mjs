import test from "node:test";
import assert from "node:assert";
import worker from "../src/index.js";

const env = {
  VERIFY_TOKEN: "test_verify",
  INSTAGRAM_ACCESS_TOKEN: "ig_token",
  FACEBOOK_PAGE_ACCESS_TOKEN: "fb_token",
  WHATSAPP_ACCESS_TOKEN: "wa_token",
  LINE_CHANNEL_ACCESS_TOKEN: "line_token",
  TIKTOK_ACCESS_TOKEN: "tt_token",
  WECHAT_TOKEN: "wx_token",
};

const ctx = { waitUntil: (p) => p };

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
