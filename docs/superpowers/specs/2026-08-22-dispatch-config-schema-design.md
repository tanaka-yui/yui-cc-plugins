# cmux-team-dispatch-task 設定スキーマの 4 ロール化 設計

対象: `apps/cmux-team-dispatch-task`（3.0.0 / 破壊的変更）

## 目的

設定を「runner の同一性」と「ロールの割り当て」に分離し、ディスパッチ時の対話的な
解決をすべて廃止する。あわせて設定ファイルの置き場所を `~/.claude/config/` の下へ
移し、ユーザーの dotfiles リポジトリ側にプラグイン固有のリンク項目を持たなくて済む
ようにする。

現状の問題は 3 つある。

1. **役割の設定が 2 ファイルに割れている**。runner の同一性（`name` / `command` /
   `engine`）と役割別の model / effort が同じ `runners.json` に同居し、一方で
   「どの runner をどの役割に使うか」は `config.json` の `design_runner` /
   `review_runner` / `exec_choice` にある。1 つの役割を変えるのに 2 ファイルを触る。
2. **ディスパッチのたびに聞かれる**。`"ask"` 値と未設定状態がそれぞれ別の質問フロー
   を持ち、Step 1f の switch 質問、Phase B の実行モデル質問、各所の「常に〜」永続化
   フォローアップが分岐を増やしている。
3. **設定が `~/.claude/config` の外にある**。`~/.claude/config` は既にユーザーの
   dotfiles リポジトリへの単一シンボリックリンクだが、`~/.claude/cmux-team-dispatch-task/`
   はその単位の外にあり、リンクマニフェストに個別項目が必要だった。結果として
   `config.json` が複製され、実際に内容が食い違った。

## 決定事項（ユーザー確定済み。再議論しない）

| # | 決定 |
|---|------|
| D1 | `runners.json` は runner の同一性のみ（`default` + `runners[].{name,command,engine}`）。役割別 6 フィールドは移動する |
| D2 | `config.json` は 4 ロールの入れ子。各ロールが `runner` / `model` / `effort` を持つ。effort は大小文字を区別せず受け、1 箇所で小文字へ正規化する |
| D3 | `"ask"` を全廃。`review_mode` は `"on" \| "off"` のみ。ディスパッチ時に runner / model / effort を決める AskUserQuestion はすべて削除する |
| D4 | `prewarm` キーを削除し prewarm を常時 on にする。非 prewarm フォールバック経路を削除する |
| D5 | ペイン配置は `review_mode` だけで決まる。on = 2x2 の 4 ペイン、off = 縦 2 ペイン |
| D6 | 基準ディレクトリを 1 つ導入する。`DISPATCH_CONFIG_HOME`（既定 `~/.claude/config/cmux-team-dispatch-task`）配下に `config.json` と `runners.json` |

## ブレインストーミングで決めた事項

| # | 問い | 決定 |
|---|------|------|
| Q1 | in-session 実行の最適化と D5 の両立 | **in-session を完全に廃止**。ペイン数は `review_mode` だけで決まる |
| Q2 | `runners-edit.sh` の去就 | **削除**し、model / effort の編集は `config-edit.sh` が持つ。model 値検証と engine 別 effort allowlist は移植して存続させる |
| Q3 | 旧フォーマット / 旧パスの `config.json` | **無視する**。移行コードも非推奨警告も書かない。新パス・新スキーマだけを読む |
| Q4 | `runners.json` の `default` | **`--setup` の初期値シードとしてのみ残す**。ディスパッチ時は誰も読まない |
| Q5 | legacy review policy | **全削除**。`REVIEW_POLICY` と cross-engine resolver を消し、`code-review.json` は常に exec_review ペインを名指す |
| Q6 | `--override` の precedence | `--override` > project config > global config > 組込み既定値の 4 段。どちらの config にも書き戻さない。対象ロールは 4 つへ拡張 |
| Q7 | ロール命名 | **config のロール名に完全一致させる**。prewarm.json のキーも agmsg agent 名も `design` / `design_review` / `exec` / `exec_review` 系に揃える |
| Q8 | ロールの runner が未設定 / 不在 | **fail-fast**。ペインを 1 つも作らずエラーで停止し `--setup` を案内する |
| A1 | config 解決の置き場所 | **`config-resolve.sh` を唯一の読み手にし、prewarm-panes.sh は `--roles <file>` 1 本で受ける** |

