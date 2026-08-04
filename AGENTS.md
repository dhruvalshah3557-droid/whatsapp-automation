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

3. Push to the remote:

```bash
git push origin main
```

### Rules

- Always push after committing. Never leave commits only on the local machine.
- If the push fails due to divergent branches, pull with rebase first, then push:

```bash
git pull --rebase origin main
git push origin main
```

- Branch names follow the convention `YYMMDD-(feat|fix|chore|refactor)-short-description`.

## Task Tracking Rule (save tasks + status to GitHub)

The repo's `TASKS.md` file is the single source of truth for task status. It lets any new session resume work that was interrupted.

### At session start

1. Read `TASKS.md`.
2. Find the first pending task (a bullet starting with `- [ ]`).
3. If a pending task exists, treat it as the active task and continue working on it before accepting new work.

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
