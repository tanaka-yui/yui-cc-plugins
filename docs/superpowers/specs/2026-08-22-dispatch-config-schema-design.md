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
- 他コンポーネントが所有するキーは、書き込みが置換ではなくマージであることによって従来どおり
  温存される。既知のものは `shell_ready_ms`（`terminal-wait.sh` 所有）と
  `loop.task_timeout_min`（loop モードの起床時 reconciliation が読む）。`--reset config` は
  この 2 つを**消してはならない**。

### レイヤー合成の粒度

**(role, field) 単位**で合成する。project の `.runner.design.model` は global の同じ
フィールドだけを上書きし、global の `.runner.design.runner` は生き残る。現行の
「`design_runner` と `review_mode` がそれぞれ独立にレイヤー解決される」挙動の自然な
延長であり、「project でモデルだけ差し替える」という実際の使い方に一致する。

ロールオブジェクトごと置換する案は採らない。project に `{"model": "x"}` とだけ書いた
とき runner が消えて Q8 の fail-fast に落ちるのは、ユーザーの意図とかけ離れている。

この粒度は書き手にも影響する。project に `runner.design.effort` だけを書く場合、engine を
決める `runner.design.runner` は global 側にあるため、`config-edit.sh` は対象ファイルだけを
見て effort の allowlist を選べない。§3 の「effort 検証のための engine 解決順」がこの穴を
塞ぐ。

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

`config-lib.sh` はパス解決に加えて、次の 3 つの検証を持つ。これが D2 の
「1 箇所で正規化する」の実体である。

1. **model 値検証**（`runners-edit.sh` から救出）。空・前後の空白・シェルメタ文字
   （`'` `"` `` ` `` `$` `\`）・制御文字を拒否する。値は
   `zsh -ic "... '<prompt>' ..."` の二重引用を通って再実行されるため load-bearing。
2. **runner 名の検証**。model と同じ拒否条件（空・前後の空白・シェルメタ文字
   `'` `"` `` ` `` `$` `\`・制御文字）を適用する。runner 名も
   `config-edit.sh --set runner.design.runner='<値>'` というシェルコマンド文字列へ埋まり、
   さらに `runners.json` の `command` を引く鍵になるため、「非空文字列」だけでは
   `x'; command; #` のような値が事前 guard を通り抜ける。
3. **effort の正規化と allowlist**。入力を小文字化してから engine 別 allowlist
   （claude `low|medium|high|xhigh|max` / codex `minimal|low|medium|high|xhigh`）
   に照合する。ユーザーが `"xHigh"` と書いても通る。**小文字化はこの関数の中だけ**で
   行う。

この 3 つは「シェルコマンドを組み立てる**前**の guard」と「スクリプト内の検証」の両方から
呼ばれる（§3 の自由入力の事前検証）。

`config-lib.sh` を source するのは次の 6 つ。

| source する側 | 使うもの |
|---------------|----------|
| `config-edit.sh`（書き手） | パス + 3 つの検証 |
| `config-resolve.sh`（読み手） | パス + 3 つの検証 |
| `prewarm-panes.sh` | **3 つの検証 + `dispatch_runners_file`**（`--roles` の再検証専用。§4） |
| `render-loop-prompt.sh` | 3 つの検証（`--prewarm` の再検証専用。§6） |
| `terminal-wait.sh` | `config.json` のパスのみ |
| `launch-workspace.sh` | `--runner` 解決のための `runners.json` のパスのみ |

`prewarm-panes.sh` が source するのは、検証ロジックを写経で二重化しないためである（R3 #5）。
ロール値そのものは引き続き `--roles <file>` だけから受け取り、`RUNNERS_CONFIG_PATH` を
ロール解決に使う経路は持たない。

## §3 読み手 `config-resolve.sh` と書き手 `config-edit.sh`

### config-resolve.sh（ロール解決の唯一の読み手）

「唯一の読み手」は**ロール解決と `review_mode` に限った話**である。`terminal-wait.sh` が
`shell_ready_ms` を自分で読み書きすることは従来どおり許される（§2 / #11）。

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
- **fail-fast**: 次のいずれかで exit 2 で停止し `--setup` を案内する。ペインは 1 つも
  作られない（Q8）。
  1. 解決対象ロールの `runner` が未設定、または `runners.json` に実在しない。
  2. **engine が codex の review ロール（`design_review` / `exec_review`）の `model` が空**。
     codex model には組込み既定値が無く、現行の「codex reviewer は `review_model` 必須」
     invariant（CLAUDE.md 項目 18）をそのまま引き継ぐ。**2 つの review ロールは独立に
     検査する**（片方だけ不備でも止める）。engine が claude の review ロールは既定値
     `opus[1m]` が埋まるのでこの検査に掛からない。engine が codex の `design` / `exec` は
     model 空が正当なので**掛けない**。
  `review_mode=off` のときは `design_review` / `exec_review` を解決対象から外す（上の 2 つの
  検査も掛けない）。