## §1 スキーマ

### runners.json

```json
{
  "default": "ccf",
  "runners": [
    { "name": "ccf",   "command": "ccf",   "engine": "claude" },
    { "name": "codex", "command": "codex", "engine": "codex"  }
  ]
}
```

- `plan_model` / `review_model` / `exec_model` / `plan_effort` / `review_effort` /
  `exec_effort` は**このファイルから消える**（D1）。
- `default` は First-run setup と `--setup` が初期 `config.json` の 4 ロールを埋める
  ときの種としてのみ使う（Q4）。ディスパッチ経路のどのコードもこのキーを読まない。
- 2.x の残存フィールドが手元のファイルに残っていても**単に無視する**（Q3）。検出も
  警告もしない。

### config.json（global / project 共通）

```json
{
  "review_mode": "on",
  "runner": {
    "design":        { "runner": "ccf",   "model": "opus[1m]",      "effort": "xhigh" },
    "design_review": { "runner": "codex", "model": "gpt-5.6-sol",   "effort": "xhigh" },
    "exec":          { "runner": "codex", "model": "gpt-5.6-terra", "effort": "high"  },
    "exec_review":   { "runner": "ccf",   "model": "opus[1m]",      "effort": "high"  }
  }
}
```

- `review_mode` の値域は `"on" | "off"` のみ。`"ask"` は無い（D3）。
- 削除するキー: `design_runner` / `review_runner` / `exec_choice` / `prewarm`。
- `shell_ready_ms`（`terminal-wait.sh` 所有）など他コンポーネントのキーは、書き込みが
  置換ではなくマージであることによって従来どおり温存される。

### レイヤー合成の粒度

**(role, field) 単位**で合成する。project の `.runner.design.model` は global の同じ
フィールドだけを上書きし、global の `.runner.design.runner` は生き残る。現行の
「`design_runner` と `review_mode` がそれぞれ独立にレイヤー解決される」挙動の自然な
延長であり、「project でモデルだけ差し替える」という実際の使い方に一致する。

ロールオブジェクトごと置換する案は採らない。project に `{"model": "x"}` とだけ書いた
とき runner が消えて Q8 の fail-fast に落ちるのは、ユーザーの意図とかけ離れている。

## §2 パス解決（D6）

新規の source 専用ヘルパー `scripts/config-lib.sh` を置く。

```bash
DISPATCH_CONFIG_HOME="${DISPATCH_CONFIG_HOME:-$HOME/.claude/config/cmux-team-dispatch-task}"

dispatch_config_file()  { printf '%s/config.json\n' "$DISPATCH_CONFIG_HOME"; }
dispatch_runners_file() { printf '%s\n' "${RUNNERS_CONFIG_PATH:-$DISPATCH_CONFIG_HOME/runners.json}"; }
```

- 基準ディレクトリの env var は `DISPATCH_CONFIG_HOME` **1 つだけ**（D6）。
- `RUNNERS_CONFIG_PATH` は `runners.json` 個別の override として存続させる。既存の
  14 テストファイル・延べ 60 箇所がこれを設定しており、そのまま動く必要がある。
- `config.json` 個別の override 用 env var は**追加しない**。テストは
  `DISPATCH_CONFIG_HOME` を一時ディレクトリへ向ければ両ファイルまとめて隔離できる。

`config-lib.sh` はパス解決に加えて、次の 2 つの検証を持つ。これが D2 の
「1 箇所で正規化する」の実体である。

