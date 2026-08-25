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
# Output: block したいときだけ {"decision":"block","reason":"..."} を stdout へ
# Exit:   0 = 判定完了 (block の有無は stdout で表す) / 2 = 使用法エラー
#
# 使用法エラーで stdout へ何も出さないのは意図的である。壊れた JSON を hook へ返すと
# engine 側が毎ターン parse error を報告し、本来の停止理由が見えなくなる。
set -uo pipefail

die() { echo "completion-gate: $1" >&2; exit 2; }

STATUS_DIR=""; ROLE=""; AGENT=""; TEAM=""; SEND_CMD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir) [[ $# -ge 2 ]] || die "--status-dir requires a value"; STATUS_DIR="$2"; shift 2 ;;
    --role)       [[ $# -ge 2 ]] || die "--role requires a value";       ROLE="$2";       shift 2 ;;
    --agent)      [[ $# -ge 2 ]] || die "--agent requires a value";      AGENT="$2";      shift 2 ;;
    --team)       [[ $# -ge 2 ]] || die "--team requires a value";       TEAM="$2";       shift 2 ;;
    --send-command) [[ $# -ge 2 ]] || die "--send-command requires a value"; SEND_CMD="$2"; shift 2 ;;
    *)            die "unknown argument: $1" ;;
  esac
done
[[ -n "$STATUS_DIR" ]] || die "--status-dir is required"
[[ -n "$AGENT" ]] || die "--agent is required"
case "$ROLE" in
  design|design_review|exec|exec_review) ;;
  *) die "--role must be design, design_review, exec or exec_review" ;;
esac

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
# ターンのたびに止まり、人間が突かない限り一歩も進まなくなった。
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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# 停止を許す。stdout へ何も出さない。
# 待機から復帰したあとに前の回数を持ち越さないよう、必ずカウンタを消す。数えているのは
# 「ターンが進んだ回数」ではなく「連続して block した回数」である。
allow() { rm -f "$BLOCK_COUNT_FILE" 2>/dev/null || true; exit 0; }

# 継続させる。上限が設定されている (MAX_BLOCKS > 0) ときだけ数え、達したら諦めて停止を許す。
# 既定の無制限ではカウンタに触れない — 数える相手が居ないので、ファイル I/O ごと不要である。
block() {
  local n
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

# 1. 仕事が終わっている
if [[ -f "$STATUS_DIR/status.json" ]]; then
  st=$(jq -r '.status // empty' "$STATUS_DIR/status.json" 2>/dev/null || echo "")
  case "$st" in done|error) allow ;; esac
fi

# 2. design は Phase B を委譲した時点で終わり
if [[ "$ROLE" == design && -f "$STATUS_DIR/.deferred" ]]; then
  allow
fi

# 最新の review ラウンドファイル。名前は design-round-N.md / code-round-N.md など複数あるので
# glob で拾い、名前順の最後を取る (N が増える命名なので順序が意味を持つ)。
latest_round() {
  local f last=""
  shopt -s nullglob
  for f in "$STATUS_DIR"/review/*round*.md; do last="$f"; done
  [[ -n "$last" ]] && printf '%s' "$last"
}
ROUND_FILE=$(latest_round)

case "$ROLE" in
  design|exec)
    # 3. タスク未着。待つのが正しい状態。
    [[ -f "$STATUS_DIR/.assigned-$AGENT" ]] || allow
    # 5. verdict 待ち。相手が書くまで待つのが正しい状態。
    if [[ -n "$ROUND_FILE" ]] && ! grep -q '^VERDICT:' "$ROUND_FILE" 2>/dev/null; then
      allow
    fi
    ;;
  design_review|exec_review)
    # 4. 依頼未着。レビューペインは .assigned を使わないので round ファイルの有無で判定する
    #    (launch-workspace.sh の所有権判定が .assigned-* を見ており、レビュアーがそれを作ると
    #     foreign assignment と誤認されて status 書き込みが抑止される)。
    [[ -n "$ROUND_FILE" ]] || allow
    # 6. VERDICT を書き終えていない = 自分の仕事が途中。依頼側 (判定 5) とは逆の判定になる。
    if ! grep -q '^VERDICT:' "$ROUND_FILE" 2>/dev/null; then
      block "review round file $ROUND_FILE has no VERDICT line yet. Finish the review, write VERDICT: approve or VERDICT: needs_work as its last line, then send one review-verdict: message from $AGENT to whoever requested it$NOTIFY_HINT."
    fi
    allow
    ;;
esac

# 7. 作業の途中で止まろうとしている
block "the task is not finished: $STATUS_DIR/status.json has no terminal status yet. Continue the work. To finish, write the terminal status with: bash $SCRIPT_DIR/report-status.sh $STATUS_DIR done <message> (use error instead of done if you are blocked), then send one dispatch-notify: message to parent as $AGENT$NOTIFY_HINT."
