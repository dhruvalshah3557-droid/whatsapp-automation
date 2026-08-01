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