1. **model 値検証**（`runners-edit.sh` から救出）。空・前後の空白・シェルメタ文字
   （`'` `"` `` ` `` `$` `\`）・制御文字を拒否する。値は
   `zsh -ic "... '<prompt>' ..."` の二重引用を通って再実行されるため load-bearing。
2. **effort の正規化と allowlist**。入力を小文字化してから engine 別 allowlist
   （claude `low|medium|high|xhigh|max` / codex `minimal|low|medium|high|xhigh`）
   に照合する。ユーザーが `"xHigh"` と書いても通る。**小文字化はこの関数の中だけ**で
   行う。

`config-lib.sh` を source するのは `config-edit.sh`（書き手）、`config-resolve.sh`
（読み手）、`terminal-wait.sh`（`config.json` のパスのみ）、`launch-workspace.sh`
（`--runner` 解決のため `runners.json` のパスのみ）の 4 つ。`prewarm-panes.sh` は
`--roles <file>` だけを入力とするため source しない（§4）。

## §3 読み手 `config-resolve.sh` と書き手 `config-edit.sh`

### config-resolve.sh（新規・唯一の読み手）

```
config-resolve.sh --project-root <dir> [--runners <path>] [--set <role>.<field>=<value>]...
```

標準出力に JSON を 1 つ出す:

```json
{
  "config_home": "/Users/…/.claude/config/cmux-team-dispatch-task",
  "global_config": "…/config.json",
  "project_config": "<repo>/.dispatch/config.json",
  "runners_file": "…/runners.json",
  "review_mode": "on",
  "roles": {
    "design":        { "runner": "ccf",   "engine": "claude", "model": "opus[1m]",      "effort": "xhigh" },
    "design_review": { "runner": "codex", "engine": "codex",  "model": "gpt-5.6-sol",   "effort": "xhigh" },
    "exec":          { "runner": "codex", "engine": "codex",  "model": "gpt-5.6-terra", "effort": "high"  },
    "exec_review":   { "runner": "ccf",   "engine": "claude", "model": "opus[1m]",      "effort": "high"  }
  }
}
```

責務:

- project → global → 組込み既定値を (role, field) 単位で合成する。
- `engine` を `roles.<r>.runner` から `runners.json` の `.engine` で引く。
- effort を `config-lib.sh` の関数で小文字化し、engine 別 allowlist に照合する。
  範囲外はそのレイヤーだけを警告して無視し、次のレイヤー、最終的に既定値へ落とす。
- model を `config-lib.sh` の関数で検証する。手編集が公式にサポートされた経路である
  以上、書き込み時の検証だけでは `zsh -ic` へメタ文字が届きうるので、**読み取り時にも
  拒否する**。
- `--set <role>.<field>=<value>` を最優先レイヤーとして適用する。これが
  `--override` の適用点であり、**config には書き戻さない**（Q6）。
- **fail-fast**: いずれかのロールの `runner` が未設定、または `runners.json` に実在
  しないとき、exit 2 で停止し `--setup` を案内する（Q8）。`review_mode=off` のときは
  `design_review` / `exec_review` を解決対象から外す。

組込み既定値（現行の表を維持する）:

| ロール | model（claude engine のみ） | effort |
|--------|------------------------------|--------|
| `design` | `opus[1m]` | `xhigh` |
| `design_review` | `opus[1m]` | `xhigh` |
| `exec` | `sonnet` | `high` |
| `exec_review` | `opus[1m]` | `xhigh` |

codex engine の model に既定値は無い（codex 側のデフォルトに委ねる）。`runner` には
普遍的な既定値が存在しないので、既定値の表に `runner` の行は無い（Q8 の fail-fast）。

### config-edit.sh（唯一の書き手）

扱えるキーを次へ拡張する。

- `review_mode` — `on` | `off` のみ（`ask` は exit 2）
- `runner.<role>.runner` — 非空文字列
- `runner.<role>.model` — `config-lib.sh` の model 検証
- `runner.<role>.effort` — `config-lib.sh` の正規化 + engine 別 allowlist。engine を
  引くために `--runners <path>` を受け取る（省略時は `dispatch_runners_file`）。
  対象ロールの `runner` は、同じ `--set` バッチ内の値 → 既存 config の値 の順で解決
  する。どちらからも決まらないときは exit 2。

削除するキー: `design_runner` / `review_runner` / `exec_choice` / `prewarm`。

writer 固有 `mktemp` + jq 成功時のみ同一ディレクトリへ `mv`、複数 `--set` / `--unset`
を 1 つの jq 式へ合成する既存の契約はそのまま維持する。`--unset runner.<role>` で
ロールごと消せる。

### runners-edit.sh の削除（Q2）

`runners-edit.sh` は allowlist の 6 フィールドがすべて `runners.json` から出ていく
ため、残しても編集できるものが無い。`name` / `command` / `engine` の編集用に転用する
案は採らない（runner の追加・削除・再生成は `--setup` の S3 が丸ごと担当しており、誰
も要求していない新機能になる）。

削除に伴い次を更新する。

- `test/test-delivery-callsites.sh` の CS4 ratchet の削除済みスクリプト表へ
  `runners-edit.sh` を追加する。
- `references/setup-mode.md` / `setup-mode-ja.md` の S3-M 節を §6 のとおり置換する。
- `test/test-runners-edit.sh` を削除する。削除されたスクリプトのテストであり、消滅は
  CS4 ratchet が固定する。PR 本文に明記する。

## §4 ペイン配置と prewarm.json（D4 / D5 / Q1 / Q7）

### prewarm は常時 on（D4）

`prewarm` 設定キーと、`prewarm: false` のためだけに存在した非 prewarm フォールバック
経路（`launch-workspace.sh --mode execute` / `--mode review` のオンデマンド spawn 分岐）
を削除する。SKILL.md の「IF prewarm.json is absent, fall back to spawn」ブロックも
すべて消える。

### in-session 実行の廃止（Q1）

`EXEC_ENGINE == DESIGN_ENGINE && EXEC_MODEL == PLAN_MODEL && EXEC_EFFORT == PLAN_EFFORT`
のとき exec ペインを起動しない最適化を削除する。ペイン数は `review_mode` だけで決まる。
節約できるのはアイドルペイン 1 枚であり、prewarm・SKILL.md・テスト・ドキュメント 4 ファイル
に条件分岐を残す代償に見合わない。

### 配置

```
review_mode=on                              review_mode=off
┌──────────────┬───────────────┐            ┌──────────────┐
│ design       │ design_review │            │ design       │
├──────────────┼───────────────┤            ├──────────────┤
│ exec         │ exec_review   │            │ exec         │
└──────────────┴───────────────┘            └──────────────┘
```

| ペイン | 起動方法 |
|--------|----------|
| `design` | workspace のメイン surface |
| `design_review` | `design` から `right` split |
| `exec` | `design` から `down` split |
| `exec_review` | `exec` から `right` split |

`review_mode=off` では `design` と `exec` の 2 枚のみ（縦積み）。`set_exec_split_flags`
と `EXEC_LAST_SURFACE` による動的な split 方向計算は、この固定表に置き換わって消える。

### prewarm.json

`review` キーと `executors` マップを廃止し、トップレベルのロールキーへ揃える（Q7）。

```json
{
  "workspace_id": "…",
  "design":        { "surface_id": "…", "agent": "<slug>",               "runner": "ccf",   "engine": "claude", "model": "…", "effort": "…", "wired": true },
  "design_review": { "surface_id": "…", "agent": "<slug>-design-review", "runner": "codex", "engine": "codex",  "model": "…", "effort": "…", "wired": true },
  "exec":          { "surface_id": "…", "agent": "<slug>-exec",          "runner": "codex", "engine": "codex",  "model": "…", "effort": "…", "wired": true },
  "exec_review":   { "surface_id": "…", "agent": "<slug>-exec-review",   "runner": "ccf",   "engine": "claude", "model": "…", "effort": "…", "wired": true }
}
```

`review_mode=off` では `design_review` / `exec_review` キーが存在しない（現行の任意
`review` キーと同じ規約）。`wired: true` は診断出力であって分岐に使ってはならない、と
いう既存の規約も維持する。

標準出力 JSON は `{workspace_id, panes: {design, design_review?, exec, exec_review?}}`。

### agmsg agent 名

| ロール | agent 名 |
|--------|----------|
| `design` | `<slug>` |
| `design_review` | `<slug>-design-review` |
| `exec` | `<slug>-exec` |
| `exec_review` | `<slug>-exec-review` |

engine 由来の `<slug>-claude` / `<slug>-codex` と、単一の `<slug>-review` は消滅する。
`exec_choice` が無くなり exec ペインが常に 1 枚である以上、engine で名前を分ける理由が
無い。

### prewarm-panes.sh の入力（A1）

ロール解決の入力を `--roles <path>` 1 本にする。SKILL.md が `config-resolve.sh` を
1 回呼び、結果を `<STATUS_DIR>/roles.json` へ書き、そのパスを渡す。

削除するフラグ: `--design-runner` / `--reviewer-runner` / `--exec-runner` /
`--claude-runner` / `--codex-runner` / `--exec-choice` / `--review-model` /
`--design-model` / `--design-effort` / `--reviewer-model` / `--reviewer-effort` /
`--exec-model` / `--exec-effort`。

`--override` は `config-resolve.sh --set` の段階で `roles.json` に織り込み済みなので、
prewarm 側に上書きフラグを持たせる必要が無くなる。`RUNNERS_CONFIG_PATH` を直接読む
コードも消える（engine は `roles.json` に入っている）。

存続するフラグ: `--with-design` / `--cwd` / `--slug` / `--status-dir` / `--agmsg-team`
/ `--parent-notify-workspace` / `--unattended` / `--timeout-sentinel` / `--workspace` /
`--base-surface` / `--review-mode`。

### launch-workspace.sh

`runners.json` の役割フィールド層（`RUNNER_PLAN_MODEL` ほか 6 変数、458-507 行）を
削除する。model / effort の解決は「`--model` / `--effort` の明示値 > `--role` に対応
する組込み既定値」の 2 段になる。`--role` の値域を `plan|review|exec` から
`design|design_review|exec|exec_review` へ揃え、`--mode` からの既定導出も対応させる
（`plan` / `superpowers` → `design`、`review` → `design_review`、`execute` /
`standby` → `exec`）。`exec_review` は `--role` 明示でのみ選ぶ。

`--runner` は runner の `command` / `engine` を引くために引き続き `runners.json` を
読む。

## §5 レビュー 2 ロール化（Q5）

`REVIEW_POLICY=fixed|legacy` と `DESIGN_ENGINE == EXEC_ENGINE` の cross-engine
resolver を全削除する。

- **Phase A-R** は `design_review` ペインが担当する。spec / plan の 2 ポイントで同一
  ペインを再利用する（レビュー文脈を保つため）。
- **Phase B-R** は `exec_review` ペインが担当する。
- `review/code-review.json` は**常に `exec_review` ペイン**を名指す。フィールド
  （`reviewer_surface` / `reviewer_agent` / `reviewer_runner` / `reviewer_engine` /
  `reviewer_workspace` / `review_dir`）自体は配線情報として存続し、中身が常に
  `exec_review` の解決値で埋まる。
- 設計ペインは**常に** `.deferred` を作って exit する。設計セッションがレビュアーへ
  転じる経路は消滅する。
- `review_mode=on` でロールが解決できないケースは Q8 の fail-fast に統合される。
  「reviewer 不在ならそのタスクだけ review off」という警告フォールバックは、
  `review_mode=on` かつ review ロールの runner が不正という設定の誤りを黙って握り潰す
  ことになるので削除する。review ペインの spawn 失敗時に当該 gate だけを警告して
  スキップする挙動は維持する（こちらは設定の誤りではなく実行時の失敗）。

## §6 SKILL.md / setup / loop

### Step 1f（Configure Child Runner）

対話フローを全廃する。

1. `runners.json` の存在確認。無ければ First-run setup。
2. `config-resolve.sh --project-root "$(git rev-parse --show-toplevel)"` を 1 回呼ぶ。
3. exit 2 なら停止して `--setup` を案内する（Q8）。
4. 結果を `<STATUS_DIR>/roles.json` へ保存し、以後のロール値はここから読む。

削除する対話: switch 質問（4 択 / 3 択の両形式）、タスクごとの runner 質問、
「常に既定 / 常に固定」の永続化 2 択。`runners.json` の reset は `--reset runners`
からのみ到達できる。

### Step 1g（Resolve Delivery, Review Mode and Execution Default）

- agmsg readiness ブロック、delivery contract、label 表、`join.sh` 配線、
  `[ready]` プロトコルは**すべて維持**する。
- `review_mode` の 4 択質問と永続化 jq merge を削除する。値は `roles.json` の
  `review_mode` を読むだけになる。
- `exec_choice` の解決と Phase B の実行モデル質問、`resolve_exec_runner()`、
  in-session 判定ブロックを削除する。
- 節タイトルを実態に合わせて `1g. Resolve Delivery and Review Mode` へ変更する。

### Step 1g-2（`--override`）

- Call 2 の選択肢を `design` / `design_review` / `exec` / `exec_review` の 4 つに
  する。review 系 2 つは `review_mode=on` のときだけ提示する。
- Call 3 は現行どおり runner / model / effort の 3 問 1 コール。
- 答えを `config-resolve.sh --set <role>.<field>=<value>` へ渡し、その出力で
  `roles.json` を上書きする。runner 変更に伴う engine 変更、effort の allowlist 外、
  claude alias model の codex への持ち込みといった不整合の警告も `config-resolve.sh`
  が出す（現行 SKILL.md の散文ルールがスクリプトの検証へ移る）。
- 「Step 1f の switch 質問との関係」表は、Step 1f の質問が消えたので削除する。

### プレースホルダ

| 旧 | 新 |
|----|----|
| `{{PLAN_MODEL}}` / `{{PLAN_EFFORT}}` | `{{DESIGN_MODEL}}` / `{{DESIGN_EFFORT}}` |
| `{{REVIEW_MODEL}}` / `{{REVIEW_EFFORT}}` | `{{DESIGN_REVIEW_MODEL}}` / `{{DESIGN_REVIEW_EFFORT}}` |
| `{{REVIEW_ENGINE}}` | `{{DESIGN_REVIEW_ENGINE}}` |
| `{{REVIEW_PANE_AGENT}}` | `{{DESIGN_REVIEW_AGENT}}` |
| `{{EXEC_MODEL}}` / `{{EXEC_EFFORT}}` | 同名で維持 |
| — | `{{EXEC_REVIEW_MODEL}}` / `{{EXEC_REVIEW_EFFORT}}` / `{{EXEC_REVIEW_ENGINE}}` / `{{EXEC_REVIEW_AGENT}}` |
| `{{EXEC_DEFAULT_HINT}}` | 削除（Phase B 質問の消滅） |
| `{{CODEX_OPTION_LINE}}` | 削除（同上） |
| `{{CODEX_BEHAVIOR_BLOCK}}` | 維持（codex executor 向けの委譲手順） |
| `{{REVIEW_BLOCK}}` / `{{CODE_REVIEW_BLOCK}}` | 維持。ただし宛先が design_review / exec_review に分かれる |

生成されるタスクプロンプトの MANDATORY MODEL SELECTION SEQUENCE は、Phase A-R が
`design_review`、Phase B-R が `exec_review` を名指す形になる。Phase B は
AskUserQuestion を持たず常に `exec` ペインへ委譲する。

### Setup Mode / Reset Mode

`references/setup-mode.md` と `setup-mode-ja.md` を書き換える。

- **S2（対象）**: グローバル `config.json` / プロジェクト `config.json` /
  `runners.json` の 3 択。
- **`config.json` 対象**: `review_mode` と「どのロールを編集するか」を 1 コール
  （2 問）で聞き、選ばれたロールごとに runner / model / effort の 3 問を 1 コールで
  聞く。最大 4 ロール = 最大 5 コール。AskUserQuestion の 1 コール 4 問・各 4 択の
  上限は守る。runner が 5 件以上のときは先頭 4 件 + 「Other」自由入力。
- **`runners.json` 対象（旧 S3）**: 4 択から 3 択へ。「登録済み runner の model /
  effort を編集」を削除し、「runner を追加 / レジストリを作り直す / そのまま」にする。
- **S3-M を削除**。候補プール表、M1 / M2 / M3 の 3 コール構成、`####` 見出し 8 個、
  `*_model` 拒否条件の限定句はすべて消える。CLAUDE.md 項目 28 が課している
  「setup-mode.md と setup-mode-ja.md が維持すべき 4 つ」のうち (1) (3) (4) は
  S3-M 由来なので消え、(2) の S7 温存 3 文は `runners-edit.sh` への言及を落として
  維持する。