**`review_mode` の解決規則**（D3 で質問が消え、D5 でこの値がペイン数を一意に決めるため、
終端まで規定する）:

- 各レイヤーを**独立に検証**する。値が文字列 `"on"` または `"off"` に**厳密一致**しなければ
  無効とする。`"ask"`、boolean の `true` / `false`、その他の型、その他の文字列はすべて無効。
- 無効なレイヤーは警告して**そのレイヤーだけ**を無視し、次のレイヤーへ落ちる
  （project 無効 → global へ）。
- 全レイヤーが未設定または無効なら、**組込み既定値 `on`** を使う。質問へ落としてはならない
  （D3）。`runner` と違い `review_mode` には普遍的に妥当な既定があるので fail-fast にしない。

**engine と model の不整合**（`--override` で runner を変えたときに起きる）:

- claude のエイリアス（`opus[1m]` / `sonnet` / `fable`）が codex engine のロールに来たとき、
  警告して**その値を持つレイヤーの model だけを無効化**し、次のレイヤー、最終的に既定値へ
  落とす（他のフィールドと同じレイヤー単位の扱い）。model 文字列の一般的な検証はしないので、
  判定はエイリアス名の一致だけで行う。
- **model 無しの表現は「フィールドを省略する」の 1 つだけ**とする。`null` も空文字も出さない。
  codex engine で model が決まらないときは `roles.<r>.model` が存在しない。downstream は
  キーの有無で判定し、無ければ `--model` フラグ自体を付けない。

組込み既定値（現行の表を維持する）:

| ロール | model（claude engine のみ） | effort |
|--------|------------------------------|--------|
| `design` | `opus[1m]` | `xhigh` |
| `design_review` | `opus[1m]` | `xhigh` |
| `exec` | `sonnet` | `high` |
| `exec_review` | `opus[1m]` | `xhigh` |

codex engine の model に既定値は無い（codex 側のデフォルトに委ねる）。`runner` には
普遍的な既定値が存在しないので、既定値の表に `runner` の行は無い（Q8 の fail-fast）。

### config-edit.sh（ロール / review 設定の唯一の書き手）

「唯一の書き手」は**ロール設定と `review_mode` に限った話**である。`shell_ready_ms` の
owner は従来どおり `terminal-wait.sh` で、自前の merge + atomic write 契約を維持したまま、
パスの解決だけを `config-lib.sh` に移す（#11）。

扱えるキーを次へ拡張する。

- `review_mode` — `on` | `off` のみ（`ask` は exit 2）
- `runner.<role>.runner` — `config-lib.sh` の **runner validator** を通ること（R3 #6）。
  「非空文字列」だけでは不十分で、前後の空白・シェルメタ文字・制御文字も exit 2 にする
- `runner.<role>.model` — `config-lib.sh` の model 検証
- `runner.<role>.effort` — `config-lib.sh` の正規化 + engine 別 allowlist

**effort 検証のための engine 解決順**（#1）。engine は次の順で決め、最初に決まったものを
使う。**この順序は `--set` の並び順に依存しない**（引数を全部読み終えてから解決する）。

1. 同じ呼び出しの `--set runner.<同じ role>.runner=<name>` の値
2. `--engine <role>=<engine>` フラグの明示値（**ロールごとに指定でき、繰り返せる**。R3 #1）。
   project が runner を持たず global から `design=claude` / `exec=codex` を継承している構成で、
   2 ロールの effort を 1 回の呼び出しで編集する正規のケースがあるため、単一の
   `--engine <engine>` では表現できない。S7 の「1 回の atomic move」を壊さずに
   ロールごとの engine を渡せる形にする
3. 書き込み対象ファイル内の `runner.<role>.runner`
4. どれからも決まらなければ **exit 2**。メッセージで `--engine` を渡すよう案内する

3 を「対象ファイル内」に限るのは、書き手にレイヤー合成を持ち込まないためである。project に
effort だけを書き global に runner がある正規のケース（§1）は 2 で解決する。呼び出し側
（`--setup` / `--override`）はロールを解決済みなので engine を必ず知っている。runner 名の
解決には `--runners <path>` を使う（省略時は `dispatch_runners_file`）。

