import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;

const ENV = {
  PORT: String(PORT),
  VERIFY_TOKEN: "test_verify",
  INSTAGRAM_ACCESS_TOKEN: "ig_token",
  FACEBOOK_PAGE_ACCESS_TOKEN: "fb_token",
  WHATSAPP_ACCESS_TOKEN: "wa_token",
  WHATSAPP_PHONE_NUMBER_ID: "987654321",
  LINE_CHANNEL_ACCESS_TOKEN: "line_token",
  TIKTOK_ACCESS_TOKEN: "tt_token",
  WECHAT_TOKEN: "wx_token",
  API_KEY: "test_api_key",
  EVENTS_FILE: path.join(__dirname, "tmp-events.json"),
};

let child;
let ready;

async function start() {
  child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: { ...process.env, ...ENV },
    stdio: "pipe",
  });
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 8000);
    child.stdout.on("data", (d) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
  });
  await ready;
}

async function stop() {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("exit", resolve));
  }
}

async function req(pathname, options = {}) {
  const headers = { Authorization: "Bearer test_api_key", ...(options.headers || {}) };
  const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

test.before(async () => {
  await start();
});

test.after(async () => {
  await stop();
});

test("unknown route returns 404", async () => {
  const { status } = await req("/nope");
  assert.equal(status, 404);
});

test("Meta verify returns challenge when token matches", async () => {
  const { status, text } = await req("/webhook/instagram-hook?hub.mode=subscribe&hub.verify_token=test_verify&hub.challenge=abc123");
  assert.equal(status, 200);
  assert.equal(text, "abc123");
});

test("Meta verify rejects wrong token", async () => {
  const { status } = await req("/webhook/instagram-hook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123");
  assert.equal(status, 403);
});

test("WeChat verify echoes echostr with valid SHA1", async () => {
  const { createHash } = await import("node:crypto");
  const token = "wx_token";
  const timestamp = "1700000000";
  const nonce = "n123";
  const sig = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
  const { status, text } = await req(`/webhook/wechat-hook?signature=${sig}&timestamp=${timestamp}&nonce=${nonce}&echostr=HELLO`);
  assert.equal(status, 200);
  assert.equal(text, "HELLO");
});

test("WeChat text message gets passive XML reply", async () => {
  const xml =
    "<xml><ToUserName><![CDATA[gh_bot]]></ToUserName><FromUserName><![CDATA[user1]]></FromUserName>" +
    "<CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content></xml>";
  const { status, text } = await req("/webhook/wechat-hook", { method: "POST", body: xml });
  assert.equal(status, 200);
  assert.match(text, /<Content><!\[CDATA\[Thanks for your WeChat message!\]\]><\/Content>/);
  assert.match(text, /<ToUserName><!\[CDATA\[user1\]\]><\/ToUserName>/);
});

test("TikTok challenge echoes challenge_code", async () => {
  const { status, text } = await req("/webhook/tiktok-hook", { method: "POST", body: JSON.stringify({ challenge_code: "ch123" }) });
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(text), { challenge_code: "ch123" });
});

test("Instagram inbound text gets 200 and echo messages are accepted", async () => {
  const body = JSON.stringify({
    entry: [{ id: "17841401829934148", messaging: [{ sender: { id: "user123" }, message: { text: "hello" } }] }],
  });
  const { status } = await req("/webhook/instagram-hook", { method: "POST", body });
  assert.equal(status, 200);
});

test("GET /api/health returns ok", async () => {
  const { status, text } = await req("/api/health");
  assert.equal(status, 200);
  const data = JSON.parse(text);
  assert.equal(data.ok, true);
  assert.equal(data.name, "messaging-webhooks");
});

test("GET /api/events returns recorded inbound events", async () => {
  const body = JSON.stringify({
    entry: [{ id: "17841401829934148", messaging: [{ sender: { id: "user123" }, message: { text: "hello" } }] }],
  });
  await req("/webhook/instagram-hook", { method: "POST", body });
  const { status, text } = await req("/api/events");
  assert.equal(status, 200);
  const { events } = JSON.parse(text);
  const match = events.find((e) => e.platform === "instagram" && e.from === "user123" && e.text === "hello");
  assert.ok(match, "expected instagram event to be recorded");
});

test("GET /api/events supports since filter", async () => {
  const { text } = await req("/api/events?since=999999999");
  const { events } = JSON.parse(text);
  assert.deepEqual(events, []);
});

test("GET /api/events rejects missing API key", async () => {
  const res = await fetch(`${BASE}/api/events`, {
    headers: { Authorization: "Bearer wrong_key" },
  });
  assert.equal(res.status, 401);
});

test("POST /api/send validates required fields", async () => {
  const { status, text } = await req("/api/send", { method: "POST", body: JSON.stringify({ platform: "whatsapp" }) });
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /required/);
});

test("POST /api/send rejects unknown platform", async () => {
  const { status } = await req("/api/send", {
    method: "POST",
    body: JSON.stringify({ platform: "nope", to: "1", text: "hi" }),
  });
  assert.equal(status, 400);
});

test("POST /api/send returns 501 for wechat", async () => {
  const { status } = await req("/api/send", {
    method: "POST",
    body: JSON.stringify({ platform: "wechat", to: "u", text: "hi" }),
  });
  assert.equal(status, 501);
});

test("GET / serves the messaging app", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Colourdiam/);
  assert.match(text, /<script>/);
});

test("GET missing static file returns 404", async () => {
  const res = await fetch(`${BASE}/does-not-exist.js`);
  assert.equal(res.status, 404);
});