- **S6 プレビュー**: 2 ファイル（`config.json` + `runners.json`）から、対象に応じた
  1 ファイルへ。
- **S7 書き込み**: `config-edit.sh` の 1 コールのみ。`runners-edit.sh` → `config-edit.sh`
  の順序規約は消える。
- **`--reset config`**: `review_mode` と `runner` の 2 キーを unset する（旧: 役割
  5 キー）。`shell_ready_ms` を残す規約は維持。
- **`--reset runners`**: 変更なし。`runners.json` だけ削除して reset mode の
  First-run setup へ入り、両 `config.json` を変更しない。

### First-run setup

`runners.json` を書いたあと、初期 `config.json` をグローバルへ書く。

- `runner.<role>.runner` は 4 ロールとも `runners.json` の `default` を入れる（Q4）。
  これが `default` の唯一の読み手である。
- `runner.<role>.model` と `runner.<role>.effort` は**書かない**。§3 の組込み既定値が
  そのまま効く。ユーザーが後から `--setup` か手編集で個別に埋める。
- `review_mode` は First-run setup で 1 回だけ聞く（`on` / `off` の 2 択）。D3 で
  ディスパッチ時の質問が消えた以上、値の初回決定はここか `--setup` しか無い。

これにより D3 の「ロールは常に config で固定」が初回から成立し、Q8 の fail-fast に
即座にぶつからない。

