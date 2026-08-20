#!/usr/bin/env bash
set -euo pipefail

# runners-edit.sh — cmux-team-dispatch-task の runners.json を原子的に読み書きする。
#
# `--setup` の S3-M（登録済み runner の model / effort 編集）から呼ばれる唯一の書き込み口。
# config-edit.sh と同型の契約 (writer 固有 mktemp + jq + jq 成功時のみ同一 directory へ mv)
# をスクリプト側で保証し、呼び出しごとに jq を組み立て直すことで起きるマージ漏れを防ぐ。
#
# 扱えるのは役割別の model / effort 6 フィールドだけ。runner の同一性
# (name / command / engine) と default には触らない。
#
# Usage: runners-edit.sh --runners <path> --name <runner> [--set <field>=<value>]... [--unset <field>]... [--dry-run]
#        runners-edit.sh --runners <path> --name <runner> --get <field>
#        runners-edit.sh --runners <path> [--name <runner>] --show
#
#   --runners <path>     対象 runners.json。既定の場所は
#                        ~/.claude/cmux-team-dispatch-task/runners.json
#   --name <runner>      対象 runner の name。--set / --unset / --get では必須
#   --set <field>=<value> フィールドを設定する (繰り返し可)
#   --unset <field>      フィールドを削除する (繰り返し可)。不在でも成功 (冪等)
#   --dry-run            書き込まず、適用後の当該レコードだけを stdout に出す
#   --get <field>        値を stdout に出す。未設定なら空。値が文字列であることを前提と
#                        する (手編集でオブジェクトが入っていると整形済み複数行を返す)
#   --show               --name 併用でレコード単体、省略時はファイル全体
#
# 検証:
#   フィールドは 6 つの allowlist のみ。未知は exit 2。
#   model は「モデル名の allowlist を作らない」が、空・空白のみ・前後の空白パディング・
#   シェルメタ文字 (' " ` $ \) ・制御文字は exit 2。値は zsh -ic の二重引用を通って
#   再実行されるため。
#   effort は runner レコードの engine 別 allowlist
#   (claude: low|medium|high|xhigh|max / codex: minimal|low|medium|high|xhigh)。
#   codex に max は無い。
#
# exit code: 0 成功 / 1 読み書き失敗 (ファイルは変更されない) / 2 usage・検証エラー

die_usage() {
  echo "runners-edit: $1" >&2
  echo 'Usage: runners-edit.sh --runners <path> --name <runner> [--set <field>=<value>]... [--unset <field>]... [--dry-run]' >&2
  echo '       runners-edit.sh --runners <path> --name <runner> --get <field>' >&2
  echo '       runners-edit.sh --runners <path> [--name <runner>] --show' >&2
  exit 2
}

known_field() {
  case "$1" in
    plan_model|review_model|exec_model|plan_effort|review_effort|exec_effort) return 0 ;;
    *) return 1 ;;
  esac
}

is_model_field() { case "$1" in *_model) return 0 ;; *) return 1 ;; esac; }

# モデル名の allowlist は作らない。空・前後の空白・シェルメタ文字・制御文字だけ弾く。
# 前後の空白を黙ってトリムすると「入力した値と違う値が保存される」ことになるので弾く。
valid_model_value() {
  local v="$1"
  [[ -n "$v" ]] || return 1
  case "$v" in
    [[:space:]]*|*[[:space:]]) return 1 ;;
  esac
  case "$v" in
    *\'*|*\"*|*\`*|*\$*|*\\*) return 1 ;;
  esac
  case "$v" in
    *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

valid_effort_value() {
  case "$2" in
    claude) case "$1" in low|medium|high|xhigh|max) return 0 ;; *) return 1 ;; esac ;;
    codex)  case "$1" in minimal|low|medium|high|xhigh) return 0 ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

