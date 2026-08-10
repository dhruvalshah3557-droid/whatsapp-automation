#!/usr/bin/env node
// Shared health-check library for the Colourdiam stack, used by monitor.mjs
// (single pass + exit code) and agent.mjs (continuous self-healing loop).
//
// Checks: local server, public preview API, webhook handshakes (preview +
// live Cloudflare worker), served assets, live worker API/version/memory,
// worker deploy status (GitHub Actions, auto re-run on failure), git sync
// state (uncommitted/ahead/behind), and the full test suite.
// Auto-heals: restarts the local server (killing a stale port process) and
// re-runs a failed worker deploy.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..");

export const PORT = process.env.MONITOR_PORT || "8099";
export const LOCAL = `http://127.0.0.1:${PORT}`;
export const PUBLIC = process.env.PREVIEW_URL || "https://8099-7d57eac4c6f4c5ad.monkeycode-ai.live";
export const WORKER = process.env.WORKER_URL || "https://messaging-webhooks.messaging-webhooks-worker.workers.dev";
export const VERIFY_TOKEN = process.env.MONITOR_VERIFY_TOKEN || "change_me_verify_token";
export const HOOKS = ["whatsapp-hook", "instagram-hook", "facebook-hook"];
export const HOOK_NOTE = "whatsapp/instagram/facebook (Meta GET verify); tiktok/line/wechat verify via POST/SHA1";

let failures = 0;
let lastDeployRerun = null;

export function resetFailures() { failures = 0; }
export function failureCount() { return failures; }

export function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(line) {
  const entry = `[${ts()}] ${line}`;
  console.log(entry);
  const file = process.env.AGENT_LOG;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, entry + "\n");
      if (fs.statSync(file).size > 1_000_000) fs.writeFileSync(file, entry + "\n");
    } catch { /* log file unavailable */ }
  }
}

export function report(name, ok, detail = "") {
  log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

export function parseInterval(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: {} };
  }
}

export async function serverUp(base = LOCAL) {
  const r = await getJson(`${base}/api/health`);
  return r.status === 200 && r.body.ok === true;
}

export function startServer() {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT, VERIFY_TOKEN, STATIC_ROOT: path.join(ROOT, "messaging") },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

export function waitForServer(ms = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      if (await serverUp()) { clearInterval(timer); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(timer); resolve(false); }
    }, 300);
  });
}

export function killPort() {
  const pids = new Set();
  try {
    const out = execFileSync("lsof", ["-ti", ":" + PORT], { encoding: "utf8" }).trim();
    if (out) for (const pid of out.split("\n")) pids.add(Number(pid));
  } catch {}
  if (pids.size === 0) {
    try {
      // lsof not installed (common on slim images) — use ss instead.
      const out = execFileSync("ss", ["-tlnp"], { encoding: "utf8" });
      for (const line of out.split("\n")) {
        if (!line.includes(":" + PORT)) continue;
        const m = line.match(/pid=(\d+)/);
        if (m) pids.add(Number(m[1]));
      }
    } catch {}
  }
  let killed = false;
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); killed = true; } catch {}
  }
  return killed;
}

export async function healServer() {
  log("  -> healing server: killing stale process on :" + PORT);
  killPort();
  await new Promise((r) => setTimeout(r, 500));
  startServer();
  if (await waitForServer()) { report("local server (after heal)", true, "up"); return true; }
  report("local server (after heal)", false, "still down");
  return false;
}

export async function checkServer(heal = false) {
  if (await serverUp()) { report("local server", true, `up on :${PORT}`); return true; }
  if (!heal) { report("local server", false, `down on :${PORT}`); return false; }
  const healed = await healServer();
  if (!healed) report("local server", false, `down on :${PORT}`);
  return healed;
}

export async function checkPublic() {
  const r = await getJson(`${PUBLIC}/api/health`);
  report("public preview API", r.status === 200, r.status === 200 ? "reachable" : `HTTP ${r.status}`);
  return r.status === 200;
}

export async function checkHooks(base = PUBLIC, label = "webhook handshakes") {
  let ok = true;
  for (const hook of HOOKS) {
    const url = `${base}/webhook/${hook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=OK${hook[0]}`;
    try {
      const res = await fetch(url);
      if (res.status !== 200) { ok = false; report(`webhook ${hook}`, false, `HTTP ${res.status}`); }
    } catch { ok = false; report(`webhook ${hook}`, false, "unreachable"); }
  }
  report(label, ok, `${HOOKS.length} hooks (${HOOK_NOTE})`);
  return ok;
}

export async function checkServedAssets(base = PUBLIC) {
  try {
    const sw = await (await fetch(`${base}/sw.js`)).text();
    const idx = await (await fetch(`${base}/index.html`)).text();
    const swVersion = (sw.match(/colourdiam-msg-v\d+/) || [])[0] || "none";
    report("SW version served", swVersion !== "none", swVersion);
    report("API not cached by SW", sw.includes('req.url.includes("/api/")'), "");
    report("app code current", idx.includes("mc_cfg_v3"), "index.html has latest config key");
    return true;
  } catch (err) {
    report("served assets", false, err.message);
    return false;
  }
}

export async function checkWorker() {
  const r = await getJson(`${WORKER}/api/health`);
  const up = r.status === 200 && r.body.ok === true;
  report("worker API", up, up ? "reachable" : `HTTP ${r.status}`);
  try {
    const sw = await (await fetch(`${WORKER}/sw.js`)).text();
    const served = (sw.match(/colourdiam-msg-v\d+/) || [])[0] || "none";
    let repo = "none";
    try {
      repo = (fs.readFileSync(path.join(ROOT, "messaging", "sw.js"), "utf8").match(/colourdiam-msg-v\d+/) || [])[0] || "none";
    } catch {}
    const current = served !== "none" && served === repo;
    report("worker app version", current, `${served} served / ${repo} repo`);
  } catch (err) {
    report("worker app version", false, "sw.js unreachable: " + err.message);
  }
  await checkHooks(WORKER, "worker webhook handshakes");
  return up;
}

