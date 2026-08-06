#!/usr/bin/env node
// Standing self-healing agent for the Colourdiam stack.
// Runs the full health suite every INTERVAL seconds, auto-fixes what it can
// (server restart, port reuse, webhook re-verification), logs every cycle to
// a rotating log file, and keeps running until stopped.
//
// Usage:
//   node scripts/agent.mjs              # watch every 60s, auto-heal
//   node scripts/agent.mjs --once       # single check + heal pass, then exit
//   node scripts/agent.mjs --interval 30

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = process.env.MONITOR_PORT || "8099";
const LOCAL = `http://127.0.0.1:${PORT}`;
const PUBLIC = process.env.PREVIEW_URL || "https://8099-36a98c8ea49ae77f.monkeycode-ai.live";
const VERIFY_TOKEN = process.env.MONITOR_VERIFY_TOKEN || "change_me_verify_token";
const TOKEN = process.env.SERVER_API_KEY || "";
const LOG = process.env.AGENT_LOG || path.join(ROOT, "logs", "agent.log");
const INTERVAL = parseInterval(process.env.AGENT_INTERVAL) || (process.argv.includes("--interval") ? parseInterval(process.argv[process.argv.indexOf("--interval") + 1]) : 60);
const ONCE = process.argv.includes("--once");
const HOOKS = ["whatsapp-hook", "instagram-hook", "facebook-hook"];
const HOOK_NOTE = "whatsapp/instagram/facebook (Meta GET verify); tiktok/line/wechat verify via POST/SHA1";

fs.mkdirSync(path.dirname(LOG), { recursive: true });

let lastHealthy = true;
let consecutiveFails = 0;
let failures = 0;

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(line) {
  const entry = `[${ts()}] ${line}`;
  console.log(entry);
  fs.appendFileSync(LOG, entry + "\n");
  if (fs.statSync(LOG).size > 1_000_000) fs.writeFileSync(LOG, entry + "\n");
}

function parseInterval(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function report(name, ok, detail = "") {
  const status = ok ? "OK  " : "FAIL";
  log(`${status} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: {} };
  }
}

async function serverUp(base = LOCAL) {
  const r = await getJson(`${base}/api/health`);
  return r.status === 200 && r.body.ok === true;
}

function startServer() {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT, VERIFY_TOKEN, STATIC_ROOT: path.join(ROOT, "messaging") },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function waitForServer(ms = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      if (await serverUp()) { clearInterval(timer); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(timer); resolve(false); }
    }, 300);
  });
}

function killPort() {
  try {
    const out = require("child_process").execSync(`lsof -ti :${PORT}`, { encoding: "utf8" }).trim();
    if (out) {
      for (const pid of out.split("\n")) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
      return true;
    }
  } catch {}
  return false;
}

async function healServer() {
  log("  -> healing server: killing stale process on :" + PORT);
  killPort();
  await new Promise((r) => setTimeout(r, 500));
  startServer();
  if (await waitForServer()) { report("local server (after heal)", true, "up"); return true; }
  report("local server (after heal)", false, "still down");
  return false;
}

async function checkServer() {
  if (await serverUp()) { report("local server", true, `up on :${PORT}`); return true; }
  report("local server", false, `down on :${PORT}`);
  return healServer();
}

async function checkPublic() {
  const r = await getJson(`${PUBLIC}/api/health`);
  report("public preview API", r.status === 200, r.status === 200 ? "reachable" : `HTTP ${r.status}`);
  return r.status === 200;
}

async function checkHooks() {
  let ok = true;
  for (const hook of HOOKS) {
    const url = `${PUBLIC}/webhook/${hook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=OK${hook[0]}`;
    try {
      const res = await fetch(url);
      if (res.status !== 200) { ok = false; report(`webhook ${hook}`, false, `HTTP ${res.status}`); }
    } catch { ok = false; report(`webhook ${hook}`, false, "unreachable"); }
  }
  report("webhook handshakes", ok, `${HOOKS.length} hooks (${HOOK_NOTE})`);
  return ok;
}

async function checkServedAssets() {
  try {
    const sw = await (await fetch(`${PUBLIC}/sw.js`)).text();
    const idx = await (await fetch(`${PUBLIC}/index.html`)).text();
    const swVersion = (sw.match(/colourdiam-msg-v\d+/) || [])[0] || "none";
    report("SW version served", swVersion !== "none", swVersion);
    report("API not cached by SW", sw.includes('req.url.includes("/api/")'), "");
    report("app code current", idx.includes("mc_cfg_v2"), "index.html has latest config key");
    return true;
  } catch (err) {
    report("served assets", false, err.message);
    return false;
  }
}

function runTests() {
  return new Promise((resolve) => {
    const t = spawn(
      process.execPath,
      ["--test", "messaging/test/messaging.test.mjs", "server/test/server.test.mjs", "worker/test/worker.test.mjs"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    t.stdout.on("data", (d) => (out += d));
    t.stderr.on("data", (d) => (out += d));
    t.on("close", (code) => resolve({ code, out }));
  });
}

async function checkTests() {
  const t = await runTests();
  const summary = `${t.out.match(/# (pass|fail|tests) \d+/g)?.join(", ") || "no summary"}`;
  report("test suite", t.code === 0, summary);
  return t.code === 0;
}

async function runCycle() {
  failures = 0;
  const started = Date.now();
  await checkServer();
  await checkPublic();
  await checkHooks();
  await checkServedAssets();
  await checkTests();

  const healthy = failures === 0;
  consecutiveFails = healthy ? 0 : consecutiveFails + 1;
  lastHealthy = healthy;
  log(`${healthy ? "AGENT OK" : `AGENT UNHEALTHY (${failures} issue(s))`} — ${Date.now() - started}ms`);
}

async function main() {
  log("Colourdiam agent started — interval " + INTERVAL + "s, server :" + PORT + ", preview " + PUBLIC);
  await runCycle();
  if (ONCE) process.exit(0);

  const timer = setInterval(runCycle, INTERVAL * 1000);
  process.on("SIGINT", () => { clearInterval(timer); log("agent stopped"); process.exit(0); });
  process.on("SIGTERM", () => { clearInterval(timer); log("agent stopped"); process.exit(0); });
}

main();
