#!/usr/bin/env bash
# codex と非互換な claude-plugins-official / security-guidance フックを検出・無効化する。
#
# なぜ必要か:
#   security-guidance の hook (security_reminder_hook.py) は Claude Code の出力契約に
#   合わせて stdout に {"metrics": {...}} を必ず書く (rewakeSummary / async も付く)。
#   一方 codex の hook 出力スキーマ (stop.command.output ほか) は
#   additionalProperties: false なので、これらは未知キーとして拒否され
#   "hook returned invalid stop hook JSON output" になる。
#   SECURITY_GUIDANCE_DISABLE=1 の kill switch 経路も metrics を出すため、
#   環境変数では回避できない。codex 側でプラグインごと無効化するしかない。
#   security-guidance は hooks しか提供していない (skill / command なし) ので、
#   無効化して失うのは「codex では元々動かない security review」だけ。
#
# Usage:
#   scripts/codex-hook-compat.sh [check|disable]
#
#   check    (既定) 非互換な状態なら exit 1、それ以外は exit 0
#   disable  enabled = false へ冪等に書き換える
#
# 注意: codex の /hooks TUI も ~/.codex/config.toml を自動保存するため、
#       disable は実行中の codex セッションを閉じてから走らせること。

set -euo pipefail

PLUGIN_ID='security-guidance@claude-plugins-official'
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"

usage() {
  cat <<EOF
Usage: scripts/codex-hook-compat.sh [check|disable]

  check    (default) exit 1 when plugin '$PLUGIN_ID' is enabled for codex
  disable  idempotently set 'enabled = false' for that plugin

Target file: $CODEX_CONFIG (override with CODEX_HOME)
Close running codex sessions before 'disable' — the /hooks TUI autosaves the
same file.
EOF
}

# 0 = 非互換 (プラグインが有効), 1 = 問題なし
is_enabled() {
  [[ -f "$CODEX_CONFIG" ]] || return 1
  awk '
    /^[[:space:]]*\[/ {
      in_sg = ($0 ~ /^[[:space:]]*\[plugins\."security-guidance@claude-plugins-official"\]/)
      next
    }
    in_sg && /^[[:space:]]*enabled[[:space:]]*=[[:space:]]*true/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$CODEX_CONFIG"
}

cmd_check() {
  if is_enabled; then
    cat >&2 <<EOF
[codex-hook-compat] NG: plugin '$PLUGIN_ID' is enabled in $CODEX_CONFIG
  Its hooks write stdout keys that codex rejects (additionalProperties: false),
  so Stop / PostToolUse / SessionStart fail with "invalid ... JSON output".
  Fix: bash scripts/codex-hook-compat.sh disable
EOF
    return 1
  fi
  echo "[codex-hook-compat] OK: plugin '$PLUGIN_ID' is not enabled for codex"
  return 0
}

cmd_disable() {
  if ! is_enabled; then
    echo "[codex-hook-compat] no change: plugin '$PLUGIN_ID' is already disabled or not installed"
    return 0
  fi

  # 同一ディレクトリの mktemp + mv でアトミックに置換する
  local tmp
  tmp=$(mktemp "$(dirname "$CODEX_CONFIG")/.codex-hook-compat.XXXXXX")
  awk '
    /^[[:space:]]*\[/ {
      in_sg = ($0 ~ /^[[:space:]]*\[plugins\."security-guidance@claude-plugins-official"\]/)
      print
      next
    }
    in_sg && /^[[:space:]]*enabled[[:space:]]*=[[:space:]]*true/ {
      sub(/true/, "false")
    }
    { print }
  ' "$CODEX_CONFIG" > "$tmp"
  mv "$tmp" "$CODEX_CONFIG"

  echo "[codex-hook-compat] disabled plugin '$PLUGIN_ID' in $CODEX_CONFIG"
  return 0
}

case "${1:-check}" in
  check) cmd_check ;;
  disable) cmd_disable ;;
  -h | --help) usage ;;
  *)
    echo "Error: unknown subcommand '$1'" >&2
    usage >&2
    exit 2
    ;;
esac
