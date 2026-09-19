## 出力言語

ユーザーへ提示する質問、選択肢ラベル、表、進捗報告はすべて日本語で表示する。
この SKILL.md 本文は規約上の統一のため英語で書かれているだけであり、ユーザーへの
表示言語を変えるものではない。

# Orca Team Dispatch

各タスクを専用の Orca worktree と専用の worker で、1 つの共有 Run 上で実行し、
成果を親へ持ち帰る。

**親は設計しない。**親は依頼をタスクに分け、Step 1b の質問を 1 回だけ尋ね、すぐ dispatch する。
brainstorming、計画、要件についての確認の質問、取りかかり方を決めるためのコード調査は、すべて
各 worker が自分の worktree で並列に行う。親は dispatch 前にそのどれも行わない。

```bash
PLUGIN="${CLAUDE_PLUGIN_ROOT:?the plugin root is not set; reinstall the plugin}"
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
```

Orca は自分の CLI 名を `ORCA_CLI_COMMAND` として export する。WSL2 ではそれが PATH 上の
`orca-ide` で、macOS では app bundle の中に居る。どちらの形も前提にせず、ユーザーへ見せる
コマンドも含めて常に `$ORCA_BIN` 経由で呼ぶ。

**まず引数で振り分ける。**`--setup` と `--reset` は設定するだけで dispatch を 1 件も起こさない
— 設定の節を実行して終わる。`--issue` は仕事をユーザーではなく GitHub から取る — Issue モードの節を
実行する。それ以外は dispatch であり、その設定を読み、設定が無ければ S0 を一度だけ尋ねてから
Step 1 を始める。

## 設定

各ロールは Orca の agent で走り、model と reasoning effort を任意で指定できる。機械的な
入口は `--setup` と `--reset` の 2 つだけで、どちらも dispatch を 1 件も起こさない。

| ファイル | 役割 |
|---|---|
| `~/.claude/config/orca-team-dispatch-task/config.json` | グローバルの role tuple |
| `<repo>/.dispatch/config.json` | プロジェクトの role tuple。グローバルを覆う |

role tuple は `agent` / `model` / `effort` の 3 つを持ち、override → project → global の順に
**フィールド単位で**解決する。runner のレジストリは無い。`--agent` が Orca の起動するものその
ものなので、**agent の id が runner である。**存在するのに読めない層は、不在として読まずに
**dispatch を止める。**

`review_mode` は dispatch がどの役を起こすかを決める。同じ 3 層で解決する。

| `review_mode` | 起こす役 | 何が起きるか |
|---|---|---|
| `off`（既定） | `design` | 1 人の worker が作る。この設定が無かった頃の dispatch と同じである |
| `on` | `design` / `design_review` | reviewer が先に起きて待ち、`design` は作る前に計画をレビューさせる |
| `on` かつ `phase_b=on` | `exec_review` が増える | 実装も同じ形でレビューする。**作る役のレビュアーは、作る役が別に居るときだけ存在する** |

`phase_b` は計画と実装を分け、`integration` は成果の届け方を決める。どちらも同じ 3 層で
解決し、**どちらも既定はこれらが無かった頃の dispatch と同じ**である。

| 設定 | 既定 | もう一方の値 |
|---|---|---|
| `phase_b` | `off` — `design` が計画も実装もする | `on` — `design` は計画を書くだけで何も作らず、2 人目の worker `exec` が自分の worktree でそれを作る |
| `integration` | `merge` — dispatch した元のブランチへ取り込む | `pr` — ブランチを push して pull request を作る |
| `setup` | `skip` — repository の setup hook を走らせずに worktree を作る | `run` — 走らせる。**setup が失敗した worktree では worker を起こさない** |
| `design_mode` | `direct` — `design` は依頼を受けてそのまま取りかかる | `plan` — 最初の編集より前に手順を決めて記録する。`brainstorm` — `superpowers:brainstorming` skill から始め、その端末を見ている人と依頼を詰める |

**`phase_b` が「どのブランチに成果が載るか」を決める** — off なら `design`、on なら `exec`。
merge も pull request も記録されたその 1 つの値を読むので、どちらのブランチを取るかで
食い違うことがない。

役が off の間もその tuple は設定できるので、`review_mode` を on にする前に reviewer を
用意できる。off の役の tuple は dispatch に見せない。

| フィールド | 未設定のときの挙動 |
|---|---|
| `agent` | `claude` を既定にする。この設定が無かった頃の dispatch と同じ挙動である |
| `model` | `--model` を渡さないので Orca 側の既定が使われる |
| `effort` | `--effort` を渡さない。Orca は `--effort` に `--model` を要求するので、model の無い effort は警告して落とす |

### S0. 設定が無ければ一度だけ尋ねる

dispatch はこの設定を読む。だから **設定が 1 つも無い dispatch は Step 1 の前に一度だけ尋ねる。**
第三者キーしか持たない層のファイルは、未設定として扱う。

```bash
: "${PLUGIN:?run the block at the top of this file first}"
SCRIPTS="$PLUGIN/skills/orca-team-dispatch-task/scripts"
RR=$(git rev-parse --show-toplevel) || { echo "not in a git repo" >&2; exit 1; }
CFG=$(bash "$SCRIPTS/config-resolve.sh" --project-root "$RR") || exit 1
jq -r 'if .configured then "configured" else "not configured" end' <<<"$CFG"
```

`not configured` と出たら、3 つの答えを持つ質問を 1 問する: 今すぐ設定する（S1 へ）/ Orca の
既定のまま dispatch する / この 1 回だけ値を指定する。**断ることも正当な答えである** — 既定の
まま dispatch し、このセッションでは二度と尋ねない。この質問で dispatch を止めてはならず、
既に `configured` のときに尋ねてもならない。

### S1. 現状を表示する

両方の層、解決後の tuple、Orca が持っているアカウントを表示する。**何も書かない。**

```bash
printf 'resolved:\n'; jq '.roles' <<<"$CFG"
printf 'global:\n';   bash "$SCRIPTS/config-edit.sh" --config "$(jq -r .global_config  <<<"$CFG")" --show
printf 'project:\n';  bash "$SCRIPTS/config-edit.sh" --config "$(jq -r .project_config <<<"$CFG")" --show
```

agent がどのアカウントでサインインするかは role tuple の一部**ではなく**、この skill から
変更できない。Orca の CLI には `account add` と `account list` しか無く、アクティブな
アカウントを選ぶ口が無いので、全ロールが Orca アプリでそのランタイムに対してアクティブに
なっているアカウントを使う。どのアカウントを消費するかが分かるように表示し、切り替えは
Orca アプリ側で行う旨を伝える:

```bash
"$ORCA_BIN" account list --json | jq '.result
  | {claude: {accounts: [.claude.accounts[]?.id], active: .claude.activeAccountIdsByRuntime},
     codex:  {accounts: [.codex.accounts[]?.id],  active: .codex.activeAccountIdsByRuntime}}'
```

### S2. 層を尋ね、次に tuple を尋ねる

書き込み先をグローバル層かプロジェクト層かで 1 問尋ねる。選ばれた層だけを書く。続けて
`review_mode` を尋ね、そのモードが**実際に起こす役**それぞれについて `agent` / `model` /
`effort` を尋ねる。**そのモードが起こさない役については尋ねない** — 誰も読まない tuple は、
利用者が正しさを確かめられない設定である。

agent の候補は `claude` と `codex` を出し、それ以外は自由入力で受ける。この一覧は便宜で
あって **allowlist ではない** — Orca が agent を増やしてもここを直さずに設定できる状態を
保つ。model と effort は選ばれた agent に合うものを出し、**常に「未設定のままにする」を
選べるようにする**（Orca の既定へ戻せる）。

### S3. 書く前に検証する

回答は pending tuple として保持する。空・前後の空白・制御文字と、`'`、`"`、`` ` ``、`$`、
`\`、`!` を拒否し、**無効だった次元だけ**を再度尋ねる。回答をトリムしてはならない —
入力された値と違う値が保存されるくらいなら拒否するほうがよい。`config-edit.sh` も再度検証し、
どこか 1 つでも無効なら何も書かない。

### S4. プレビューし、確認し、1 度だけ書く

選んだファイルの before と after を見せ、書き込みか中止かを選ばせる。書くときは **1 回だけ**
`config-edit.sh` を呼び、すべての `--set` をそこに載せる。こうすると結果全体が 1 度の
原子的な mv で入り、値が 1 つでも拒否されればファイルは元のままになる。プロジェクト層なら
先に `.dispatch` ディレクトリを `mkdir -p` し、以後このリポジトリではグローバル層を覆うことを
伝える。

```bash
LAYER=$(jq -r .global_config <<<"$CFG")   # or .project_config for the project layer
mkdir -p "$(dirname "$LAYER")"
bash "$SCRIPTS/config-edit.sh" --config "$LAYER" \
  --set roles.design.agent="$AGENT" --set roles.design.model="$MODEL" --set roles.design.effort="$EFFORT"
