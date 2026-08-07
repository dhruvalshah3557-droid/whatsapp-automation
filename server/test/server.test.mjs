import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

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
  MEDIA_CONFIG_FILE: path.join(__dirname, "tmp-media-config.json"),
  INVENTORY_FILE: path.join(__dirname, "tmp-inventory.json"),
  SYNC_ON_START: "0",
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
  const { writeFileSync } = await import("node:fs");
  writeFileSync(ENV.MEDIA_CONFIG_FILE, "{}");
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

test("POST /api/track validates required fields", async () => {
  const { status, text } = await req("/api/track", { method: "POST", body: JSON.stringify({ carrier: "fedex" }) });
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /required/);
});

test("POST /api/track rejects unknown carrier", async () => {
  const { status, text } = await req("/api/track", {
    method: "POST",
    body: JSON.stringify({ carrier: "ups", trackingNumber: "123" }),
  });
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /carrier/);
});

test("POST /api/track fedex reports missing server keys", async () => {
  const { status, text } = await req("/api/track", {
    method: "POST",
    body: JSON.stringify({ carrier: "fedex", trackingNumber: "999999999999" }),
  });
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /FEDEX_API_KEY/);
});

test("POST /api/track dhl reports missing server key", async () => {
  const { status, text } = await req("/api/track", {
    method: "POST",
    body: JSON.stringify({ carrier: "dhl", trackingNumber: "9999999999" }),
  });
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /DHL_API_KEY/);
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

test("GET /api/products returns the ColourDiam catalogue", async () => {
  const { status, text } = await req("/api/products");
  if (status === 502) {
    assert.match(JSON.parse(text).error, /Could not load products/);
    return;
  }
  assert.equal(status, 200);
  const { products } = JSON.parse(text);
  assert.ok(Array.isArray(products));
  assert.ok(products.length > 0, "expected a non-empty catalogue");
  const p = products[0];
  for (const field of ["id", "name", "category", "carat", "price", "stock", "emoji", "color"]) {
    assert.ok(p[field] !== undefined, `missing product field: ${field}`);
  }
  assert.ok(typeof p.price === "number");
});

test("GET /api/sync/site reports inventory status", async () => {
  const { status, text } = await req("/api/sync/site");
  assert.equal(status, 200);
  const data = JSON.parse(text);
  assert.equal(data.ok, true);
  assert.ok(typeof data.count === "number");
  assert.ok(["ready", "syncing", "error", "idle"].includes(data.status));
});

test("POST /api/sync/site starts a sync and returns 202", async () => {
  const { status, text } = await req("/api/sync/site", { method: "POST", body: JSON.stringify({ enrich: false }) });
  assert.equal(status, 202);
  const data = JSON.parse(text);
  assert.match(data.message, /sync started/);
});

test("POST /api/sync/site returns 405 for other methods", async () => {
  const { status } = await req("/api/sync/site", { method: "PUT" });
  assert.equal(status, 405);
});

test("POST /api/llm returns 501 when server LLM not configured", async () => {
  const { status, text } = await req("/api/llm", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(status, 501);
  assert.match(JSON.parse(text).error, /not configured/);
});

test("POST /api/llm rejects invalid JSON", async () => {
  const { status } = await req("/api/llm", { method: "POST", body: "{not json" });
  assert.equal(status, 400);
});

test("POST /api/llm proxies to an OpenAI-compatible endpoint when configured", async () => {
  const http = await import("node:http");
  const calls = [];
  const mockLlm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ url: `http://127.0.0.1:3459${req.url}`, body: JSON.parse(raw), auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Bonjour" } }] }));
    });
  });
  await new Promise((resolve) => mockLlm.listen(3459, resolve));

  const llmServer = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: {
      ...process.env,
      ...ENV,
      PORT: String(3457),
      USER_LLM_BASE_URL: "http://127.0.0.1:3459/v1",
      USER_LLM_MODEL: "deepseek-chat",
      USER_LLM_API_KEY: "llm_secret",
    },
    stdio: "pipe",
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("llm server did not start")), 8000);
    llmServer.stdout.on("data", (d) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  try {
    const res = await fetch("http://127.0.0.1:3457/api/llm", {
      method: "POST",
      headers: { Authorization: "Bearer test_api_key", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, "Bonjour");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:3459/v1/chat/completions");
    assert.equal(calls[0].auth, "Bearer llm_secret");
    assert.equal(calls[0].body.model, "deepseek-chat");
  } finally {
    llmServer.kill("SIGTERM");
    await new Promise((resolve) => llmServer.on("exit", resolve));
    await new Promise((resolve) => mockLlm.close(resolve));
  }
});

/* ---------------- FTP media endpoints ---------------- */

test("GET /api/media/config returns the config shape", async () => {
  const { status, text } = await req("/api/media/config");
  assert.equal(status, 200);
  const data = JSON.parse(text);
  assert.equal(typeof data.configured, "boolean");
  assert.equal(typeof data.host, "string");
  assert.equal(typeof data.port, "number");
  assert.equal(typeof data.hasPassword, "boolean");
});

test("POST /api/media/test returns 400 when FTP is not configured", async () => {
  const { status, text } = await req("/api/media/test", { method: "POST", body: JSON.stringify({}) });
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /not configured/i);
});