- `runner` — **トップレベルの `--unset runner` だけ**を許す（#3）。`--reset config` の
  正準手順が `config-edit.sh --config <path> --unset review_mode --unset runner` の
  **1 回の呼び出し**（1 つの jq 式 / 1 回の `mv`）で表現できるようにするため。空の
  `runner` オブジェクトは残さない（`del(.runner)` なのでキーごと消える）。
  `--set runner=...` は受け付けない。

削除するキー: `design_runner` / `review_runner` / `exec_choice` / `prewarm`。

**自由入力の事前検証（command line 保護）**（#5）。SKILL.md / setup-mode.md の指示に従う
エージェントは、ユーザーの自由入力を `config-edit.sh --set runner.design.model='<値>'` の
ような**シェルコマンド文字列として組み立てる**。したがって `'` やバッククォート、`$`、`\`、
制御文字は、スクリプトの検証関数に届く前に引用を破壊する。旧 `setup-mode.md` はこの事前検証を
「command line を守る唯一の guard」として持っていたので、**必ず引き継ぐ**:

- `--setup` と `--override` の runner / model / effort の自由入力は、**コマンドを組み立てる
  前に** `config-lib.sh` と同じ拒否条件で検査する。違反したら値を捨てて**再質問**し、
  再入力も違反ならその次元の変更を中止する。**違反値をコマンドへ埋めてはならない。**
- スクリプト側の検証は取り除かない。手編集された config を読む経路には事前検証が無いので、
  二重に持つことが必要である。

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
`--base-surface`。

**`--review-mode` フラグは作らない**（R2 #1）。A1 が `--roles <file>` を唯一のロール入力と
決めた以上、`review_mode` も同じファイルから読む。別フラグを併存させると
`roles.json.review_mode=on` × `--review-mode off` のときに D5 の 2/4 ペイン不変条件が
どちらの値で決まるか分岐する。active なロール集合も配置も **`roles.json` の `review_mode`
だけ**が決める。

**`roles.json` は prewarm 側で再検証する**（R2 #1）。このファイルは `<STATUS_DIR>` に置かれ、
`<STATUS_DIR>` は codex reviewer へ `--add-dir` で書き込み許可を与えている領域である
（CLAUDE.md 項目 20 のトラストバウンダリ）。したがって resolver が書いてから prewarm が読む
までの間に差し替えられうる。ここで通した値は `zsh -ic "... '<prompt>' ..."` のコマンド文字列へ
再び埋め込まれるため、検証を省くと引用破壊から任意コマンド実行に至る。

- 検証の位置は **`--roles` を読み込んだ直後**。ペイン作成・`join.sh` / `delivery.sh set`・
  `launch-workspace.sh` 呼び出しより**前**に完了する。
- 検証内容: キー集合が厳密に一致すること、`review_mode` が `on` / `off` のいずれか、
  active な各ロールの `runner` が `config-lib.sh` の runner validator を通ったうえで
  `runners.json` に実在し `engine` と整合すること、`model` が model validator を通ること、
  `effort` が engine 別 allowlist に入ること、`review_mode=on` なら review 2 ロールが存在し
  `off` なら存在しないこと。
- **registry のパスは `roles.json` の中身から取らない**（R3 #5）。`roles.json.runners_file` は
  改竄可能な metadata なので、`dispatch_runners_file`（env と既定値から独立に導出）を使う。
  `roles.json` 内の path フィールドは**一致検査に使うか無視する**だけで、参照先の決定には
  使わない。偽の registry を指させれば、どんな runner 名でも「実在する」と検証を通せてしまう。
- **`model` キーを省略してよいロールを matrix で固定する**（R3 #5）。省略可否を曖昧にすると、
  codex の review ロールから `model` を消すだけで §3 の fail-fast を迂回できてしまう。

  | engine \ ロール | `design` | `design_review` | `exec` | `exec_review` |
  |---|---|---|---|---|
  | claude | 必須（既定値が埋まる） | 必須（既定値が埋まる） | 必須（既定値が埋まる） | 必須（既定値が埋まる） |
  | codex | **省略可** | **必須** | **省略可** | **必須** |

  `null` と空文字はどちらも不正であり、省略の表現は「キーが無いこと」だけである。
- 違反は**副作用ゼロで exit 2**（ペインも worktree も team member も作らない）。

**検証済みスナップショット契約**（R4 #2）。`<STATUS_DIR>` は codex reviewer に書き込み許可を
与えている領域なので、`roles.json` と `prewarm.json` は**検証したあとも書き換えられうる**。
「読み込み直後に検証する」だけでは、検証と利用の間に差し替えられた値が
`zsh -ic "... '<prompt>' ..."` の合成へ到達する。素直なシェル実装（検証後にもう一度同じパスを
`jq` する）はまさにこの形になるので、契約として縛る。

- 各 consumer は対象 JSON を**内容として 1 回だけ読む**（`DOC=$(cat …)` など）。
- 検証はその読み込んだ内容に対して行い、**以後は検証済みのローカル値だけを使う**。
- **同じ処理の中で元のパスを読み直してはならない。**
- 対象 consumer は 3 つ: `prewarm-panes.sh`（`roles.json`）、`render-loop-prompt.sh`
  （`prewarm.json`）、**`loop-cleanup.sh`（`prewarm.json`）**。cleanup を落とすと、
  leave / close の対象が差し替えられて**別のエージェントやサーフェスを終了させられる**。

`prewarm.json` を読む 2 つ（renderer / cleanup）は、runner / engine / model / effort に加えて
**実際に配送と終了処理へ使うフィールドも検証する**:

- `agent` が**そのロールに対応する名前**であること（`<slug>` / `<slug>-design-review` /
  `<slug>-exec` / `<slug>-exec-review`）。別ロール名や `parent` への差し替えを拒否する。
- `surface_id` / `workspace_id` が非空であること。
- `wired` が **`true`（boolean）**であること。
- JSON の型が厳密であること（文字列であるべき箇所が文字列であること）と、**許可キー以外が
  存在しないこと**。

**model 無しの表現は `roles.json` と `prewarm.json` の両方で「キーの省略」に統一する**
（R2 #1）。`null` も空文字も書かない。prewarm は `model` キーが無いロールの launch に
`--model` フラグ自体を付けない。

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
- **`code-review.json` と `--review-config` は exec_review ペインの起動と readiness が
  成功したときだけ**書く／渡す（#10）。spawn に失敗したときは**両方とも省略**し、Phase B-R
  の gate だけをスキップする。到達不能な surface / agent を書いた JSON を残すと、実装者が
  永遠に来ない verdict を待つ。
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
- **`--reset config`**: `config-edit.sh --config <path> --unset review_mode --unset runner`
  の**1 回の呼び出し**で行う（#3）。1 つの jq 式に合成され 1 回の `mv` で反映されるので、
  途中状態は観測されない。`shell_ready_ms` など他コンポーネントのキーを残す規約は維持し、
  空の `runner` オブジェクトも残さない。
- **自由入力の事前検証**: runner / model / effort の自由入力（`runners[]` が 5 件以上のときの
  「Other」を含む）は、`config-edit.sh` のコマンドを組み立てる**前に** §2 の 3 つの検証
  （runner / model / effort）で検査し、違反なら再質問する（#5 / R2 #4）。
- **回答は pending tuple として、書き込み前に engine 整合を再検証する**（R2 #3）。1 コールで
  runner / model / effort を同時に聞く以上、runner の回答が engine を変えたあとで model の
  回答（「変更なし」を含む）が engine と不整合になりうる。実際に起きるのは、review ロールの
  runner を claude から codex へ変え、model を「変更なし」（= claude 既定の `opus[1m]`）の
  ままにする経路である。writer は runner の保存に成功するが、resolver は claude エイリアスを
  codex 上で無効化し、codex review model 空として次回ディスパッチを exit 2 にする。
  再検証は **3 次元すべて**に掛ける（R3 #2）。model だけでは足りない:
  - **runner** — `runners.json` に実在するか。`runners[]` が 5 件以上のときの「Other」自由入力で
    未登録名が来ると engine 自体を引けないので、この次元の検証が最初に必要になる。
  - **model** — 新しい engine と整合するか（claude エイリアスが codex に来ていないか）。
    codex の review ロールでは非空であること。
  - **effort** — 新しい engine の allowlist に入るか。claude runner で `max` を選んだあと
    runner を codex へ変えて effort を「変更なし」にすると `max` が残るが、codex に `max` は無い。

  - **不正になった次元だけを再質問**する。
  - 2 回目も不正なら、**`--setup` はそのロールの tuple を丸ごと未変更のままにし**、
    **`--override` はそのロールの変更を丸ごと破棄して警告する**（当回の resolve は止めない）。
  - **全ての pending 変更が有効になるまで atomic write を行わない**。部分適用された
    「保存はできたが次回は必ず失敗する config」を作らない。再質問の最中も
    `config.json` はバイト単位で不変である。
- **`--reset runners`**: 変更なし。`runners.json` だけ削除して reset mode の
  First-run setup へ入り、両 `config.json` を変更しない。

### 入口ごとの config 書き込み契約（R2 #5）

`--reset runners` は「両 `config.json` を変更しない」規約を持つ一方、First-run setup は初期
config を書く。この 2 つが矛盾しないよう、入口ごとに固定する。

| 入口 | `runners.json` | `config.json` | review model の質問 | 終了時に 4 ロールが有効か |
|------|----------------|---------------|--------------------|--------------------------|
| 初回ディスパッチ（`runners.json` 不在） | 作成 | **グローバルへ初期値を作成** | codex default のときのみ | **はい** |
| `--setup` の S3「runner を追加」 | 追記 | **書かない** | しない | 変更前の状態を維持 |
| `--setup` の S3「レジストリを作り直す」 | 再作成 | **書かない** | しない | 既存 config の runner 名が新レジストリに無ければ**いいえ**（次回 resolve が Q8 fail-fast。S6 のプレビューで警告する） |
| `--reset runners` | 削除 → reset mode の First-run で再作成 | **書かない**（既存規約） | しない | 上と同じ理由で**いいえ**になりうる |
| `--reset config` | 触らない | `review_mode` と `runner` を unset | しない | **いいえ**（次回 resolve が Q8 fail-fast） |
| `--reset all` | 削除 → **通常モードの** First-run で再作成 | **global と project の両方**から役割キーを消したうえで、global に**初期値を作成** | codex default のときのみ | **はい** |

**`--reset all` はレイヤー選択を持たない**（R3 #3）。既存の reset は config を対象にしたとき
global / project / both を選ばせるが、`--reset all` でそれを許すと 2 つの穴が開く: project だけを
選んだのに global を初期化する実装と、global だけを選んで古い project の runner を残す実装に
分岐し、後者では古い project 値が新しい global を遮蔽して「終了時に 4 ロールが有効 = はい」が
成立しない。したがって **`--reset all` は常に両レイヤーの役割キー（`review_mode` と `runner`）を
消し、global にだけ初期値を書く**。レイヤー選択が残るのは `--reset config` の側である。

つまり**初期 config を書くのは「初回ディスパッチ」と `--reset all` の 2 経路だけ**であり、
どちらも通常モードの First-run setup を通る。`--reset runners` は reset mode なので書かない。
`--reset all` を reset mode にすると「config を消したのに書き戻さない」状態になり、直後の
ディスパッチが必ず Q8 fail-fast に落ちるので、通常モードにする。

### First-run setup（通常モード）

`runners.json` を書いたあと、初期 `config.json` をグローバルへ書く。reset mode
（`--reset runners` 由来）ではこの書き込みを**行わない**。

- `runner.<role>.runner` は 4 ロールとも `runners.json` の `default` を入れる（Q4）。
  これが `default` の唯一の読み手である。
- `runner.<role>.effort` は**書かない**。§3 の組込み既定値がそのまま効く。
- `runner.<role>.model` も原則**書かない**が、**例外が 1 つある**（#2）: `default` が
  codex engine の runner のとき、`design_review` と `exec_review` はその engine で model が
  必須（§3 の fail-fast 2）なので、**First-run setup が 2 つの review ロールぶんの model を
  1 コールで聞いて書く**。聞かずに済ませると、初回生成した config が §3 の fail-fast に
  必ず引っかかり、ディスパッチが 1 度も動かない。`default` が claude engine のときは
  既定値 `opus[1m]` が埋まるので聞かない。
- `review_mode` は First-run setup で 1 回だけ聞く（`on` / `off` の 2 択）。D3 で
  ディスパッチ時の質問が消えた以上、値の初回決定はここか `--setup` しか無い。

これにより D3 の「ロールは常に config で固定」が初回から成立し、Q8 の fail-fast に
即座にぶつからない。

### Loop mode / unattended

**`render-loop-prompt.sh` の I/F を 4 ロールへ作り直す**（#6）。現行は review の tuple を
1 つしか受けず、2 つの review ブロックを同じ tuple から生成してしまうため、design_review と
exec_review に別 runner を設定した構成で **Phase A-R と Phase B-R の依頼が片方の reviewer へ
誤配送される**。

- **入力は `--prewarm <path>` 1 本**にする（R3 #4）。ロール別フラグ 20 本を並べる案は捨てる。
  理由は「review が有効かどうか」を I/F が表現できないからである。区別すべき状態は 3 つあり、
  フラグの有無だけでは 2 つしか表せない:

  | 状態 | design_review ブロック | exec_review ブロック |
  |------|----------------------|---------------------|
  | config が `review_mode=off` | 出さない | 出さない |
  | `on` で両ペインとも起動成功 | 出す | 出す |
  | `on` だが exec_review の spawn / readiness だけ失敗（§5） | **出す** | **出さない** |

  `prewarm.json` は**実際に起動したロールだけ**を持つので、「ロールが存在する ⇔ そのロールの
  ブロックを出す」という 1 本の規則で 3 状態すべてを正しく表現できる。runner / engine / model /
  effort / agent もすべて `prewarm.json` にある（§4）。
- `prewarm.json` も `<STATUS_DIR>` にあるので、renderer は §4 の**検証済みスナップショット契約**
  に従う（1 回だけ内容として読む / 検証済みローカル値だけを使う / 再読しない）。検証内容は
  `config-lib.sh` の 3 つの検証 + engine 整合 + model 省略可否 matrix に加えて、`agent` の
  ロール対応・非空の `surface_id` / `workspace_id`・`wired === true`・厳密な型・許可キー以外の
  不在。違反は副作用ゼロで die。
- `design` と `exec` は codex engine のとき `model` 省略が正当。**active な review ロールの
  `model` は必須**（§4 の matrix と同一）。
- 旧来の単一 `--review-*` フラグ群とロール別フラグ案は**どちらも受け付けずに die** する。
- ブロック対応: `references/unattended/review-block.md` → **design_review**、
  `code-review-block.md` → **exec_review**。`phase-block-claude.md` /
  `phase-block-codex.md` は **design ロールの engine** で選ぶ（R2 #2）。両ファイルの本文は
  「Phase A CLI behavior: … design runner」であり、現行 renderer も
  `phase-block-$DESIGN_ENGINE.md` を読む。exec engine で選ぶと design=claude / exec=codex の
  構成で claude 設計ペインへ codex 用の plan 手順が渡る。

**`loop-cleanup.sh` を 4 ロール対応にする**（#7。task brief が scope に明示している）。
現行は旧 agent 名（`<slug>-codex` / `<slug>-review` など）を決め打ちで leave するため、
新名称の `<slug>-design-review` / `<slug>-exec` / `<slug>-exec-review` が team に残り、
次のディスパッチの配送先と衝突する。**`prewarm.json` に実在するロールの `agent` を列挙して
leave / close する**契約に変える（`review_mode=off` なら 2 件、`on` なら 4 件、いずれも
各 1 回だけ）。cleanup も §4 の**検証済みスナップショット契約**に従う（R4 #2）— leave / close の
対象を後から差し替えられると、無関係なエージェントやサーフェスを終了させられる。既存の `.. | objects | .surface_id? // empty` 列挙と `awk 'NF && !seen[$0]++'`
の重複除去、`close-surface --workspace` 必須の規約はそのまま維持する。