/* ---------------- GitHub deploy + git sync ---------------- */

function gitHubCreds() {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: ROOT, encoding: "utf8" }).trim();
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (!m) return null;
    const [, owner, repo] = m;
    const out = execFileSync("git", ["credential", "fill"], {
      cwd: ROOT,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    const pw = (out.match(/^password=(.+)$/m) || [])[1] || "";
    if (!pw) return null;
    return { owner, repo, token: pw };
  } catch {
    return null;
  }
}

async function ghApi(g, apiPath, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${g.owner}/${g.repo}${apiPath}`, {
    method: opts.method || "GET",
    headers: {
      Authorization: "Bearer " + g.token,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export async function checkDeploy(autoFix = false) {
  const g = gitHubCreds();
  if (!g) { report("worker deploy status", false, "no GitHub access (token/remote) — cannot verify"); return false; }
  try {
    const r = await ghApi(g, "/actions/workflows/worker-deploy.yml/runs?per_page=1&branch=main");
    const run = r.body.workflow_runs && r.body.workflow_runs[0];
    if (!run) { report("worker deploy status", false, "no deploy runs found"); return false; }
    if (run.status === "in_progress" || run.status === "queued" || run.status === "waiting") {
      report("worker deploy status", true, `in progress (${run.head_sha.slice(0, 7)})`);
      return true;
    }
    if (run.conclusion === "success") {
      report("worker deploy status", true, `success (${run.head_sha.slice(0, 7)})`);
      return true;
    }
    report("worker deploy status", false, `failed (${run.head_sha.slice(0, 7)})`);
    if (autoFix) {
      if (lastDeployRerun === run.id) {
        report("worker deploy re-run", false, "already re-ran this run — waiting for result");
      } else {
        lastDeployRerun = run.id;
        const rr = await ghApi(g, `/actions/runs/${run.id}/rerun-failed-jobs`, { method: "POST" });
        report("worker deploy re-run", rr.status === 201 || rr.status === 204, rr.status === 201 || rr.status === 204 ? "triggered re-run" : `HTTP ${rr.status}`);
      }
    }
    return false;
  } catch (err) {
    report("worker deploy status", false, "GitHub API error: " + (err && err.message));
    return false;
  }
}

export async function checkGitState() {
  let ok = true;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (status) {
      ok = false;
      report("git working tree", false, `${status.split("\n").length} uncommitted file(s) — commit & push`);
    } else {
      report("git working tree", true, "clean");
    }
  } catch (err) {
    report("git working tree", false, "git unavailable");
    ok = false;
  }
  try {
    execFileSync("git", ["fetch", "origin", "main"], { cwd: ROOT, encoding: "utf8", stdio: "ignore" });
    const ahead = Number(execFileSync("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: ROOT, encoding: "utf8" }).trim());
    const behind = Number(execFileSync("git", ["rev-list", "--count", "HEAD..origin/main"], { cwd: ROOT, encoding: "utf8" }).trim());
    if (ahead > 0) { ok = false; report("git sync", false, `ahead of origin/main by ${ahead} — push needed`); }
    else if (behind > 0) { ok = false; report("git sync", false, `behind origin/main by ${behind} — pull needed`); }
    else report("git sync", true, "in sync with origin/main");
  } catch (err) {
    report("git sync", false, "cannot reach origin/main");
    ok = false;
  }
  return ok;
}

/* ---------------- Free API hunter ---------------- */

export async function checkFreeApi() {
  try {
    const { readState } = await import("./free-api-lib.mjs");
    const state = readState();
    const prov = state.provider || {};
    const live = Object.entries(prov).filter(([, v]) => v.reachable).length;
    const keyed = Object.entries(prov).filter(([, v]) => v.keyStatus === "key-ok").map(([id]) => id);
    const detail = `free-api state: ${live}/${Object.keys(prov).length} providers reachable, ${keyed.length ? "key-ok: " + keyed.join(",") : "no working key on file"}`;
    report("free-api hunter", Object.keys(prov).length > 0, detail);
    return true;
  } catch (err) {
    report("free-api hunter", true, "not yet run — " + err.message);
    return true;
  }
}

/* ---------------- Tests ---------------- */

function runTests() {
  return new Promise((resolve) => {
    const t = spawn(
      process.execPath,
      ["--test", "messaging/test/messaging.test.mjs", "server/test/server.test.mjs", "server/test/site-sync.test.mjs", "server/test/auth.test.mjs", "worker/test/worker.test.mjs"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    t.stdout.on("data", (d) => (out += d));
    t.stderr.on("data", (d) => (out += d));
    t.on("close", (code) => resolve({ code, out }));
  });
}

export async function checkTests() {
  const t = await runTests();
  const summary = `${t.out.match(/# (pass|fail|tests) \d+/g)?.join(", ") || "no summary"}`;
  report("test suite", t.code === 0, summary);
  return t.code === 0;
}

/* ---------------- Full pass ---------------- */

export async function runHealthPass(opts = {}) {
  resetFailures();
  const heal = !!opts.heal;
  await checkServer(heal);
  await checkPublic();
  await checkHooks(PUBLIC);
  await checkServedAssets(PUBLIC);
  await checkWorker();
  await checkDeploy(opts.autoFix);
  await checkGitState();
  await checkFreeApi();
  await checkTests();
  return failureCount() === 0;
}