bash "$SCRIPTS/config-edit.sh" --config "$LAYER" --show
```

未設定のままにする次元は `--set` ごと落とす。既に設定済みのものを消すには `--unset` を使う。

### R. `--reset`

層を尋ね、**この skill が所有するキーだけ**を消す。そのファイルの他のキーは保持し、存在しない
ファイルは作らない。

```bash
bash "$SCRIPTS/config-edit.sh" --config "$LAYER" --unset roles
```

何が変わったかを報告し、S1 から続けるかを尋ねる。

### `design` の取りかかり方を選ぶ

`design_mode` が変えるのは **`design` の指示だけ**である。`exec` は計画に従う役であり、
reviewer は何も作らない。両方に取りかかり方を言うと、誰が決めるのかが曖昧になる。

**設定値は既定であって決定ではない。**dispatch がそれを尋ねずに worker へ適用することは
無い。Step 1b が全タスクについて尋ね、Step 2 がその答えを運ぶ。したがって `direct` へ到達できるのは
設定と `--issue` の経路だけであり、**人が見ている dispatch には必ず `brainstorm` か `plan` の
どちらかが渡る**。

**`brainstorm` は人を要する。**worker の端末は実際に話しかけられる端末であり、それが
この mode を成立させている。同じ理由で、**`--issue` の実行は黙って `plan` へ落とし、
落としたことを言う** — 無人実行には答える人が居ないので、worker は 1 往復待ってから
どのみち自分で決めることになる。その実行は何も尋ねないので、Step 1b を持たない。

`brainstorm` の worker には、**答えが無くても止まらない**こと、skill が入っていなければ
自分流の代替を発明せず `result.md` にそう書くことまで指示してある。

### 保存せずに 1 回だけ試す

Step 2 は `--agent` / `--model` / `--effort` / `--design-mode` を受け取る。これらはその 1 コールに
限り両方の層より強く、**何も書かない**ので、保存する前に model を試せる。

## Issue モード

`--issue` は仕事をユーザーの依頼文ではなく GitHub の issue から取る。`--issue <N>` はその
1 件だけを運び、**I1 を丸ごと飛ばす**。引数なしの `--issue` は I1 を尋ねてから、issue が
尽きるかバッチ上限に達するまでバッチ単位で claim する。

**1 件の issue は 1 コールで最後まで運ばれる。**それが `bin/orca-issue.sh` である。dispatch し、
待ち、merge し、ラベルを遷移させ、issue を close する。**資源は 1 つも消さない** — 手書きの
dispatch とまったく同じく、Step 5 が判定し Step 6 が尋ねる。

| 性質 | この版 |
|---|---|
| 統合 | **merge のみ。**PR の経路は無い。提示してはならない |
| 駆動 | 1 バッチずつ。終わるまで待ってから次を claim する |
| 役 | `review_mode` が解決したものを、その実行の全 issue で共通に使う |

### I0. 事前確認

`gh` / `jq` / Orca ランタイムを確かめ、lock を取る。**lock が生きているなら開始しない** —
2 つのループが同じ issue を claim すると、同じ worktree 名で衝突する。

```bash
: "${PLUGIN:?run the block at the top of this file first}"
SCRIPTS="$PLUGIN/skills/orca-team-dispatch-task/scripts"
RR=$(git rev-parse --show-toplevel) || { echo "not in a git repo" >&2; exit 1; }
STATE="$RR/.dispatch-issue/state.json"
command -v gh >/dev/null 2>&1 || { echo "gh is not installed" >&2; exit 1; }
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" lock-check || exit 1
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" lock-acquire --lease-min 60 || exit 1
# The state file and its lock would otherwise leave the parent checkout dirty, and every
# merge refuses a dirty checkout. Exclude the directory the way `.dispatch/` is excluded.
EX=$(git -C "$RR" rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$EX")" \
  && grep -qxF '.dispatch-issue/' "$EX" 2>/dev/null || printf '.dispatch-issue/\n' >> "$EX"
```

`lock-acquire` は安定した session id を要求する。環境が持っていなければ `LOOP_SESSION_ID` を
export する。**どの終了経路でも lock を解放する** — 想定していなかった経路も含めて。

### I1a. 単件を指定されたとき

`--issue <N>` は仕事を名指ししているので、**尋ねることが無い** — 絞り込みもバッチ数も
バッチ上限も要らない。I0 を済ませたら、その issue を claim して運ぶ。**claim は同じ
`fetch` を通る。**単件では検索を飛ばし、state を書けなかったときにラベルを戻す補償は
そのまま効く。

```bash
: "${SCRIPTS:?run the I0 block first}"; : "${STATE:?run the I0 block first}"
: "${NUM:?set NUM to the issue number given on the command line}"
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" init \
  --config-json '{"concurrency":1}' --filter-json '{"issue":"named"}' || exit 1
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" ensure-labels || exit 1
CLAIM=$(bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" \
          fetch --issue "$NUM" --limit 1 --batch 1) || exit 1
[[ "$(jq 'length' <<<"$CLAIM")" -eq 1 ]] || {
  echo "issue #$NUM was not claimed; it is already recorded in $STATE" >&2
  exit 1
}
SLUG=$(jq -r '.[0].slug' <<<"$CLAIM")
REQ=$(mktemp); jq -r '.[0] | "\(.title)\n\n\(.body)"' <<<"$CLAIM" > "$REQ"
printf 'slug=%s\nrequest_file=%s\n' "$SLUG" "$REQ"
```

claim が空なのは隠すべき失敗ではない。**その issue が既に state file に載っている**という
ことであり、今回の実行のものか以前のものかを述べて、二重に claim せずに止まる。

そのあとは I3 のブロックで運び、I4 のブロックで lock を解放する。**I1 と I2 は飛ばす** —
バッチが無いからである。`init` を上のブロックに入れてあるのは `fetch` が state file を
要求するためであり、`reconcile` は**意図して外している** — 名指しされた issue は state の
残りに依存せず、既に記録済みの issue は `fetch --issue` が既に拒む。

### I1. 一度だけ尋ね、あとは尋ねない

この節は引数なしの `--issue` のためのものである。単件指定はここへ来ない。

次の 4 つを 1 問にまとめて尋ねる。issue の実行は始まったら無人なので、**終わるまで何も
尋ねてはならない。**

1. **ラベル絞り込み** — `gh label list` の上位ラベルに加え、「絞り込まない」と自由入力。
2. **assignee** — `@me` / 未 assign のみ / 絞り込まない。
3. **同時に扱う issue 数** — 1〜10 の整数、既定 5。これは**本当に同時に走る** — I3 が
   バッチ全体を dispatch してから待つ。**上限 10 は資源増幅に対する安全弁であり、
   要求されても上げない。**1 issue が worktree 1 つと worker 1 本を消費し、`review_mode=on`
   では倍になる。
4. **バッチ数の上限** — 数、または issue が尽きるまで。

`review_mode` / `phase_b` / `integration` は尋ねない。設定から解決し、その実行の間は固定
である。**どれが効いているかは開始前に伝える** — 実行の費用と成果の行き先が変わるからである。

### I2. claim の前に整合させる

```bash
: "${SCRIPTS:?run the I0 block first}"; : "${STATE:?run the I0 block first}"
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" init \
  --config-json '{"concurrency":5}' --filter-json '{"state":"open"}' || exit 1
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" ensure-labels || exit 1
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" reconcile
```

**`reconcile` が `abort` を返したら実行を止める。**前回の実行が dispatched のままの issue を
残しており、その worker はまだ生きているかもしれない。lock を解放し、理由を見せて止まる。
state を手で消してはならない。

### I3. 1 バッチを claim し、1 件ずつ運ぶ

`fetch` は `--limit` 件まで claim し、割り当てた `slug` 付きの JSON で返す。exit 3 は
「1 件も claim できなかった」、exit 4 は「尽きたと確認できなかった」であり、**どちらも
ループし直さずに実行を終える。**

**バッチは 3 パスで並列に走らせる。**まず全件を dispatch し、次に **1 回**で全件を待ち、
最後に 1 件ずつ finish する。1 件を最後まで運んでから次を始めると、**ユーザーが何を選んでも
issue は 1 件ずつしか走らず**、バッチの大きさが意味を失う。

パス 1、issue ごとに 1 回。title と body を依頼ファイルへ書き出してから:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${STATE:?run the I0 block first}"
: "${NUM:?set NUM, SLUG and REQ from the claimed issue}"
: "${SLUG:?set NUM, SLUG and REQ from the claimed issue}"
: "${REQ:?set NUM, SLUG and REQ from the claimed issue}"
bash "$PLUGIN/bin/orca-issue.sh" --state-file "$STATE" --phase dispatch \
  --issue "$NUM" --slug "$SLUG" --request-file "$REQ" ${RUN:+--run "$RUN"}
```

**印字された `run_id` を控え、そのバッチの以降の issue には `--run` で渡す** — バッチ全体が
1 つの Run と 1 つの親メールボックスを共有するようにする。印字された `status_dir` も全部控える。
dispatch に失敗した issue は既に `dispatch/failed` が付いて資源が残っている。次へ進み、
その issue をパス 2 から外す。

パス 2、バッチ全体で 1 回 — dispatch できた issue ごとに `--status-dir` を 1 つ:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "<status_dir 1>" --status-dir "<status_dir 2>"
```

exit code の読み方は Step 3 のとおりであり、背景で走らせる理由もそこに書いてある。
exit 5 は**一部の失敗**であってバッチの失敗ではない。自身の `role=design` の行が
`succeeded` だった issue についてパス 3 へ進む。

パス 3、dispatch できた issue ごとに 1 回。統合し、ラベルを遷移させる:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${STATE:?run the I0 block first}"
: "${NUM:?set NUM and SLUG from the issue you dispatched}"
: "${SLUG:?set NUM and SLUG from the issue you dispatched}"
bash "$PLUGIN/bin/orca-issue.sh" --state-file "$STATE" --phase finish \
  --issue "$NUM" --slug "$SLUG" ${REPO:+--repo "$REPO"}
```

`integration` が `pr` のときは、Step 4 と同じ理由で **repository を実行全体で 1 度だけ**
解決し、`REPO` として渡す:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) || exit 1
```

**pull request を作る実行は issue を close しない。**各 pull request の本文に
`Closes #<N>` が入っているので、それがマージされたときに GitHub が閉じる。ここで閉じると、
pull request が却下されても閉じたままになる。


exit 1 はその issue を運べなかったことを意味する。ラベルは既に `dispatch/failed` へ動いて
おり、**その資源は意図して残されている。**次の issue へ進む — 1 件の失敗は他の件について
何も言っていない。

### I4. バッチの間

issue ごとに何が起きたかを報告し、次のバッチを claim する。バッチ上限に達したとき、`fetch` が
何も見つけなかったとき、exit 3 または 4 のときに止める。**最後に lock を解放する:**

```bash
: "${SCRIPTS:?run the I0 block first}"; : "${STATE:?run the I0 block first}"
bash "$SCRIPTS/issue-fetch.sh" --state-file "$STATE" lock-release
```

そのうえで、実行が生んだすべての `status_dir` について Step 5 へ進む。片付けは手書きの
dispatch と同じである — 判定し、ユーザーが承認し、承認されたものだけを消す。

## Step 1: 依頼を書き出す

dispatch するのは一度に 4 タスクまでとする。4 タスクは既に 4 本の agent セッションであり、
Step 6 がタスクごとに 1 問尋ねるが、`AskUserQuestion` が受け取れる質問は
最大 4 問である。ユーザーがそれ以上を望むときは、タスク件数と起動するセッション本数を示し、
4 を超える前に明示的な同意を得る。

**分けるだけで、設計しない。**依頼をタスクに分けることが、親が中身について下す唯一の判断である。
`superpowers:brainstorming` を自分で呼ばず、要件についてユーザーに尋ねず、タスクを形作るために
コードを調べない — `brainstorm` で起動した worker が、それを自分の端末でユーザーと行う。
分け方そのものが不明なときは、分け方だけを尋ねる。

worker は依頼をファイルから読む。逐語で写し、要約しない。要約するとユーザーが実際に
出した指示が失われる。これはタスクごとに 1 回行い、タスクごとに固有の slug と固有の
依頼ファイルを与える。

```bash
SLUG=<lowercase, digits and hyphens, 1-30 chars>
REQ=$(mktemp)
# Use the coding environment's file-write tool to write the user's request verbatim to "$REQ".
# Do not use a shell heredoc: a request may contain REQUEST (or any delimiter) on its own line.
printf 'request_file=%s\n' "$REQ"
```

表示された `request_file` path を file-write tool へ渡す。shell 変数は tool call を跨がないため、
Step 2 を別 call で実行するときは、その正確な path を `REQ` へ設定する。

## Step 1b: 各タスクの取りかかり方を尋ねる

**これは Step 2 より前に、毎回、1 回の `AskUserQuestion` 呼び出しで尋ねる。**全タスクを
一度に扱う。`cmux-team-dispatch-task` の Step 1c と同じ尋ね方である。設定済みの `design_mode` は
この質問が推奨として示す値であって、質問を省く理由ではない — 取りかかり方の適切さはタスクごとに
異なる。

まず設定値を読む:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
RR=$(git rev-parse --show-toplevel) || { echo "not in a git repo" >&2; exit 1; }
bash "$PLUGIN/skills/orca-team-dispatch-task/scripts/config-resolve.sh" --project-root "$RR" \
  | jq -r .design_mode
```

そのうえで、brainstorming から始めるタスクはどれかを尋ねる。各質問は `multiSelect` で選択肢は
タスクの slug なので、1 問に 4 タスクまで入れる。タスクを順に区切り、その質問を 1 回の呼び出しに
最大 4 問入れる。16 タスクを超えるときは、次の 16 件を別の呼び出しで尋ねる。選ばれたタスクは
`brainstorm`、それ以外のタスクは `plan` になる:

| 答え | `design` の worker に渡る指示 |
|---|---|
| `brainstorm`（選ばれた） | `superpowers:brainstorming` skill から始め、計画や実装の前に、端末を見ている人と未解決の論点を詰める |
| `plan`（選ばれなかった） | 最初の編集より前に取りかかり方を決め、`result.md` に記録する |

設定値を推奨として質問文に書く。`brainstorm` なら全タスク、`plan` か `direct` なら無し。
**ここでは `direct` は答えにならない** — 人が見ている dispatch は尋ねられる dispatch なので、
選択は「話して詰める」か「書いて決める」かの間にある。UI が空の選択を拒むことがあるので、
自由記述の選択肢で「なし」と答えれば全タスクが `plan` で始まることを質問文に書いておく。

各タスクの答えをそのタスクの `DESIGN_MODE` として保持し、Step 2 で渡す。Step 2 はそれが
無ければ実行を拒むので、**誰にも尋ねられていないタスクは起動できない。**

**`--issue` は Step 1b を持たない。**無人実行には尋ねる相手が居ないので、`design_mode` は
設定から取り、`brainstorm` は `plan` へ落とす。

## Step 2: 開始

これをタスクごとに 1 回実行する。**最初の呼び出しが Run を作って `run_id` を印字し、以降の
呼び出しはその同じ `run_id` を `--run` で渡す。こうして全タスクが 1 つの Run と 1 つの親
mailbox を共有する。**並列にではなく、順番に呼ぶ。

```bash
: "${REQ:?set REQ to the exact request_file path printed in Step 1}"
: "${DESIGN_MODE:?set DESIGN_MODE to this task's Step 1b answer: brainstorm or plan}"
RUN="${RUN:-}"   # empty for the first task; the printed run_id for every task after it
OUT=$(bash "$PLUGIN/bin/orca-start.sh" --request-file "$REQ" --slug "$SLUG" \
        --design-mode "$DESIGN_MODE" \
        --objective "<one line naming the outcome>" ${RUN:+--run "$RUN"}) || { echo "$OUT"; exit 1; }
SD=$(sed -n 's/^status_dir=//p' <<<"$OUT")
RUN=$(sed -n 's/^run_id=//p' <<<"$OUT")
printf 'status_dir=%s\nrun_id=%s\n' "$SD" "$RUN"
```

`--objective` は依頼そのものの言葉から取る。成果を名指すだけで、先に詰めるべき設計ではない。

ここでも shell 変数は tool call を跨がず、`DESIGN_MODE` もその 1 つである。この call の中で、
そのタスクの Step 1b の答えから設定する。全タスクの `status_dir` と 1 つの `run_id` を
印字された値のまま控える。Step 3、Step 4、Step 5 はいずれもその正確な値を必要とする。

exit 1 はそのタスクの worker が起動しなかったことを意味する。メッセージに resources are KEPT と
あれば Task はすでに実在する。何も削除せず、表示された inspection コマンドを実行する。すでに
起動済みのタスクは影響を受けない。通常どおり Step 3 で待つ。

起動が、そのタスクの reviewer を起こしたあと `design` を起こす前に失敗したときは、status dir が
既にあるので Step 2 は同じ slug を拒否する。代わりに
`bash "$PLUGIN/bin/orca-start.sh" --slug "$SLUG" --resume --design-mode "$DESIGN_MODE"` で続きから
起動する。記録済みの依頼と Run を使い、まだ dispatch の無い役だけを起こす。`design` に dispatch が
既にあれば拒否する。

起動に失敗しても worker が生きていることがある。exit 1 のメッセージが `dispatch=<id>` を
名指ししているとき、または `worker-start did not report ready` と言っているとき（受け取った
dispatch id を印字せずに記録している）、その worker は共有 mailbox へ完了を送りうる。その
タスクの status dir、すなわち `<repo root>/.dispatch/<slug>` を、それでも Step 3 の待機集合へ
加える — ただし id が実際に `workers.json` へ届いている場合に限る（上記の 2 つのメッセージは
いずれも届いている）。メッセージが代わりに dispatch id を記録できなかったと言っている場合、
id は stderr にしか無いので、そのタスクの dir を加える前に自分で `workers.json` へ書き込む。
そうしないと待機全体が起動時点で `the dispatch identity is incomplete` として失敗し、兄弟
タスクも道連れになる。外すと batch 全体が止まる。待機は知らされていない dispatch のメッセージを
処理できず、兄弟タスクの成果がすべてその後ろで滞る。

## Step 3: 待つ

**完了は 2 相で行い、この待機が親側の半分を担う。**worker は自分で done を報告しない。
nonce を載せた `merge_ready` で成果を差し出して待つ。待機は成果が実際に在るかを確かめ —
計画役なら計画、作る役なら `result.md`、reviewer なら `VERDICT:` 行 — 同じ dispatch へ
`completion-accepted:` か `completion-remediation:` を返す。worker が報告して `worker_done`
を送るのはそのあとである。

**reviewer も検査の例外にしない。**例外にすると findings が正式になる時点が未定義になり、
findings が欠落しても誰も気づかない。

このために追加で走らせるものは無い。下の待機がその中で行う。

先にユーザーへ伝える。worker が終わると、この skill はメッセージを acknowledge する前に
その端末を retain する。ここでは何も解放しない。端末、worktree、dispatch 記録はいずれも、
Step 5 が削除してよいものを判定し、Step 6 がユーザーへ尋ねるまで残る。保持は意図的である。
後段の stage が同じセッションへ review の指摘を送り返すためである。

1 回の呼び出しで全タスクを待つ。タスクは 1 つの Run と 1 つの親 mailbox を共有するので、
1 度の drain ですべてが settle する。`--status-dir` をタスクごとに 1 つ渡す。

```bash
# One --status-dir per task, in Step 2's order. Repeat the flag for every further task.
bash "$PLUGIN/bin/orca-wait.sh" --status-dir "<task 1 status_dir printed by Step 2>" \
                               --status-dir "<task 2 status_dir printed by Step 2>"
```

**背景で走らせる。前景で呼ばない。**最長 24 時間待つ（`--max-waits` の既定 288 × 5 分）
ので、自分のシェル呼び出しはそのはるか手前で打ち切られる。打ち切られても失われるものは
無い（batch を処理し切るまで ack しない）が、居ない間はだれも worker に答えていないので、
その都度また起動する。

**この待機を起動し直す者は居らず、止まったことを知らせる者も居ない。**最大 24 時間
常駐するので、この実行とは無関係な理由でホストに止められうる — 2026-09-11 に 2 回観測した。
worker 自身のテスト実行がマシンを埋め、ハーネスがメモリを取り戻すために待機を停止した。
起動し直すのは常に安全である。batch は処理し切るまで ack されない。誰か待っているかを
知るには、待機が見ているタスクごとに残す鼓動を読む:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
jq -r '"age=\(now - .beat | floor)s window=\(.window_ms / 1000)s"' "$SD/wait.json" 2>/dev/null \
  || echo "no wait has ever stamped this task"
```

age が 3 窓を超えていれば、そのタスクの worker には誰も答えていない。同じ `--status-dir`
の組で待機を起動し直す。`orca-recover.sh` も何かを判断する前に同じことを言うので、
「worker を失った」と「待機を失った」を取り違えずに済む。

ホストが止め続けるなら、待機を監視下から切り離せる。**ただし意識して選ぶこと** —
一方の失敗をもう一方の失敗と取り替えているからである:

```bash
setsid nohup bash "$PLUGIN/bin/orca-wait.sh" --status-dir "<task 1 status_dir>" \
  >> "$SD/wait.log" 2>&1 < /dev/null &
```

切り離した待機は生き残るが、**その exit code は誰にも届かない。**効くのは終了コード 6 で
ある。人へ質問した worker は、誰かが `wait.log` を読んで答えるまでブロックしたままになる。
そのログを見に行くつもりがあるときだけ切り離す。

**`phase_b` が on のとき、この待機は `exec` が終わるまで戻らない — そしてまだ誰も `exec` を
起こしていない。**集約には `integration_role` の `status.json` が要り、`phase_b` ではそれは
`exec` である。ここで放っておいた待機は、見えている worker が全員終わっている状態のまま、
24 時間だまって polling し続ける。**この待機を走らせたまま** Step 3.5 へ行き、そのあと下の
exit 表へ戻る。

走っている間、outcome の収集のほかに 2 つのことをする。`merge_ready` ごとに受理か差し戻しを
返し、**その worker の端末へ 1 行入力する**。後半は飾りではない — Orca のメールボックスに
入れたメッセージは、ターンを閉じた worker を起こさないので、**だれも読まない返事はその
dispatch を永久に止める**。同じ理由で、完了の返事を待ったままの worker には 30 分ごとに
同じ 1 行を打ち直す。働いている worker には打たない。

| Exit | 意味 | すること |
|---|---|---|
| 0 | すべての worker が成功を報告して完了 | 各タスクの `$SD/roles/design/result.md` を読み、ユーザーへ伝えて全タスクを Step 4 へ進める |
| 5 | 1 件以上の worker が失敗を報告 | 各 `result.md` を読み、どのタスクがなぜ失敗したかを伝える。Step 4 へ進めるのは成功したタスクだけで、Step 5 は全タスクに行う。**失敗したタスクを merge しない** |
| 3 | まだ実行中 | 進捗を報告してから、同じ `--status-dir` の組でもう一度呼ぶ |
| 6 | worker が人へ質問し、回答待ちでブロックしている | 質問をそのままユーザーへ取り次ぎ、待機が出力した `reply` コマンドに回答を入れて実行し、同じ待機をもう一度走らせる。失敗ではない。worker は reply で再開する |
| 4 | worker が停止・失敗した、または待機が依存する Orca 呼び出しを検証できない | 調べてユーザーへ伝える。何も削除しない。retention または acknowledgement が完了していないので canonical wait を再実行し、batch を手で復旧しない。完了を負ったまま worker が失われた場合は、下の回復の節を見る |
| 1 | batch がこの版で扱えないメッセージを含む、または outcome が記録と矛盾する | acknowledge していない。手動 acknowledge はせず、下のとおり確認する |

終了コード 6 では何も壊れていない。worker が `orchestration ask` を使っており、人が
この親を通して答えるまでブロックする — 動かせるのは回答だけである。出力された質問を
そのままユーザーへ見せて尋ね、出力された `orchestration reply --id <message id>` に
回答を入れて実行する。そのあと同じ待機をもう一度走らせる。一度取り次いだ質問は処理済み
として扱うので、batch が流れてその worker の完了が処理される。手で acknowledge しては
ならず、ブロックを失敗として扱ってもならない — worker は生きて待っている。

**判断の根拠は exit code であって出力の文字列ではない。**集約行の前に、待機は
`task=... role=... dispatch=... status_dir=... outcome=...` の行を**起動した役ごとに 1 行**
印字するので、レビュー中のタスクは 2 行を持つ。一部だけ失敗したときは、それらの行に両方の
outcome が同時に現れる。どのタスクが失敗したかを名指しするためにその行を使い、成功判定を
出力中の `outcome=` の検索で行ってはならない。

**タスクの結末はその `design` の行である。**reviewer が失敗したのは「レビューが付かなかった」
のであって成果が失われたのではないので、それだけでタスクを失敗にはしない。起きたときは
隠さずに言う — その行はすぐそこに出ている。

exit 1 では **自分で `--ack` を実行しない**。まず error を読む。batch を acknowledge することは、その
batch の全メッセージを処理したという宣言である。この batch は処理できていない。この版が扱えない
メッセージ型を含むか、outcome が既にディスクへ記録された内容と矛盾しているかのいずれかである。
どちらも手作業で直すものではなく、待機を再実行しても同じ batch を読み直すだけで解決しない。
端末と worktree を保持して acknowledge せず、**Step 4 へ進まない**。記録済み receipt と
result をユーザーと確認する。成功した worker outcome が示されていれば、ユーザーは下の手動統合コマンドを
明示的に選べるが、それで batch を acknowledge することはない。acknowledge されない batch はこの親端末の
queue の先頭に残り、手動統合で queue は解消されない。後続の dispatch は別の Orca terminal を開き、そこで
この skill を呼び出して開始する。`orca-start.sh` に親端末を指定する flag はなく、実行した Orca terminal の
`ORCA_TERMINAL_HANDLE` を読むため、新しい terminal の handle が使われる。blocked な handle をコピーまたは
設定してはならない。cursor を進めずに確認して、ユーザーの指示を待つ。この版が扱えないメッセージを
捨ててはならない。

```bash
PH=$(jq -r '.parent_handle // empty' "$SD/run.json")
[[ -n "$PH" ]] || { echo "missing parent handle; do not acknowledge anything" >&2; exit 1; }
"$ORCA_BIN" orchestration check --terminal "$PH" --peek --json
# Rerun the canonical wait only for exit 4; it retries the retention and the acknowledgement.
# For an unhandled or contradictory batch, do not rerun it, and never ack by hand.
```

前の inspection の後で、記録済み outcome と result をユーザーへ見せる。
ユーザーが成功した result を統合すると明示的に決めた場合、次の安全な merge コマンドを実行できる。receipt、
status、result、branch、clean checkout の通常の guard はすべて実行し、blocked な batch を acknowledge しない。

```bash
cat "$SD/received.json"
sed -n '1,240p' "$SD/roles/design/result.md"
# Only after the user has inspected both files and chosen manual integration:
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

確認したメッセージと、この版がそれを扱えなかった理由 — 未知のメッセージ型か、記録と矛盾する
outcome か — をユーザーへ見せる。transport/health の失敗は exit 4 であり、batch を手作業で復旧する
合図ではない。

### 失われた worker を回復する

成果を差し出した worker、あるいは `error` を書いた worker は、まだ `worker_done` を
負っている。**Orca は親がそれを代理送信することを許さない**ので、agent の process が
消えていれば誰も送れない — 仕事は終わっているのにタスクが決着しない。これが、その状況で
何をするかを役ごとに決める:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
: "${PLUGIN:?run the block at the top of this file first}"
bash "$PLUGIN/bin/orca-recover.sh" --status-dir "$SD" --dry-run
```

何をするつもりかを読んでから、`--dry-run` を外してもう一度実行すると実行される。選択肢は
**意図して狭くしてある**:

- **生きている** → nudge するだけ。生きている worker を置き換えると、2 人が同じ完了を
  進めることになる。
- **`failed` / `stopped` が証明された** → **同じ** task に `--retry-of` で replacement を
  起こし、generation を上げ、旧い完了記録を捨てる。新しい worker は新しい nonce で
  差し出し直す。
- **確認できないもの（`outcome_unknown` を含む）** → 何もせず、そう言う。fence が先である。
  ここで推測すると、2 つの capability が 1 つの lifecycle を進めることになる。
- **Orca が既に決着させていた** → 何も送らず、ローカルの記録を合わせる。

Step 3 が exit 4 を返したとき、または worker が居ないままタスクが終わらないときに実行する。

## Step 3.5: `phase_b` が on のときに exec 段を起こす

`phase_b` が `off` のときはこの節をまるごと飛ばす — `design` が自分で成果を運ぶので、
2 段目は存在しない。

`orca-start.sh` は 1 回の呼び出しで 1 段だけを起こす。Step 2 が `--phase design` を走らせた。
実装役が別の段なのは、まだ存在しない計画を実装できる者が居ないからである。**ほかに起こす
主体は居ない** — Step 2 でもなく、待機でもなく、worker でもない。Step 3 の待機は `exec` が
走り切るまで戻らないので、この節を飛ばした dispatch は、起動した worker が全員終わっている
状態のまま 24 時間ハングし、そのあいだ何ひとつ言わない。

**Step 3 の待機は走らせたままにする。止めてはならない。**知らない dispatch を名指しする
message が来るたびに `workers.json` を読み直すので、この節が `exec` と `exec_review` を
記録すれば、待機は自分でそれらを拾う。名指しした batch は理解されるまで ack されないので、
読み直しのあいだに失われるものは無い。

止めて起動し直すのは、何もしないより悪い。Orca の waiter は、それを握っていたプロセスより
長く生き残るので、新しい待機はしばらく弾かれ、その隙間のあいだ誰も worker に答えない。

待機がメールボックスを握っている以上、`design` が終わったことを教えてくれるのは `design`
自身の status ファイルである。タスクごとに 1 回見て、まだ決着していなければ 1 分後にもう
一度見る:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
jq -r '.status // "missing"' "$SD/roles/design/status.json" 2>/dev/null || echo missing
```

- `done` → 下の手順で段を起こす。
- `error` → **起こしてはならない。**建てる価値のある計画が無い。Step 5 へ進み、
  `$SD/roles/design/result.md` が何と言っているかをユーザーへ伝える。
- それ以外 → `design` はまだ working である。あとでもう一度見る。

そのうえで、`design` が `done` を報告したタスクごとに 1 回:

```bash
: "${PLUGIN:?run the block at the top of this file first}"
: "${SLUG:?set SLUG to that task's slug}"
bash "$PLUGIN/bin/orca-start.sh" --phase exec --slug "$SLUG"
```

これはそのタスクの既存の Run と status dir を引き継ぐので、`--request-file` も `--objective`
も `--run` も取らない。`review_mode` が on なら `exec` より先に `exec_review` を起こす。
Step 2 が reviewer を先に起こすのと同じ理由である — 実装役は起動した瞬間にレビューを
求めうる。

`design` が `done` でないとき、`plan.md` が無いか空のとき、`exec` に既に dispatch が在るとき
は、**何も起こさずに拒否する**。これらは guard であって、回避して再試行する種類の失敗では
ない — message が名指しするものを読んで、それを直す。

そのあとは Step 3 の exit 表へ戻る。駆動しているのは既に在る待機のままである。いまは `exec`
にも答え、`exec` が決着するまで戻らない。新しい段を拾った瞬間、その log に
`a dispatch was added after this wait started` と出る。

## Step 4: 成果を持ち帰る

成功したタスクごとに 1 回、`SD` へそのタスクの `status_dir` を設定して実行する。exit 0 なら
全タスクが対象である。exit 5 なら、**成果を載せる役**の行が `outcome=succeeded` で終わって
いたタスクだけが対象である。その役は `integration_role` に記録されている。reviewer の
worktree には持ち帰る成果が無い。

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD"
```

dispatch を始めたときにいたブランチへ、その役のブランチを merge する。worker が成功を
報告していること、`result.md` が空でないこと、checkout が開始時のブランチのままであること、
checkout が clean であることのすべてを満たさなければ拒否する。競合時は merge を中断して
すべてを残すので、ユーザーへ解決方法を伝える。タスクは順番に merge して結果をそれぞれ報告する。
あるタスクが拒否されても、他のタスクについては何も意味しない。

**レビューを求めておいて verdict を得られなかった成果も拒否する。**取り込む役に reviewer が
起動されていたなら、`review/<plan|code>-round-*-findings.md` の少なくとも 1 つが `VERDICT:`
行を持ち、**その verdict が宛先の worker に届いていなければならない**（`sent.json` が記録
する）。findings ファイルだけでは「誰かが書いた」ことしか証明しない。2026-09-12 に観測: reviewer の verdict が 3 Run 中 2 Run で
配送を拒まれて捨てられ、無レビューの成果がそれでも `succeeded` を報告した。**この件で
worker を差し戻すことはしない** — round 2 で諦めるのはこの skill が意図して許している道で
ある。だから検査は、人が判断するここに置く。拒否されたら、`result.md` がレビューについて
何と言っているかを添えてユーザーへ報告し、ユーザーがそう言ったときにだけ取り込む:

```bash
bash "$PLUGIN/bin/orca-merge.sh" --status-dir "$SD" --allow-unreviewed
```

**`integration` が `pr` のときは、上の merge の代わりにこちらを使う。**両方やってはならない
— pull request を作ったうえで merge すると、誰かがレビューする前に成果が入る。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
: "${PLUGIN:?run the block at the top of this file first}"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) || exit 1
bash "$PLUGIN/bin/orca-pr.sh" --status-dir "$SD" --repo "$REPO"
```

**repository はここで 1 度だけ解決して渡す。**2026-09-02 の実測: 3 つの remote を持つ
repository で worker に remote を解決させたところ、personal fork へ push して **その fork の
中に pull request を作った**。issue はそこに無いので `Closes` 行は何もせず、その fork の
pull request が完了の証拠として受理された。

## Step 5: ユーザーへ正確な片付けコマンドを渡す

この step は何も削除しない。削除してよいものを判定し、実際の値を埋めたコマンドを表示する。
placeholder を見せない。実行してよいかは Step 6 がユーザーへ尋ねる。

ここでは worker を release しない。`orchestration worker-list --run <run_id> --json` で Orca が
すでに保持しているものを尋ね、その答えで分類する。worker の端末を閉じる release は Step 6 が
尋ねるアクションの 1 つであり、ユーザーが判断している間、worker のセッションはそのまま残る。

各 cleanup block は別の tool call である。[C1]、[C2]、[C3]、[C5] はタスクごとに 1 回、`SD` へ
そのタスクの正確な `status_dir` を設定して実行する。[C7] は Run 全体について、いずれかの削除の
前に 1 回だけ実行する。各 block は state を自分で読み直し、state がなければ fail closed する。
作り物の handle、dispatch、worktree id を代入してはならない。

**exit code は数字ではなくメッセージで読む。**[C1] が exit 0 になるのは止まる理由を見つけたとき
だけなので、通常の経路では `expected:` で始まるメッセージを出して exit 1 になる。これは停止では
なく、そのまま [C2] へ進む。それ以外の非 0 終了はすべて停止である。メッセージは
`required cleanup state is missing`、`could not …`、`release state … does not authorise` の
いずれかで始まり、そのタスクについて何も閉じても消してもならないことを意味する。[C2] や [C3] が
コマンドを印字せずに exit 0 になるのも停止ではない。提示するものが無いと判定しただけであり、
その理由を述べている。

[C1] `release_pending` または `release_unknown`: そのタスクは **ここで止まる。**exit 0 は何かを
閉じる権限ではない。報告された state と次の inspection コマンドをユーザーへ見せ、端末と worktree は
意図的に保持していると伝える。通常の経路ではこの block は `expected: no hold on this task …` を
印字して exit 1 になる。そのまま [C2] へ進む。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
ROLES=$(jq -r '.roles | to_entries[] | select((.value.dispatch // "") != "") | .key' \
  "$SD/workers.json" 2>/dev/null)
[[ -n "$ROLES" && -n "$RUN" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not read the release state; do not close anything" >&2
  exit 1
}
HELD=0
for ROLE in $ROLES; do
  DID=$(jq -r --arg r "$ROLE" '.roles[$r].dispatch // empty' "$SD/workers.json" 2>/dev/null)
  W=$(jq -c --arg d "$DID" 'first(.result.workers[] | select(.dispatchId == $d)) // empty' <<<"$WL" 2>/dev/null)
  [[ -n "$W" ]] || { echo "could not read the release state; do not close anything" >&2; exit 1; }
  STATE=$(jq -r '.resource.releaseState // .terminalState // empty' <<<"$W" 2>/dev/null)
  case "$STATE" in
    release_pending|release_unknown)
      printf '%s\n' "$W"
      printf '%q orchestration worker-show --dispatch %q --json\n' "$ORCA_BIN" "$DID"
      HELD=1 ;;
    released|already_released|not_requested|retained|active|reclaimable) ;;
    *)
      echo "could not read the release state; do not close anything" >&2
      exit 1 ;;
  esac
done
[[ "$HELD" -eq 0 ]] || exit 0
echo "expected: no hold on this task; continue with [C2]" >&2
exit 1
```

