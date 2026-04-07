#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
bold()  { printf '\033[1m%s\033[0m\n' "$1"; }

bold "=== yui-cc-plugins インストール ==="
echo ""

claude plugin marketplace add "${REPO_DIR}"
green "マーケットプレイス登録完了"
echo ""

claude plugin install cmux-fork@yui-cc-plugins
claude plugin install cmux-using@yui-cc-plugins
claude plugin install cmux-team@yui-cc-plugins
claude plugin install cmux-team-dispatch-task@yui-cc-plugins
echo ""

green "すべてのプラグインのインストールが完了しました。"
