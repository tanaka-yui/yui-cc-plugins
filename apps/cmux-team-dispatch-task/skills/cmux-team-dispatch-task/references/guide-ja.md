# Team Dispatch

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

---

## 表示フォーマット規約（Display Format Conventions）

子セッション一覧、進捗報告、最終サマリーは **必ず** 以下の Box drawing 表で出力する。
ASCII 罫線（`-`, `+`, `|`）や自由記述レイアウトは禁止。詳細は SKILL.md の "Display Format Conventions" を参照。

### Template A — 起動前タスク一覧（Step 1h / セッション起動報告）

```
┌────┬──────────────────────────┬──────────┬────────────┬──────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Strategy     │
├────┼──────────────────────────┼──────────┼────────────┼──────────────┤
│ 1  │ login-page-ui            │ surf:5   │ superpwr   │ PR per task  │
└────┴──────────────────────────┴──────────┴────────────┴──────────────┘
```

### Template B — 実行中の進捗報告（Step 3 完了通知受信時に再描画）

```
┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Status    │ Last message            │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ surf:5   │ superpwr   │ executing │ implementing routes…    │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘
```

### Template C — 最終サマリー（全タスク terminal 状態到達時）

```
┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ https://github.com/…    │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘
```

ルール:

- カラム幅は固定。長すぎる文字列は中央 `…` で省略
- Mode 列: `superpwr` = superpowers/brainstorming、`plan` = 組み込み /plan
- Status 列: `launched` / `executing` / `done` / `error` のみ
- 子セッション側にも Template B が `PROGRESS REPORTING FORMAT` として埋め込まれ、同じ表で進捗を返す

---

## ループモード（GitHub issue 自動ループ）

`--loop` は `references/loop-mode.md` の手順で GitHub issue をバッチ処理する。状態は `.dispatch-loop/`、タスク状態は `.dispatch/` に置く。`loop.task_timeout_min` と `loop.lock_lease_min` は timeout とロック lease を別に設定する。通常 dispatch は active loop lock があれば開始・一括 cleanup を拒否する。Codex 起動には全経路で `--dangerously-bypass-hook-trust` を付与する。runner wrapper は既存の `pr_url` を保持する。無人 prompt には解決済み 4 ロールの runner と engine を渡し、role 間の関係から再推測しない。4 ロールすべてを codex にした構成は codex の role pane を 4 枚起動する。timeout sentinel と cleanup は `prewarm.json` に実在する role だけを対象にする。

---

## セットアップモード（設定の明示構成）

`--setup` でのみ発動する。ディスパッチは行わず、完全な手順を [`references/setup-mode-ja.md`](setup-mode-ja.md) へ委譲する。

## リセットモード（設定のリセット）

`--reset` でのみ発動し、完全な手順を [`references/setup-mode-ja.md`](setup-mode-ja.md) へ委譲する。`--reset config` は所有する 2 キー `runner` / `review_mode` を消し、`--reset all` は両設定レイヤーを消す。

---

## Override Mode（タスク単位の一時上書き）

`--override` は値を取らないフラグ。design / design_review / exec / exec_review の各役割のうち、どれをこのディスパッチ
（このディスパッチだけ）で解決済み設定とは別の runner / model / effort で動かすかを、タスクごとに
質問する。**どちらの config ファイルにも一切書き込まない** — 永続化経路は意図的に存在しない。

`--override` は `--loop` / `--setup` / `--reset` と互いに排他。`--loop` が排他なのはポリシーでは
なく構造上の理由で、無人の issue ループには質問に答える人がいない。複数同時指定はエラーで両方の
名前を挙げて停止する。`--setup` / `--reset` と同様、`--override` は Step 1a のタスク解析へ絶対に
到達させない。

---

## Step 1: 解析と準備

タスク収集、Agent ルーティング、統合戦略決定、4 ロール解決を 1 ステップで実行する。
runner とレビューモードは config だけから解決し、ディスパッチ時には質問しない。メッセージトランスポートの質問も**存在しない** — 1g を参照。

### 1a. タスク収集

タスクを `$ARGUMENTS` から解析（なければ1回だけ質問）。分割の前に、まず `--loop` / `--setup` /
`--reset [target]` / `--override` のモードフラグを `$ARGUMENTS` から取り除き、タスク文言や
slug にこれらが混入しないようにする。

### 1b. 利用可能な Agent の発見（自動）

`.claude/agents/` をスキャンして利用可能な Agent 一覧を収集

### 1c. Brainstorming 対象タスクの選択

**brainstorming タスク選択**:
- 各タスクについて brainstorming スキルを使うか選択
- 選択されたタスク → superpowers モード + MANDATORY EXECUTION SEQUENCE
- 非選択タスク → plan モード

### 1d. レイアウト

レイアウトは常に `workspace`。各タスクは独立した cmux workspace（サイドバー項目）で起動する。選択質問やレイアウト指定フラグはない。

### 1e. 統合戦略の選択

**統合戦略選択**:
- **PR per task** — 各子タスクがブランチを push して GitHub PR を作成。親は PR を監視
- **Wait and merge** (デフォルト) — 全タスク完了後に親がローカルマージ

### 1f. ロールを解決する（Resolve Roles）

全ロールは config で固定する。ディスパッチ時の対話解決は行わない。

config-lib.sh は source 専用であり、直接実行しても出力しない。source して関数を呼ぶ:

    . <SKILL_DIR>/scripts/config-lib.sh
    RUNNERS_FILE="$(dispatch_runners_file)"
    [[ -f "$RUNNERS_FILE" ]] || run_first_run_setup

    ROOT="$(git rev-parse --show-toplevel)"
    ROLES_JSON="<STATUS_DIR>/roles.json"
    mkdir -p "$(dirname "$ROLES_JSON")"
    RESOLVE_RC=0
    bash <SKILL_DIR>/scripts/config-resolve.sh --project-root "$ROOT" > "$ROLES_JSON"       || RESOLVE_RC=$?
    case "$RESOLVE_RC" in
      0) ;;
      2) echo "[error] 未設定ロール: $(cat "$ROLES_JSON" 2>/dev/null)" >&2
         echo "        --setup で設定を修正してください" >&2
         rm -f "$ROLES_JSON"; exit 1 ;;
      *) echo "[error] config-resolve.sh の読み取り失敗 (rc=$RESOLVE_RC)" >&2
         rm -f "$ROLES_JSON"; exit 1 ;;
    esac

exit 2 は未登録 runner、または Codex review ロールの model 欠落など、ユーザーが --setup
で直す設定エラーを示す。それ以外の非 0 は壊れた JSON や読み取り不能である。両者を別分岐にし、
どちらでも pane を作らない。以後の値はすべて $ROLES_JSON から読み、再導出しない。

| ロール | runner / engine | model / effort | agent |
|---|---|---|---|
| design | {{DESIGN_RUNNER}} / {{DESIGN_ENGINE}} | {{DESIGN_MODEL}} / {{DESIGN_EFFORT}} | task slug |
| design_review | {{DESIGN_REVIEW_RUNNER}} / {{DESIGN_REVIEW_ENGINE}} | {{DESIGN_REVIEW_MODEL}} / {{DESIGN_REVIEW_EFFORT}} | {{DESIGN_REVIEW_AGENT}} |
| exec | {{EXEC_RUNNER}} / {{EXEC_ENGINE}} | {{EXEC_MODEL}} / {{EXEC_EFFORT}} | task-slug-exec |
| exec_review | {{EXEC_REVIEW_RUNNER}} / {{EXEC_REVIEW_ENGINE}} | {{EXEC_REVIEW_MODEL}} / {{EXEC_REVIEW_EFFORT}} | {{EXEC_REVIEW_AGENT}} |

REVIEW_ENABLED は ROLES_JSON の review_mode が on のときだけ true にする。review placeholder
は対応 role key が存在するときだけ使う。

runners.json は name / command / engine と default だけを持つ。model / effort は config
または組込み既定値の責務である。default は初回セットアップだけが読む。

初回セットアップでは starter / custom registry を選び、runner レコードへ name / command /
engine だけを書く。その後、通常モードでのみ review_mode を on / off の 2 択で 1 回聞き、
4 ロールすべての runner に default を設定した初期 global config を config-edit.sh 1 回で書く。
model / effort は原則書かない。default が Codex engine の場合だけ design_review と
exec_review の model を 1 回の AskUserQuestion で同時に聞いて書く。default が Claude なら
組込み値を使うので聞かない。--reset runners 由来の reset mode では runners.json だけを再生成し、
review_mode を聞かず、project / global の両 config を変更しない。

### 1g. 配送とレビューモードを解決する（Resolve Delivery and Review Mode）