[C2] worker の端末を閉じてよいかを判定し、閉じるコマンドを **実行せずに** 印字する。通常の経路
では state は `retained` である。Step 3 がこの worker を意図的に retain しているためである。
`active`、`reclaimable`、`not_requested` もここでは同じ意味であり、端末はまだ在って、閉じる
ことを提示するのはこちらの役目である。`not_requested` は、起動直後に失敗した worker が
`terminalState: reclaimable` と並べて報告する値である。release が一度も要求されていないという
だけの意味だが（2026-09-11 に観測）、これを「読めない」と扱っていたために、**もっとも片付けを
必要とする失敗ほど Step 5 が片付けを拒む**状態になっていた。`released` と `already_released` は端末が既に無いという意味であり、提示する
ものはない。コマンドを印字してよいのは Orca が報告する handle と worktree が記録済み state と
一致するときだけで、一致しなければ何を、なぜ残すのかを伝える。

印字するのは raw な端末 close ではなく `orchestration worker-release --dispatch <id>` である。
閉じる前に worker の出力を archive するので、閉じた後も `worker-read` が読める。そして identity を
証明できない端末や、誰かが引き取った端末を閉じることを拒む。この拒否は、この block が適用する
gate の下にあるもう 1 つの gate である。

Orca が既に閉じた端末は show できない。したがってここでは `terminal show` の失敗は致命的である。
identity 検査へ到達する state では、いずれも端末がまだ在るはずだからである。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
ROLES=$(jq -r '.roles | to_entries[] | select((.value.dispatch // "") != "") | .key' \
  "$SD/workers.json" 2>/dev/null)
