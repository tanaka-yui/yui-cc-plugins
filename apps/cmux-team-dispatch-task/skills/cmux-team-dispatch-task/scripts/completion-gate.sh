#!/usr/bin/env bash
# completion-gate.sh — Stop hook から呼ばれ、子セッションが仕事の途中で止まろうとして
# いるかを判定する。止まろうとしているなら block して継続させる。
#
# 判定は **ディスクだけ** を読む。モデル評価もネットワークも cmux も使わない。dispatch の
# 完了条件は既に status.json / .deferred / review ファイルとして materialize されており、
# 「待って良い状態」もそこから確定できるので、会話からの推測に賭ける理由が無い。
# (spec 2026-08-22-dispatch-completion-gate-design.md の §3-4)
#
# 出力キーを decision / reason に限るのは codex の hook 出力スキーマが
# additionalProperties: false で、Stop の許可キーが continue / decision / reason /
# stopReason / suppressOutput / systemMessage の 6 つしか無いためである。未知キーを 1 つ
# 出すと毎ターン parse error になる (security-guidance が metrics を出して拒否されている
# のと同じ失敗)。
#
# reason はログではなく **次ターンへのガイダンス** として届き、モデルがそれに従うことを
# 2026-08-22 に両 engine で実測済み (spec §6 の G-T1 / G-T2)。何をすべきかを書くこと。
#
# Usage:
#   completion-gate.sh --status-dir <dir> --role <design|design_review|exec|exec_review> \
#                      --agent <name> [--team <team>] [--send-command <path>]
#
# --send-command を省略した場合は <status-dir>/.send-command から読む。launch-workspace.sh
# はこのファイル経由で渡す (hook のコマンド文字列に agmsg の実パスを埋められないため。
# 理由は下の SEND_CMD フォールバックの comment を参照)。
#
# Output: block したいときだけ {"decision":"block","reason":"..."} を stdout へ
# Exit:   0 = 判定完了 (block の有無は stdout で表す) / 2 = 使用法エラー
#
# 使用法エラーで stdout へ何も出さないのは意図的である。壊れた JSON を hook へ返すと
# engine 側が毎ターン parse error を報告し、本来の停止理由が見えなくなる。
[[ -n "${BASH_VERSION:-}" ]] || exec bash "$0" "$@"
set -uo pipefail

die() { echo "completion-gate: $1" >&2; exit 2; }

