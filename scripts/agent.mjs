#!/usr/bin/env node
// Standing self-healing agent for the Colourdiam stack.
// Runs the full health suite every INTERVAL seconds and auto-fixes what it
// can: restarts the local server (killing a stale port process), re-verifies
// webhook handshakes on the preview and the live Cloudflare worker, watches
// the worker deploy status on GitHub Actions (re-runs a failed deploy), and
// reports git drift + uncommitted work. Logs every cycle to logs/agent.log.
//
// Usage:
//   node scripts/agent.mjs              # watch every 60s, auto-heal
//   node scripts/agent.mjs --once       # single check + heal pass, then exit
//   node scripts/agent.mjs --interval 30

import path from "node:path";
import { ROOT, PORT, PUBLIC, parseInterval, runHealthPass, log } from "./health-lib.mjs";

process.env.AGENT_LOG = process.env.AGENT_LOG || path.join(ROOT, "logs", "agent.log");

const INTERVAL = parseInterval(process.env.AGENT_INTERVAL) || (process.argv.includes("--interval") ? parseInterval(process.argv[process.argv.indexOf("--interval") + 1]) : 60);
const ONCE = process.argv.includes("--once");

let consecutiveFails = 0;

async function runCycle() {
  const started = Date.now();
  const healthy = await runHealthPass({ heal: true, autoFix: true });
  consecutiveFails = healthy ? 0 : consecutiveFails + 1;
  log(`${healthy ? "AGENT OK" : "AGENT UNHEALTHY"} — ${Date.now() - started}ms`);
  if (consecutiveFails >= 3) {
    log("AGENT: 3 consecutive unhealthy cycles — inspect logs/agent.log and fix the failing check(s)");
  }
}

async function main() {
  log(`Colourdiam agent started — interval ${INTERVAL}s, server :${PORT}, preview ${PUBLIC}`);
  await runCycle();
  if (ONCE) process.exit(0);

  const timer = setInterval(runCycle, INTERVAL * 1000);
  process.on("SIGINT", () => { clearInterval(timer); log("agent stopped"); process.exit(0); });
  process.on("SIGTERM", () => { clearInterval(timer); log("agent stopped"); process.exit(0); });
}

main();
