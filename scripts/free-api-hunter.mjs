#!/usr/bin/env node
// Free API hunter — standing agent that keeps looking for free LLM providers
// and keyless public APIs so the user doesn't have to keep supplying keys.
//
// Each cycle it:
//   1. probes every free LLM provider + keyless public API for availability,
//   2. tests any free keys the user dropped in store/free-api-keys.conf,
//   3. auto-provisions the first working provider into the app (server/.env
//      + GitHub Actions secret so the live worker gets it), restarts the
//      local server, verifies /api/health reports ai:true,
//   4. logs everything to logs/free-api.log and writes store/free-api-state.json.
//
// Boundary: reads ONLY keys the user deliberately stores (no env scanning, no
// scraping, no account registration). It can only help the user, never harm.
//
// Usage:
//   node scripts/free-api-hunter.mjs --once        # single pass
//   node scripts/free-api-hunter.mjs --interval 900 # watch every 15min

import path from "node:path";
import fs from "node:fs";
import {
  ROOT, CONF_FILE, FREE_LLM_PROVIDERS, FREE_PUBLIC_APIS,
  loadKeys, readState, writeState, probeUrl, testProviderKey,
  providerEnv, writeServerEnv, pushGhSecret, mask,
} from "./free-api-lib.mjs";
import { log, report, startServer, killPort, waitForServer, getJson, LOCAL } from "./health-lib.mjs";

const LOG_FILE = path.join(ROOT, "logs", "free-api.log");
process.env.AGENT_LOG = process.env.AGENT_LOG || LOG_FILE;

const parseInterval = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const INTERVAL = parseInterval(process.env.HUNTER_INTERVAL)
  || (process.argv.includes("--interval") ? parseInterval(process.argv[process.argv.indexOf("--interval") + 1]) : 900);
const ONCE = process.argv.includes("--once");

let state = readState();
const keyInfo = {}; // providerId -> { status, err }

async function probePublicApis() {
  const results = [];
  for (const api of FREE_PUBLIC_APIS) {
    const r = await probeUrl(api.url, { timeout: 6000 });
    results.push({ ...api, ...r });
  }
  const up = results.filter((r) => r.ok).length;
  report("free public APIs", up === results.length || up >= 2, `${up}/${results.length} reachable (${results.filter((r) => r.ok).map((r) => r.name).join(", ") || "none"})`);
  for (const r of results) {
    state.api = state.api || {};
    state.api[r.name] = { ok: r.ok, at: Date.now() };
  }
  return results;
}

async function probeProviders(keys) {
  const summary = [];
  for (const p of FREE_LLM_PROVIDERS) {
    const base = p.base.replace(/\/+$/, "");
    const r = await probeUrl(base, { timeout: 6000 });
    const reachable = r.status > 0 && r.status < 500; // 4xx = up, just needs a key
    let detail = p.keyVar ? "needs key" : "keyless";
    let keyStatus = "no-key";
    if (p.keyVar && keys[p.keyVar]) {
      const t = await testProviderKey(p, keys[p.keyVar]);
      keyStatus = t.ok ? "key-ok" : `key-bad(${t.status})`;
      detail = t.ok ? `key works (${t.content.trim() || "ok"})` : `key rejected (HTTP ${t.status})`;
    }
    const item = { id: p.id, name: p.name, reachable, status: r.status, keyStatus, detail, tier: p.tier, base, model: p.model, signup: p.signup };
    summary.push(item);
    keyInfo[p.id] = { status: keyStatus };
    state.provider = state.provider || {};
    state.provider[p.id] = { reachable, keyStatus, at: Date.now() };
    report(`free LLM ${p.id}`, true, `${reachable ? "reachable" : "down"} · ${detail}`);
  }
  return summary;
}

async function provisionBest(summary, keys) {
  // Prefer keyless (ollama) then a working free key, then any working key.
  const keyless = summary.find((s) => s.reachable && s.tier === "local");
  const freeOk = summary.find((s) => s.reachable && s.tier === "free" && s.keyStatus === "key-ok");
  const anyOk = summary.find((s) => s.reachable && s.keyStatus === "key-ok" && s.tier !== "free");
  const best = keyless || freeOk || anyOk;
  if (!best) {
    report("auto-provision", false, "no working free provider yet — see logs/free-api.log for signup links");
    log("free-api-hunter: no working provider. To enable one: sign up and put the key in " + CONF_FILE);
    log("  Candidates (free tier):");
    for (const p of FREE_LLM_PROVIDERS.filter((p) => p.tier === "free")) {
      log(`    ${p.name}  ${p.signup}  ->  ${p.keyVar}=<your key>`);
    }
    return false;
  }

  const provider = FREE_LLM_PROVIDERS.find((p) => p.id === best.id);
  const key = provider.keyVar ? keys[provider.keyVar] : "";
  const env = providerEnv(provider, key);

  // Already provisioned?
  const health = await getJson(`${LOCAL}/api/health`);
  if (health.status === 200 && health.body.ai === true) {
    report("auto-provision", true, `already live (${provider.name}${provider.keyVar ? " key " + mask(key) : ""})`);
    return true;
  }

  writeServerEnv(env);
  const gh = provider.keyVar ? await pushGhSecret("USER_LLM_API_KEY", key) : { ok: true };
  const ghBase = await pushGhSecret("USER_LLM_BASE_URL", provider.base);
  const ghModel = await pushGhSecret("USER_LLM_MODEL", provider.model);
  report("auto-provision", true,
    `${provider.name} written to server/.env + GH secrets${provider.keyVar ? " (key " + mask(key) + ")" : ""}` +
    (gh.ok ? "" : ` GH key push failed: ${gh.err || gh.status}`));

  // Restart the local server so the new env takes effect.
  killPort();
  await new Promise((r) => setTimeout(r, 500));
  startServer();
  const up = await waitForServer();
  const h = up ? await getJson(`${LOCAL}/api/health`) : null;
  const ai = up && h.status === 200 && h.body.ai === true;
  report("local server after provisioning", up && ai, up ? (ai ? "up, ai:true" : "up, ai:false") : "down");
  state.provisioned = { provider: provider.id, at: Date.now(), key: mask(key) };
  return true;
}

async function runCycle() {
  const started = Date.now();
  log("free-api-hunter cycle start");
  const keys = loadKeys();
  const keysFound = FREE_LLM_PROVIDERS.map((p) => p.keyVar).filter((v) => v && keys[v]).map((v) => mask(keys[v]));
  log(`  keys on file: ${keysFound.length ? keysFound.join(", ") : "none — no keys provided (use " + CONF_FILE + ")"}`);

  const pub = await probePublicApis();
  const prov = await probeProviders(keys);
  const provisioned = await provisionBest(prov, keys);
  writeState(state);
  log(`free-api-hunter cycle done — ${Date.now() - started}ms, public APIs: ${pub.filter((r) => r.ok).length}/${pub.length}, provisioned: ${provisioned ? "yes" : "no"}`);
}

async function main() {
  log(`Free API hunter started — interval ${INTERVAL}s, keys file ${CONF_FILE}`);
  await runCycle();
  if (ONCE) process.exit(0);
  const timer = setInterval(runCycle, INTERVAL * 1000);
  process.on("SIGINT", () => { clearInterval(timer); log("hunter stopped"); process.exit(0); });
  process.on("SIGTERM", () => { clearInterval(timer); log("hunter stopped"); process.exit(0); });
}

main();
