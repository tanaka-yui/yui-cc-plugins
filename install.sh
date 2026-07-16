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
claude plugin install cmux-codex-review@yui-cc-plugins
claude plugin install dev-up@yui-cc-plugins
claude plugin install e2e-test@yui-cc-plugins
claude plugin install token-meter@yui-cc-plugins
echo ""

bold "=== token-meter のセットアップ ==="
(cd "${REPO_DIR}/apps/token-meter" && make deps setup-hooks)
green "token-meter の hook 配線が完了しました"
echo ""

green "すべてのプラグインのインストールが完了しました。"
echo ""
echo "圧縮プラグイン (rtk/caveman/headroom) のインストールは別途必要です:"
echo "  cd apps/token-meter && make install-plugins   # brew/pipx/curl が走ります"
echo "または:"
echo "  cd apps/token-meter && make setup             # 完全セットアップ (上記 + hook 配線)"