STATUS_DIR=""; ROLE=""; AGENT=""; TEAM=""; SEND_CMD=""; GATE_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir) [[ $# -ge 2 ]] || die "--status-dir requires a value"; STATUS_DIR="$2"; shift 2 ;;
    --role)       [[ $# -ge 2 ]] || die "--role requires a value";       ROLE="$2";       shift 2 ;;
    --agent)      [[ $# -ge 2 ]] || die "--agent requires a value";      AGENT="$2";      shift 2 ;;
    --team)       [[ $# -ge 2 ]] || die "--team requires a value";       TEAM="$2";       shift 2 ;;
    --send-command) [[ $# -ge 2 ]] || die "--send-command requires a value"; SEND_CMD="$2"; shift 2 ;;
    --gate-id)    [[ $# -ge 2 ]] || die "--gate-id requires a value";    GATE_ID="$2";    shift 2 ;;
    *)            die "unknown argument: $1" ;;
  esac
done

# 引数で来なかった値は runner が export したプロセス環境から読む。
#
# ロールを hook の command 文字列に焼き込んではならない。4 ロールは 1 つの worktree を
# 共有し、claude は .claude/settings.local.json を、codex は .codex/hooks.json を
# それぞれ 1 本しか持たない。注入の冪等性判定はファイル内に gate があるかしか見ないので、
# 同じ engine の 2 ロール目は注入をスキップし、1 ロール目の焼き込み値で動いてしまう。
# 2026-08-25 に実測: exec_review ペインが design のゲートを実行し、レビュー専任なのに
# 「タスクの terminal status を書け」と迫られ続けた (codex 側は design_review が exec の
# ゲートを実行していた)。
#
# 環境変数ならペインごとに違う値が入るので、command が共有のままでも取り違えない。
# command 文字列に '$VAR' を書いて実行時展開させる方法は使えない: シングルクォート内は
# hook 実行時も展開されず、\$VAR も同じである。
[[ -n "$STATUS_DIR" ]] || STATUS_DIR="${DISPATCH_GATE_STATUS_DIR:-}"
[[ -n "$ROLE" ]]       || ROLE="${DISPATCH_GATE_ROLE:-}"
[[ -n "$AGENT" ]]      || AGENT="${DISPATCH_GATE_AGENT:-}"
[[ -n "$TEAM" ]]       || TEAM="${DISPATCH_GATE_TEAM:-}"

# identity が揃わない = この hook を書いた dispatch の管理外で実行されている。
# 共有設定に残った Stop hook は、同じ worktree を開いた手動セッションでも発火するので、
# ここで縛ると無関係のペインを無期限に拘束することになる。停止を許す。
#
# die (exit 2) にしてはならない。Claude Code の Stop hook では exit 2 は blocking error
# であって「何もしない」ではない。fail-open にしたいなら exit 0 かつ stdout 無出力である。
# 診断は stderr に出す — stdout は engine が JSON として読むので混ぜられない。
if [[ -z "$STATUS_DIR" || -z "$ROLE" || -z "$AGENT" ]]; then
  # 判定は fail-open のままにする。ただし dispatch の handoff が辿れるときは、親が
  # identity 欠落を検出できるよう status dir に固定名の記録を残す。worktree に増分ファイルを
  # 作ると work-signal.sh の入力を攪乱するため、置き場所は handoff が指す status dir に限る。
  if [[ -r .dispatch-handoff.json ]]; then
    _status_dir=$(jq -r '.status_dir // empty' .dispatch-handoff.json 2>/dev/null || echo "")
    if [[ -n "$_status_dir" && -d "$_status_dir" ]]; then
      _count=$(jq -r '.count // 0' "$_status_dir/.gate-open" 2>/dev/null || echo 0)
      [[ "$_count" =~ ^[0-9]+$ ]] || _count=0
      _tmp=$(mktemp "$_status_dir/.gate-open.XXXXXX" 2>/dev/null) && {
        jq -nc --argjson last_seen "$(date +%s)" --argjson count "$((_count + 1))" \
          '{last_seen:$last_seen, count:$count}' > "$_tmp" 2>/dev/null \
          && mv -f "$_tmp" "$_status_dir/.gate-open" 2>/dev/null || rm -f "$_tmp"
      }
    fi
  fi
  echo "completion-gate: no dispatch identity in args or environment; letting the session stop" >&2
  exit 0
fi

case "$ROLE" in
  design|design_review|exec|exec_review) ;;
  *) die "--role must be design, design_review, exec or exec_review" ;;
esac

# --send-command が省略されたときは STATUS_DIR のファイルから読む。launch-workspace.sh は
# 送信コマンドを hook のコマンド文字列に埋められない: agmsg は自分が書いた Stop エントリ
# かどうかを command に 'agmsg' が含まれるかだけで判定するので、send.sh の実パスを埋めると
# この gate が agmsg 由来と誤認され、mode が monitor ではなく both と報告される。
# codex-shim.sh は `mode: monitor` の完全一致を要求するため、そうなると app-server bridge が
# 起動せず codex ペインが受信不能になる (2026-08-24 実測)。
# 値は reason の文面に埋めるだけで、この gate が実行することはない。
if [[ -z "$SEND_CMD" && -r "$STATUS_DIR/.send-command" ]]; then
  IFS= read -r SEND_CMD < "$STATUS_DIR/.send-command" || SEND_CMD=""
fi

# hook が渡してくる JSON (stdin) は読まない。判定材料はすべてディスク上にあるからである。
# 「書き手が EPIPE を踏まないように空読みする」形を一度書いたが、EOF に達しない stdin を
# 継承した呼び出し (テストハーネスなど) でハングした。得られる利益は仮説にすぎず、害は
# 実測されたので読まない。stop_hook_active を使いたくなったときは、ハングしない読み方を
# 実測してから入れること。
# 連続 block の上限。既定は 0 = 無制限。engine 側には連続 block の回数上限が無いことを
# 2026-08-22 に実測済み (spec §6) なので、有限値を入れたときだけこちらが止める責任を持つ。
#
# 既定を無制限にしたのは、有限の上限が「本当にまだ終わっていない長いタスク」を殺すからで
# ある。上限に達した block() はカウンタを保持したまま諦める。カウンタを消せるのは判定 1-5
# の allow だけなので、実装フェーズの exec (status=executing、かつ最新 round に VERDICT が
# 既にある = 待機でもない) はどの allow にも二度と当たらず、以後永久に毎ターン停止する。
# 2026-08-25 に実ペインで観測した: 上限 10 に達した exec が、作業の途中であるにもかかわらず
# ターンのたびに止まり、人間が突かない限り一歩も進まなくなった。Codex ペインは素の実行
# モデルが「1 turn = 1 応答」なので、この gate が諦めた瞬間に task ごとの停止が露出する。
#
# 暴走が怖い場面 (原理的に完了できないタスクを回すなど) では DISPATCH_GATE_MAX_BLOCKS に
# 正の数を入れて上限を復活させること。
MAX_BLOCKS="${DISPATCH_GATE_MAX_BLOCKS:-0}"
[[ "$MAX_BLOCKS" =~ ^[0-9]+$ ]] || die "DISPATCH_GATE_MAX_BLOCKS must be a whole number"
# カウンタはロールごとに分ける。4 ロールは 1 つの status dir を共有するので、1 ファイルに
# 数えると「4 ペイン合計で上限」になり、どのペインも自分の回数に達する前に諦めてしまう。
BLOCK_COUNT_FILE="$STATUS_DIR/.gate-blocks-$ROLE"

# reason は次ターンのガイダンスとして届き、モデルがそれに従う (spec §6 の G-T1 で実証)。
# したがって **このスクリプトが知っている値は reason に入れる**。実ペインの E2E で、
# パスを書かなかったために block されたセッションが status dir を ls で探し、
# completion-gate.sh と report-status.sh を読み、team 名を find で探す、という考古学に
# まる 1 ターンを費やした。知っているものを渡さないのは単なる取りこぼしである。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# team はディスパッチ配下でのみ渡る。無いときに send.sh の 4 引数を埋めさせようとすると
# 存在しない team 名を捏造させることになるので、そのときは触れない。
# 送信コマンドまで書けるのは team と send-command の両方が揃ったときだけ。片方でも欠けたら
# 具体的な手順を書かない — 埋められない引数を持つコマンドを見せると、子はそれを埋めようとして
# 存在しない値を捏造するか、探し回って 1 ターンを溶かす (どちらも E2E で観測した)。
NOTIFY_HINT=""
if [[ -n "$TEAM" && -n "$SEND_CMD" ]]; then
  NOTIFY_HINT=" Send it with exactly: $SEND_CMD $TEAM $AGENT parent 'dispatch-notify: ...'"
elif [[ -n "$TEAM" ]]; then
  NOTIFY_HINT=" (team $TEAM)"
fi

# 待機の連続性を記録するファイル。判定 5 / 5b の「待って良い状態」で allow するたびに
# 現在時刻を置き、次の呼び出しがどれだけ近かったかを測る。詳細は wait_guard() を参照。
LEASE_FILE="$STATUS_DIR/.gate-wait-$ROLE"
SEQ_FILE="$STATUS_DIR/.gate-seq-$ROLE"
SEEN_FILE="$STATUS_DIR/.gate-seen-$ROLE"
clear_wait_lease() { rm -f "$LEASE_FILE" 2>/dev/null || true; }
clear_seen() { rm -f "$SEEN_FILE" 2>/dev/null || true; }
clear_lease() { clear_wait_lease; clear_seen; }
next_lease_seq() {
  local n tmp
  n=$(cat "$SEQ_FILE" 2>/dev/null || echo 0); [[ "$n" =~ ^[0-9]+$ ]] || n=0
  n=$((n + 1)); tmp=$(mktemp "$STATUS_DIR/.gate-seq.XXXXXX" 2>/dev/null) || return 1
  printf '%s\n' "$n" > "$tmp" && mv -f "$tmp" "$SEQ_FILE" || { rm -f "$tmp"; return 1; }
  printf '%s' "$n"
}
arm_lease() {
  local gen="${1:-}" seq tmp deadline
  [[ "$WAIT_MINUTES" -gt 0 ]] || { clear_lease; return 0; }
  if [[ -z "$gen" ]]; then
    [[ -n "$POINT" && -n "$ROUND_NO" ]] || return 0
    gen="$POINT|$ROUND_NO|$ROLE|$AGENT"
  fi
  seq=$(next_lease_seq) || { clear_lease; return 1; }
  deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
  tmp=$(mktemp "$STATUS_DIR/.gate-wait.XXXXXX" 2>/dev/null) || { clear_lease; return 1; }
  jq -nc --arg g "$gen" --argjson s "$seq" --argjson d "$deadline" '{generation:$g,lease_seq:$s,deadline_epoch:$d}' > "$tmp" \
    && mv -f "$tmp" "$LEASE_FILE" || { rm -f "$tmp"; clear_lease; return 1; }
}
lease_failure_block() { block "the recovery lease under $STATUS_DIR could not be written, so nothing outside this pane can time out your wait. Send exactly one message to parent reporting that the status directory is not writable$NOTIFY_HINT, then continue working if you can."; }
# この実行が待機経路 (wait_guard) を通ったか。通ったなら allow はスタンプを消さない。
# 消してしまうと自分が今書いた時刻が毎回消え、次の呼び出しが永久に「1 回目」になる。
WAIT_STAMPED=0
# 判定 7 の progress lease は残すが、次の素の待機を auto-restart と誤認しないよう seen は消す。
PRESERVE_LEASE=0

# 停止を許す。stdout へ何も出さない。
# 待機から復帰したあとに前の回数を持ち越さないよう、必ずカウンタを消す。数えているのは
# 「ターンが進んだ回数」ではなく「連続して block した回数」である。
# 待機スタンプは「待機ではない停止」でだけ消す。待機が終わった (verdict が来た /
# 仕事が終わった) あとに古い時刻が残っていると、次の待機の 1 回目が「自動再開」と
# 誤判定される。逆にこの実行が待機経路を通っているなら、消してよいのは自分が今書いた
# 時刻だけになってしまうので触らない。
allow() {
  rm -f "$BLOCK_COUNT_FILE" 2>/dev/null || true
  [[ "$WAIT_STAMPED" -eq 1 ]] || clear_lease
  exit 0
}

# 継続させる。上限が設定されている (MAX_BLOCKS > 0) ときだけ数え、達したら諦めて停止を許す。
# 既定の無制限ではカウンタに触れない — 数える相手が居ないので、ファイル I/O ごと不要である。
# 待機経路を通らずにここへ来たなら、この停止は待機ではない (判定 7 やレビュアー側の
# 判定 6 など)。allow と同じ理由で古いスタンプを残さない。
block() {
  local n
  if [[ "$WAIT_STAMPED" -ne 1 ]]; then
    clear_seen
    [[ "$PRESERVE_LEASE" -eq 1 ]] || clear_wait_lease
  fi
  if [[ "$MAX_BLOCKS" -gt 0 ]]; then
    n=$(cat "$BLOCK_COUNT_FILE" 2>/dev/null || echo 0)
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
    if [[ "$n" -ge "$MAX_BLOCKS" ]]; then
      # stdout は engine が JSON として読むので、諦めた事実は stderr へ出す。
      echo "completion-gate: gave up after $n consecutive blocks; letting the session stop" >&2
      # ここで allow() を呼んではならない。allow() はカウンタを消すので、次の呼び出しで
      # 上限が再武装され「上限まで block → 1 回休み」を永久に繰り返す。諦めた状態は
      # 維持し、判定 1-5 のいずれかで本当に停止を許したときだけリセットする
      # (待機や完了に入れば自然に回復する)。
      exit 0
    fi
    echo "$((n + 1))" > "$BLOCK_COUNT_FILE" 2>/dev/null || true
  fi
  jq -nc --arg r "$1" '{decision:"block",reason:$r}'
  exit 0
}

# macOS (BSD) と Linux (GNU) で stat のフラグが違う。work-signal.sh と同じ形にしておく。
if stat -f %m . >/dev/null 2>&1; then
  mtime_of() { stat -f %m "$1" 2>/dev/null; }
else
  mtime_of() { stat -c %Y "$1" 2>/dev/null; }
fi

# 待機防衛。
#
# codex の goal 継続機能 (feature flag `goals`) は、ターン終了の数十ミリ秒後に
# <codex_internal_context source="goal"> を注入して新しいターンを始める。待機中はこれが
# 7〜10 秒周期で回る。そしてその注入文自体が codex の blocked audit を含んでいる:
# 「同じ blocker が 3 連続の goal ターン (自動継続を含めて数える) で続いたら
# update_goal(status:"blocked") を呼べ」。レビュー待ちは同じ blocker に見えるので、
# この閾値は待機開始から 30 秒足らずで満たされる。
#
# 2026-08-31 に 2 件の実ペインで実測した。どちらも exec は正常に待機へ入り、この gate は
# 毎回正しく allow していた:
#   - pr-490-fix-blockers: review-code 送信の 81 秒後に abort。goal 継続 6 回
#   - 2026-08-28 の別 dispatch: 111 秒後に abort。goal 継続 13 回
# どちらも abort 直後に update_goal({status:"blocked"}) を実際に実行しており、モデルが
# 従っていたのは skill の文面ではなく codex の注入文だった。同じセッションの別ラウンドで
# goal が非アクティブだった区間では、同じ待機構造が 90 分そのまま継続している。したがって
# 「codex は構造的に待てない」のではなく「goal 継続が待機を潰していた」が正しい。
#
# allow は stdout へ何も出さないので、この gate は待機中のターンに一言も持てない。そこで
# 「自動再開が起きている待機」だけ block へ倒し、reason で反論する。reason は次ターンの
# ガイダンスとして届き、モデルがそれに従うことは実測済みである (spec §6 G-T1 / G-T2。
# 2026-08-28 には判定 7 の文面が提示した唯一の逃げ道を実際に取った)。
#
# 素の待機まで block しないための判別はスタンプの間隔で行う。自動再開が無ければ、次の Stop は
# verdict が届くまで来ないので 2 回目の呼び出しがそもそも存在しない。1 回目は必ず allow し、
# 前回から WAIT_RESTART_SECONDS 以内に再訪したときだけ「何かがターンを刻んでいる」と見なす。
# ここに新しいポーリングループは無い — 数えているのは engine が勝手に起こしたターンである。
WAIT_MINUTES="${DISPATCH_GATE_WAIT_MINUTES:-30}"
[[ "$WAIT_MINUTES" =~ ^[0-9]+$ ]] || die "DISPATCH_GATE_WAIT_MINUTES must be a whole number"
WAIT_RESTART_SECONDS="${DISPATCH_GATE_WAIT_RESTART_SECONDS:-90}"
[[ "$WAIT_RESTART_SECONDS" =~ ^[0-9]+$ ]] || die "DISPATCH_GATE_WAIT_RESTART_SECONDS must be a whole number"

# $1 = 待機の起点として時刻を測るファイル (依頼文。無いときは空文字)
# 猶予が残っていて自動再開が起きているときだけ block し、それ以外は呼び出し元へ返して
# 従来どおり allow させる。WAIT_MINUTES=0 は防衛の無効化 (常に allow) を意味する。
wait_guard() {
  local ref="$1" now prev started elapsed_min
  [[ "$WAIT_MINUTES" -gt 0 ]] || { clear_lease; return 0; }
  now=$(date +%s)
  prev=$(cat "$SEEN_FILE" 2>/dev/null || echo "")
  echo "$now" > "$SEEN_FILE" 2>/dev/null || true
  WAIT_STAMPED=1
  # 1 回目。ここで止まれるなら自動再開は無い。素直に待たせる。
  [[ "$prev" =~ ^[0-9]+$ ]] || { arm_lease || lease_failure_block; return 0; }
  # 前回が遠い = 自動再開ではなく、正常に眠っていて別の理由で起きた。
  (( now - prev <= WAIT_RESTART_SECONDS )) || { arm_lease || lease_failure_block; return 0; }
  # 経過は依頼文の mtime から測る。gate だけが時計を持てる — モデルは自動再開を
  # 「タイマーが鳴った」と写像するので、経過時間を数字で渡すことに意味がある。
  started=$(mtime_of "$ref")
  [[ "$started" =~ ^[0-9]+$ ]] || started="$prev"
  elapsed_min=$(( (now - started) / 60 ))
  if (( elapsed_min >= WAIT_MINUTES )); then
    local reviewer reviewer_engine abort_file
    reviewer=$(jq -r '.reviewer_agent // empty' "$STATUS_DIR/review/code-review.json" 2>/dev/null || echo "")
    reviewer_engine=$(jq -r '.reviewer_engine // empty' "$STATUS_DIR/review/code-review.json" 2>/dev/null || echo "")
    abort_file="$STATUS_DIR/review/$POINT-round-$ROUND_NO-abort.md"
    if [[ -n "$reviewer" && -n "$TEAM" ]]; then
      if [[ "$reviewer_engine" == codex ]]; then
        block "you have been waiting on $POINT round $ROUND_NO for about $elapsed_min minute(s), which is past the $WAIT_MINUTES minute budget. Run $SCRIPT_DIR/verify-agmsg-ready.sh --codex --team $TEAM --name $reviewer once; if reachable, re-send the same round request once. Otherwise write $abort_file or run bash $SCRIPT_DIR/escalate.sh $STATUS_DIR and tell parent$NOTIFY_HINT. Do NOT write a terminal status."
      fi
      block "you have been waiting on $POINT round $ROUND_NO for about $elapsed_min minute(s), which is past the $WAIT_MINUTES minute budget. The claude reviewer $reviewer reported [ready] and is reachable by definition; re-send the same round request once. Otherwise write $abort_file or run bash $SCRIPT_DIR/escalate.sh $STATUS_DIR and tell parent$NOTIFY_HINT. Do NOT write a terminal status."
    fi
    block "you have been waiting on $POINT round $ROUND_NO for about $elapsed_min minute(s), which is past the $WAIT_MINUTES minute budget. Write $abort_file or run bash $SCRIPT_DIR/escalate.sh $STATUS_DIR and tell parent$NOTIFY_HINT. Do NOT write a terminal status."
  fi
  block "you are waiting for a review verdict and that is the correct state, not a failure. About $elapsed_min minute(s) of the $WAIT_MINUTES minute wait budget have passed, and reviews of this size normally take 10 to 30 minutes. Do NOT write an abort file, do NOT write a terminal status, and do NOT call update_goal with status blocked: a review that is still running is not an impasse. If an automatic goal continuation restarted you, that is NOT a timer firing and NOT part of any wake budget, so do not count these turns against a re-arm limit or a consecutive-blocker rule — they are seconds apart, not minutes. Do not re-read the findings file and do not check the reviewer pane again this turn. Say in one short sentence that you are still waiting, then end the turn. Only a review-verdict: message, or an instruction from parent, ends this wait."
}

# 1. 仕事が終わっている
expected_exec_agent() { local value; [[ -r "$STATUS_DIR/prewarm.json" ]] || return 1; value=$(jq -r '.exec.agent // empty' "$STATUS_DIR/prewarm.json" 2>/dev/null) || return 1; [[ -n "$value" ]] || return 1; printf '%s' "$value"; }
delegation_recorded() { local expected; expected=$(expected_exec_agent) || return 1; [[ -f "$STATUS_DIR/.deferred" && -f "$STATUS_DIR/.assigned-$expected" ]]; }
DELEGATE_HINT=" Delegate with one call to $SCRIPT_DIR/phase-b-deliver.sh; do not write delegation markers by hand."
st=$(jq -r '.status // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
[[ "$st" == error ]] && allow
[[ "$st" == done && "$ROLE" != design ]] && allow

# parent へ判断を引き渡している状態は prewarm の破損より先に解放する。
[[ -f "$STATUS_DIR/.escalated" ]] && allow

if [[ "$ROLE" == design ]]; then
  expected_exec_agent >/dev/null || block "the prewarm snapshot at $STATUS_DIR/prewarm.json is missing, unreadable, or has no exec agent. Report this to parent$NOTIFY_HINT and wait; do not write a terminal status."
  if [[ "$st" == done ]]; then delegation_recorded || block "status says done but delegation is not recorded.$DELEGATE_HINT"; allow; fi
  if [[ -f "$STATUS_DIR/.deferred" ]]; then delegation_recorded || block "the deferred marker lacks the expected exec assignment.$DELEGATE_HINT"; allow; fi
fi

# 2b. parent へ判断を引き渡して待っている。待つのが正しい状態である。
# レビューのラウンド上限に達した子は、round 6 を始めることも Phase B へ進むこともできない。
# このとき .assigned は残り、最新 round ファイルには VERDICT があり、.deferred はまだ無いので、
# この sentinel が無いと判定 7 に落ちて「terminal status を書け」と迫られる。ところが
# report-status.sh が受け付けるのは done か error だけで、どちらも虚偽になる —
# done は未完了、error は指示どおりの正常な引き渡しであって障害ではない。
# 子は引き渡し時に escalate.sh で token を原子的に書き、parent の回答を受けて再開するときに自分で消す。
# 2026-08-24 に実測: 5 ラウンド上限に達した design ペインが停止のたびに block された。

# review の状態は review-state.sh に一本化する。gate は述語を消費するだけで、
# closure の規則を再実装しない。
# shellcheck disable=SC1090
. "$SCRIPT_DIR/review-state.sh"
# role ごとに自分の review point だけを見る。design ペインは Phase A-R の依頼者、exec は
# Phase B-R の依頼者であり、それぞれの相手が design_review / exec_review である。
# 全 point を混ぜて最新 1 件を選ぶと、design 点の VERDICT 付き findings が exec の未完了
# レビューをマスクし、待機中の実装者が判定 7 へ落ちる (2026-09-02 に 4/7 のタスクで発生)。
# code は固定名で書ける (phase-b-deliver.sh と launch-workspace.sh に code と焼き込まれて
# いる) が、design 側の checkpoint 名は固定ではない (superpowers モードは spec と plan の
# 2 点、無人ループは design)。design 側を literal な point 名へ包含スコープすると、
# superpowers モードの design ペインが自分の spec-round-*/plan-round-* を見失い、この
# タスクが直そうとしているのと同じ症状が design 側で再発する。そこで design 側は
# 「code 以外すべて」という除外スコープで表す。
case "$ROLE" in
  design|design_review) GATE_POINT='!code' ;;
  exec|exec_review)     GATE_POINT=code ;;
esac
review_select_active "$STATUS_DIR" "$GATE_POINT"
POINT="$RS_POINT"; ROUND_NO="$RS_ROUND"
ROUND_FILE="$RS_ROUND_FILE"; REQUEST_FILE="$RS_REQUEST_FILE"; ABORT_FILE="$RS_ABORT_FILE"
answer_pending() { [[ "$RS_ANSWER_PENDING" == 1 ]]; }
round_aborted() { [[ "$RS_ROUND_ABORTED" == 1 ]]; }
findings_unfinished() { [[ "$RS_FINDINGS_UNFINISHED" == 1 ]]; }

case "$ROLE" in
  design|exec)
    # 3. タスク未着。待つのが正しい状態。
    [[ -f "$STATUS_DIR/.assigned-$AGENT" ]] || allow
    # 5. verdict 待ち。相手が書くまで待つのが正しい状態。
    #    wait_guard は「猶予が残っていて、かつ engine が待機ターンを自動再開している」
    #    ときだけ block へ倒す。それ以外は戻ってきて従来どおり allow する。
    if ! round_aborted; then
      if findings_unfinished; then
        wait_guard "${REQUEST_FILE:-$ROUND_FILE}"
        allow
      fi
      # 5b. 依頼は出したが、その依頼に対する findings がまだ無い = 相手待ち。
      if answer_pending; then
        wait_guard "$REQUEST_FILE"
        allow
      fi
    fi
    ;;
  design_review|exec_review)
    # 4. 依頼未着。レビューペインは .assigned を使わないので review/ のファイルで判定する
    #    (launch-workspace.sh の所有権判定が .assigned-* を見ており、レビュアーがそれを作ると
    #     foreign assignment と誤認されて status 書き込みが抑止される)。
    #    依頼文だけが先に届く区間があるので、findings と依頼文のどちらも無いときだけ許す。
    [[ -n "$ROUND_FILE" || -n "$REQUEST_FILE" ]] || allow
    # 4b. 依頼側がそのラウンドを打ち切った。書きかけの findings を抱えていても、答える相手は
    #     もう待っていないので縛らない。中断記録を findings のパスへ書かせるのをやめた分、
    #     レビュアーの解放はここが担う。
    if round_aborted; then
      allow
    fi
    # 6. 最新の依頼に答え終えていない = 自分の仕事が途中。依頼側 (判定 5/5b) とは逆になる。
    #    依頼文しか無い区間で許してしまうと、レビューを一度も書かないまま止まれてしまう。
    if answer_pending; then
      block "the review requested in ${REQUEST_FILE:-the request file} has no findings file yet. Write your findings to the path that request names, whose LAST line must be VERDICT: approve or VERDICT: needs_work, then send one review-verdict: message from $AGENT to whoever requested it$NOTIFY_HINT."
    fi
    if findings_unfinished; then
      block "review round file $ROUND_FILE has no VERDICT line yet. Finish the review, write VERDICT: approve or VERDICT: needs_work as its last line, then send one review-verdict: message from $AGENT to whoever requested it$NOTIFY_HINT."
    fi
    allow
    ;;
esac

# 7. 作業の途中で止まろうとしている
#
# reason は次ターンのガイダンスとして届き、モデルはそれに従う。したがってこの文面は
# 「terminal status を書け」だけであってはならない。判定 5/5b は依頼がディスク上の
# <point>-round-<N>-request.md として materialize されていることを前提にしており、それを
# 書き忘れた待機者はここへ落ちる。2026-08-28 に実測: レビュー依頼の 110 秒後、毎ターン
# block された codex の exec が、この文面が唯一提示していた逃げ道 (error) を取り、
# 進行中だったレビューを「verdict が返らない」として中断した。
#
# したがって待機の逃がし方をここに書く。待機は障害ではないので error は虚偽であり、
# 正しい出口は request ファイルを書いて待機をディスクへ現すことである。これは指示の
# 書き忘れを gate 自身が自己修復する層でもある (次ターンで判定 5b が成立して停止できる)。
# 必須コードレビューが配線されているのに、まだ一度も依頼していない実装者への追記。
#
# Phase B-R の配線はこれまで phase-b-deliver.sh が組み立てる `phase-b-exec:` の本文にしか
# 存在せず、設計ペインが正規経路を通らず自作の引き継ぎ文を送ると情報ごと消えていた。
# 2026-08-31 実測 (lead-psp-liff の member): 手書きの引き継ぎ文には review-code の手順も
# レビュアーの agent 名も無く、代わりに「進捗と blocker は parent へ報告せよ」と書かれて
# いた。実装者は指示どおり parent へレビューを依頼し、レビュアーの inbox は参加以来 0 通、
# code-round-* は 1 つも生まれなかった。
#
# code-review.json はディスク上にあり、そこにレビュアーの agent 名が入っている。この gate は
# それを読めるので、実装者が仕事の途中で止まろうとした瞬間に名指しで渡す。「知っているものは
# reason に入れる」という既存の方針そのものである。
REVIEW_HINT=""
REVIEW_CONFIG="$STATUS_DIR/review/code-review.json"
if [[ "$ROLE" == exec && -r "$REVIEW_CONFIG" ]]; then
  reviewer=$(jq -r '.reviewer_agent // empty' "$REVIEW_CONFIG" 2>/dev/null || echo "")
  # 依頼済みかどうかは request ファイルの有無で見る。1 つでもあれば実装者は経路を知っている。
  code_requested=""
  shopt -s nullglob
  for f in "$STATUS_DIR"/review/code-round-*-request.md; do code_requested="$f"; break; done
  if [[ -n "$reviewer" && -z "$code_requested" ]]; then
    REVIEW_HINT_PREFIX=" A mandatory code review is wired for this task and you have not requested it once: the reviewer is the agent $reviewer, and its findings belong in $STATUS_DIR/review/code-round-<N>.md. Address the request to that agent name — never to parent, and never to a surface or workspace id. If your handoff message did not mention any of this, the wiring is still real: this pane also has $STATUS_DIR/review/code-review.json and a pointer to it in .dispatch-handoff.json at the root of your worktree."
    # TEAM は通常 STATUS_DIR/ROLE/AGENT と一緒に export されるが、この hook の identity 判定は
    # TEAM を必須にしていない。TEAM が無いまま --team を埋めると空文字の壊れた呼び出し例を
    # 提示してしまうので、その場合はコマンド行を出さない。
    if [[ -n "$TEAM" ]]; then
      REVIEW_HINT="$REVIEW_HINT_PREFIX Make the request with one call to bash $SCRIPT_DIR/review-request.sh --review-dir $STATUS_DIR/review --point code --round <N> --team $TEAM --from $AGENT --to $reviewer, piping the request text into it on standard input; that single call writes the request file this gate reads and sends the message."
    else
      REVIEW_HINT="$REVIEW_HINT_PREFIX Materialize the request with bash $SCRIPT_DIR/review-request.sh before sending; that single call writes the request file this gate reads and sends the message."
    fi
  fi
fi

# TEAM が既知のときだけ、実行可能な review-request.sh の呼び出し例を reason に埋める。
# 上の REVIEW_HINT と同じ理由: 空文字の --team を提示しない。
if [[ -n "$TEAM" ]]; then
  WAIT_REISSUE="Instead re-issue the same round through bash $SCRIPT_DIR/review-request.sh --review-dir $STATUS_DIR/review --point <point> --round <N> --team $TEAM --from $AGENT --to <the reviewer agent>, using the same <point> as the round you requested, piping the same request text into it on standard input; that is how this gate sees a wait. Then keep waiting."
else
  WAIT_REISSUE="Instead re-issue the same round through bash $SCRIPT_DIR/review-request.sh, using the same <point> as the round you requested and piping the same request text into it on standard input; that is how this gate sees a wait. Then keep waiting."
fi

arm_lease "progress|$ROLE|$AGENT" || true
PRESERVE_LEASE=1
block "the task is not finished: $STATUS_DIR/status.json has no terminal status yet.$REVIEW_HINT Continue the work. Waiting for a review verdict is NOT being blocked and is NOT an error: if you are waiting, do not write a terminal status. $WAIT_REISSUE To finish real work, write the terminal status with: bash $SCRIPT_DIR/report-status.sh $STATUS_DIR done <message> (use error instead of done only when the work itself failed), then send one dispatch-notify: message to parent as $AGENT$NOTIFY_HINT."
