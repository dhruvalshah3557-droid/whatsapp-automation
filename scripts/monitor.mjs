#!/usr/bin/env node
// Colourdiam stack health monitor + self-healer.
// Usage:
//   node scripts/monitor.mjs            # check only
//   node scripts/monitor.mjs --fix      # restart local server + re-run failed worker deploy
// Exit code 0 when healthy, 1 when a check fails.

import { runHealthPass } from "./health-lib.mjs";

const FIX = process.argv.includes("--fix");

const healthy = await runHealthPass({ heal: FIX, autoFix: FIX });
console.log(healthy ? "MONITOR OK" : "MONITOR FAILED");
process.exit(healthy ? 0 : 1);