### Loop mode / unattended

`render-loop-prompt.sh` が受け取る解決済み runner / engine を 3 ロールから 4 ロール
へ拡張する。`references/loop-mode.md` / `loop-mode-ja.md` と
`references/unattended/*.md` のロール語彙を新名称へ揃える。`review-block.md` /
`code-review-block.md` の宛先を design_review / exec_review へ分ける。

## §7 テスト

### 新規

| ファイル | 内容 |
|----------|------|
| `test/test-config-resolve.sh` | (role, field) 単位の precedence、`xHigh` → `xhigh` の正規化、組込み既定値の表、runner 未設定・不在の fail-fast（exit 2）、model メタ文字の拒否、`DISPATCH_CONFIG_HOME` / `RUNNERS_CONFIG_PATH` の解決、`--set` の最優先適用、`review_mode=off` で review 2 ロールを解決対象から外すこと |
| `test/test-pane-invariant.sh` | `review_mode=on` でちょうど 4 ペイン・`off` でちょうど 2 ペイン。split 方向が §4 の固定表と一致すること。`executors` キーが出力されないこと |

### 更新

| ファイル | 変更 |
|----------|------|
| `test-config-edit.sh` | 入れ子キー `runner.<role>.<field>`、`review_mode` の `ask` 拒否、`--reset config` 相当の 2 キー unset、`--unset runner.<role>` |
| `test-role-models.sh` | runners.json の役割フィールドではなく config の 4 ロールから解決することへ全面書き換え |
| `test-in-session.sh` | **反転**。`executors` が `{}` にならず exec ペインが必ず立つこと、in-session 判定コードが存在しないことのラチェット |
| `test-override.sh` | 対象ロール 4 つ、`--set` 経由の適用、prewarm へは `--roles` 1 本で渡ること |
| `test-setup-skill.sh` | S3-M 由来の needle（SU10-12 / 14-16）を新しいロール質問節の needle へ置換。SU13 の「両スクリプトを名指す」担保は `config-edit.sh` のみへ |
| `test-prewarm-layout.sh` / `test-prewarm-all-codex.sh` / `test-prewarm-unattended.sh` / `test-prewarm-design-permissions.sh` | ロールキーと `--roles` 入力へ |
| `test-launch-workspace-*.sh` | `--role` の新しい値域、役割フィールド層の消滅 |
| `test-delivery-callsites.sh` | CS4 ratchet の削除済みスクリプト表へ `runners-edit.sh` を追加 |
| `test-doc-stale-vocab.sh` | DS2 の旧語彙リストへ `design_runner` / `review_runner` / `exec_choice` / `prewarm` キー / `"ask"` / in-session / `REVIEW_POLICY` / legacy resolver / `runners-edit.sh` を追加。DS3 のラチェットも更新 |

