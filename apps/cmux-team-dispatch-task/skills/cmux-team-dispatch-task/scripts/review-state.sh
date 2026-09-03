#!/usr/bin/env bash
# review-state.sh — review ディレクトリの状態を 1 か所で計算する。

review_select_active() {
  # $2 = 省略可能な point マッチ指定。"<name>" はその point だけを候補にし、
  # "!<name>" はその point だけを除外する。フォールバックは持たない。
  # role ごとに自分の review point だけを見るためのものだが、包含で書けるのは
  # code 側だけである: Phase B-R の point 名は phase-b-deliver.sh と
  # launch-workspace.sh に code と焼き込まれている。design 側の checkpoint 名は
  # 固定ではなく (superpowers モードは spec と plan の 2 点、無人ループは design)、
  # 特定の名前へ包含スコープすると設計ペインが自分の findings を見失う。
  # そこで design 側は「code 以外すべて」として表す。
  local sd="$1" want_point="${2:-}" f base p n key
  local exclude_point=""
  if [[ "$want_point" == '!'* ]]; then
    exclude_point="${want_point#!}"
    want_point=""
  fi
  RS_POINT=""; RS_ROUND=""; RS_ROUND_FILE=""; RS_REQUEST_FILE=""; RS_ABORT_FILE=""
  RS_HAS_ACTIVITY=0; RS_ANSWER_PENDING=0; RS_ROUND_ABORTED=0
  RS_FINDINGS_UNFINISHED=0; RS_SOFT_CLOSED=0
  [[ -d "$sd/review" ]] || return 0

  local restore_nullglob=0
  shopt -q nullglob || restore_nullglob=1
  shopt -s nullglob
  local -a files=()
  for f in "$sd"/review/*.md; do files+=("$f"); done
  ((restore_nullglob)) && shopt -u nullglob
  ((${#files[@]})) || return 0
  RS_HAS_ACTIVITY=1

  local -a sorted=()
  while IFS= read -r f; do sorted+=("$f"); done < <(printf '%s\n' "${files[@]}" | LC_ALL=C sort)

  local -a keys=()
  for f in "${sorted[@]}"; do
    base=${f##*/}
    [[ "$base" =~ ^(.+)-round-([0-9]+)(-request|-abort)?\.md$ ]] || continue
    [[ -z "$want_point" || "${BASH_REMATCH[1]}" == "$want_point" ]] || continue
    [[ -z "$exclude_point" || "${BASH_REMATCH[1]}" != "$exclude_point" ]] || continue
    key="${BASH_REMATCH[1]}|${BASH_REMATCH[2]}"
    [[ " ${keys[*]-} " == *" $key "* ]] || keys+=("$key")
  done
  ((${#keys[@]})) || { RS_HAS_ACTIVITY=0; return 0; }

  local best_pending="" best_pending_file="" best_any="" best_any_file=""
  local request findings abort newest pending
  for key in "${keys[@]}"; do
    p="${key%|*}"; n="${key#*|}"
    request="$sd/review/$p-round-$n-request.md"
    findings="$sd/review/$p-round-$n.md"
    abort="$sd/review/$p-round-$n-abort.md"
    newest=""
    for f in "$request" "$findings" "$abort"; do
      [[ -f "$f" ]] || continue
      [[ -z "$newest" || "$f" -nt "$newest" ]] && newest="$f"
    done
    [[ -n "$newest" ]] || continue

    pending=0
    if [[ -f "$request" ]]; then
      pending=1
      [[ -f "$abort" && "$abort" -nt "$request" ]] && pending=0
      if ((pending)) && [[ -f "$findings" ]]; then
        [[ "$request" -nt "$findings" ]] || pending=0
      fi
    fi
    if ((pending)) && { [[ -z "$best_pending_file" || "$newest" -nt "$best_pending_file" ]]; }; then
      best_pending="$key"; best_pending_file="$newest"
    fi
    if [[ -z "$best_any_file" || "$newest" -nt "$best_any_file" ]]; then
      best_any="$key"; best_any_file="$newest"
    fi
  done

  key="${best_pending:-$best_any}"
  [[ -n "$key" ]] || return 0
  p="${key%|*}"; n="${key#*|}"
  RS_POINT="$p"; RS_ROUND="$n"
  [[ -f "$sd/review/$p-round-$n.md" ]] && RS_ROUND_FILE="$sd/review/$p-round-$n.md"
  [[ -f "$sd/review/$p-round-$n-request.md" ]] && RS_REQUEST_FILE="$sd/review/$p-round-$n-request.md"
  [[ -f "$sd/review/$p-round-$n-abort.md" ]] && RS_ABORT_FILE="$sd/review/$p-round-$n-abort.md"

  if [[ -n "$RS_REQUEST_FILE" ]]; then
    RS_ANSWER_PENDING=1
    [[ -n "$RS_ABORT_FILE" && "$RS_ABORT_FILE" -nt "$RS_REQUEST_FILE" ]] && RS_ANSWER_PENDING=0
    if ((RS_ANSWER_PENDING)) && [[ -n "$RS_ROUND_FILE" ]]; then
      [[ "$RS_REQUEST_FILE" -nt "$RS_ROUND_FILE" ]] || RS_ANSWER_PENDING=0
    fi
  fi
  if [[ -n "$RS_ABORT_FILE" ]]; then
    RS_ROUND_ABORTED=1
    [[ -n "$RS_REQUEST_FILE" && ! "$RS_ABORT_FILE" -nt "$RS_REQUEST_FILE" ]] && RS_ROUND_ABORTED=0
    [[ -n "$RS_ROUND_FILE" && ! "$RS_ABORT_FILE" -nt "$RS_ROUND_FILE" ]] && RS_ROUND_ABORTED=0
  fi
  if [[ -n "$RS_ROUND_FILE" ]] && ! grep -q '^VERDICT:' "$RS_ROUND_FILE" 2>/dev/null; then
    RS_FINDINGS_UNFINISHED=1
  fi
  if ((RS_ROUND_ABORTED)) || { [[ -n "$RS_ROUND_FILE" ]] && (( ! RS_FINDINGS_UNFINISHED )); }; then
    RS_SOFT_CLOSED=1
  fi
  return 0
}
