#!/usr/bin/env bash
# orca-issue.sh — claim 済みの issue を 1 件、最後まで運ぶ。
#
# Usage: orca-issue.sh --state-file <p> --issue <N> --slug <s> [--phase dispatch|finish|all]
#                      [--request-file <f>] [--run <run_id>] [--repo-root <p>]
#                      [--repo <owner/repo>] [--timeout-ms <n>] [--max-waits <n>]
#
# ★ **phase を分けられるのは並列のためである。**`all`（既定）は dispatch → wait → finish を
#   1 件ぶん通すので、バッチで順に呼ぶと **1 件ずつ直列にしか走らない**。バッチでは
#   `dispatch` を N 件ぶん先に呼び、`orca-wait.ts` を **1 回**で全件待ってから `finish` を
#   N 件ぶん呼ぶ。Stage A が作った「N タスクを 1 Run に載せて 1 回で待つ」形をそのまま使う。
#   単件（`--issue <N>`）には並列にするものが無いので `all` でよい。
# Exit:  0 = done（merge してラベルを遷移し、片付けの判定まで済んだ）
#        1 = 運べなかった（**資源は保持する**）
#        2 = 使用法エラー
#
# ★ **順序が核心である。merge が成功して初めて cleanup してよい**（spec 18-1 の裁定）。
#   逆にすると worktree を消してから merge に失敗し、成果が消える。
#
# ★ **統合はどちらか一方である。**`integration=merge` は親ブランチへ取り込み、
#   `integration=pr` は push して pull request を作る。両方はやらない — PR を作ったうえで
#   親へ merge すると、レビューされる前に成果が入る。
#
# ★ **`integration=pr` のとき issue を close しない。**本文に `Closes #N` を入れてあるので、
#   **PR がマージされたときに GitHub が閉じる。**先に閉じると、PR が却下されても issue は
#   閉じたままになる。
#
# ★ **cleanup は資源を消さない。**Step 5 と同じく「消してよいか」を判定して印字するだけで、
#   実行はユーザーの承認を経た Step 6 が行う。無人で走る経路が資源を消すと、失敗の証拠が
#   その場で失われる。

set -uo pipefail
die() { echo "orca-issue: $1" >&2; exit 2; }
log() { echo "orca-issue: $1" >&2; }
need2() { [[ "$2" -ge 2 ]] || die "$1 requires a value"; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; PLUGIN="$(cd "$HERE/.." && pwd)"
SCRIPTS="$PLUGIN/skills/orca-team-dispatch-task/scripts"

SF="" NUM="" SLUG="" RF="" RUN="" RR="" TMO=600000 MAXW=60 PHASE=all PRREPO=""
while [[ $# -gt 0 ]]; do case "$1" in
  --state-file)   need2 "$1" $#; SF="$2";   shift 2 ;;
  --issue)        need2 "$1" $#; NUM="$2";  shift 2 ;;
  --slug)         need2 "$1" $#; SLUG="$2"; shift 2 ;;
  --request-file) need2 "$1" $#; RF="$2";   shift 2 ;;
  --run)          need2 "$1" $#; RUN="$2";  shift 2 ;;
  --repo-root)    need2 "$1" $#; RR="$2";   shift 2 ;;
  --timeout-ms)   need2 "$1" $#; TMO="$2";  shift 2 ;;
  --max-waits)    need2 "$1" $#; MAXW="$2"; shift 2 ;;
  --phase)        need2 "$1" $#; PHASE="$2"; shift 2 ;;
  --repo)         need2 "$1" $#; PRREPO="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
case "$PHASE" in dispatch|finish|all) ;; *) die "--phase must be dispatch, finish or all: $PHASE" ;; esac
[[ -n "$SF" && -n "$NUM" && -n "$SLUG" ]] || die "--state-file, --issue and --slug are required"
[[ "$NUM" =~ ^[0-9]+$ ]] || die "--issue must be a number: $NUM"
# finish は既に dispatch 済みの状態を引き継ぐので依頼ファイルを要らない
if [[ "$PHASE" != finish ]]; then
  [[ -n "$RF" ]] || die "--request-file is required for phase '$PHASE'"
  [[ -r "$RF" ]] || die "--request-file is not readable: $RF"
