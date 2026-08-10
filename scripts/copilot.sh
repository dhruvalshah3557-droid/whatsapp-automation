#!/bin/bash
# GitHub Copilot CLI launcher for this project.
#
# Usage:
#   ./scripts/copilot.sh             -> interactive session (chat)
#   ./scripts/copilot.sh agent       -> autonomous coding-agent mode
#   ./scripts/copilot.sh plan        -> plan mode (combine with agent for auto-approve)
#   ./scripts/copilot.sh auth        -> authenticate with GitHub Copilot
#   ./scripts/copilot.sh "prompt"    -> run a one-shot non-interactive prompt
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v copilot >/dev/null 2>&1; then
  echo "GitHub Copilot CLI is not installed."
  echo "Install it with: npm install -g @github/copilot"
  exit 1
fi

case "${1:-}" in
  agent)
    shift
    exec copilot --mode autopilot "$@"
    ;;
  plan)
    shift
    exec copilot --plan "$@"
    ;;
  auth)
    shift
    exec copilot login "$@"
    ;;
  "" | interactive)
    exec copilot
    ;;
  *)
    exec copilot --prompt "$*"
    ;;
esac