`references/loop-mode.md` / `loop-mode-ja.md` と `references/unattended/*.md` のロール語彙を
新名称へ揃える。

## §7 テスト

### 新規

| ファイル | 内容 |
|----------|------|
| `test/test-config-resolve.sh` | (role, field) 単位の precedence（global runner + project effort-only を含む）、`xHigh` → `xhigh` の正規化、組込み既定値の表、runner 未設定・不在の fail-fast（exit 2）、**codex review ロールの model 空を 2 ロール別々に fail-fast すること / codex の `design`・`exec` は model 空でも通ること**（#2）、model メタ文字の拒否、`DISPATCH_CONFIG_HOME` / `RUNNERS_CONFIG_PATH` の解決、`--set` の最優先適用、`review_mode=off` で review 2 ロールを解決対象から外すこと |
| `test/test-config-resolve.sh`（続き） | **レイヤー単位 fallback の負例**（R2 #7）: global に有効値・project に不正 effort → global の値へ落ちること、codex ロールに claude エイリアス model → その layer だけ無効化して次層／既定へ落ちること。いずれも**不正値が出力に一切残らない**こと、resolver 全体が exit せず既定値へ飛び越しもしないこと |
| `test/test-review-mode-resolve.sh`（`test-config-resolve.sh` に統合可） | `review_mode` の終端規則（#4）: 未設定 / `"ask"` / boolean / 任意文字列 / 型違いを各レイヤーで無効化して次へ落ち、全レイヤー無効なら既定 `on` に到達すること。質問へ落ちる経路が存在しないこと |
| `test/test-snapshot-contract.sh` | 検証済みスナップショット契約（R4 #2）: `prewarm-panes.sh` / `render-loop-prompt.sh` / `loop-cleanup.sh` の 3 者それぞれで、**検証の後に対象 JSON を差し替えても差し替え後の値が使われない**こと（検証時点の値で動くか、そもそも再読しないこと）。`prewarm.json` を読む 2 者では、`agent` を別ロール名や `parent` に変えたもの、`surface_id` / `workspace_id` が空のもの、`wired` が `false` / 文字列 `"true"` のもの、型違い、許可外キーの追加を**すべて副作用ゼロで拒否**すること。特に `loop-cleanup.sh` が差し替えられた `agent` / `surface_id` を leave / close しないこと |
| `test/test-roles-input.sh` | `--roles` の再検証（R2 #1 / R3 #5）: **registry path を `roles.json.runners_file` から取らない**こと（偽 registry を指す `runners_file` を置いても `dispatch_runners_file` 側で判定して exit 2）、model 省略可否 matrix（codex `design` / `exec` の省略は成功、codex `design_review` / `exec_review` の省略・`null`・空文字は副作用ゼロの exit 2、claude 4 ロールは既定値で埋まる）、`review_mode=on` の 4 ロール fixture と `off` の 2 ロール fixture を別々に持つこと。加えて **`review_mode` と active ロールのキー集合が整合した 2 つの fixture**（on = 4 ロール / off = 2 ロール）で 2/4 ペインが決まること、そのとき `--review-mode` フラグが存在しないこと（R4 #3。厳密スキーマ検証と両立しないので「同一 fixture の `review_mode` だけを変える」形にはしない — 4 ロール fixture を off にすれば余分なロールで、2 ロール fixture を on にすれば必須ロール欠落で、どちらも exit 2 になり正例にならない）、改竄 `roles.json`（不正キー・engine 不整合・model のメタ文字・effort 範囲外・review_mode と review ロールの矛盾）が**副作用ゼロで exit 2** になること、`model` キー省略時に `--model` が渡らないこと、廃止した 13 フラグをすべて拒否すること、prewarm 本体から `RUNNERS_CONFIG_PATH` を読む経路が消えていること |
| `test/test-pane-invariant.sh` | `review_mode=on` でちょうど 4 ペイン・`off` でちょうど 2 ペイン。split 方向が §4 の固定表と一致すること。`executors` キーが出力されないこと。**exec_review の spawn 失敗時に `code-review.json` と `--review-config` の両方が出ないこと / 正常系で design_review と exec_review に異なる値が入ること**（#10） |
| `test/test-config-paths.sh` | D6 の path helper が**全 consumer へ届く**こと（#12）: `terminal-wait.sh` が `DISPATCH_CONFIG_HOME` 配下の `config.json` を読み書きすること、`launch-workspace.sh` が `RUNNERS_CONFIG_PATH` 未設定時に既定 base を解決し、設定時はそちらを使うこと。旧 `~/.claude/cmux-team-dispatch-task` を参照する箇所が 1 つも残らないこと |
| `test/test-input-validation.sh` | 自由入力の事前検証（#5）: `'` / バッククォート / `$` / `\` / 制御文字 / 空 / 前後空白を含む値が、`config-edit.sh` を**起動する前に**拒否されて再質問に落ちる旨が SKILL.md・setup-mode.md・setup-mode-ja.md に明記されていること（needle 検査）|