[[ -n "$ROLES" && -n "$RUN" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not read the release state; do not close anything" >&2
  exit 1
}
for ROLE in $ROLES; do
  WT=$(jq -r --arg r "$ROLE" '.roles[$r].worktree_id // empty' "$SD/workers.json" 2>/dev/null)
  TH=$(jq -r --arg r "$ROLE" '.roles[$r].terminal // empty' "$SD/workers.json" 2>/dev/null)
  DID=$(jq -r --arg r "$ROLE" '.roles[$r].dispatch // empty' "$SD/workers.json" 2>/dev/null)
  WP=$(jq -r --arg r "$ROLE" '.roles[$r].worktree_path // empty' "$SD/workers.json" 2>/dev/null)
  [[ -n "$WT" && -n "$TH" && -n "$DID" && -n "$WP" ]] || {
    echo "required cleanup state is missing; do not close or remove anything" >&2
    exit 1
  }
  W=$(jq -c --arg d "$DID" 'first(.result.workers[] | select(.dispatchId == $d)) // empty' <<<"$WL" 2>/dev/null)
  [[ -n "$W" ]] || { echo "could not read the release state; do not close anything" >&2; exit 1; }
  STATE=$(jq -r '.resource.releaseState // .terminalState // empty' <<<"$W" 2>/dev/null)
  case "$STATE" in
    released|already_released)
      echo "Orca already closed the $ROLE terminal; nothing to close"; continue ;;
    not_requested|retained|active|reclaimable) ;;
    *) echo "release state '${STATE:-unknown}' does not authorise C2" >&2; exit 1 ;;
  esac
  SHRC=0; SHOWN=""
  SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
  [[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 || {
    echo "could not verify the terminal identity; do not close anything" >&2
    exit 1
  }
  if [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
     && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
    printf '%s orchestration worker-release --dispatch %q --json\n' "$ORCA_BIN" "$DID"
  else
    echo "the $ROLE terminal no longer matches our state; leave it alone"
  fi
done
```

[C3] worktree の削除は破壊的である。次の条件がすべて実際に成り立つ場合だけ削除コマンドを
表示する。条件を説明するだけで済ませない。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
MERGED=$(jq -r '.merged // false' "$SD/integration-result.json" 2>/dev/null)
ROLES=$(jq -r '.roles | to_entries[] | select((.value.dispatch // "") != "") | .key' \
  "$SD/workers.json" 2>/dev/null)
[[ -n "$ROLES" && -n "$RUN" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not read the release state; do not remove anything" >&2
  exit 1
}
for ROLE in $ROLES; do
  WT=$(jq -r --arg r "$ROLE" '.roles[$r].worktree_id // empty' "$SD/workers.json" 2>/dev/null)
  TH=$(jq -r --arg r "$ROLE" '.roles[$r].terminal // empty' "$SD/workers.json" 2>/dev/null)
  DID=$(jq -r --arg r "$ROLE" '.roles[$r].dispatch // empty' "$SD/workers.json" 2>/dev/null)
  WP=$(jq -r --arg r "$ROLE" '.roles[$r].worktree_path // empty' "$SD/workers.json" 2>/dev/null)
  OWNED=$(jq -r --arg r "$ROLE" '.roles[$r].worktree_created_by_this_run // false' "$SD/workers.json" 2>/dev/null)
  KNOWN=$(jq -c --arg r "$ROLE" '.roles[$r].worktree_terminals // null' "$SD/workers.json" 2>/dev/null)
  [[ -n "$WT" && -n "$TH" && -n "$DID" && -n "$WP" && -n "$KNOWN" ]] || {
    echo "required cleanup state is missing; do not close or remove anything" >&2
    exit 1
  }
  W=$(jq -c --arg d "$DID" 'first(.result.workers[] | select(.dispatchId == $d)) // empty' <<<"$WL" 2>/dev/null)
  [[ -n "$W" ]] || { echo "could not read the release state; do not remove anything" >&2; exit 1; }
  STATE=$(jq -r '.resource.releaseState // .terminalState // empty' <<<"$W" 2>/dev/null)
  case "$STATE" in
    released|already_released|not_requested|retained|active|reclaimable) ;;
    *) echo "release state '${STATE:-unknown}' does not authorise C3" >&2; exit 1 ;;
  esac
  SHRC=0; SHOWN=""; SHOW_OK=no
  SHOWN=$("$ORCA_BIN" terminal show --terminal "$TH" --json 2>/dev/null) || SHRC=$?
  [[ "$SHRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminal | type == "object")' <<<"$SHOWN" >/dev/null 2>&1 \
    && SHOW_OK=yes
  if [[ "$SHOW_OK" == no && "$STATE" != released && "$STATE" != already_released ]]; then
    echo "could not verify the terminal identity; do not remove anything" >&2
    exit 1
  fi
  IDENTITY_OK=no
  if [[ "$SHOW_OK" == no ]]; then
    IDENTITY_OK=yes
  elif [[ "$(jq -r '.result.terminal.handle // empty' <<<"$SHOWN")" == "$TH" \
       && "$(jq -r '.result.terminal.worktreeId // empty' <<<"$SHOWN")" == "$WT" ]]; then
    IDENTITY_OK=yes
  fi
  DIRTY=$(git -C "$WP" status --porcelain 2>/dev/null); DRC=$?

  # Every terminal Orca still has in that worktree must be one we recorded. Keep all three
  # states: yes is proven, no is disproven, and unknown is not enough authority to remove.
  ACCOUNTED=unknown
  TLRC=0; TL=$("$ORCA_BIN" terminal list --worktree "id:$WT" --json 2>/dev/null) || TLRC=$?
  if [[ "$TLRC" -eq 0 ]] && jq -e '.ok == true and (.result.terminals | type == "array")' <<<"$TL" >/dev/null 2>&1 \
     && jq -e 'type == "array"' <<<"$KNOWN" >/dev/null 2>&1; then
    ACCOUNTED=$(jq -n --argjson l "$(jq -c '[.result.terminals[].handle]' <<<"$TL")" \
                      --argjson k "$KNOWN" 'if (($l - $k) | length) == 0 then "yes" else "no" end' -r)
  fi

  if [[ "$MERGED" == true && "$OWNED" == true && "$DRC" -eq 0 && -z "$DIRTY" \
        && "$IDENTITY_OK" == yes && "$ACCOUNTED" == yes ]]; then
    printf '%s worktree rm --worktree %q --json\n' "$ORCA_BIN" "id:$WT"
  else
    echo "not offering to remove the $ROLE worktree:"
    [[ "$MERGED" == true ]]      || echo "  - the work is not merged yet"
    [[ "$OWNED" == true ]]       || echo "  - this dispatch reused an existing worktree; it is not ours to remove"
    [[ "$DRC" -eq 0 ]]           || echo "  - the worker checkout could not be inspected"
    [[ -z "$DIRTY" ]]            || echo "  - the worker checkout has uncommitted changes"
    [[ "$IDENTITY_OK" == yes ]]  || echo "  - the terminal identity did not match our state"
    case "$ACCOUNTED" in
      yes) ;;
      no)      echo "  - a terminal in that worktree is not one we recorded" ;;
      unknown) echo "  - the terminals in that worktree could not be listed, so nothing is proven" ;;
    esac
  fi
done
```

[C3] は worktree を削除してよいかを判定する。[C2] と同じく、この block は何も削除しない。
Step 6 は端末のアクションを先に実行するので、端末がまだ開いたままの worktree がここで正当に
提示されることがある。

`IDENTITY_OK` は [C3] の中で計算する。[C2] から shell 変数を持ち込まない。released 系の state で
端末を show できないとき（Orca が閉じたことがそのまま証明になる）と、この block 内で handle と
worktree が一致したときにだけ `yes` になる。
worker が Step 3 で exit 5 を返したタスクは `MERGED` が false であり、そのタスクの削除を
提示しない。これは意図した動作であって欠落ではない。

[C7] `worker-retain` は durable な例外を記録するため、中断したセッションの保持が
残りうる。この Run について何かを消す前に、Orca が実際に何を保持しているか尋ね、
自分たちの記録と突き合わせる。記録に無い保持は他者のもの、あるいは前回の Run の
自分たちのものであり、いずれにせよ手を出してよいものではない。この Run のすべての
タスクが 1 つの答えを共有するので、実行は 1 回だけとし、`SDS` には **すべての** タスクの
status dir を並べる。Orca は Run 全体を報告するため、`SDS` から漏れた兄弟タスクは ghost に
見え、全タスクの片付けを止めてしまう。別の Run の status dir を混ぜると逆に既知集合が広がり、
本物の ghost を隠してしまう。そのため、並べた各 dir の `run_id` を、その dispatch を信用する
前に検査する:

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
ORCA_BIN="${ORCA_BIN:-${ORCA_CLI_COMMAND:-/Applications/Orca.app/Contents/Resources/bin/orca}}"
SDS=("$SD")   # append every other status_dir of this Run
RUN=$(jq -r '.run_id // empty' "$SD/run.json" 2>/dev/null)
[[ -n "$RUN" && -n "$ORCA_BIN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
# A dir from another Run would widen the known set and hide the very ghost we look for.
WJ=()
for d in "${SDS[@]}"; do
  [[ "$(jq -r '.run_id // empty' "$d/run.json" 2>/dev/null)" == "$RUN" ]] || {
    echo "$d does not belong to Run $RUN; do not close or remove anything" >&2
    exit 1
  }
  WJ+=("$d/workers.json")
done
KNOWN=$(jq -sc '[.[] | .roles[]?.dispatch // empty]' "${WJ[@]}" 2>/dev/null)
[[ -n "$KNOWN" ]] || {
  echo "required cleanup state is missing; do not close or remove anything" >&2
  exit 1
}
WLRC=0; WL=$("$ORCA_BIN" orchestration worker-list --run "$RUN" --terminal-state retained --json 2>/dev/null) || WLRC=$?
[[ "$WLRC" -eq 0 ]] && jq -e '.ok == true and (.result.workers | type == "array")' <<<"$WL" >/dev/null 2>&1 || {
  echo "could not list what Orca still holds for this Run; do not remove anything" >&2
  exit 1
}
GHOSTS=$(jq -c --argjson k "$KNOWN" '[.result.workers[].dispatchId] - $k' <<<"$WL")
if [[ "$(jq 'length' <<<"$GHOSTS")" -eq 0 ]]; then
  echo "every retained worker in this Run is one we recorded"
else
  echo "Orca still holds retained workers we did not record:" >&2
  jq -r '.[]' <<<"$GHOSTS" >&2
  echo "do not remove any worktree or dispatch record for this Run" >&2
  exit 1
fi
```

[C5] `.dispatch/<slug>` の dispatch 記録は、依頼と worker の結果の唯一のローカル控えである。
そのため、そのタスクの成果が merge 済みになったときだけ削除を提示する。この block は Orca
コマンドを呼ばないので release の分類も行わない。代わりに `$SD` が本当にこの dispatch の
記録であり、`.dispatch` ディレクトリの中にあることを証明する。

```bash
: "${SD:?set SD to the exact status_dir printed in Step 2}"
MERGED=$(jq -r '.merged // false' "$SD/integration-result.json" 2>/dev/null)
[[ -f "$SD/run.json" && -f "$SD/workers.json" ]] || {
  echo "this is not a dispatch status directory; do not remove anything" >&2
  exit 1
}
PARENT=$(cd "$SD/.." 2>/dev/null && pwd -P) || PARENT=""
[[ "$(basename "${PARENT:-/}")" == .dispatch ]] || {
  echo "the status directory is not inside .dispatch; do not remove it" >&2
  exit 1
}
if [[ "$MERGED" == true ]]; then
  printf 'rm -rf %q\n' "$SD"
else
  echo "not offering to remove the dispatch record:"
  echo "  - the work is not merged yet, so this is the only copy of the request and result"
fi
```

ユーザーへ、次を平易な言葉で伝える。

- [C1] `release_pending` と `release_unknown` は、以前の release を Orca が確定できていない状態で
  ある。そのタスクについては何も閉じても消してもならない。ここに acknowledge するものはない。
  この worker を報告したメッセージは Step 3 が既に acknowledge している。報告された state と
  inspection コマンドを見せ、端末・worktree・記録をそのまま残す。`release_pending` は自然に
  確定しうるので、後で Step 5 をやり直せば解ける場合がある。`release_unknown` はユーザーが
  見る必要がある。
- [C2] `retained`、`active`、`reclaimable`、`not_requested` は worker の端末がまだ在ることを
  意味し、handle と worktree が記録済み state に一致する端末だけを release の対象として提示する。
  一致しなければ、すでに他者の所有物である。`not_requested` は「まだ誰も release を要求して
  いない」というだけで、起動時に失敗した worker の通常の状態である。`released` と `already_released` は端末が既に無いことを意味し、
  そのタスクについて閉じるものは残っていない。
- [C3] 削除コマンドは、成果が merge 済み、この dispatch が worktree を作成した、checkout が
  読めて clean、端末 identity が一致、worktree にまだ残る端末すべてが記録済み、の全条件を
  満たすときだけ表示する。再利用 worktree は最初からこちらのものではないため、削除を提示しない。
  **端末を列挙できないことは「存在しない」ことではない。何も証明されないのでコマンドを表示しない。**
- [C7] 何かを消す前に、この Run について Orca が実際に保持しているものが、こちらの記録と
  一致していなければならない。記録に無い保持が 1 つでもあれば、その worker だけでなく
  Run 全体の片付けを止める。
- [C4] `worktree rm` は branch の削除も試みる。Orca は変更が merge 済みと証明できない branch を
  残すので、branch が残ることは失敗ではなく合図である。ユーザーが dirty なファイルを見て失っても
  よいと判断するまで、`--force` を加えない。
- [C5] dispatch 記録は merge 済みになってからだけ提示する。それまでは何を依頼して何が返って
  きたかの唯一の控えであり、失うと手で調べる・再開する手段も失う。

## Step 6: 一度だけ尋ね、承認されたものを実行する

判定は Step 5 が済ませた。この step は尋ねて実行する。独自の判定は一切行わない。
Step 5 が実際に印字したコマンドを、印字されたとおりに実行するだけである。**worker の端末を
release するのはここである。**セッションを閉じることはユーザーが承認するアクションの 1 つで
あって、判定の副作用ではない。

[C6] 尋ね方と実行:

- どのタスクについても Step 5 が片付けのコマンドを 1 つも印字しなかったときは、承認するものが
  ない。[C1] の inspection コマンドはこれに数えない。Step 5 が既に印字した理由をそのまま使い、
  何を、なぜ残すのかをユーザーへ伝えて終わる。尋ねない。
- 質問はタスクごとに 1 問とし、質問の header にはそのタスクの slug を使い、選択肢はそのタスクに
  ついて Step 5 が印字した対象だけにする。Step 5 が何も印字しなかったタスクは質問から丸ごと
  外し、そのタスクについて何を、なぜ残すのかを伝える。
- `AskUserQuestion` が受け取れる質問は最大 4 問である。Step 1 でユーザーが 4 を超えるタスクを
  承認していた場合は、代わりに単一の質問とし、選択肢を「全タスクの端末」「全タスクの worktree」
  「全タスクの dispatch 記録」とする。選択肢に出してよいのは、少なくとも 1 つのタスクについて
  Step 5 がその対象を印字したときだけである。
- Step 5 が印字を見送った対象を選択肢に出さない。
- 何も選ばないのは正当な回答である。すべてを残し、何が残ったかを伝える。
- 承認されたコマンドは、タスクを slug 順に、タスク内では 端末 → worktree → dispatch 記録 の順に
  実行する。端末のコマンドは Step 5 が印字した `worker-release` であり、worker のセッションを
  終わらせるのはこれである。端末が開いたままの worktree を Orca は手放さず、記録は最後に失う
  ものだからである。
- 各コマンドは Step 5 が印字したとおりに実行する。handle や worktree id を打ち直さない、
  `--force` を加えない、印字を見ていない selector に差し替えない。
- Orca コマンドごとに receipt を確認する。`.ok == true` のときだけ実行できたとみなす。
  それ以外ならそこで止め、何が実行されなかったかを報告し、残りには手を付けない。
  失敗が次の step を authorise することはなく、あるタスクの失敗が別のタスクの先送りを
  authorise することもない。
- **端末の操作については `.ok == true` では足りない。**実機で計測したところ、Orca が端末を
  user-owned とみなしている場合、`worker-release` は何も解放しないまま `ok` を返す —
  receipt は `releaseState: retained` と `retainedReason: user_takeover` のままである。
  セッションを閉じたと言う前に、その state を読み直す。Orca が保持した端末は止まるべき失敗
  ではなく（worktree の step は続けてよい）、閉じたと報告することだけが誤りである。
- dispatch 記録は端末と worktree の id を保持している。それらと並べて提示するときは、
  記録だけを削除して他を残すと何を失うのかをその選択肢に書き、承知のうえで選べるようにする。
- 最後に、タスクごとに削除したものと残したものを報告する。

## 既知の制限

該当するときは、黙って回避せずユーザーへ伝える。

| 制限 | ユーザーがすること |
|---|---|
| 片付けが勝手に走ることはない | Step 6 の質問に答える。承認したものだけが削除され、断ったものは残る |
| 回復は自動では走らない。いつ走らせるかは人が決める | `orca-recover.sh`（Step 3）が役ごとに判断し、`--dry-run` を外して実行したときだけ動く。`$ORCA_BIN orchestration task-list --run <run_id> --json` と `$ORCA_BIN orchestration worker-show --dispatch <id> --json` で調べ、Step 5 と Step 6 と同様に片付ける |
| worker が報告せずに停止すると、組全体の待機が timeout する | 同じ inspection を行う。状態は `.dispatch/<slug>/` に、タスクごとに 1 ディレクトリある |
| worker が人へ尋ねるのは `design_mode` がそう指示したときだけで、答えるまでブロックする | `direct` と `plan` では代わりに `result.md` へ理由を書いて失敗として終了するよう指示してある。読んで再度 dispatch する。`brainstorm` では `orchestration ask` を使い、待機が終了コード 6 で質問と `reply` コマンドを出す。worker が再開するのはそのコマンドを実行したときだけである |
| 差し戻された worker は同じセッションで作り直す。この skill はそのラウンド数を制限しない | 待機の出力を見る。差し戻しは理由付きで 1 行ずつ出る。検査を満たせない worker は、失敗するか待機が時間切れになるまで差し戻され続ける |
| レビューは 2 ラウンドで打ち切り、無言の reviewer への再依頼は 1 回だけ | レビューされる側が未解決の findings を `result.md` に記録し、手元の最良版を保つ。統合する前にその節を読む |
| agent がどのアカウントでサインインするかは選べない | Orca の CLI には `account add` と `account list` しか無く、アクティブなアカウントを選ぶ口が無い。切り替えは Orca アプリで行い、現状は `$ORCA_BIN account list --json` で読む |
| setup hook は頼まない限り走らない | `setup` を `run` にする。setup が失敗した worktree には worker が付かないので、失敗は「起動を拒む」形で見える（不可解な成果物としてではなく） |
| pull request は作るだけで、この skill が merge もレビューもしない | 自分でレビューして merge する。issue は pull request がマージされたときに閉じるのであって、実行が終わったときではない |
| reviewer の verdict が配送を拒まれ、成果が無レビューのまま残ることがある | 2026-09-12 に 3 Run 中 2 Run で観測: 依頼側が待つのをやめて決着したため、その dispatch がもう verdict を受け付けず、`orca-send.sh` が未配送として報告した。findings ファイルはディスクに残る。だから待機も Step 4 もそのファイルをレビューとは数えず、どちらも `sent.json` の配送記録を読む。待機は `accepted UNREVIEWED` と言い、Step 4 は `--allow-unreviewed` を渡すまで merge を拒む |
| 待機を起動し直す者は居らず、止まったことを知らせる者も居ない | 最大 24 時間常駐するのでホストに止められうる — worker 自身のテストがマシンのメモリを使い切った場面で 2 回観測した。`wait.json` を読む（Step 3）か、`orca-recover.sh` を走らせる。何かを判断する前にそう言う。起動し直すのは常に安全である。`setsid` で切り離せば生き残るが、その exit code はどこにも届かなくなる |
| 新しい worktree が親 checkout の「いまの」HEAD から切られない | `worktree create` は基点を取らないので、基点を選ぶのは Orca である。2026-09-12 に観測: 先のタスクを取り込んだあとに切った worktree が取り込み前の base のままで、そこで実装すると既に入っている変更を知らないまま働くことになる。Step 2 は**自分が作った** worktree を親の HEAD まで早送りしてそう言い、両者に祖先関係が無ければ起動そのものを拒む。再利用した worktree には触らない — 動かすと進行中の作業を巻き戻しかねないからである |
| 待機が新しい段に気づくのは、そこからの message が届いたときである | 知らない dispatch を名指しする最初の message で `workers.json` を読み直すので、Step 3.5 に再起動は要らない。その最初の message が来るまで新しい役は進捗行に出ないが、それは段の起動に失敗した印ではない |
| worker が自分のレビュー待ちを取れないことがある | 2026-09-11 に観測: `exec` は、Orca がその Run で既にアクティブな actionable waiter を持っていたためレビュー待ちを開始できないと報告し、verdict の無いまま成果を差し出した。worker には「この拒否はメールボックスが塞がっているという意味であって、レビューが使えないという意味ではない。待ちをもう一度走らせよ」と指示してある。それでも無レビューで終わったときは待機がそう名指しする — log に `accepted UNREVIEWED`、その役の最終行に `review=unreviewed` が出る |
| `phase_b=on` は 2 段目を人が起こす必要があり、それを欠いた待機は黙って失敗する | Step 3.5 が起こす。`integration_role` が `status.json` を書かないままの待機は、log に何も出さず、起動した worker が全員終わっている状態で 24 時間 polling し続ける。worker が詰まっていると結論する前に `roles/<integration_role>/status.json` を見る |
| `phase_b=on` はタスクごとに worker と worktree を 1 つずつ増やす | 計画と実装を分ける価値があるとき以外は off のままにする。計画は書かれたなら `.dispatch/<slug>/plan.md` に残る |
| `--issue` の実行は crash から自力で再開しない | 次の実行の `reconcile` が claim を見つけ、何も走っていなければ release し、走っているかもしれなければ実行を止める |
| 遅い 1 件がそのバッチの残りを待たせる | 待ちはバッチ単位である。長くなると分かっている issue があるならバッチを小さくする |
| 解放したはずの worker が `retained` の記録のまま残り、同じ Run の後の dispatch で [C7] が止まることがある | 2 回独立に観測した: `worker-release` は `ok` を返すのに receipt は `releaseState: retained` / `retainedReason: user_takeover` のままで、その記録は端末そのものより長く残る。worktree を消すと端末も一緒に閉じる — release が通らなかった場面で `$ORCA_BIN worktree rm --worktree "id:<worktree id>"` は成功した（2026-09-11 に観測）ので、そのタスクについては Step 6 でそちらを提示する。それ以外では、dispatch が消えた Run を使い回さず新しい Run を起こす。[C7] の範囲は Run 単位なので、新しい Run は影響を受けない |
| この版が扱えない batch は acknowledge されないまま親 terminal の queue を block する | acknowledge しない。`received.json` と `result.md` を確認する。guarded manual integration でも queue は解消されない。後続の dispatch は別の Orca terminal から開始し、launch 時にはその `ORCA_TERMINAL_HANDLE` が使われる |
| Orca が `release_pending` / `release_unknown` と報告する dispatch は片付けられない | [C1] がそのタスクを止める。端末・worktree・記録をそのまま残し、`$ORCA_BIN orchestration worker-show --dispatch <id> --json` で調べる。`release_pending` は自然に確定しうるが、`release_unknown` は判断が要る |
| failure / edge receipt fixture の一部は simulated のままである | 実機 E2E は worker 1 本の成功経路に加え、**レビュー 2 役の成功経路**、`check` の wait/ack、`worker-release` の別 state、terminal/worktree cleanup の実機 receipt まで証明した。**failure と rejection の receipt は依然 simulated** であり、それを消費する経路に依存する前に capture する |

## ディスク上の状態

タスクごとに `.dispatch/<slug>/` が 1 つあり、そこに `request.md`、`run.json`、`workers.json`、
`received.json`、`integration-result.json`、`wait.json`（待機が毎周回残す鼓動）、
`sent.json`（このタスクが実際に配送した message の記録）、
`roles/design/{status.json,result.md}` がある。
1 つの Run のタスクは `run.json` に同じ `run_id` を持ち、`workers.json` にそれぞれの worktree を
持つ。`workers.json` の `roles` map は役ごとに 1 entry を持つので、後段の stage が何も動かさずに
役を増やせる。手で再開・片付けするために必要なものはすべてここにある。`.dispatch/` は
repository の `info/exclude` に加えるため、ユーザーの `git status` には現れない。