### 削除

- `test/test-runners-edit.sh` — 対象スクリプトが削除されるため。消滅は CS4 ratchet が
  固定する。PR 本文に理由を明記する。

### 検証コマンド

```bash
pnpm check
pnpm check:doc-lang
for f in apps/cmux-team-dispatch-task/test/test-*.sh; do bash "$f"; done
```

旧契約を encode しているテストは**意図的に更新**し、PR 本文にその旨を書く。テストを
削除して通すことはしない。

## §8 ドキュメント

4 ファイル整合の絶対ルール（SKILL.md / guide-ja.md / README.md / プラグイン CLAUDE.md）
を維持する。SKILL.md は英語、guide-ja.md は見出し 1:1 の日本語ミラー。

プラグイン `CLAUDE.md` の更新対象:

- 「role 解決の現行契約」節を全面書き換え。
- ファイル構成表から `runners-edit.sh` を削除し、`config-lib.sh` / `config-resolve.sh`
  を追加。設定ファイルのパスを新基準へ。
- 項目 8（モデル選択フロー）— Phase B の質問と in-session 条件を削除。
- 項目 10（役割別 model / effort）— config 由来の解決へ書き換え。
- 項目 13（prewarm.json スキーマ）— 4 ロールキーへ。
- 項目 17 / 18（Phase B-R / 独立 review runner）— legacy policy 削除、2 review ロール。
- 項目 19（`design_runner` / `exec_choice` の precedence）— キー消滅に伴い、
  (role, field) 単位のレイヤー合成と fail-fast の記述へ置換。