fi
[[ -n "$RR" ]] || RR=$(git rev-parse --show-toplevel 2>/dev/null) || die "not in a git repo"
command -v gh >/dev/null 2>&1 || die "gh is not installed"

IFETCH="$SCRIPTS/issue-fetch.ts"
[[ -r "$IFETCH" ]] || die "issue-fetch.ts is missing at $IFETCH"
SD="$RR/.dispatch/$SLUG"

# ★ **state ディレクトリを repo の除外へ入れる。**`.dispatch/` と同じ理由である —
#   入れないと state file と lock で親が常に dirty になり、`orca-merge.ts` の dirty
#   ガードが必ず発火して **1 件も merge できない**（実測）。state file の置き場所は
#   呼び出し側が決めるので、その directory 名を除外する。
#   ★ **両辺を同じ形に揃えてから比べる。**片方だけ `pwd -P` で symlink を解決すると、
#   macOS の `/var` → `/private/var` のように **repo root が symlink 越しのとき必ず外れる**
#   （実測: fixture の親が `?? .dispatch-issue/` のままになり merge が 1 件も通らない）。
SFD=$(cd "$(dirname "$SF")" 2>/dev/null && pwd -P) || SFD=""
RRP=$(cd "$RR" 2>/dev/null && pwd -P) || RRP="$RR"
if [[ -n "$SFD" && "$SFD" == "$RRP"/* ]]; then
  EX=$(git -C "$RR" rev-parse --git-path info/exclude 2>/dev/null || echo "")
  case "$EX" in /*) ;; ?*) EX="$RR/$EX" ;; esac
  if [[ -n "$EX" ]]; then
    mkdir -p "$(dirname "$EX")"
    ENTRY="${SFD#"$RRP"/}/"
    grep -qxF "$ENTRY" "$EX" 2>/dev/null || printf '%s\n' "$ENTRY" >> "$EX"
  fi
fi

# ★ **終端ラベルを先に付け、`dispatch/in-progress` はそのあとで外す。**間で落ちても
#   issue には結末が付いた状態で残る。逆順にすると「in-progress でも done でもない」
#   宙ぶらりんの issue ができ、次の実行の候補にも入らない。
#
#   ★ **`terminal` という名前のラベルは無い。**cmux 版の `terminal` は「終端ラベル」を
#   指す変数名であって、ラベル名ではない（実機で発見: 存在しないラベルを付けようとして
#   全 issue の遷移が失敗した）。作るのも付けるのも `dispatch/*` の 3 つだけである。
label_terminal() {   # $1=done|failed
  local other=failed; [[ "$1" == failed ]] && other=done
  gh issue edit "$NUM" --add-label "dispatch/$1" >/dev/null 2>&1 || return 1
  # ★ **反対の終端ラベルも外す。**1 度失敗して再実行した issue には `dispatch/failed` が
  #   既に付いている。外さないと done と failed が同時に付き、**人が結末を読めなくなる**
  #   （実機で発見）。`fetch` の検索はどちらでも除外するので取りこぼしはしないが、
  #   矛盾したラベルを残さない。
  gh issue edit "$NUM" --remove-label "dispatch/$other" >/dev/null 2>&1
  gh issue edit "$NUM" --remove-label dispatch/in-progress >/dev/null 2>&1
}

# 失敗して抜けるときは **必ず state を終端へ落とす**。落とさないと reconcile が
# 「dispatched のまま」と読んで、次のループごと abort させる (IF8)。
fail_out() {   # $1=理由
  log "$1"
  if label_terminal failed; then
    node "$IFETCH" --state-file "$SF" finalize --issue "$NUM" --status failed --message "$1" \
      >/dev/null 2>&1 || log "the state file could not be updated for issue #$NUM"
  else
    # ★ ラベルを動かせなかったことを **state に嘘で上書きしない。**次の reconcile が
    #   痕跡を見て止まるほうが、静かに done にするより良い。
    log "could not move the labels for issue #$NUM; the state is left as dispatched"
  fi
  log "issue #$NUM: resources are KEPT at $SD"
  exit 1
}

# --- 1. dispatch ---
if [[ "$PHASE" != finish ]]; then
# ★ **親が dirty なら先に言う。**merge の dirty ガードは finish まで発火しないので、
#   黙って進むと **必ず merge できない仕事に worker を 1 本使う**。止めはしない
#   （dispatch と finish の間に commit されうる）が、無人実行で気づけるようにする。
PORC=$(git -C "$RR" status --porcelain 2>/dev/null) || PORC=""
[[ -z "$PORC" ]] || log "issue #$NUM: the parent checkout is dirty; it must be clean by the time this merges"

# ★ **無人実行で brainstorming は成立しない。**答える人が居ないので、design は 1 往復
#   待ってから自分で決めることになる。待つだけ無駄なので `plan` へ落とす。cmux 版が
#   loop-mode で「plan mode に固定」としているのと同じ判断である。
DM=$(node "$SCRIPTS/config-resolve.ts" --project-root "$RR" 2>/dev/null \
     | jq -r '.design_mode // "direct"' 2>/dev/null || echo direct)
DM_ARGS=()
if [[ "$DM" == brainstorm ]]; then
  log "issue #$NUM: design_mode is 'brainstorm' but an issue run is unattended; using 'plan'"
  DM_ARGS=(--design-mode plan)
fi
OUT=$(node "$PLUGIN/bin/orca-start.ts" --request-file "$RF" --slug "$SLUG" \
        --objective "issue #$NUM" --repo-root "$RR" ${RUN:+--run "$RUN"} \
        ${DM_ARGS[@]+"${DM_ARGS[@]}"} 2>&1) || {
  log "$OUT"
  fail_out "issue #$NUM: the dispatch did not start"
}
# ★ **機械可読行を stderr へ複製しない。**呼び出し側が `2>&1` で受けると `run_id=` が
#   2 行になり、`--run` に改行入りの値が渡って壊れる（実機で発見）。診断だけ通す。
printf '%s\n' "$OUT" | grep -vE '^(status_dir|run_id)=' >&2 || true
RUN=$(sed -n 's/^run_id=//p' <<<"$OUT")
[[ -n "$RUN" ]] || fail_out "issue #$NUM: the dispatch printed no run_id"

node "$IFETCH" --state-file "$SF" mark-dispatched --issue "$NUM" >/dev/null 2>&1 \
  || log "issue #$NUM: could not mark it dispatched; the wait continues"
if [[ "$PHASE" == dispatch ]]; then
  # ★ **待たない。**呼び出し側が全件を 1 回の `orca-wait.ts` で待ち、そのあと finish を呼ぶ。
  printf 'issue=%s\nslug=%s\nstatus_dir=%s\nrun_id=%s\n' "$NUM" "$SLUG" "$SD" "$RUN"
  exit 0
fi
fi

# --- 2. wait（ブロック）---
# ★ wake 駆動にしない。落とした通知でジョブが黙って消える失敗様式を持ち込まない。
# ★ **停滞で止まって尋ねない。**無人なので尋ねる相手が居ない。stall.json に残して待ち続ける。
if [[ "$PHASE" == all ]]; then
  WRC=0
  node "$PLUGIN/bin/orca-wait.ts" --status-dir "$SD" --max-waits "$MAXW" --timeout-ms "$TMO" \
    --on-stall report || WRC=$?
  case "$WRC" in
    0) ;;
    5) fail_out "issue #$NUM: the worker reported failure; the result is in $SD/roles/design/result.md" ;;
    *) fail_out "issue #$NUM: waiting ended with $WRC; nothing was merged" ;;
  esac
fi
[[ -r "$SD/workers.json" ]] || fail_out "issue #$NUM: there is no dispatch state at $SD"
CRC=0; CFG=$(node "$SCRIPTS/config-resolve.ts" --project-root "$RR") || CRC=$?
[[ "$CRC" -eq 0 ]] || fail_out "issue #$NUM: cannot resolve the dispatch configuration"

# --- 3. 統合。**ここが通って初めて片付けの話になる** ---
# ★ **取り込み方は記録した値を読む。**dispatch と finish の間には待機バッチが挟まり、
#   その間に設定が変わりうる。orca-merge.ts / orca-pr.ts は起動時に記録した値を基準に
#   もう一方を拒むので、finish もそこと同じ値を読む。記録が無い（旧版の status dir）
#   ときだけ、いま解決した設定へ従来どおり落ちる。
INTEGRATION=$(jq -r '.integration // empty' "$SD/workers.json" 2>/dev/null || echo "")
[[ -n "$INTEGRATION" ]] || INTEGRATION=$(jq -r '.integration // "merge"' <<<"$CFG")
PR_URL=""
if [[ "$INTEGRATION" == pr ]]; then
  # ★ **repo は呼び出し側が 1 度だけ解決した値を渡す。**`orca-pr.ts` も自分では見に行かない
  #   （spec 12-2 の実測: 子が remote を解決して fork の中に PR を作った）。
  [[ -n "$PRREPO" ]] || fail_out "issue #$NUM: integration is 'pr' but --repo <owner/repo> was not given"
  PR_URL=$(node "$PLUGIN/bin/orca-pr.ts" --status-dir "$SD" --repo "$PRREPO" --issue "$NUM") \
    || fail_out "issue #$NUM: no pull request was opened; the worktree and branch are kept"
else
  node "$PLUGIN/bin/orca-merge.ts" --status-dir "$SD" \
    || fail_out "issue #$NUM: the work was not merged; the worktree and branch are kept"
fi

# --- 4. ラベル遷移と issue のクローズ ---
label_terminal done || fail_out "issue #$NUM: integrated, but the labels could not be moved"
# ★ **成功時にも message を書く。**`finalize` は空の message を無視するので、
#   前回の失敗時に書かれた理由が `done` のまま残る（実機で発見）。上書きする。
if [[ "$INTEGRATION" == pr ]]; then
  # ★ **閉じない。**`Closes #$NUM` を本文に入れてあるので、PR がマージされたときに
  #   GitHub が閉じる。先に閉じると、PR が却下されても issue は閉じたままになる。
  node "$IFETCH" --state-file "$SF" finalize --issue "$NUM" --status done \
    --pr-url "$PR_URL" --message "pull request opened" >/dev/null 2>&1 \
    || log "issue #$NUM: the pull request is at $PR_URL but the state file could not be updated"
  log "issue #$NUM: $PR_URL is open. The issue closes when that merges. Resources are kept at $SD"
else
  gh issue close "$NUM" --reason completed >/dev/null 2>&1 \
    || log "issue #$NUM: merged and labelled, but the issue could not be closed"
  node "$IFETCH" --state-file "$SF" finalize --issue "$NUM" --status done \
    --message "merged and closed" >/dev/null 2>&1 \
    || log "issue #$NUM: merged, but the state file could not be updated"
  log "issue #$NUM: merged and closed. Resources are kept for the Step 5/6 cleanup at $SD"
fi
# ★ **空の値を印字しない。**finish phase は Run を知らないので `run_id=` を出すと
#   空文字が渡り、受け取った側が `--run ""` を組み立てて壊れる（実機で気づいた）。
printf 'issue=%s\nslug=%s\nstatus_dir=%s\n' "$NUM" "$SLUG" "$SD"
[[ -z "$RUN" ]] || printf 'run_id=%s\n' "$RUN"