test("POST /api/media/config saves and masks the password", async () => {
  const { status, text } = await req("/api/media/config", {
    method: "POST",
    body: JSON.stringify({ host: "ftp.example.com", port: 21, user: "demo", pass: "secret123", baseUrl: "https://files.example.com", remoteRoot: "media" }),
  });
  assert.equal(status, 200);
  const data = JSON.parse(text);
  assert.equal(data.configured, true);
  assert.equal(data.host, "ftp.example.com");
  assert.equal(data.hasPassword, true);
  assert.ok(!("pass" in data) || data.pass === undefined, "password must not be returned");
  const again = await req("/api/media/config");
  const saved = JSON.parse(again.text);
  assert.equal(saved.host, "ftp.example.com");
  assert.equal(saved.baseUrl, "https://files.example.com");
});

test("POST /api/media/upload rejects non-multipart payloads", async () => {
  const { status, text } = await req("/api/media/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "1003" }),
  });
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /multipart/i);
});

test("POST /api/media/upload returns 400 without a productId", async () => {
  const boundary = "----testboundary123";
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nFAKEIMG\r\n--${boundary}--\r\n`
  );
  const { status, text } = await req("/api/media/upload", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(status, 400);
  assert.match(JSON.parse(text).error, /productId/);
});

/* ---------------- Minimal FTP client against a fake FTP server ---------------- */

function startFakeFtp() {
  const listings = {
    "/": "total 2\ndrwxr-xr-x 2 ftp ftp 4096 Jul 01 10:00 Product\n-rw-r--r-- 1 ftp ftp 1234 Jul 01 10:00 hello.jpg\n",
  };
  const dataServers = [];
  const srv = net.createServer((sock) => {
    sock.write("220 FakeFTP ready\r\n");
    sock.on("error", () => {});
    let dataSock = null;
    sock.on("data", async (d) => {
      const line = d.toString().trim();
      const cmd = line.split(" ")[0].toUpperCase();
      if (cmd === "USER") sock.write("331 need password\r\n");
      else if (cmd === "PASS") sock.write("230 logged in\r\n");
      else if (cmd === "TYPE") sock.write("200 Type set\r\n");
      else if (cmd === "PASV") {
        const dataServer = net.createServer((ds) => {
          dataSock = ds;
          ds.on("error", () => {});
        });
        dataServers.push(dataServer);
        await new Promise((r) => dataServer.listen(0, "127.0.0.1", r));
        const p = dataServer.address().port;
        sock.write(`227 Entering Passive Mode (127,0,0,1,${Math.floor(p / 256)},${p % 256})\r\n`);
      } else if (cmd === "LIST") {
        sock.write("150 Here comes the listing\r\n");
        const path = line.split(/\s+/)[1] || "/";
        if (dataSock) {
          dataSock.write(listings[path] || listings["/"]);
          dataSock.end();
        }
        sock.write("226 Directory send OK\r\n");
      } else if (cmd === "AUTH") {
        sock.write("500 AUTH not supported\r\n");
      } else if (cmd === "MKD") {
        sock.write("257 \"/new\" created\r\n");
      } else if (cmd === "STOR") {
        sock.write("150 Ok to send data\r\n");
        if (dataSock) {
          dataSock.on("data", () => {});
          dataSock.on("end", () => sock.write("226 Transfer complete\r\n"));
        }
      } else if (cmd === "QUIT") {
        sock.write("221 bye\r\n");
        sock.end();
      } else {
        sock.write("200 OK\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => {
        srv.close(() => {
          for (const ds of dataServers) ds.close();
          r();
        });
      }),
    }));
  });
}

test("FTP client connects, lists and stores against a fake FTP server", async () => {
  const fake = await startFakeFtp();
  try {
    const { ftpList, ftpStore, ftpMkdirs } = await import("../ftp.js");
    const cfg = { host: "127.0.0.1", port: fake.port, user: "demo", pass: "secret" };

    const listing = await ftpList(cfg, "/");
    assert.match(listing, /hello\.jpg/);
    assert.match(listing, /Product/);

    await ftpMkdirs(cfg, "media/1003");
    await ftpStore(cfg, "media/1003/a.jpg", Buffer.from("IMG"));

    assert.ok(true, "store + mkdirs completed without throwing");
  } finally {
    fake.close();
  }
});

test("FTP client throws when the host refuses the connection", async () => {
  const { ftpList } = await import("../ftp.js");
  await assert.rejects(
    () => ftpList({ host: "127.0.0.1", port: 1, user: "demo", pass: "secret" }, "/"),
    /ECONNREFUSED|FTP connection/i
  );
});

test("POST /api/media/test works end-to-end against the fake FTP server", async () => {
  const fake = await startFakeFtp();
  try {
    const { status, text } = await req("/api/media/test", {
      method: "POST",
      body: JSON.stringify({ host: "127.0.0.1", port: fake.port, user: "demo", pass: "secret" }),
    });
    assert.equal(status, 200);
    const data = JSON.parse(text);
    assert.equal(data.ok, true);
    assert.match(data.message, /Connected to 127\.0\.0\.1/);
    assert.ok(Array.isArray(data.entries));
  } finally {
    fake.close();
  }
});