- 項目 26（レイアウト）— 固定表 2 パターンへ。
- 項目 28（setup / reset）— S3-M 削除、`config-edit.sh` の新 allowlist、2 キー reset。
- 項目 37 / 38（`design_runner` default / `exec_choice` default）— 削除。
- 項目 43（`--setup` / `--reset`）— S3-M 記述を新ロール質問へ。
- 項目 44（`--override`）— 4 段 precedence、4 ロール、`config-edit.sh` のみ言及。
- E2E テスト節の項目 8 / 9（モデル選択の動的表示 / in-session 実行）— 削除。
- 項目 47（退役候補）— `runners-edit.sh` と削除した分岐を反映。

`README.md` は設定ファイルのパス、スキーマ例、ペイン配置図、`--setup` の手順を更新。

## §9 バージョン

破壊的変更のため **3.0.0**。次の 3 箇所を同期する。

- `apps/cmux-team-dispatch-task/.claude-plugin/plugin.json`
- `apps/cmux-team-dispatch-task/.codex-plugin/plugin.json`
- ルート `.claude-plugin/marketplace.json` の対応エントリ

## §10 適用範囲外

- token-meter の設定ファイル位置（ユーザーが延期）。
- **ユーザーの実ファイルの移動**、および dotfiles リポジトリ（local-conf）のリンク
  マニフェスト編集。`~/.claude/**` を含む worktree 外のパスは一切触らない。代わりに
  `result.md` の末尾に、ユーザー自身が実行すべきシェルコマンドと local-conf 側の
  変更点を記す。

