#!/usr/bin/env bash
# config-lib.sh — cmux-team-dispatch-task の設定パスと値検証を 1 箇所に集約する
# source 専用ヘルパー。実行してはならない。
#
# ここに置くのは「複数のスクリプトが同じ判断をする必要があるもの」だけ:
#   - 設定ファイルのパス解決 (DISPATCH_CONFIG_HOME / RUNNERS_CONFIG_PATH)
#   - runner 名 / model 値の拒否条件。値は zsh -ic "... '<prompt>' ..." の二重引用を
#     通って再実行されるため、引用を破る文字を 1 箇所で弾く
#   - effort の小文字正規化と engine 別 allowlist。ユーザーは "xHigh" と書きうる
#   - ロール名・cmux ID・組込み既定値・model 省略可否の表
#
# source する側: config-edit.sh / config-resolve.sh / prewarm-panes.sh /
#                render-loop-prompt.sh / terminal-wait.sh / launch-workspace.sh

dispatch_config_home() {
  printf '%s\n' "${DISPATCH_CONFIG_HOME:-$HOME/.claude/config/cmux-team-dispatch-task}"
}

dispatch_config_file() { printf '%s/config.json\n' "$(dispatch_config_home)"; }

dispatch_project_config_file() { printf '%s/.dispatch/config.json\n' "$1"; }

# RUNNERS_CONFIG_PATH は runners.json だけの個別 override。既存テスト 14 本が使う。
dispatch_runners_file() {
  printf '%s\n' "${RUNNERS_CONFIG_PATH:-$(dispatch_config_home)/runners.json}"
}

dispatch_role_names() { printf 'design\ndesign_review\nexec\nexec_review\n'; }

# launch-workspace.sh が cmux 出力から採用する ref と同じ strict 形式だけを許す。
# shell-safe なだけの自由文字列は、read-screen / close-surface の対象に使わない。
dispatch_valid_workspace_id() { [[ "$1" =~ ^workspace:[0-9]+$ ]]; }
dispatch_valid_surface_id() { [[ "$1" =~ ^surface:[0-9]+$ ]]; }

# 空・前後の空白・シェルメタ文字・制御文字を拒否する。内部の空白は許容する
# (前後の空白を黙ってトリムすると「入力した値と違う値が保存される」ため弾く)。
_dispatch_valid_shell_value() {
  local v="$1"
  [[ -n "$v" ]] || return 1
  case "$v" in
    [[:space:]]*|*[[:space:]]) return 1 ;;
  esac
  case "$v" in
    *\'*|*\"*|*\`*|*\$*|*\\*|*!*) return 1 ;;
  esac
  case "$v" in
    *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

dispatch_valid_runner_name() { _dispatch_valid_shell_value "$1"; }
dispatch_valid_model() { _dispatch_valid_shell_value "$1"; }

dispatch_normalize_effort() { printf '%s\n' "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"; }

dispatch_valid_effort() {
  case "$2" in
    claude) case "$1" in low|medium|high|xhigh|max) return 0 ;; *) return 1 ;; esac ;;
    codex)  case "$1" in minimal|low|medium|high|xhigh) return 0 ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

# codex には既定 model が無い (codex 側のデフォルトに委ねる)。
dispatch_default_model() {
  [[ "$2" == claude ]] || { printf '\n'; return 0; }
  case "$1" in
    exec) printf 'sonnet\n' ;;
    design|design_review|exec_review) printf 'opus[1m]\n' ;;
    *) printf '\n' ;;
  esac
}

dispatch_default_effort() {
  case "$1" in
    exec) printf 'high\n' ;;
    *) printf 'xhigh\n' ;;
  esac
}

# claude は既定値が必ず埋まるので常に必須。codex は review 2 ロールだけ必須で、
# design / exec は省略可 (codex 側デフォルトに委ねる)。
dispatch_model_required() {
  [[ "$2" == codex ]] || return 0
  case "$1" in
    design_review|exec_review) return 0 ;;
    *) return 1 ;;
  esac
}
