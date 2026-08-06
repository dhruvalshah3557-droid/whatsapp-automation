#!/usr/bin/env node
// Colourdiam stack health monitor + self-healer.
// Usage:
//   node scripts/monitor.mjs            # check only
//   node scripts/monitor.mjs --fix      # restart local server if down
// Exit code 0 when healthy, 1 when a check fails.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = process.env.MONITOR_PORT || "8099";
const LOCAL = `http://127.0.0.1:${PORT}`;
const PUBLIC = process.env.PREVIEW_URL || "https://8099-75fdcec81dd144e5.monkeycode-ai.live";
const VERIFY_TOKEN = process.env.MONITOR_VERIFY_TOKEN || "change_me_verify_token";
const FIX = process.argv.includes("--fix");

let failures = 0;
function report(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function getJson(url) {
  try {
    const res = await fetch(url);
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

function waitForServer(ms = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      if (await serverUp()) { clearInterval(timer); resolve(true); }
      else if (Date.now() - t0 > 8000) { clearInterval(timer); resolve(false); }
    }, 300);
  });
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

async function checkServer() {
  if (await serverUp()) {
    report("local server", true, `up on :${PORT}`);
    return;
  }
  report("local server", false, `down on :${PORT}`);
  if (FIX) {
    console.log("  -> restarting server...");
    startServer();
    if (await waitForServer()) report("local server (after restart)", true, "up");
    else report("local server (after restart)", false, "still down");
  }
}

async function checkPublic() {
  const r = await getJson(`${PUBLIC}/api/health`);
  report("public preview API", r.status === 200, r.status === 200 ? "reachable" : `HTTP ${r.status}`);
}

async function checkServedAssets() {
  try {
    const sw = await (await fetch(`${PUBLIC}/sw.js`)).text();
    const idx = await (await fetch(`${PUBLIC}/index.html`)).text();
    const swVersion = (sw.match(/colourdiam-msg-v\d+/) || [])[0] || "none";
    report("SW version served", swVersion !== "none", swVersion);
    report("API not cached by SW", sw.includes('req.url.includes("/api/")'), "");
    report("app code current", idx.includes("mc_cfg_v3"), "index.html has latest config key");
  } catch (err) {
    report("served assets", false, err.message);
  }
}

async function main() {
  const started = Date.now();
  await checkServer();
  await checkPublic();
  await checkServedAssets();
  const t = await runTests();
  const summary = `${t.out.match(/# (pass|fail|tests) \d+/g)?.join(", ") || "no summary"}`;
  report("test suite", t.code === 0, summary);
  console.log(failures ? `MONITOR FAIL (${failures})` : `MONITOR OK (${Date.now() - started}ms)`);
  process.exit(failures ? 1 : 0);
}

main();
