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

# 2b. parent へ判断を引き渡して待っている。待つのが正しい状態である。
# レビューのラウンド上限に達した子は、round 6 を始めることも Phase B へ進むこともできない。
# このとき .assigned は残り、最新 round ファイルには VERDICT があり、.deferred はまだ無いので、
# この sentinel が無いと判定 7 に落ちて「terminal status を書け」と迫られる。ところが
# report-status.sh が受け付けるのは done か error だけで、どちらも虚偽になる —
# done は未完了、error は指示どおりの正常な引き渡しであって障害ではない。
# 子は引き渡し時に touch し、parent の回答を受けて再開するときに自分で消す (.deferred と同じ扱い)。
# 2026-08-24 に実測: 5 ラウンド上限に達した design ペインが停止のたびに block された。
if [[ -f "$STATUS_DIR/.escalated" ]]; then
  allow
fi

# 最新の review ラウンドファイル。checkpoint 名は spec / plan / design / code など複数あるので
# glob で拾うが、選び方には 2 つの落とし穴がある。どちらも実測で踏んだ (2026-08-24)。
#
# 1. 依頼文 (<point>-round-<N>-request.md) も同じ glob に一致する。依頼文は findings では
#    ないうえ、レビュアーへの手順説明として "VERDICT: approve" という行を含むのが普通なので、
#    拾うと「verdict 済み」と誤判定する。findings の形 (末尾が round-<数字>.md) だけを取る。
# 2. 「名前順の最後」は checkpoint をまたぐと壊れる。spec が approve 済みで plan が進行中の
#    とき、辞書順では plan-round-1.md < spec-round-5.md なので完了済みの spec を選んでしまい、
#    判定 5 の「verdict 待ちなら allow」が成立せず、正しく待っている依頼側が毎回 block される。
#    要求側もレビュアー側も欲しいのは「最後に依頼されたラウンド」なので mtime で選ぶ。
#    ついでに round-10 が round-2 より前に来る辞書順の問題も同時に消える。
latest_round() {
  local f base last=""
  shopt -s nullglob
  for f in "$STATUS_DIR"/review/*round*.md; do
    base=${f##*/}
    [[ "$base" =~ round-[0-9]+\.md$ ]] || continue
    [[ -z "$last" || "$f" -nt "$last" ]] && last="$f"
  done
  [[ -n "$last" ]] && printf '%s' "$last"
}
ROUND_FILE=$(latest_round)

# 最新の依頼文。findings と対で見る必要がある。findings だけでは「依頼を出して待っている」
# 状態を表現できないからである。round-<N>.md フィルタが依頼文を除外した結果、依頼直後は
# ROUND_FILE が空になり、round 2 以降は ROUND_FILE が前ラウンドの VERDICT 付き findings を
# 指したままになる。どちらも「答えがまだ来ていない」のに、findings だけを見ると
# 「待っていない」と判定されてしまう。
# 2026-08-26 に実ペインで観測: レビュー依頼中の design が毎ターン判定 7 に落ち、
# 「terminal status を書け」と迫られ続けた (上限が無制限だったので停止はしなかった)。
latest_request() {
  local f base last=""
  shopt -s nullglob
  for f in "$STATUS_DIR"/review/*round*-request.md; do
    base=${f##*/}
    [[ "$base" =~ round-[0-9]+-request\.md$ ]] || continue
    [[ -z "$last" || "$f" -nt "$last" ]] && last="$f"
  done
  [[ -n "$last" ]] && printf '%s' "$last"
}
REQUEST_FILE=$(latest_request)

# 最新の依頼に対する答えがまだ無い、を両側で共有する判定。依頼が findings より新しければ、
# その依頼はまだ処理されていない。依頼側にとっては「待て」、レビュアーにとっては「書け」と
# 正反対の意味になるので、判定そのものは 1 か所に置き、使う側で向きを決める。
answer_pending() {
  [[ -n "$REQUEST_FILE" ]] || return 1
  [[ -z "$ROUND_FILE" ]] && return 0
  [[ "$REQUEST_FILE" -nt "$ROUND_FILE" ]]
}

case "$ROLE" in
  design|exec)
    # 3. タスク未着。待つのが正しい状態。
    [[ -f "$STATUS_DIR/.assigned-$AGENT" ]] || allow
    # 5. verdict 待ち。相手が書くまで待つのが正しい状態。
    if [[ -n "$ROUND_FILE" ]] && ! grep -q '^VERDICT:' "$ROUND_FILE" 2>/dev/null; then
      allow
    fi
    # 5b. 依頼は出したが、その依頼に対する findings がまだ無い = 相手待ち。
    #     判定 5 は findings が存在することを前提にしているので、round 1 の依頼直後
    #     (findings 未作成) と round N+1 の依頼中 (findings は round N のもので VERDICT 済み)
    #     を拾えない。ここで拾う。
    if answer_pending; then
      allow
    fi
    ;;
  design_review|exec_review)
    # 4. 依頼未着。レビューペインは .assigned を使わないので review/ のファイルで判定する
    #    (launch-workspace.sh の所有権判定が .assigned-* を見ており、レビュアーがそれを作ると
    #     foreign assignment と誤認されて status 書き込みが抑止される)。
    #    依頼文だけが先に届く区間があるので、findings と依頼文のどちらも無いときだけ許す。
    [[ -n "$ROUND_FILE" || -n "$REQUEST_FILE" ]] || allow
    # 6. 最新の依頼に答え終えていない = 自分の仕事が途中。依頼側 (判定 5/5b) とは逆になる。
    #    依頼文しか無い区間で許してしまうと、レビューを一度も書かないまま止まれてしまう。
    if answer_pending; then
      block "the review requested in ${REQUEST_FILE:-the request file} has no findings file yet. Write your findings to the path that request names, whose LAST line must be VERDICT: approve or VERDICT: needs_work, then send one review-verdict: message from $AGENT to whoever requested it$NOTIFY_HINT."
    fi
    if [[ -n "$ROUND_FILE" ]] && ! grep -q '^VERDICT:' "$ROUND_FILE" 2>/dev/null; then
      block "review round file $ROUND_FILE has no VERDICT line yet. Finish the review, write VERDICT: approve or VERDICT: needs_work as its last line, then send one review-verdict: message from $AGENT to whoever requested it$NOTIFY_HINT."
    fi
    allow
    ;;
esac

# 7. 作業の途中で止まろうとしている
block "the task is not finished: $STATUS_DIR/status.json has no terminal status yet. Continue the work. To finish, write the terminal status with: bash $SCRIPT_DIR/report-status.sh $STATUS_DIR done <message> (use error instead of done if you are blocked), then send one dispatch-notify: message to parent as $AGENT$NOTIFY_HINT."
