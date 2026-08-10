# AGENTS.md

## Automatic Git Save Rule

Every time a coding task is completed in this workspace, the changes MUST be committed and pushed to GitHub automatically. Do not wait for the user to ask.

### Steps after completing any task

1. Check what changed:

```bash
git status
git diff --stat
```

2. Stage and commit the changes with a descriptive message:

```bash
git add -A
git commit -m "<concise description of the change>"
```

3. Push to the remote (the project is backed up to two remotes):

```bash
git push origin main
git push backup main:colourdiam-messaging
```

### Rules

- Always push after committing. Never leave commits only on the local machine.
- `origin` = `github.com/dhruvalshah3557-droid/whatsapp-automation` (branch `main`). `backup` = `github.com/zebbern/no-cost-ai`, pushed to branch `colourdiam-messaging` so the existing project in that repo is preserved.
- If the push fails due to divergent branches, pull with rebase first, then push:

```bash
git pull --rebase origin main
git push origin main
git push backup main:colourdiam-messaging
```

- Branch names follow the convention `YYMMDD-(feat|fix|chore|refactor)-short-description`.

## Task Tracking Rule (save tasks + status to GitHub)

The repo's `TASKS.md` file is the single source of truth for task status. It lets any new session resume work that was interrupted.

### At session start

1. Read `TASKS.md`.
2. Find the first pending task (a bullet starting with `- [ ]`).
3. If a pending task exists, treat it as the active task and continue working on it before accepting new work.

### Monitoring agent (keep checking and fixing)

A self-healing monitor lives in `scripts/monitor.mjs` (single check, exit code) and a standing auto-healing agent lives in `scripts/agent.mjs` (continuous loop). Treat them as the standing "agents" that keep the stack healthy.

The 24/7 deep-QA agent lives in `scripts/qa-agent.mjs` (standing loop, default 180s). On top of the health pass it probes real API contracts (products, wa/status, memory, events, auth login+me), sanity-checks the served app (chat pane, composer, auth screen, WhatsApp Web card), and re-triggers the Cloudflare worker deploy when it serves a stale app version. `.github/workflows/qa-cron.yml` runs the full suite + live-worker probes every 3h on GitHub's servers so QA continues even when the sandbox hibernates. Start the QA agent in a background terminal during a live session:

```bash
node scripts/qa-agent.mjs            # every 180s
node scripts/qa-agent.mjs --once     # single deep-QA pass
```

- At the start of every session (and before finishing), run:

```bash
node scripts/monitor.mjs --fix
```

  It checks the local webhook server, the public preview API, that the service worker never caches `/api` calls, that the served app code is current, and the full test suite. With `--fix` it restarts the server if it is down. Exit code 0 = healthy, 1 = something failed that must be fixed before stopping.
- If the monitor reports failures, fix them and re-run until `MONITOR OK`.
- The standing agent (`scripts/agent.mjs`) runs the same checks every 60s, logs each cycle to `logs/agent.log`, and auto-heals: it restarts the webhook server if it is down, kills a stale process occupying the port, and re-verifies the Meta webhook handshakes. Start it in a background terminal during a live session:

```bash
node scripts/agent.mjs --interval 60
```

  Run it with `--once` for a single check+heal pass. Check the agent's live output with the background terminal log; any `FAIL` line means an issue was found that must be fixed.

### Free API hunter (keep finding free LLM/APIs)

A standing agent (`scripts/free-api-hunter.mjs`) keeps watching for free LLM providers and keyless public APIs so the user doesn't have to keep supplying keys. Each cycle it probes every provider/API in `scripts/free-api-lib.mjs`, tests any free keys the user stored in `store/free-api-keys.conf` (git-ignored, template at `store/free-api-keys.example`), and auto-provisions the first working provider into the app (`server/.env` + GitHub Actions secret, then restarts the local server). Logs to `logs/free-api.log`, state in `store/free-api-state.json`.

```bash
node scripts/free-api-hunter.mjs --once          # single pass
node scripts/free-api-hunter.mjs --interval 900  # watch every 15 min (standing)
```

Boundary: it only reads keys the user deliberately stores — no environment scanning, no key scraping, no account registration.

### When a new task arrives

1. Add a pending entry to `TASKS.md`:

```markdown
- [ ] YYMMDD: <task description> — status: pending
```

2. Commit and push the tracker update immediately (so the task is saved even if work is interrupted).

### When a task is completed

1. Mark the entry finished and note what was done:

```markdown
- [x] YYMMDD: <task description> — status: finished
  - Done: <what was completed> (commit <short-sha>)
```

2. Commit and push the tracker update together with the task's code changes.

### Rules

- Always keep the latest task status in `TASKS.md` and push it to GitHub.
- Never leave a task marked pending after it is finished.
- Never leave work uncommitted at the end of a session — commit and push before stopping.
- If work is interrupted mid-task, leave the task as pending in `TASKS.md` and commit the partial work so it can be resumed.