想定する移行手順（`result.md` に載せるもの）:

```bash
mkdir -p ~/.claude/config/cmux-team-dispatch-task
mv ~/.claude/cmux-team-dispatch-task/runners.json ~/.claude/config/cmux-team-dispatch-task/
# config.json は旧スキーマなので移さず、新スキーマで作り直す
rm -f ~/.claude/cmux-team-dispatch-task/config.json
rmdir ~/.claude/cmux-team-dispatch-task 2>/dev/null || true
# 4 ロールを対話で埋める
# /cmux-team-dispatch-task --setup
```

local-conf 側は、`~/.claude/config` が既に単一シンボリックリンクである以上、
`~/.claude/cmux-team-dispatch-task` を指すリンクマニフェスト項目を**削除**するだけで
よい（新パスは既存の `~/.claude/config` リンクの内側に入る）。

## 残余リスク

- **旧設定が黙って効かなくなる**（Q3 の帰結）。新パスに `config.json` が無い状態で
  ディスパッチすると、Q8 の fail-fast が「role の runner が未設定」で止める。沈黙して
  既定値で走ることは無いので、事故ではなく明示的な停止として現れる。
- **ペインが 1 枚増える構成がある**（Q1 の帰結）。design と exec の設定が同一のとき、
  以前は 1 枚で済んだ場面で 2 枚立つ。アイドルペインのコストのみ。
- **`--roles <file>` はファイル経由の受け渡し**なので、`<STATUS_DIR>` が作れない環境
  では prewarm が動かない。`<STATUS_DIR>` は既に status.json / prewarm.json /
  review/ の置き場所として必須なので、新しい前提ではない。