agmsg は必須であり、縮退配送や pane へのタイプ入力は無い。pane 起動前に send.sh の存在を確認し、
**確認したパスをそのまま `AGMSG_SEND` へ代入して以降の全 callsite で使い回す**。存在確認だけして
変数へ束縛しないと `$AGMSG_SEND` が未定義のまま空文字へ展開され、`--send-command` に非空を要求する
helper（`phase-a-review-wait.sh`）が usage error (exit 2) で止まる。
自身の到達性は `verify-agmsg-ready.sh --parent --team "$TEAM"` の 1 回呼び出しで確認する。
**呼び出し側で engine 分岐を書かないこと**: 分岐はスクリプトの中にあり、Claude 親なら生きた
Monitor watcher を、Codex 親なら記録済みの bridge seat を見る。無条件の `--self` は codex
セッションから呼ぶと必ず rc=2 になり、「rc=2 は判定不能なので停止」規則と噛み合って
codex 親のディスパッチを最初の起床で自滅させる。rc=1 のときにユーザーへ出す助言は
**engine ではなく返ってきた `reason=` で分ける**（`reason=no-seat` なら seat 記録の手順、
それ以外なら Monitor watcher の話）。reason はスクリプトの答えであり、engine は呼び出し側が
してはならない推測だからである。
同じ呼び出しは `sharing=<N>|unknown` も返す。これはこのプロジェクトの未 claim な role を
受信している他の watcher の数である。read cursor は (team, agent) に 1 つしか無いので、
先に poll した watcher が row を取り、他方は何も見ない（取られた row は既読になるので
`inbox.sh` は「新着なし」と正直に答える）。到達可能かどうかの判定は変わらないので、正の数の
ときだけ 1 行警告し、`0` と `unknown` では何も言わない。`unknown` は「判定できなかった」で
あって 0 ではなく、毎回出る警告は誰も読まないからである。
**safety timer を持つのは Claude 親だけである。** 90 分の single-shot sleep を 1 本だけ張り、
ループにはしない。Codex 親は永続タイマーを作れない（バックグラウンドのサブシェルも detached
な nohup 版も 2026-08-21 の実測 D-T2 でターン終了とともに消えた）ので何も武装せず、装っても
ならない。**この事実を述べるのはここだけ**で、以降はすべて「親のタイマー」と呼び「あれば」の
意味で読む。無人ディスパッチを Codex 親から拒否するのはこの理由による。

全メッセージは team / sender agent / recipient agent / quoted body の 4 位置引数を渡す
send.sh 1 回で送る。宛先は agent 名であり surface / workspace ではない。本文 prefix は
phase-a-task: / phase-b-exec: / review-plan: / review-code: / review-verdict: /
abort-reviewer: / dispatch-notify: を使う。

親を team へ join した後、prewarm-panes.sh が 4 role agent を join・wire する。agent 名は
design が slug、以後 slug-design-review / slug-exec / slug-exec-review。各 pane は Claude
なら Monitor directive、Codex なら codex-record-session.sh を先に実行し、[ready] <agent>
を親へ送る。Codex は ready 受領後にも verify-agmsg-ready.sh --codex を通す。

design / exec が ready でなければ停止する。design_review が ready でなければ警告して
Phase A-R だけを、exec_review なら Phase B-R だけをスキップする。config は変更しない。

