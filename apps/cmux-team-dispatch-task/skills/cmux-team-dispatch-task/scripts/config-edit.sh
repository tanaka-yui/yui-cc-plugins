#!/usr/bin/env bash
set -euo pipefail

# config-edit.sh — cmux-team-dispatch-task の config.json を原子的に読み書きする。
#
# `--setup` / `--reset` および「常に〜」の永続化から呼ばれる唯一の書き込み口。
# SKILL.md の正準パターン (writer 固有 mktemp + jq merge + jq 成功時のみ同一
# directory へ mv) をスクリプト側で保証し、呼び出しごとに jq を組み立て直すことで
# 起きるマージ漏れを防ぐ。特に terminal-wait.sh が所有する `shell_ready_ms` は
# このスクリプトが知らないキーだが、必ず保持する (置換ではなくマージ)。
#
# 複数の --set / --unset は 1 つの jq 式に合成され、1 回の mv で反映される。
# 途中まで書けた中間状態は外から観測されない。
#
# Usage: config-edit.sh --config <path> [--set <key>=<value>]... [--unset <key>]...
#        config-edit.sh --config <path> --get <key>
#        config-edit.sh --config <path> --show
#
#   --config <path>      対象 config.json。グローバルは
#                        ~/.claude/cmux-team-dispatch-task/config.json、
#                        プロジェクトは <repo>/.dispatch/config.json
#   --set <key>=<value>  キーを設定する (繰り返し可)
#   --unset <key>        キーを削除する (繰り返し可)。未設定に戻す用
#   --get <key>          値を stdout に出す。未設定・ファイル未存在なら空
#   --show               config 全体を整形して stdout に出す
#
# 扱えるキーは役割キー 5 つだけ。未知キー・不正値は exit 2 で弾く。
#   design_runner  runners[].name または "ask"
#   review_runner  runners[].name または "ask"
#   exec_choice    "claude" | "codex" | "ask"
#   review_mode    "on" | "off" | "ask"
#   prewarm        true | false (JSON boolean として書き込む)
# runner 名が runners.json に実在するかの確認は呼び出し側 (SKILL.md) の責務。
#
# exit code: 0 成功 / 1 書き込み・読み取り失敗 / 2 usage・検証エラー

die_usage() {
  echo "config-edit: $1" >&2
  echo 'Usage: config-edit.sh --config <path> [--set <key>=<value>]... [--unset <key>]...' >&2
  echo '       config-edit.sh --config <path> --get <key>' >&2
  echo '       config-edit.sh --config <path> --show' >&2
  exit 2
}

known_key() {
  case "$1" in
    design_runner|review_runner|exec_choice|review_mode|prewarm) return 0 ;;
    *) return 1 ;;
  esac
}

# 値が当該キーの取り得る範囲に収まっているか。範囲外は呼び出し側のバグなので弾く。
valid_value() {
  case "$1" in
    prewarm)
      [[ "$2" == 'true' || "$2" == 'false' ]] ;;
    review_mode)
      case "$2" in on|off|ask) return 0 ;; *) return 1 ;; esac ;;
    exec_choice)
      case "$2" in claude|codex|ask) return 0 ;; *) return 1 ;; esac ;;
    design_runner|review_runner)
      [[ -n "$2" ]] ;;
    *)
      return 1 ;;
  esac
}

CONFIG=""
GET_KEY=""
SHOW=0
FILTER=""
JQ_ARGS=()
MUTATE=0
ARG_INDEX=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || die_usage '--config requires a value'
      CONFIG="$2"; shift 2
      ;;
    --set)
      [[ $# -ge 2 ]] || die_usage '--set requires <key>=<value>'
      case "$2" in
        *=*) ;;
        *) die_usage "--set must be <key>=<value>: $2" ;;
      esac
      set_key="${2%%=*}"
      set_value="${2#*=}"
      known_key "$set_key" || die_usage "unknown key: $set_key"
      valid_value "$set_key" "$set_value" || die_usage "invalid value for $set_key: $set_value"
      ARG_INDEX=$((ARG_INDEX + 1))
      if [[ "$set_key" == 'prewarm' ]]; then
        # boolean は文字列 "true" ではなく JSON boolean として書く
        JQ_ARGS+=(--argjson "v$ARG_INDEX" "$set_value")
      else
        JQ_ARGS+=(--arg "v$ARG_INDEX" "$set_value")
      fi
      # キーは allowlist 済みなので jq 式へ直接埋めてよい
      FILTER="${FILTER:+$FILTER | }.${set_key} = \$v$ARG_INDEX"
      MUTATE=1
      shift 2
      ;;
    --unset)
      [[ $# -ge 2 ]] || die_usage '--unset requires a key'
      known_key "$2" || die_usage "unknown key: $2"
      FILTER="${FILTER:+$FILTER | }del(.${2})"
      MUTATE=1
      shift 2
      ;;
    --get)
      [[ $# -ge 2 ]] || die_usage '--get requires a key'
      known_key "$2" || die_usage "unknown key: $2"
      GET_KEY="$2"; shift 2
      ;;
    --show)
      SHOW=1; shift
      ;;
    *)
      die_usage "unknown argument: $1"
      ;;
  esac
done

[[ -n "$CONFIG" ]] || die_usage '--config is required'

# モードは 1 つだけ。読み取りと書き込みを 1 回の呼び出しに混ぜない。
mode_count=$((MUTATE + SHOW))
[[ -n "$GET_KEY" ]] && mode_count=$((mode_count + 1))
[[ "$mode_count" -eq 1 ]] \
  || die_usage 'specify exactly one of --set/--unset, --get, or --show'

if [[ -n "$GET_KEY" ]]; then
  [[ -f "$CONFIG" ]] || exit 0
  if ! jq -r --arg k "$GET_KEY" '.[$k] // empty' "$CONFIG" 2>/dev/null; then
    echo "config-edit: cannot read $CONFIG (invalid JSON?)" >&2
    exit 1
  fi
  exit 0
fi

if [[ "$SHOW" -eq 1 ]]; then
  if [[ ! -f "$CONFIG" ]]; then
    echo '{}'
    exit 0
  fi
  if ! jq '.' "$CONFIG" 2>/dev/null; then
    echo "config-edit: cannot read $CONFIG (invalid JSON?)" >&2
    exit 1
  fi
  exit 0
fi

mkdir -p "$(dirname "$CONFIG")"

# 共有 $CONFIG.tmp は並列書き込みで壊れるため必ず writer 固有の mktemp を使う。
if ! TMP=$(mktemp "$CONFIG.XXXXXX"); then
  echo 'config-edit: mktemp failed; nothing was written' >&2
  exit 1
fi

# jq が失敗したまま mv すると config を空にしてしまうので、成功時だけ mv する。
if [[ -f "$CONFIG" ]]; then
  jq_ok=0
  jq ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} "$FILTER" "$CONFIG" > "$TMP" 2>/dev/null || jq_ok=1
else
  jq_ok=0
  jq -n ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} "{} | $FILTER" > "$TMP" 2>/dev/null || jq_ok=1
fi

if [[ "$jq_ok" -ne 0 ]]; then
  rm -f "$TMP"
  echo "config-edit: write failed (existing config broken?); $CONFIG is unchanged" >&2
  exit 1
fi

mv "$TMP" "$CONFIG"