RUNNERS=""
NAME=""
GET_FIELD=""
SHOW=0
DRY_RUN=0
MUTATE=0
ARG_INDEX=0
FILTER=""
JQ_ARGS=()
SET_FIELDS=" "
UNSET_FIELDS=" "
EFFORT_CHECKS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runners)
      [[ $# -ge 2 ]] || die_usage '--runners requires a value'
      # 繰り返し不可のフラグは last-wins で黙って通さない。S6 のプレビューを組み立てる
      # LLM がフラグを重ねたとき、別フィールドの値を「現在値」として提示しうるため。
      # 空文字は「未指定」と区別しない (S3-M で空名は流れない)。boolean の --show /
      # --dry-run は値を持たず曖昧さが無いので重複を許す。
      [[ -z "$RUNNERS" ]] || die_usage '--runners given more than once'
      RUNNERS="$2"; shift 2 ;;
    --name)
      [[ $# -ge 2 ]] || die_usage '--name requires a value'
      [[ -z "$NAME" ]] || die_usage '--name given more than once'
      NAME="$2"; shift 2 ;;
    --set)
      [[ $# -ge 2 ]] || die_usage '--set requires <field>=<value>'
      case "$2" in
        *=*) ;;
        *) die_usage "--set must be <field>=<value>: $2" ;;
      esac
      set_field="${2%%=*}"
      set_value="${2#*=}"
      known_field "$set_field" || die_usage "unknown field: $set_field"
      case "$SET_FIELDS" in *" $set_field "*) die_usage "duplicate --set for $set_field" ;; esac
      case "$UNSET_FIELDS" in *" $set_field "*) die_usage "--set and --unset for the same field: $set_field" ;; esac
      if is_model_field "$set_field"; then
        valid_model_value "$set_value" \
          || die_usage "invalid model value for $set_field (empty, leading/trailing whitespace, or contains a shell metacharacter or a control character)"
      else
        # engine はレコードを読むまで分からないので、後で照合する
        EFFORT_CHECKS+=("$set_field=$set_value")
      fi
      SET_FIELDS="$SET_FIELDS$set_field "
      ARG_INDEX=$((ARG_INDEX + 1))
      JQ_ARGS+=(--arg "v$ARG_INDEX" "$set_value")
      # フィールド名は allowlist 済みなので jq 式へ直接埋めてよい。値は必ず --arg 経由。
      FILTER="${FILTER:+$FILTER | }.${set_field} = \$v$ARG_INDEX"
      MUTATE=1
      shift 2 ;;
    --unset)
      [[ $# -ge 2 ]] || die_usage '--unset requires a field'
      known_field "$2" || die_usage "unknown field: $2"
      case "$SET_FIELDS" in *" $2 "*) die_usage "--set and --unset for the same field: $2" ;; esac
      case "$UNSET_FIELDS" in *" $2 "*) die_usage "duplicate --unset for $2" ;; esac
      UNSET_FIELDS="$UNSET_FIELDS$2 "
      FILTER="${FILTER:+$FILTER | }del(.${2})"
      MUTATE=1
      shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    --get)
      [[ $# -ge 2 ]] || die_usage '--get requires a field'
      known_field "$2" || die_usage "unknown field: $2"
      [[ -z "$GET_FIELD" ]] || die_usage '--get given more than once'
      GET_FIELD="$2"; shift 2 ;;
    --show)
      SHOW=1; shift ;;
    *)
      die_usage "unknown argument: $1" ;;
  esac
done

[[ -n "$RUNNERS" ]] || die_usage '--runners is required'

mode_count=$((MUTATE + SHOW))
[[ -n "$GET_FIELD" ]] && mode_count=$((mode_count + 1))
[[ "$mode_count" -eq 1 ]] \
  || die_usage 'specify exactly one of --set/--unset, --get, or --show'
[[ "$DRY_RUN" -eq 0 || "$MUTATE" -eq 1 ]] || die_usage '--dry-run requires --set or --unset'
if [[ "$MUTATE" -eq 1 || -n "$GET_FIELD" ]]; then
  [[ -n "$NAME" ]] || die_usage '--name is required for --set/--unset/--get'
fi

# 検証はすべて mktemp より前に完了する。trap は引数パース直後に張る:
# 検証エラーの exit 経路と mktemp 経路で trap の有無を分岐させないためと、
# mktemp 〜 mv の窓を SIGINT / SIGTERM / SIGHUP から守るため。
# trap 本体は必ず成功で終わる形にする (rm -f の -f を外すと exit 2 が exit 1 に化ける)。
TMP=""
trap 'rm -f "${TMP:-}"' EXIT

# -e ではなく -f を使う。-e だとディレクトリを渡したとき偽成功する。
if [[ ! -f "$RUNNERS" ]]; then
  if [[ "$MUTATE" -eq 1 ]]; then
    die_usage "$RUNNERS does not exist; creating the registry is First-run setup's job"
  fi
  if [[ -n "$GET_FIELD" ]]; then exit 0; fi
  echo '{}'
  exit 0
fi

if ! DOC=$(jq . "$RUNNERS" 2>/dev/null); then
  echo "runners-edit: cannot read $RUNNERS (invalid JSON or unreadable)" >&2
  exit 1