prewarm.json の key は launch 成功しか示さない。ready でない optional review role は
`prune-not-ready.sh` だけで回収する。この helper は snapshot を 1 回だけ読み、strict な
workspace / surface ID、workspace 一致、全 active role の surface 一意性、対象 surface の live
ownership を破壊操作前に検証する。design / exec は対象にできない。検証後だけ pane close、team
leave、snapshot key 削除を行う。

    PRUNE_ARGS=()
    for role in "${NOT_READY[@]}"; do PRUNE_ARGS+=(--role "$role"); done
    if [[ ${#PRUNE_ARGS[@]} -gt 0 ]]; then
      bash <SKILL_DIR>/scripts/prune-not-ready.sh \
        --prewarm "<EXISTING_STATUS_DIR>/prewarm.json" --workspace "$WS" \
        --team "$TEAM" --slug "<slug>" "${PRUNE_ARGS[@]}" || exit 1
    fi

順序は prewarm 起動 → ready 収集 → prune-not-ready.sh → render → review gate → delivery
で固定する。以後は role key が存在することと利用可能であることが同値になる。

Phase A-R は design_review pane を spec / plan の 2 ポイントで再利用する。Phase B-R は
exec_review pane が担当する。design session が reviewer へ転じる分岐は無く、Phase B を exec
へ委譲したら常に .deferred を作って exit する。

Phase B-R の判定を散文で再実装せず `review-gate.sh` へ委譲する。ready role を --ready で渡す。
stdout は空または canonical な review config path だけであり、launcher の引数列ではない。
exec_review key と readiness がそろった場合だけ `review/code-review.json` を書く。strict な
workspace / surface ID、workspace 一致、全 surface の一意性、canonical non-symlink review dir、
最終 regular JSON を検証する。この path は `phase-b-deliver.sh --review-config` に渡し、
`launch-workspace.sh` には渡さない。親 shell の変数継承には頼らず、返された exact path を生成する
design task prompt の `REVIEW_CONFIG_PATH` literal として埋め込む。

全 child prompt には、done/error の status.json 書き込み直後に dispatch-notify: を send.sh
1 回で親へ送る完了通知を入れる。非 0 なら 1 回再試行し、再失敗を status.json に記録する。
wrapper の exit 時通知は idle TUI が終了しない場合を補えないため backstop に過ぎない。

### 1g-2. タスク単位の一時上書きを適用する（--override のみ）

--override が無い場合は全体を飛ばす。Call 1 は対象タスク、Call 2 は design / design_review /
exec / exec_review を multiSelect で聞く。review 2 ロールは review_mode=on の場合だけ提示する。
Call 3 は runner / model / effort の 3 問を 1 回で聞き、回答を pending tuple として扱う。

runner 変更で engine が変わったら 3 次元すべてを新 engine で再検証し、不正な次元だけ再質問する。
2 回目も不正なら、その role の override 全体を破棄する。部分適用してはならない。

コマンドを組み立てる前に自由入力の runner / model / effort を検証する。空、前後空白、制御文字、
apostrophe、double quote、grave accent、dollar sign、backslash、exclamation mark を拒否して
再質問する。trim や shell 展開をしてはならない。

pending tuple は必ず override-args.sh へ渡す。この builder だけが role 全体破棄を判断し、
生き残った --set を NUL 区切りで返す。runner も pending に含める。返された引数で
config-resolve.sh を再実行し、成功時だけ roles.json を置き換える。失敗時は .new を消し、
元の解決値を維持する。どちらの config ファイルにも書き込まない。

### 1h. サマリー表示と実行

Template A（Display Format Conventions）で情報表示し、即座にディスパッチ:
```
Dispatching 3 tasks (workspace mode, PR per task):

┌────┬──────────────────────────┬──────────┬────────────┬──────────────┐
│ #  │ Task                     │ Surface  │ Mode       │ Strategy     │
├────┼──────────────────────────┼──────────┼────────────┼──────────────┤
│ 1  │ login-page-ui            │ pending  │ superpwr   │ PR per task  │
│ 2  │ auth-api-endpoint        │ pending  │ plan       │ PR per task  │
│ 3  │ test-coverage            │ pending  │ superpwr   │ PR per task  │
└────┴──────────────────────────┴──────────┴────────────┴──────────────┘

Available agents: backend-coding, frontend-coding
Launching…
```

`--override` が何らかの変更を生んだ場合、Template A の表の直後にこのブロックを印字する。表自体は
変更しない。実際に変わった次元だけを、タスク・role ごとに1行で列挙し、Step 1g-2 で出た警告も
含める:

```
Overrides (this dispatch only):
  auth-api  exec    runner codex / model gpt-5.6-terra / effort xhigh
  auth-api  design  effort max
```

上書きが無ければ何も印字しない。

Mode 略称: `superpwr` = superpowers/brainstorming、`plan` = 組み込み /plan モード。

---

## Step 2: セッションの起動

レイアウトモードに応じてセッションを起動。

### Prompt File Approach（プロンプトの受け渡し）

子セッションへのプロンプトは **`.cmux-team-dispatch-task-prompt.md` ファイル経由** で渡されます。

**プロンプトファイルの構成順序**:

```
1. MANDATORY EXECUTION SEQUENCE（brainstorming タスクのみ）
2. AVAILABLE AGENTS ブロック（Agent が発見された場合）
3. タスク説明
4. ステータスプロトコル指示
```

ブレスト指示と Agent 情報がタスク説明より先に来るため、子セッションが最初にブレストを実行し、適切な Agent を選択できます。

**なぜファイル経由なのか**: シェルエスケープの問題を完全に回避するためです。

**プロンプトファイルの場所**: 各 worktree のルートディレクトリ: `<worktree>/.cmux-team-dispatch-task-prompt.md`

### Runner Script Wrapper（ランナースクリプト ラッパー）

起動スクリプトは各 worktree に `.cmux-team-dispatch-task-run-<workspace-name>.sh` を生成します。ファイル名に workspace 名を含めることで、同じ worktree を共有する prewarm 済みの design / review / exec 各ロールでも runner ファイル同士が衝突しません（実行中のスクリプトを上書きすると bash が undefined 挙動になります）。

**ランナースクリプトが保証すること**:

1. `status.json` を `"executing"` に更新（絶対パス使用）
2. `claude` コマンドをインタラクティブに実行
3. Claude 終了後、`status.json` を `"done"` または `"error"` に更新
4. `cmux wait-for --signal <slug>-done` で完了をシグナル
5. `cmux notify` で親 workspace に通知
6. `dispatch-notify: [dispatch] task ... finished (status: ...)` のテキストを、
   `parent` agent 宛の agmsg `send.sh` 1 回呼び出しで親へ配送する。`--agmsg-team` /
   `--agmsg-from` が渡されていないときはスキップされる — そのペインには送信元となる
   agmsg identity が無いため

- **親通知は agmsg 一本**: `~/.agents/skills/agmsg/scripts/send.sh <team> <from> parent
  'dispatch-notify: <msg>'` の 1 回呼び出しだけで送る。非ゼロ終了は親へ届いていないこと
  を意味し、wrapper は notify marker を更新しないので次の poll で再試行される
  （`cmux notify` と `cmux wait-for --signal` は従来どおり併走する別機構）
- **standby wrapper（`--mode standby`）**: 起動時に status.json を書かず、exit 時も
  `<STATUS_DIR>/.assigned-<workspace-name>` が存在するときだけ done/error に遷移させる
  （`.deferred` の逆向き。ロール別ファイルにすることで同じ STATUS_DIR を共有する
  claude/codex 等の standby 同士が互いの割り当てを誤検知しない）。
  signal 名は `<workspace-name>-done`（例: `login-page-ui-claude-done`）
- **signal 終了ガード**: 最終クリーンアップで pane を閉じる（`cmux close-surface` /
  `close-workspace`）と子プロセスは signal 由来の終了コード（128+N。SIGHUP=129 /
  SIGKILL=137 / SIGTERM=143）を返す。このとき `status.json` が既に terminal
  （`done` / `error`）なら wrapper は status 書き込みも親通知も行わない。
  これにより、完了済みタスクが pane を閉じただけで `error` に降格したり、
  偽の `[dispatch] task ... finished (status: error)` が親へ飛んだりしない。
  まだ `executing` の pane を kill した場合は本当の中断なので従来どおり
  `error` を書いて通知する

シグナル名は `<task-slug>-done` で、起動スクリプトの出力 JSON の `signal_name` フィールドで返されます。

### Building the Task Prompt（子セッションプロンプトの組み立て）

prompt は解決済み 4 ロールだけから作る。他 role の engine から execution / review role を推測せず、
config を読み直さない。

| placeholder group | source |
|---|---|
| {{DESIGN_RUNNER}}, {{DESIGN_ENGINE}}, {{DESIGN_MODEL}}, {{DESIGN_EFFORT}} | roles.design |
| {{DESIGN_REVIEW_RUNNER}}, {{DESIGN_REVIEW_ENGINE}}, {{DESIGN_REVIEW_MODEL}}, {{DESIGN_REVIEW_EFFORT}}, {{DESIGN_REVIEW_AGENT}}, {{DESIGN_REVIEW_SURFACE}} | roles.design_review |
| {{DESIGN_REVIEW_WORKSPACE}} | 検証済み prewarm workspace_id |
| {{EXEC_RUNNER}}, {{EXEC_ENGINE}}, {{EXEC_MODEL}}, {{EXEC_EFFORT}} | roles.exec |
| {{EXEC_REVIEW_RUNNER}}, {{EXEC_REVIEW_ENGINE}}, {{EXEC_REVIEW_MODEL}}, {{EXEC_REVIEW_EFFORT}}, {{EXEC_REVIEW_AGENT}} | roles.exec_review |

design は task slug、exec は task-slug-exec。Phase A-R の依頼先は常に
{{DESIGN_REVIEW_AGENT}}、Phase B-R は常に {{EXEC_REVIEW_AGENT}} である。

PHASE A は design tuple で brainstorming / planning を完了し、承認済み plan を保存する。
PHASE B では engine/model を質問せず、常に exec pane へ phase-b-exec: を 1 通送る。
送信前に assignment marker、送信成功後に .deferred を作り、design session は exit する。
自分で実装・code review は行わない。

prewarm.json は必須で、内容を 1 回だけ読み、全体を検証してから here-string で role を参照する。
ファイル欠落時の spawn fallback は無い。design / exec 欠落は fatal、review key 欠落は launch
失敗または readiness prune 後の gate skip を示す。

Phase A-R は design_review pane を spec と plan の 2 checkpoint で再利用する。review-plan:
を 1 通送り、reviewer は findings の VERDICT と review-verdict: を返す。wake のたびに findings
を再読する。needs_work は修正して最大 5 round。waiter engine は timer の有無だけを決め、
reviewer engine は到達性検査を独立に決める。Codex reviewer は bridge seat、Claude reviewer は
{{DESIGN_REVIEW_WORKSPACE}} / {{DESIGN_REVIEW_SURFACE}} の `cmux read-screen` を 1 回 retry して検査する。

親は Phase A task の配送前に `phase-a-review-wait.sh` を waiter / reviewer の両 engine と
reviewer workspace / surface 付きで実行し、その出力を design prompt へ 1 回だけ埋め込む。

Claude waiter は Bash tool の run_in_background で single-shot safety timer を 1 本だけ張る。
Codex waiter には safety net が無いため、生成済み wait protocol に従って reviewer engine 別の
到達性を確認し、保険の無い待機へ入ることを dispatch-notify: で親へ 1 通報告する。どの wake
でも findings を再読し、timer wake を verdict とみなさない。

Phase B は `phase-b-deliver.sh` だけで検証済み snapshot の `exec` ペインへ配送する。新しい execute
session を起動せず、`launch-workspace.sh --mode execute` も呼ばない。helper は exec の固定 tuple を
検証し、確認済み agent / engine から本文と宛先を組み立て、assignment marker の後に 4 位置引数の
send.sh を 1 回だけ呼ぶ。成功後だけ `.deferred` を作る。

    PHASE_B_REVIEW_ARGS=()
    if [[ -n "$REVIEW_CONFIG_PATH" ]]; then
      PHASE_B_REVIEW_ARGS=(--review-config "$REVIEW_CONFIG_PATH")
    fi
    bash <SKILL_DIR>/scripts/phase-b-deliver.sh \
      --prewarm "<EXISTING_STATUS_DIR>/prewarm.json" \
      --plan-file "<PLAN_FILE_PATH>" --status-dir "<EXISTING_STATUS_DIR>" \
      --team "$TEAM" --slug "<slug>" "${PHASE_B_REVIEW_ARGS[@]}" || exit 1

review config が空なら base request だけを送る。非空なら helper が canonical review directory 内の
regular JSON を 1 回読み、exec_review tuple / workspace と一致することを証明した後、実際の
prewarmed exec request へ Phase B-R protocol を 1 回だけ埋め込む。implementer は各 round で
verified exec_review agent だけへ review-code: を送り、reviewer は
`<EXISTING_STATUS_DIR>/review/code-round-N.md` の末尾へ `VERDICT: approve` または
`VERDICT: needs_work` を書いて review-verdict: を 1 回返す。最大 5 ラウンドとし、第 6 ラウンドは
開始しない。round 5 が needs_work なら未解決指摘を PR 本文へ記録して進む。design pane を
reviewer にせず、design_review と exec_review の担当を混ぜない。

全 child は executing を書いてから作業し、成功時は result.md + done、失敗時は error を書く。
既存 pr_url を保持し、terminal status の直後に dispatch-notify: を親へ送る。委譲済み design
session は .deferred を作り、exec role の terminal status を上書きしない。

### plan モードの遵守ゲート（ExitPlanMode hook）

標準 plan モードでは ExitPlanMode 承認直後に「プランを実行せよ」という強いシステム指示が
入り、上記シーケンスがスキップされることがある。これを防ぐため、`launch-workspace.sh` は
`--mode plan` かつ claude engine のときのみ、worktree の `.claude/settings.local.json` に
PostToolUse hook（matcher: `ExitPlanMode`、command:
`zsh <skill-dir>/scripts/plan-approved-hook.sh`）を注入する。hook は承認直後に「ファイル
編集前に Phase A-R（有効時）→ Phase B を実行せよ」という additionalContext を機械的に
再注入する。

- ベストエフォート: settings 書き込み・マージ失敗は警告のみで dispatch を止めない
  （プロンプト側の指示がフォールバック）。既存 settings.local.json は jq でマージし、
  worktree 再利用時に重複注入しない
- 誤コミット防止: `.claude/settings.local.json` と plan 保存先 `.claude/plans/` は repo 共有の
  `info/exclude` に追記される（plan ファイルは `--plan-file` のパス渡しで使う作業物であり、
  子の `git add -A` でタスクブランチにコミットさせない）
- hook は worktree の settings.local.json に残存するため、同一 worktree を再利用する後続
  セッション（prewarm 済み exec を含む）にも作用する。それらは plan モードを使わないため
  実害はない
- superpowers モード / codex engine / execute・standby・review モードでは注入されない

### Launch: workspace モード（デフォルト）

workspace が唯一の layout。通常 dispatch は design task のために launch-workspace.sh を直接
呼ばず、下の常時 prewarm 経路が worktree 作成、4 role launch、--defer-status、agmsg
join/wiring、初期 status を所有する。launch-workspace.sh は prewarm-panes.sh が使う下位 launcher
であり、すべての呼び出しに roles.json 由来の明示 --role / runner / model / effort を渡す。

--status-dir を渡すとき --agmsg-team / --agmsg-from は必須。desktop notification 用 parent flag
は agmsg と独立しており、配送を代替しない。

### Pre-warm Standby Panes（workspace レイアウトのみ）

prewarm は常時 on であり、設定キーも非 prewarm spawn fallback も無い。
prewarm-panes.sh には検証済み resolver 出力を --roles "$ROLES_JSON" 1 本で渡す。

    review_mode=off                 review_mode=on

    +----------------+              +----------------+----------------+
    | design         |              | design         | design_review  |
    +----------------+              +----------------+----------------+
    | exec           |              | exec           | exec_review    |
    +----------------+              +----------------+----------------+

**4 ペインは均等な 4 象限でなければならない** — 高さの等しい 2 段、それぞれが幅の等しい 2 列。
2 ペインのときは高さの等しい 2 段。これは挿絵ではなく要件である。1 枚が全高を占め、残り 3 枚が
反対側を分け合っているワークスペースは、全ペインが存在して配線されていても**欠陥**である。

均等かどうかは**ペインを作る順序だけ**で決まる。`cmux new-split` はサイズ引数を取らず、
指し示された surface を半分に割るだけだからである。したがって順序は固定である:

    1. design         ワークスペース全面
    2. exec           design から down  → 高さの等しい 2 段（どちらも全幅）
    3. design_review  design から right → 上段が幅の等しい 2 列になる
    4. exec_review    exec から right   → 下段が幅の等しい 2 列になる

**exec は design_review より先に作らなければならない。** design_review を先に作ると design が
左半分へ縮み、design_review が右半分を全高で占める。そのあと design を down 分割しても割れるのは
左半分だけなので、左に 3 枚・右に 1 枚（全高）という不均等なレイアウトになる。この壊れた状態でも
個々の分割方向と分割元は正しいままなので、`test-prewarm-layout.sh` は方向だけでなく**順序そのもの**
を検査している。

### 完走ゲート（Stop hook）

子セッションは仕事の途中で止まることがある（実装が最後まで行かない、レビュアーが verdict を
書く前に終わる）。`launch-workspace.sh` はペインごとに `type: "command"` の Stop hook を 1 本
注入し、人が「続けて」と言わなくてもセッションが継続するようにする。実体は
`scripts/completion-gate.sh` で、**判定スクリプトも出力契約も両 engine で共通**、違うのは
注入先だけである（claude は `.claude/settings.local.json`、codex は `.codex/hooks.json`。
後者は agmsg 自身の entry を壊さないようマージする）。

**ゲートはディスクだけを読む。** モデル評価もネットワークも cmux も使わない。完了条件は
`status.json` / `.deferred` / review のラウンドファイルとして既に materialize されており、
会話から推測すべきものが無いからである。これが push 待機と両立する理由でもある: まだタスクを
受け取っていないペインと、依頼済みの `review-verdict:` を待っているペインは**ゲートが邪魔しては
ならない状態**で、どちらもディスク上に見えている。モデル評価のゲートはこれを推測するしかない。

**同じ状態がレビューの両側で逆の意味を持つ。** `VERDICT:` 行の無いラウンドファイルは、依頼側に
とっては「相手がまだ答えていないので待て」、レビュアーにとっては「自分がまだ書き終えていない」で
ある。ゲートは依頼側の停止を許し、レビュアーを block する。逆にすると、verdict を書かない
レビュアーが取り残されるか、idle でいるべき実装者が叩き起こされる。

block には上限がある。連続 block を `<status-dir>/.gate-blocks` に数え、10 回
（`DISPATCH_GATE_MAX_BLOCKS`）で止める。engine 側に上限は無いので、上限を持たないゲートは
永久にループする。**諦めるときにカウンタを消してはならない** — 消すと上限が即座に再武装され、
「上限まで block → 1 回休み」を延々と繰り返す。リセットするのは本当に停止を許したときだけで、
タスクが待機か終端に入れば自然に回復する。

注入は `ExitPlanMode` hook と同じくベストエフォートで、失敗しても警告だけで dispatch は続く。
worktree を再利用しても二重には入らない。

off は 2 pane、on は 4 pane 固定。review pane の launch 失敗はその role key だけを省略して
対応 gate をスキップする。design / exec の launch 失敗時は、この prewarm 呼び出しが作成・join・
launch した worktree / branch / team member / surface だけを rollback し、再利用資源を残して停止する。

    RESULT=$(bash <this-skill-dir>/scripts/prewarm-panes.sh \
      --with-design \
      --cwd "<repo-root>/.worktrees/<task-slug>" \
      --slug <task-slug> \
      --status-dir "$(pwd)/.dispatch/<task-slug>" \
      --roles "$ROLES_JSON" \
      --agmsg-team "$TEAM" \
      --parent-notify-workspace "$CMUX_WORKSPACE_ID")

script は worktree 作成 / 再利用、全 role agent の join、launch 前 delivery wiring、readiness
clause 付き pane 起動、初期 launched status を担当する。prewarm.json は workspace_id /
review_mode と、design / design_review / exec / exec_review の明示 key を持つ。各 tuple は
surface_id / agent / runner / engine / optional model / effort / wired=true であり、入れ子の
executor や汎用 review container は無い。

consumer は必ず内容を 1 回だけ読む:

    source <this-skill-dir>/scripts/prewarm-snapshot.sh
    PREWARM_DOC=$(cat "<EXISTING_STATUS_DIR>/prewarm.json") || exit 1
    validate_prewarm_snapshot "$PREWARM_DOC" || exit 1
    DESIGN_SURFACE=$(jq -r '.design.surface_id' <<<"$PREWARM_DOC")
    EXEC_SURFACE=$(jq -r '.exec.surface_id' <<<"$PREWARM_DOC")

role ごとに元パスを読み直してはならない。途中差し替えにより無関係な surface を cleanup /
delivery する危険がある。Phase A task は準備だけ先に行い、design の [ready] 後に assignment
marker を作り、phase-a-task: を 1 通送る。review readiness の prune は render / delivery より先。

## タスク内の並列実行

タスク同士は既に worktree 横断で並列に走っている。この節が扱うのは **1 タスクの中**の話で、
各子セッションに「独立した調査と検証は 1 件ずつ順にやらず、子エージェントへ分散させよ」と
指示する。

`scripts/parallel-directive.sh` がその文面の単一情報源である。

```
parallel-directive.sh --engine <claude|codex> --mode <plan|superpowers|execute|review> [--agents <N>]
```

- codex セッションには `spawn_agent` / `wait_agent` を、claude セッションには
  1 メッセージで複数の Task サブエージェントを起動することを指示する
- ファイル編集は常に親エージェントで逐次に保つ。実装の順序を制御するスキル
  （superpowers subagent-driven-development の「実装者は同時に 1 体」）は上書きしない
- 分散してよいのは**読み取り専用の検証だけ**。auto-fix / write モード
  （formatter や linter を write フラグ付きで走らせるもの）はファイルと共有ビルドキャッシュを
  書き換えるため、親エージェントで逐次に実行する
- `--agents` が同時実行の上限。2〜8 の整数のみで既定は 4
- `standby` モードは存在しない。standby ペインは実行系なので `--mode execute` を渡す
- `--agents` / `--no-parallel` は `launch-workspace.sh` のフラグ。このスキルは
  どちらも渡さないので、スキル経由のディスパッチには常に既定値が適用される

注入箇所:

| 対象 | 注入する側 |
|------|-----------|
| plan / superpowers / execute の起動プロンプト | `launch-workspace.sh`（`--no-parallel` で抑止） |
| standby ペインへ送る Phase B 実行指示 | このスキル（スクリプト経由） |
| Phase A-R のレビュー依頼 | このスキル（スクリプト経由） |
| Phase B-R のレビュー依頼（prewarm 経路） | このスキル（スクリプト経由） |

ある engine 向けに生成したディレクティブを、別 engine のセッション宛のテキストの中に
埋め込むとき（実装者のプロンプトに同梱するレビュアー向けディレクティブがこれにあたる）は、
宛先を明示的にマークする。位置だけでは境界にならず、claude セッションに `spawn_agent` を
指示してもそのツールは存在しない。

## Step 3: 監視と完了

プッシュベースの監視 → 結果収集 → レポート生成 → マージ/クリーンアップ。

### プッシュベースの監視（唯一のモード）

monitor スクリプトも heartbeat もポーリングループも存在しない。このセッションは常設の
agmsg Monitor ストリームを保持しているので、子からのメッセージは 1 行として届き、idle でも
このセッションを起こす。信頼できる情報源は `.dispatch/*/status.json` であり、メッセージは
「いつ見に行くか」を伝えるだけである。

**ペインを起動した直後 — `[ready]` を 1 つも待つ前に:**

1. **claude 親は**単発の safety timer を 1 つ武装する。これにより「ready を一度も報告しない
   ペイン」も「一度も始まらない子」も、このセッションを永久に眠らせたままにはできない。
   先に武装することが readiness 待ちそのものを安全にする — タスク配送後に武装すると
   `[ready]` の窓が丸ごと無防備になる。**sleep は 1 回だけ、ループにしない**:

   ```bash
   # claude 親のみ: Bash tool を `run_in_background: true` で実行する
   sleep $((90 * 60))
   ```

   codex 親はここで何も武装しない — 理由は Step 1g に書いてあり、述べるのはそこだけである。
   代わりに、このターンを閉じる前に期待する codex ペインの seat を
   `verify-agmsg-ready.sh --codex` で確認し、「子のメッセージ以外にこのセッションを起こす
   ものは無いので、黙った子はユーザーの目が必要になる」と起動サマリーで明言すること。

   **90 分固定**。このディスパッチで別の値が解決されることは
   無い: config キー
   `loop.task_timeout_min` を読むのは loop モードの起床時 reconciliation
   （`references/loop-mode.md`）だけで、issue ごとの timeout に使われ、このタイマーには
   届かない。別の数値を使うのはユーザーが求めたときだけ。これは締切ではなくセーフティネット
   であり、生きているが遅いタスクは再武装で延びる。
   **タイムアウト検知の粒度は以前より粗くなっている。** 旧 loop 待機スクリプトがやっていた
   5 秒ごとの `claimed_at` 再確認はもう無く、いまは起床と起床の間に見直すものが何も無いので、
   このタイマーより短い `loop.task_timeout_min` は次の起床まで検知されない。待機ループを
   全廃したことの意図した代償であり、欠陥ではない。
   **タスク id と、何回武装したかを覚えておくこと。** `sleep` に架空のフラグ名を注記しない
   （Bash tool に `--wake-after` のようなパラメータは無く、それを読んだモデルは渡そうとする）
   — 散文で書く。

   **Completion でタイマーを止める。** 全タスクが terminal になり Template C を出すときは、
   まずタイマーを止める（下の `### Completion（完了レポート）` の手順 1）:
   background task を `TaskStop` する。生き残った `sleep` は 90 分後に終了し、ユーザーが既に別の話に移っている場に無意味な
   起床を注入する。
   しかもその起床は再武装分岐に落ちるので、ディスパッチのたびに古いタイマーが 1 つずつ
   永久に残ることになる。

   **再武装には上限を設ける。** メッセージも目に見える進捗も無いまま 3 回再武装したら、
   再武装をやめて `cmux read-screen` の抜粋を添えて報告し、どうするかをユーザーに聞く。
   「ペインは生きている」は進捗の証拠ではない。

2. Template A で起動サマリーを具体的な surface ID 付きで報告する。
3. ユーザーへ「N 件のタスクを監視中。agmsg の通知を待っています」と伝える。
4. **ターンを閉じる。** ブロックもポーリングもしない — `[ready]` も完了通知も待ち受けない。
   以降のこのディスパッチのすべてのステップは起床から始まる。

### 起床のたびに状態を再導出する

監視ループを持たないので、どの起床もステートレスに扱う: `.dispatch/*/status.json` をすべて
読み、記憶ではなくそこから判断する。

**自分自身の受信チャネルを、起動時だけでなく起床のたび・タイマー発火のたびに再検証する。**
Step 1g とまったく同じ `--parent` の 1 行を使う。起床はステートレスなので `TEAM` は記憶せず
毎回導出し直す:

```bash
# 起床時の readiness 検査（Step 1g と同一。engine の選択はスクリプトの中にある）
TEAM="dispatch-$(basename "$(git rev-parse --show-toplevel)")"

WAKE_READY_RC=0
WAKE_READY_OUT=$(bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --parent --team "$TEAM") \
  || WAKE_READY_RC=$?
```

判定は終了コード（`0` = 到達可能 / `1` = 到達不能 / `2` = 使用法エラー）か stdout の
`ready=yes` / `ready=no` 接頭辞で行い、行全体では比較しない — 接頭辞の後ろには実行ごとに
変わる診断フィールド（`pid=` / `session=`）が続くため。ここでも `1` と `2` を混ぜない:
`1` はこのセッションについての事実、`2` は質問に答えられなかったということなので、`2` の
ときは watcher や seat について何も結論せず、使用法エラーとして停止して報告する。

claude 親の watcher はディスパッチ途中で死にうる（`watch.sh:426-429` の `_install_changed`
による自己終了、`/compact` と `TaskStop` の競合）。codex 親の bridge seat も同様に落ちうる。
チャネルが消えたあとは **すべての** 子の通知が黙って失われる。`ready=no` ならそう報告し、
「メッセージが来ない」ことを子についての情報として扱うのをやめる。

`sharing=` は起床のたびに変わりうる。同じチェックアウトでいつでも 2 つ目のセッションを
開けるからである。Step 1g と同じ規則を適用する: 正の数のときだけ警告し、`0` と `unknown`
では何も言わない。ディスパッチ途中に現れた競合は 1 行の価値がある — その瞬間から parent 宛の
`[ready]` や `dispatch-notify:` が他方の watcher に消費され、このセッションへ二度と届かなく
なりうるからである。

```bash
for f in .dispatch/*/status.json; do
  slug=$(basename "$(dirname "$f")")
  echo "$slug: $(jq -r '.status' "$f" 2>/dev/null || echo unknown) - $(jq -r '.message // ""' "$f" 2>/dev/null)"
done
```

そのうえで、何に起こされたかで分岐する:

- **`[ready] <name>`** — そのペインが到達可能になった。期待するペインがすべて報告したら
  タスクを送る（Step 2 の配送）。ユーザーへ報告することは無い。
- **本文が `dispatch-notify:` で始まり、タスク slug を含むメッセージ** — そのタスクの
  `status.json` を読み、`done` なら `result.md` も読む。進捗テーブル全体を再描画する
  （**Template B**。1 行の自由記述にしない）。全タスクが terminal なら Completion
  （Template C）へ進む。残っていれば残数を伝えてまたターンを閉じる。

  識別は `dispatch-notify:` 接頭辞 **＋ slug の部分一致**で行う。`task "<slug>" finished` の
  完全一致を要求してはならない: runner wrapper 版はリテラルのバックスラッシュ付きで
  （`task \"<slug>\" finished`）描画されるため、素の二重引用符に固定した matcher は黙って
  一度も発火しない。

  同じ完了通知を 2 度受け取るのは正常である: 通知は子自身、runner wrapper が併走させる
  status.json watcher、wrapper の session exit の 3 系統から届く。冪等に扱い、status.json を
  信頼する。
- **それ以外の子メッセージ**（質問・進捗報告） — その子の agent 名宛に `send.sh` で返信し、
  ターンを閉じる。
- **タイマー**（武装されている場合だけ発火する） —
  この窓の間にメッセージが来なかったというだけである。子が失敗した証拠ではなく、
  メッセージが来なかったという証拠にすぎない。**判断の前に永続記録を読む**:
  `.dispatch/*/status.json` から状態を再導出し、`[ready]` を一度も見ていないタスクについては
  inbox ではなく history を確認する:

  ```bash
  ~/.agents/skills/agmsg/scripts/history.sh "$TEAM" parent 50 | grep -E '\[ready\] <slug>$'
  ```

  **`inbox.sh` ではなく `history.sh` を使う**: 競合 watcher に消費された `[ready]` は既読に
  なっているので、`inbox.sh` は row が DB にあるのに「新着なし」と正直に答えてしまう。slug は
  行末にアンカーし、素の `grep -F '[ready]'` にしないこと: 本文は常に `[ready] <slug>` で
  history 行の末尾に来るため、アンカー無しだと slug `api` が `[ready] api-v2` で満たされて
  しまい、報告していないタスクが ready に見える。**`[ready]` を横取りされたタスクを `error` に
  すると健全な子を殺す。** history にも `[ready]` が無いことを確認して初めて、そのペインを
  到達不能として扱ってよい。

  そのうえで terminal でない各タスクについて、ペインにまだ動きがあれば
  （`cmux read-screen --surface <id>`。何かを結論づける前に **1 回リトライ**する — cmux の
  一時的なソケット障害をペイン死亡と読んではならない）同じタイマーを再武装してターンを閉じる
  （上の再武装上限まで）。本当にペインが消えていればそのタスクを理由付きで `error` にして
  報告する。codex ペインでは
  `bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --codex --team "$TEAM" --name <agent>`
  で「seat 未記録」と「ペイン死亡」を切り分ける。


### ステータスファイルのポーリング（手動確認）

ユーザーから明示的に聞かれたときの手動確認手段:

   ```bash
   for f in .dispatch/*/status.json; do
     task_name=$(dirname "$f" | xargs basename)
     task_status=$(jq -r '.status' "$f" 2>/dev/null || echo "unknown")
     message=$(jq -r '.message' "$f" 2>/dev/null || echo "")
     echo "$task_name: $task_status - $message"
   done
   ```

### 画面の直接読み取り（オンデマンド）

- workspace モード: `cmux read-screen --workspace <workspace-id> --scrollback`

### When to Intervene（介入のタイミング）

- **ステータスが "error"**: エラーメッセージとセッション画面を確認し、リトライまたはエスカレーションを提案
- **長時間応答なし**: 行動の合図ではない。沈黙のために safety timer がある。ポーリングを
  始めず、ターンを閉じてタイマーに起こされ、上のタイマー分岐に従う。タイマーを武装して
  いなければ沈黙はユーザーが尋ねるまで沈黙のままである — そのことは起動時に 1 度伝え、
  ここで待機を発明しないこと
- **ユーザーリクエスト**: ユーザーはいつでも特定のセッションの確認を依頼できる。これも他と
  同じ「起床」なので、状態を 1 度だけ再導出して答え、ターンを閉じる

### Completion（完了レポート）

全タスクが終了ステータス（`"done"` または `"error"`）に到達したら:

1. **Step 3 で武装した safety timer を、武装していれば止める**: background の `sleep`
   タスクを `TaskStop` する。何かを読むより
   **先に**これを行う —
   タイマーを止める場所はここだけで、生き残ると 90 分後に無関係な会話へ発火する。
2. **結果を収集**: `.dispatch/<task-slug>/result.md` をすべて読む。
3. **統合レポートを生成**。統合戦略（Step 1e で選択）によってテンプレートが異なり、必ず
   Template C（最終サマリー表）から始める。
4. **Step 1e で選んだ統合戦略に従って統合へ進む**。

レポートは必ず Template C（Display Format Conventions）の表で始める。

**Wait and merge の場合:**

```
# Team Dispatch Report

┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ feat/login-page-ui      │
│ 2  │ auth-api-endpoint        │ 08m02s   │ plan       │ done      │ feat/auth-api-endpoint  │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘

## Task Results

### 1. login-page-ui [brainstorming]
<.dispatch/login-page-ui/result.md の内容>

### 2. auth-api-endpoint [plan]
<.dispatch/auth-api-endpoint/result.md の内容>

## Worktree Branches
- feat/login-page-ui
- feat/auth-api-endpoint

## Next Steps
- Review and merge branches
- Run full test suite across all changes
- Clean up worktrees when done
```

**PR per task の場合:**

```
# Team Dispatch Report

┌────┬──────────────────────────┬──────────┬────────────┬───────────┬─────────────────────────┐
│ #  │ Task                     │ Duration │ Mode       │ Status    │ Result / PR             │
├────┼──────────────────────────┼──────────┼────────────┼───────────┼─────────────────────────┤
│ 1  │ login-page-ui            │ 12m34s   │ superpwr   │ done      │ https://github.com/…    │
│ 2  │ auth-api-endpoint        │ 08m02s   │ plan       │ done      │ https://github.com/…    │
└────┴──────────────────────────┴──────────┴────────────┴───────────┴─────────────────────────┘

## Task Results

### 1. login-page-ui [brainstorming]
<.dispatch/login-page-ui/result.md の内容>
PR: <PR URL from status.json>

### 2. auth-api-endpoint [plan]
<.dispatch/auth-api-endpoint/result.md の内容>
PR: <PR URL from status.json>

## Pull Requests
- login-page-ui: <PR URL>
- auth-api-endpoint: <PR URL>

## Next Steps
- Review and merge PRs on GitHub
- Clean up worktrees when done
```

### Integration and Cleanup（統合とクリーンアップ）

Step 1e で選択した統合戦略に応じて動作が異なります。

#### When integration strategy is "Wait and merge"

全タスク完了後、ユーザーにマージするか確認します:

**マージする場合:**

1. 各 worktree の未コミット変更をコミット
2. 現在のブランチに順次マージ:
   ```bash
   for slug in <task-slugs>; do
     git merge "feat/$slug" --no-edit || echo "CONFLICT in feat/$slug"
   done
   ```
3. コンフリクトが発生した場合、ユーザーの解決を支援
4. マージ完了後、**親セッションでまとめてクリーンアップ確認**（後述「親セッションのクリーンアップ確認」節）を実行。
   親が一度だけ「ワークスペース閉鎖 / worktree 削除 / ブランチ削除」を聞き、全タスクに適用する。
5. マージ結果を `git log --oneline` で表示

**マージしない場合:**

1. `.dispatch/` ディレクトリのみ削除。`config.json` はプロジェクト config レイヤーであって
   ディスパッチの生成物ではないため、唯一残す:
   ```bash
   if bash <this-skill-dir>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check; then
     [[ -d .dispatch ]] && find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +
   else
     echo "<.dispatch/ の一括削除をスキップ: issue ループが実行中>" >&2
   fi
   ```
2. 手動クリーンアップのコマンドを表示:
   ```
   Worktrees are preserved for manual review. To clean up later:

   # worktree 一覧表示
   git worktree list

   # 個別の worktree とブランチを削除
   git worktree remove .worktrees/<task-slug>
   git branch -D feat/<task-slug>

   # 一括削除
   for slug in <task-slugs>; do
     git worktree remove ".worktrees/$slug" --force
     git branch -D "feat/$slug"
   done
   rmdir .worktrees 2>/dev/null
   ```

#### When integration strategy is "PR per task"

各子セッションが完了時に PR を作成済み。完了レポートに PR URL を含めて表示:

1. **PR 一覧と状態の表示**:
   ```bash
   for slug in <task-slugs>; do
     pr_url=$(jq -r '.pr_url // empty' ".dispatch/$slug/status.json" 2>/dev/null)
     if [[ -n "$pr_url" ]]; then
       pr_state=$(gh pr view "$pr_url" --json state -q '.state' 2>/dev/null || echo "unknown")
       echo "$slug: $pr_state - $pr_url"
     else
       echo "$slug: PR 未作成"
     fi
   done
   ```

2. **親セッションでまとめてクリーンアップ確認**（後述「親セッションのクリーンアップ確認」節）を実行。
   親が一度だけ「ワークスペース閉鎖 / worktree 削除 / ブランチ削除」を聞き、全タスクに適用する。

   すべて「保持」を選んだ場合は `.dispatch/` の掃き出し（`config.json` は残す）のみで、
   worktree とブランチは残る。
   手動で後から削除するコマンドは「Wait and merge の『マージしない場合』」と同じ。

### Cleanup prompts — 親セッションのクリーンアップ確認（両戦略共通）

全 child が terminal state に到達した後、親で 1 回だけ実行する。pane/workspace を閉じるか、
worktree を削除するか、feature branch を削除するかをこの順で聞き、close_all /
remove_wt_all / delete_br_all に記録する。

status.json は workspace 照合元にしない。現在 workspace は cleanup 引数、または cmux workspace
list の [slug] リテラル一致から得る。prewarm.json は内容を 1 回だけ読み、完全に検証した
snapshot の workspace_id が現在値と一致した場合だけ、4 role key を明示列挙して close する:

```bash
    . <this-skill-dir>/scripts/config-lib.sh
    RUNNERS_FILE="$(dispatch_runners_file)"
    validate_cleanup_prewarm_snapshot() { # $1=document, $2=task slug
      local doc="$1" slug="$2" role expected runner engine effort model registered review_mode
      [[ -f "$RUNNERS_FILE" ]] || return 1
      jq -e 'type == "object" and
        ((keys - ["workspace_id","review_mode","design","design_review","exec","exec_review"]) | length == 0) and
        (.workspace_id | type == "string" and length > 0) and
        (.review_mode == "on" or .review_mode == "off") and has("design") and has("exec")' \
        >/dev/null 2>&1 <<<"$doc" || return 1
      review_mode=$(jq -r '.review_mode' <<<"$doc")
      if [[ "$review_mode" == off ]]; then
        jq -e 'has("design_review") or has("exec_review")' >/dev/null 2>&1 <<<"$doc" && return 1
      fi
      for role in design design_review exec exec_review; do
        jq -e --arg r "$role" 'has($r)' >/dev/null 2>&1 <<<"$doc" || continue
        jq -e --arg r "$role" '
          (.[$r] | type == "object") and
          ((.[$r] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) | length == 0) and
          (.[$r].surface_id | type == "string" and length > 0) and
          (.[$r].agent | type == "string" and length > 0) and
          (.[$r].runner | type == "string" and length > 0) and
          (.[$r].engine == "claude" or .[$r].engine == "codex") and
          (.[$r].effort | type == "string") and (.[$r].wired == true)' \
          >/dev/null 2>&1 <<<"$doc" || return 1
        case "$role" in
          design) expected="$slug" ;;
          *) expected="$slug-${role//_/-}" ;;
        esac
        [[ "$(jq -r --arg r "$role" '.[$r].agent' <<<"$doc")" == "$expected" ]] || return 1
        runner=$(jq -r --arg r "$role" '.[$r].runner' <<<"$doc")
        engine=$(jq -r --arg r "$role" '.[$r].engine' <<<"$doc")
        effort=$(jq -r --arg r "$role" '.[$r].effort' <<<"$doc")
        dispatch_valid_runner_name "$runner" || return 1
        dispatch_valid_effort "$effort" "$engine" || return 1
        registered=$(jq -r --arg runner "$runner" \
          'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
        [[ "$registered" == "$engine" ]] || return 1
        if jq -e --arg r "$role" '.[$r] | has("model")' >/dev/null 2>&1 <<<"$doc"; then
          jq -e --arg r "$role" '.[$r].model | type == "string" and length > 0' \
            >/dev/null 2>&1 <<<"$doc" || return 1
          model=$(jq -r --arg r "$role" '.[$r].model' <<<"$doc")
          dispatch_valid_model "$model" || return 1
        elif dispatch_model_required "$role" "$engine"; then
          return 1
        fi
      done
    }

    for slug in <task-slugs>; do
      cleanup_workspace=$(cmux workspace list 2>/dev/null         | awk -v s="[$slug]" 'index($0, s) {print $1; exit}')
      pj=".dispatch/$slug/prewarm.json"
      PREWARM_DOC=
      PREWARM_MATCH=false

      if [[ "$close_all" == "true" && -n "$cleanup_workspace" && -f "$pj" ]]; then
        if PREWARM_DOC=$(cat "$pj") \
          && validate_cleanup_prewarm_snapshot "$PREWARM_DOC" "$slug"; then
          snapshot_workspace=$(jq -r '.workspace_id' <<<"$PREWARM_DOC")
          if [[ "$snapshot_workspace" == "$cleanup_workspace" ]]; then
            PREWARM_MATCH=true
            while IFS= read -r sf; do
              [[ -n "$sf" ]] || continue
              cmux close-surface --workspace "$cleanup_workspace" --surface "$sf" 2>/dev/null || true
            done < <(jq -r '. as $d | ["design","design_review","exec","exec_review"]
              | map(select($d[.] != null) | $d[.].surface_id) | .[]' <<<"$PREWARM_DOC"               | awk 'NF && !seen[$0]++')
            cmux close-workspace --workspace "$cleanup_workspace" 2>/dev/null || true
          else
            echo "[warn] $slug: prewarm workspace '$snapshot_workspace' does not match current workspace '$cleanup_workspace'; nothing closed" >&2
          fi
        else
          echo "[warn] $slug: invalid prewarm snapshot; nothing closed" >&2
        fi
      fi

      [[ "$remove_wt_all" == "true" ]] && git worktree remove ".worktrees/$slug" --force 2>/dev/null
      [[ "$delete_br_all" == "true" ]] && git branch -D "feat/$slug" 2>/dev/null
    done
    true
```


再帰列挙は禁止する。将来別 object に surface_id が増えたとき、無関係な surface を閉じるためである。
awk の重複除去と close-surface の --workspace は維持する。

dispatch artifact を消す前に、同じ one-read / validation / workspace match / 4 role 明示列挙で
team member を leave する:

```bash
    . <this-skill-dir>/scripts/config-lib.sh
    RUNNERS_FILE="$(dispatch_runners_file)"
    validate_cleanup_prewarm_snapshot() { # $1=document, $2=task slug
      local doc="$1" slug="$2" role expected runner engine effort model registered review_mode
      [[ -f "$RUNNERS_FILE" ]] || return 1
      jq -e 'type == "object" and
        ((keys - ["workspace_id","review_mode","design","design_review","exec","exec_review"]) | length == 0) and
        (.workspace_id | type == "string" and length > 0) and
        (.review_mode == "on" or .review_mode == "off") and has("design") and has("exec")' \
        >/dev/null 2>&1 <<<"$doc" || return 1
      review_mode=$(jq -r '.review_mode' <<<"$doc")
      if [[ "$review_mode" == off ]]; then
        jq -e 'has("design_review") or has("exec_review")' >/dev/null 2>&1 <<<"$doc" && return 1
      fi
      for role in design design_review exec exec_review; do
        jq -e --arg r "$role" 'has($r)' >/dev/null 2>&1 <<<"$doc" || continue
        jq -e --arg r "$role" '
          (.[$r] | type == "object") and
          ((.[$r] | keys - ["surface_id","agent","runner","engine","model","effort","wired"]) | length == 0) and
          (.[$r].surface_id | type == "string" and length > 0) and
          (.[$r].agent | type == "string" and length > 0) and
          (.[$r].runner | type == "string" and length > 0) and
          (.[$r].engine == "claude" or .[$r].engine == "codex") and
          (.[$r].effort | type == "string") and (.[$r].wired == true)' \
          >/dev/null 2>&1 <<<"$doc" || return 1
        case "$role" in
          design) expected="$slug" ;;
          *) expected="$slug-${role//_/-}" ;;
        esac
        [[ "$(jq -r --arg r "$role" '.[$r].agent' <<<"$doc")" == "$expected" ]] || return 1
        runner=$(jq -r --arg r "$role" '.[$r].runner' <<<"$doc")
        engine=$(jq -r --arg r "$role" '.[$r].engine' <<<"$doc")
        effort=$(jq -r --arg r "$role" '.[$r].effort' <<<"$doc")
        dispatch_valid_runner_name "$runner" || return 1
        dispatch_valid_effort "$effort" "$engine" || return 1
        registered=$(jq -r --arg runner "$runner" \
          'first(.runners[]? | select(.name == $runner) | .engine) // empty' "$RUNNERS_FILE")
        [[ "$registered" == "$engine" ]] || return 1
        if jq -e --arg r "$role" '.[$r] | has("model")' >/dev/null 2>&1 <<<"$doc"; then
          jq -e --arg r "$role" '.[$r].model | type == "string" and length > 0' \
            >/dev/null 2>&1 <<<"$doc" || return 1
          model=$(jq -r --arg r "$role" '.[$r].model' <<<"$doc")
          dispatch_valid_model "$model" || return 1
        elif dispatch_model_required "$role" "$engine"; then
          return 1
        fi
      done
    }

    for slug in <task-slugs>; do
      cleanup_workspace=$(cmux workspace list 2>/dev/null         | awk -v s="[$slug]" 'index($0, s) {print $1; exit}')
      pj=".dispatch/$slug/prewarm.json"
      PREWARM_DOC=
      if [[ -n "$cleanup_workspace" && -f "$pj" ]] && PREWARM_DOC=$(cat "$pj") \
        && validate_cleanup_prewarm_snapshot "$PREWARM_DOC" "$slug" \
        && [[ "$(jq -r '.workspace_id' <<<"$PREWARM_DOC")" == "$cleanup_workspace" ]]; then
        while IFS= read -r agent; do
          [[ -n "$agent" ]] || continue
          ~/.agents/skills/agmsg/scripts/leave.sh "$TEAM" "$agent" 2>/dev/null || true
        done < <(jq -r '. as $d | ["design","design_review","exec","exec_review"]
          | map(select($d[.] != null) | $d[.].agent) | .[]' <<<"$PREWARM_DOC"           | awk 'NF && !seen[$0]++')
      fi
    done
```


最後に .dispatch/config.json を保持し、live issue loop が lock を持つ間は一括削除を拒否する:

    if bash <this-skill-dir>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check; then
      [[ -d .dispatch ]] && find .dispatch -mindepth 1 -maxdepth 1 ! -name config.json -exec rm -rf {} +
    else
      echo "<skip bulk .dispatch/ delete: issue loop is running>" >&2
    fi
    rmdir .worktrees 2>/dev/null


close → worktree → branch の順序を守る。child session 自身は cleanup 質問も削除も行わない。

## ステータスプロトコル

### status.json

```json
{
  "status": "launched",
  "workspace_id": "workspace:3",
  "surface_id": "surface:5",
  "message": "Runner session launched in plan mode (workspace layout)",
  "pr_url": "https://github.com/owner/repo/pull/123",
  "timestamp": "2026-04-07T16:00:00Z"
}
```

- `pr_url` は PR per task 戦略で PR 作成済みの場合のみ `done` で付与。
- クリーンアップ意思は `status.json` には記録しない。親がディスパッチ完了時に
  `AskUserQuestion` で一度だけ聞き（ワークスペース閉鎖 / worktree 削除 / ブランチ削除）、
  その回答を全タスクに適用する。子セッションは質問も削除も行わない。

### result.md

タスク完了時に子セッションが `.dispatch/<task-slug>/result.md` に書き出す成果物サマリー。

```markdown
# <タスク名>

## Changes Made

- 変更したファイルと内容の一覧

## Test Results

- テストの合否サマリー

## Commits

- <hash> <コミットメッセージ>
```

---

## superpowers 統合（Execution Handoff 第3選択肢）

`superpowers:writing-plans` でプランが完成すると、Execution Handoff として3つの実行方法から選択:

```
1. Subagent-Driven (推奨)   → superpowers:subagent-driven-development
2. Inline Execution          → superpowers:executing-plans
3. Parallel (cmux)           → cmux-team-dispatch-task  ← THIS SKILL
```

### Parallel (cmux) を勧めるタイミング

（このセクションに対応する既存の日本語記述はありません。3つの実行オプションの使い分けの目安は SKILL.md の "When to Suggest Parallel (cmux)" 節の表を参照してください。）

### フロー

1. プランファイルからタスクを抽出
2. brainstorming 選択（プランから来た場合、brainstorming 完了済みなのでデフォルト「なし」）
3. レイアウト選択（デフォルト workspace、引数で override）
4. 起動・監視・完了

### プランからタスク JSON を組み立てる

（このセクションに対応する既存の日本語記述はありません。`superpowers:writing-plans` のプランファイルから `### Task N: <name>` 見出しをタスクとして抽出する手順は SKILL.md の "Building the Tasks JSON from a Plan" 節を参照してください。）

---

## 制約

- **cmux 必須**: `/Applications/cmux.app/` にインストールされている必要があります
- **同時セッション数**: 3〜5 セッションが推奨
- **ファイル競合**: 2つのタスクが同じファイルを変更してはいけません
- **完了シグナルは信頼性あり**: ランナースクリプトが `status.json` の更新と `cmux wait-for --signal <slug>-done` の発火を保証し、子 runner セッション終了時に `dispatch-notify: [dispatch] ...` を `parent` agmsg agent 宛の `send.sh` 1 回呼び出しで配送する。検証すべき Enter も詰まりうる input box も無く、メッセージは親の inbox に着く。`send.sh` の非ゼロ終了は親へ届いていないことを意味し、wrapper は notify marker を更新しないので次の poll で再試行する
- **codex 統合の前提**: `cmux codex install-hooks` 済みであること（`external_migration = true` と hooks がインストールされている）
- **配送**: 通知トランスポートの設定項目は無い。`message_type` は廃止され、`launch-workspace.sh` / `prewarm-panes.sh` の `--message-type` フラグも削除された (渡すと `was removed` で die する)。agmsg は必須要件で劣化モードは無い: Step 1g は `~/.agents/skills/agmsg/scripts/send.sh` が無いとき、または親自身の readiness 検査が失敗したときにディスパッチを止める。検査は `verify-agmsg-ready.sh --parent --team "$TEAM"` の 1 回呼び出しで、engine の選択はスクリプトの中にある: claude 親は生きた Monitor watcher、codex 親は記録済みの bridge seat で判定する。**呼び出し側は engine で分岐しない** — 無条件の `--self` は codex セッションから呼ぶと rc=2 になり、「rc=2 は判定不能なので停止」規則と噛み合ってディスパッチを最初の起床で自滅させる。同じ呼び出しは `sharing=<N>|unknown`（このプロジェクトの未 claim な role を受信している他の watcher の数）も返す。到達可能かどうかの判定は変えないので、正の数のときだけ警告し `0` / `unknown` では何も言わない。monitor スクリプトも heartbeat もポーリングループも無い (status.json の遷移は不変)。すべてのメッセージは `~/.agents/skills/agmsg/scripts/send.sh` の 1 回呼び出しで配送し、宛先は **agmsg の agent 名** であって surface / workspace ID ではない。outbox も長さ閾値も Enter 検証も再送も無い: `send.sh` は agmsg の共有 SQLite DB へ本文を書くか非ゼロで終了するかのどちらかで、**非ゼロ終了は配送されなかったことを意味する**ので必ず報告する。メッセージ種別はフラグではなく本文の label 接頭辞 (`phase-a-task:` / `phase-b-exec:` / `review-plan:` / `review-code:` / `review-verdict:` / `abort-reviewer:` / `dispatch-notify:`) で表す。ペインは `[ready] <name>` を報告してはじめて到達可能で、それ以前に送ったメッセージは inbox に未読で残る。完了通知は2段構え: 子セッションが status.json 書き込み直後に送る必須通知 (Step 2 で子プロンプトに埋め込む) + runner wrapper の exit 時通知 (バックストップ)。idle TUI は exit しないため wrapper だけに頼ると通知されない。親自身の wake チャネルは SessionStart hook が要求する常設の `Monitor` ストリームで、Step 1g はその生存を検証するだけ、Step 3 は起床のたびに再検証する。verdict 待ちも push である: レビュアーが findings ファイルを書いてから `review-verdict:` を依頼元へ 1 通送り、誰もファイルをポーリングしない。待機者 (Phase A-R の設計ペイン、Phase B-R の実装者) は起床のたびに findings ファイルを読み直す — 失われうるのはメッセージだけだからである。**safety timer は claude 専用**で、claude セッションは Bash tool で単発の `sleep` を background 実行する (親の 90 分タイマーも同じ仕組み)。codex はその tool を持たず、自分宛の遅延メッセージで代用することもできない — バックグラウンドのサブシェルで sleep してから自分へメッセージを送るやり方も、その detached (`nohup`) 版も 2026-08-21 に実測してターン終了で消えた (D-T2) — ので、**codex の待機者には保険が無く、張ったふりをしてはならない**。到達性を確認し、保険の無い待機に入ったことを親へ 1 通報告してからターンを閉じる。したがって codex 親が回す無人ループには backstop が 1 つも無く、拒否される。**verdict 行の無いタイマー起床は `needs_work` ではない** — メッセージが来なかったという意味しかない。**タイムアウト検知の粒度**は旧 loop 待機スクリプトの 5 秒間隔から 90 分固定タイマーの起床時のみへ粗くなっており、`loop.task_timeout_min` を 90 分未満にしても検知は次の起床までずれる (ポーリング全廃の意図した代償)。
- **Pre-warm role panes**: prewarm は常時 on。review_mode=off は design / exec、on は design / design_review / exec / exec_review を起動する。prewarm.json はこの 4 role key を明示的に持ち、consumer は検証済み snapshot を 1 回だけ読む。

---

## 補足（SKILL.md に対応セクションなし）

以下は利用者向けの補足であり、上の SKILL.md 対応節に新しい実行分岐を追加しない。

### 基本的な呼び出し

    /cmux-team-dispatch-task タスクA, タスクB
    /cmux-team-dispatch-task .claude/plans/feature-a.md
    /cmux-team-dispatch-task --setup
    /cmux-team-dispatch-task --reset config
    /cmux-team-dispatch-task --override タスクA

### ターミナル起動待機の自動学習

launch-workspace.sh は pane の shell prompt を検知してからコマンドを送る。実測待機時間は
shell_ready_ms として config に保存し、次回の上限へ反映する。

保存場所の優先順位:

1. project: <project>/.dispatch/config.json
2. global: ~/.claude/config/cmux-team-dispatch-task/config.json

学習値は 4 ロール設定と同じファイルに共存するが、config-edit.sh は未知 key を保持する。
global 学習値だけを確認するには次を使う:

    jq '.shell_ready_ms' ~/.claude/config/cmux-team-dispatch-task/config.json

学習値をリセットするときは config 全体を削除せず、shell_ready_ms だけを原子的に削除する。
壊れた JSON は dispatch 前に読み取りエラーとして停止し、--setup で再構成する。

### runner registry の補足

registry は ~/.claude/config/cmux-team-dispatch-task/runners.json に置く。最小 schema は:

    {
      "default":"claude",
      "runners":[
        {"name":"claude","command":"claude","engine":"claude"},
        {"name":"codex","command":"codex","engine":"codex"}
      ]
    }

default は初回 config 生成だけが読み、通常 resolve は 4 ロールそれぞれの config を使う。
runner レコードへ model / effort は保存しない。role ごとの runner / model / effort と
review_mode は --setup または config-edit.sh で管理する。
