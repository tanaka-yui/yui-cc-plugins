#!/usr/bin/env bash
# install.sh — install agent-browser globally (once per machine).

set -euo pipefail

if command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser already installed: $(agent-browser --version 2>&1 || echo 'version unknown')"
else
  echo "installing agent-browser via npm..."
  npm install -g agent-browser
fi

echo "running 'agent-browser install' to fetch Chromium..."
agent-browser install
echo "done."