### 更新

| ファイル | 変更 |
|----------|------|
| `test-config-edit.sh` | 入れ子キー `runner.<role>.<field>`、`review_mode` の `ask` 拒否、`--unset review_mode --unset runner` の 1 コール reset（空 `runner` を残さず `shell_ready_ms` を温存）、`--unset runner.<role>`、**effort の engine 解決順 4 段（同一バッチ runner → `--engine` → 対象ファイル → exit 2）が `--set` の並び順に依存しないこと**（#1）、**runner の禁止文字を `config-edit.sh` へ直接渡した各ケース**（空 / 前後空白 / `'` `"` `` ` `` `$` `\` / 制御文字）が exit 2 かつ原本不変であること（R3 #6）、**旧 4 キー**（`design_runner` / `review_runner` / `exec_choice` / `prewarm`）の `--set` / `--unset` が exit 2 かつ原本不変であること（R3 #7 の負例ラチェット）、**`--engine <role>=<engine>` の反復**で project effort-only × 異種 engine の複数ロールを 1 回の atomic move で更新でき、各 effort が自分の engine で検証されること（R3 #1）、**reset が第三者キーを温存すること**（R2 #8。fixture に `shell_ready_ms` と `loop.task_timeout_min` および `loop` 配下の別キーを置き、reset 後に消えるのは `review_mode` と `runner` だけで、`shell_ready_ms` と `loop` オブジェクトがバイト相当で不変であることを検査する）、そして **`test-runners-edit.sh` から移植する検証群**（#8）: model の全拒否条件（空 / 前後空白 / `'` `"` `` ` `` `$` `\` / 制御文字）と**内部空白を含む値は許容**すること、engine 別 effort allowlist の正例・負例（codex に `max` が無いこと）、`xHigh` → `xhigh`、失敗時に元ファイルが変更されないこと |
| `test-role-models.sh` | runners.json の役割フィールドではなく config の 4 ロールから解決することへ全面書き換え |
| `test-in-session.sh` | **反転**。`executors` が `{}` にならず exec ペインが必ず立つこと、in-session 判定コードが存在しないことのラチェット |
| `test-override.sh` | 対象ロール 4 つ、`--set` 経由の適用、prewarm へは `--roles` 1 本で渡ること。**永続化しない契約**（R2 #6）: 全ロール・全フィールドを override した後も global / project 両 `config.json` が**バイト単位で不変**であり、続けて override 無しで resolve すると元の値へ戻ること。engine 変更で無効になった runner override が適用されず警告されること（R2 #3）。**pending tuple の 3 負例**（model / effort / 未登録 runner）それぞれで、**そのロールの変更が丸ごと破棄**され他ロールの override は生きること（R4 非ブロッキング注記 1）|
| `test-setup-skill.sh` | S3-M 由来の needle（SU10-12 / 14-16）を新しいロール質問節の needle へ置換。SU13 の「両スクリプトを名指す」担保は `config-edit.sh` のみへ |
| `test-prewarm-layout.sh` / `test-prewarm-all-codex.sh` / `test-prewarm-unattended.sh` / `test-prewarm-design-permissions.sh` | ロールキーと `--roles` 入力へ |
| `test-launch-workspace-*.sh` | `--role` の新しい値域、役割フィールド層の消滅。**旧 `--role plan` / `review` が exit 2 になること**（R3 #7 の負例ラチェット）。**`--role exec` は新しい正当値として成功すること**（R4 #1。`exec` は旧値であると同時に新値でもあるので、退役リストに入れてはならない。入れると必須の exec ペインが起動できなくなる）|
| `test-setup-skill.sh`（追加分） | pending tuple の再検証（R3 #2）: claude → codex の runner 変更に対し、不正になった **model / effort / 未登録 runner のそれぞれ**で当該次元だけが再質問されること、再質問の最中も両 `config.json` がバイト不変であること、2 回目も不正なら `--setup` はそのロールを未変更のままにすること。入口ごとの config 書き込み契約（R2 #5 / R3 #3）: global と project に異なる値を置いた状態で初回ディスパッチ / `--reset runners` / `--reset config` / `--reset all` を通し、両 config の前後バイト列・質問の有無・最終 resolve が §6 の表どおりになること。特に `--reset all` が**両レイヤー**の役割キーを消すこと |
| `test-delivery-callsites.sh` | CS4 ratchet の削除済みスクリプト表へ `runners-edit.sh` を追加 |
| `test-loop-prompt.sh` / `test-loop-skill.sh` | renderer の 4 ロール I/F（#6）: design_review と exec_review に異なる reviewer を与えたとき 2 つのブロックが別々の宛先を持つこと、`review_mode=off` で review フラグ一式を完全省略して成功すること、旧単一 `--review-*` I/F が die すること。**必須フィールド欠落の検出**（R2 #9）: `review_mode=on` で review 2 ロール × `runner` / `engine` / `model` / `effort` / `agent` を 1 つずつ欠落させ、いずれも非ゼロ終了すること（空宛先のレビュー依頼を生成しないこと）。**phase block の選択基準**（R2 #2）: design=claude / exec=codex と design=codex / exec=claude の 2 方向で、Phase A の文言が **design engine** と一致すること。**`--prewarm` 入力の 4 状態**（R3 #4 + R4 非ブロッキング注記 3）: review ロール 0 件 / 2 件 / exec_review だけ欠落 / **design_review だけ欠落** の 4 fixture（欠落を対称に置くことで「実在するロールだけ block を出す」一般則そのものを固定する） でブロックの出方が表どおりになること、codex `design` / `exec` の model 省略が成功し active review ロールの model 欠落が die すること、`--prewarm` 未指定と旧フラグ群が die すること |
| `test-loop-cleanup.sh` / `test-cleanup-close.sh` | `prewarm.json` 実在ロールの列挙による leave / close（#7）: `review_mode=on` で 4 ロールを各 1 回、`off` で 2 ロールを各 1 回。`close-surface --workspace` が付くこと |
| `test-doc-stale-vocab.sh` | **走査対象に英語の `SKILL.md` と `references/unattended/*.md` を明示的に含める**（R3 #7）。DS2 の旧語彙リストへ `design_runner` / `review_runner` / `exec_choice` / `prewarm` キー / `"ask"` / in-session / `REVIEW_POLICY` / legacy resolver / `runners-edit.sh` を追加。DS3 のラチェットも更新 |

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

ファイル構成表には `config-lib.sh` / `config-resolve.sh` を足し、`runners-edit.sh` を落とす。
`render-loop-prompt.sh` と `loop-cleanup.sh` の説明も 4 ロール対応へ書き換える。

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