fi
# jq は 0 バイト入力・空白のみ入力に rc=0 を返すので、別途弾く。
if [[ -z "${DOC//[[:space:]]/}" ]]; then
  echo "runners-edit: $RUNNERS is empty" >&2
  exit 1
fi

if [[ -n "$NAME" ]]; then
  if [[ "$(jq -r '.runners | type' <<<"$DOC" 2>/dev/null)" != array ]]; then
    echo "runners-edit: .runners is not an array in $RUNNERS" >&2
    exit 2
  fi
  # jq が失敗しても空文字になり "1" と等しくならない
  # (型安全 select にした今 || echo '' は到達不能な安全弁。select を戻したときのため残す)
  MATCHES=$(jq --arg n "$NAME" \
    '[.runners[] | select((type == "object") and .name == $n)] | length' \
    <<<"$DOC" 2>/dev/null || echo '')
  if [[ "$MATCHES" != 1 ]]; then
    echo "runners-edit: --name '$NAME' must match exactly one runner (matched: ${MATCHES:-error})" >&2
    exit 2
  fi
fi

# effort の照合はレコードの engine を読んでから。--set <*_effort> のときだけ。
if [[ "$MUTATE" -eq 1 && ${#EFFORT_CHECKS[@]} -gt 0 ]]; then
  ENGINE=$(jq -r --arg n "$NAME" \
    'first(.runners[] | select((type == "object") and .name == $n) | .engine // empty)' \
    <<<"$DOC" 2>/dev/null || echo '')
  case "$ENGINE" in
    claude|codex) ;;
    *)
      echo "runners-edit: runner '$NAME' has no usable engine; cannot validate effort" >&2
      exit 2 ;;
  esac
  for chk in ${EFFORT_CHECKS[@]+"${EFFORT_CHECKS[@]}"}; do
    chk_field="${chk%%=*}"
    chk_value="${chk#*=}"
    valid_effort_value "$chk_value" "$ENGINE" \
      || die_usage "invalid effort '$chk_value' for the $ENGINE engine ($chk_field)"
  done
fi

# 読み取りモードはここで結果を出して終わる。--name は必ず --arg、
# フィールド名は allowlist 通過後にのみ式へ埋める。
if [[ -n "$GET_FIELD" ]]; then
  if ! jq -r --arg n "$NAME" \
    "first(.runners[] | select((type == \"object\") and .name == \$n) | .${GET_FIELD} // empty)" \
    <<<"$DOC"; then
    echo "runners-edit: read failed" >&2
    exit 1
  fi
  exit 0
fi

if [[ "$SHOW" -eq 1 ]]; then
  if [[ -n "$NAME" ]]; then
    if ! jq --arg n "$NAME" \
      'first(.runners[] | select((type == "object") and .name == $n))' <<<"$DOC"; then
      echo "runners-edit: read failed" >&2
      exit 1
    fi
  else
    # 手順 3 / 4 はスキップ済み。config-edit.sh と同じ素通し。
    if ! jq '.' <<<"$DOC"; then
      echo "runners-edit: read failed" >&2
      exit 1
    fi
  fi
  exit 0
fi

# 対象 runner だけを写像する。他の要素・default・未知キーはそのまま通す。
# (type == "object") and を省略すると、要素が非オブジェクトのレジストリで jq が rc=5 で死ぬ。
WRITE_FILTER=".runners |= map(if (type == \"object\") and .name == \$n then ($FILTER) else . end)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  # 書き込みは Task 3 で実装する。
  echo 'runners-edit: --dry-run not implemented yet' >&2
  exit 1
fi

# 共有 $RUNNERS.tmp は並列書き込みで壊れるため必ず writer 固有の mktemp を使う。
if ! TMP=$(mktemp "$RUNNERS.XXXXXX"); then
  echo 'runners-edit: mktemp failed; nothing was written' >&2
  exit 1
fi

# jq が失敗したまま mv すると runners.json を壊すので、成功時だけ mv する。
# なおここに到達する失敗の witness は構築できない (手順 3 / 4 を通過した文書では
# 型安全 select が効くため)。意図的に到達困難な安全弁である。
jq ${JQ_ARGS[@]+"${JQ_ARGS[@]}"} --arg n "$NAME" "$WRITE_FILTER" <<<"$DOC" > "$TMP" || {
  rm -f "$TMP"
  echo "runners-edit: write failed (jq error); $RUNNERS is unchanged" >&2
  exit 1
}

mv "$TMP" "$RUNNERS" || {
  rm -f "$TMP"
  echo "runners-edit: move failed; $RUNNERS is unchanged" >&2
  exit 1
}
TMP=""
