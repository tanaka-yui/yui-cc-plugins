# cmux-team-dispatch-task `--setup` での役割別 model / effort 設定の設計

対象: `apps/cmux-team-dispatch-task`

## 背景

`runners.json` の runner レコードは v1.20.0 以降、役割ごとの model と effort を
6 つの任意フィールドとして持つ。

| フィールド | 役割 |
|---|---|
| `plan_model` / `plan_effort` | design（plan / superpowers / prewarm design standby） |
| `review_model` / `review_effort` | review（Phase A-R / Phase B-R のレビューペイン） |
| `exec_model` / `exec_effort` | exec（execute / executor standby） |

この 6 フィールドは **engine 中立**で、claude runner でも codex runner でも同じ名前で
解決される。解決順序も既定値も既に実装済みで、`launch-workspace.sh` /
`prewarm-panes.sh` / `--override` のすべてがこれを読む。

欠けているのは**書き込み側だけ**である。値を入れる経路は 2 つしかない。

1. **First-run setup** — `runners.json` が存在しないときにだけ走る。既に登録された
   runner のフィールドを後から変えることはできない。
2. **JSON の手編集** — `~/.claude/cmux-team-dispatch-task/runners.json` を直接開く。

`--setup` は runner（`design_runner` / `review_runner` / `exec_choice`）を選ばせるが、
その runner が**どのモデルでどの effort で動くか**は選ばせない。「レビューだけ effort を
上げたい」「exec を `fable` にしたい」といった、最も頻度の高い調整が `--setup` から
到達できない。

## 目的

`--setup` から、登録済み runner の **3 役割 × 2 次元 = 6 フィールドすべて**を設定・変更・
既定へ戻すことができるようにする。JSON の手編集を不要にする。

## 非目標

以下は明示的に扱わない。

- 解決ロジック・既定値・優先順位の変更。`launch-workspace.sh` / `prewarm-panes.sh` /
  `--override` は 1 行も変えない。
- `config.json` への新キー追加。model / effort は `runners.json` に属し、config の
  役割キー 5 つ（`design_runner` / `review_runner` / `exec_choice` / `review_mode` /
  `prewarm`）は不変。
- runner の追加・削除、`name` / `command` / `engine` / `default` の変更。これらは
  First-run setup と `--reset runners` の担当のまま。
- First-run setup の書き込み経路を新スクリプトへ移行すること。現行のまま動いており、
  触れば回帰リスクだけが増える。
- `--setup` の排他規則（`--loop` / `--reset` / `--override`）と「ディスパッチしない」
  性質の変更。
- バージョン番号の bump、push、PR 作成。

## 前提として守る事実

| 項目 | 内容 |
|---|---|
| 未設定時の既定 model | plan: claude `opus[1m]` / codex なし、review: claude `opus[1m]` / codex は reviewer に選ぶなら必須、exec: claude `sonnet` / codex なし |
| 未設定時の既定 effort | plan `xhigh` / review `xhigh` / exec `high`（両 engine 共通） |
| effort allowlist | claude `low\|medium\|high\|xhigh\|max`、codex `minimal\|low\|medium\|high\|xhigh`。**codex に `max` は決して出さない** |
| model 文字列 | 検証しない。claude の別名（`opus[1m]` / `sonnet` / `fable`）は候補として出すが、任意の文字列を通す |
| AskUserQuestion 上限 | 1 コール 4 問、1 問 4 選択肢。"Other" 自由入力欄は自動で付き、この 4 枠を消費しない |
| 原子的書き込み | writer 固有 `mktemp` + `jq` + jq 成功時のみ `mv`。他コンポーネント所有のキーを消さない |

`config.json` の `shell_ready_ms`（`terminal-wait.sh` 所有）が生き残らねばならないのと
同じ理由で、`runners.json` でも「編集対象でない runner」「編集対象でないフィールド」
「`default` キー」が生き残らねばならない。

---

## 設計

### 1. 書き込み口 — 新規スクリプト `scripts/runners-edit.sh`

`runners.json` への書き込みは、`config-edit.sh` と同一の契約を持つ**専用スクリプト**を
新設して一本化する。

#### 1.1 なぜ新規スクリプトなのか

3 案を検討した。

| 案 | 判定 | 理由 |
|---|---|---|
| **新規 `runners-edit.sh`** | **採用** | 対象ファイル・スキーマ・検証ドメインのいずれも `config.json` と別物。`config-edit.sh` と同型の契約を持たせれば、読む側の認知負荷は増えない |
| `config-edit.sh` を拡張 | 却下 | `known_key` / `valid_value` の「5 キー allowlist」モデルと `--config` という引数名が壊れる。単一オブジェクトのキー更新と配列要素の部分更新という別種の操作が 1 スクリプトに混ざり、`test-config-edit.sh` CE5「未知キーは exit 2」契約とも衝突する |
| SKILL.md / setup-mode.md にインライン jq | 却下 | `setup-mode.md` 自身の「Never hand-assemble a jq invocation for these files」に真正面から反する。`config-edit.sh` が生まれた動機（呼び出しごとに jq を組み立て直すことで起きるマージ漏れ）は、配列要素の部分更新ではさらに深刻になる |

新規スクリプトにしかできないことが 1 つある。**effort の検証には runner の `engine` が
必要**で、その `engine` は編集対象のレコード自身に書いてある。スクリプトなら
`--set plan_effort=max` を受け取った時点でレコードから `engine` を読み、codex runner
なら `max` を弾ける。インライン jq では「呼び出し側が engine を正しく渡す」ことを
毎回祈ることになる。

#### 1.2 インターフェース

```
runners-edit.sh --runners <path> --name <runner> [--set <field>=<value>]... [--unset <field>]...
runners-edit.sh --runners <path> --name <runner> --get <field>
runners-edit.sh --runners <path> [--name <runner>] --show
```

`config-edit.sh` の `--config` / `--set` / `--unset` / `--get` / `--show` と 1:1 で
対応する。追加されたのは `--name`（どの runner レコードを対象にするか）だけ。

| 引数 | 意味 |
|---|---|
| `--runners <path>` | 対象 `runners.json`。既定の場所は `~/.claude/cmux-team-dispatch-task/runners.json` だが、パスは呼び出し側が渡す（テスト可能性のため） |
| `--name <runner>` | 対象 runner の `name`。実在しなければ exit 2 |
| `--set <field>=<value>` | フィールドを設定（繰り返し可） |
| `--unset <field>` | フィールドを削除 = 既定へ戻す（繰り返し可） |
| `--get <field>` | 値を stdout へ。未設定なら空文字で exit 0 |
| `--show` | `--name` 併用でそのレコードだけ、省略時はファイル全体を整形出力 |

#### 1.3 検証

**フィールド allowlist**（これ以外は exit 2）:

```
plan_model  review_model  exec_model  plan_effort  review_effort  exec_effort
```

`name` / `command` / `engine` / `default` は allowlist に**入れない**。この
スクリプトは runner の同一性には触らない。

**値の検証**:

- `*_model` — 非空文字列であること以外は検証しない。モデル文字列を検証しないのは
  既存契約であり、新しいモデル名が出るたびにスクリプトを直す羽目になるのを避けるため。
- `*_effort` — レコードの `engine` を読み、engine 別 allowlist と照合する。
  - `engine: claude` → `low` / `medium` / `high` / `xhigh` / `max`
  - `engine: codex` → `minimal` / `low` / `medium` / `high` / `xhigh`
  - 範囲外は exit 2。**codex に `max` を渡すと必ず失敗する。** codex が `max` を
    受け付けるかは確認されていないので、安全側の分岐を維持する。
  - `engine` がレコードに無い、または上記 2 値以外のときは exit 2（どちらの
    allowlist を適用すべきか決められないため、黙って通さない）。

**モード排他**: `--set`/`--unset` 群 / `--get` / `--show` のうち、ちょうど 1 つだけを
指定する。混在は exit 2。`config-edit.sh` と同じ規則。

#### 1.4 書き込み

```
1. mkdir -p "$(dirname "$RUNNERS")"
2. TMP=$(mktemp "$RUNNERS.XXXXXX")        # 共有 $RUNNERS.tmp は並列書き込みで壊れる
3. 全 --set / --unset を単一の jq 式へ合成し、1 回の jq 実行で $TMP へ書く
4. jq が成功したときだけ mv "$TMP" "$RUNNERS"
5. 失敗したら rm -f "$TMP" して exit 1（元ファイルは無傷）
```

jq 式は対象 runner だけを写像する形にする。他の要素はそのまま通す。

```
.runners |= map(if .name == $n then (.plan_effort = $v1 | del(.exec_model)) else . end)
```

これにより次が保証される。

- 他の runner レコードは 1 バイトも変わらない
- `default` キーおよびトップレベルの未知キーが残る
- 編集対象レコード内の、allowlist 外のフィールド（`name` / `command` / `engine` や
  将来追加されるフィールド）が残る = **置換ではなくマージ**

**exit code**: 0 成功 / 1 書き込み・読み取り失敗（ファイルは変更されない）/
2 usage・検証エラー。`config-edit.sh` と完全に同じ。

#### 1.5 ファイルが存在しない場合

`--runners` が指すファイルが無いときは **exit 2**。`config-edit.sh` は config を新規
作成するが、`runners.json` は「登録済み runner を編集する」という前提が崩れるので
作らない。レジストリの新規作成は First-run setup の責務。

---

### 2. `--setup` フローの変更

runtime SoT は `references/setup-mode.md`（日本語ミラー `setup-mode-ja.md`）。

#### 2.1 S1 — 現状表示

レジストリの一覧に effort 3 列を追加し、6 フィールドすべてを出す。未設定のフィールドは
空欄ではなく `default (<値>)` と表示して、実効値が読めるようにする（役割キーの
「unset と表示する」規則と同じ思想）。codex の model 既定は値が無いので
`default (codex-side)` と表示する。

#### 2.2 S2 — 質問コール①

Q2「対象」の選択肢ラベルを変える。**選択肢の数と意味は変えない。**

| 変更前 | 変更後 |
|---|---|
| `runners.json` のみ | `the runner registry (models and efforts included)` |

model / effort は `runners.json` の中身なので、対象を増やすと「`runners.json` と
モデル設定の違いは何か」という無意味な区別を利用者に強いる。ラベル改名だけで
発見可能性を補う。

#### 2.3 S3 — `runners.json`（対象に含まれるときだけ）

ファイルが存在するときの選択肢を 3 択から 4 択にする。

| # | 選択肢 | 動作 |
|---|---|---|
| 1 | 追加 | 既存どおり First-run setup の対話で 1 件足す |
| 2 | **登録済み runner の model と effort を編集** | **新規。S3-M へ** |
| 3 | 作り直し | 既存どおりレジストリを再構築 |
| 4 | そのまま | 既存どおり何もしない |

ちょうど AskUserQuestion の 4 選択肢上限に収まる。

#### 2.4 S3-M — model / effort エディタ（新規）

S3 で選択肢 2 を選んだときだけ走る。**AskUserQuestion は計 3 コール**。

##### M1. どの runner か（1 問）

選択肢は `runners[]` のエントリ（label = `name`、description = `command (engine)`）。
登録が 5 件以上なら**先頭 4 件を出し、残りは自動 "Other" 自由入力**で受ける。これは
S5 の `design_runner` 選択と `--override` Call 1 が既に使っている逃がし方であり、
新しいパターンを発明しない。

"Other" に登録されていない名前が入力されたら、警告して同じ質問をもう一度出す。
**新規 runner を作らない**（runner の追加は S3 の選択肢 1 の担当）。

##### M2. model 3 問（1 コール）

`plan_model` / `review_model` / `exec_model` を 1 コールで聞く。

##### M3. effort 3 問（1 コール）

`plan_effort` / `review_effort` / `exec_effort` を 1 コールで聞く。

##### 役割単位ではなく次元単位にした理由

`--override`（Step 1g-2）は「どの役割か」を先に聞いてから役割ごとに 1 コールを出す
（最大 5 コール）。ここでは採らない。

- `--override` はタスクごとに engine が変わりうるので役割単位が自然だが、`--setup`
  では**編集対象の runner が 1 つに固定**されており、6 フィールドすべてが同じ engine
  で解釈される。役割ごとに分ける理由がない。
- 各問の第 1 選択肢が常に「変更しない」なので、「この役割は触らない」は選択肢 1 で
  表現できる。役割選択の前置き質問は情報を増やさない。
- 結果として M1 + M2 + M3 の **3 コール固定**になり、`--override` より 2 コール少ない。

##### 選択肢の組み立て

各問の**第 1 選択肢は常に「変更しない」**で、現在値（未設定なら既定値）を併記する。
**第 4 枠は、現在値が設定済みのときだけ「既定に戻す（フィールド削除）」**に充てる。
未設定のときはその枠を候補値に回す。

| engine | フィールド | 現在値 | opt1 | opt2 | opt3 | opt4 |
|---|---|---|---|---|---|---|
| claude | `<role>_model` | 設定済 | 変更しない (`<v>`) | `opus[1m]` | `sonnet` | 既定に戻す (`<d>`) |
| claude | `<role>_model` | 未設定 | 変更しない (既定 `<d>`) | `opus[1m]` | `sonnet` | `fable` |
| codex | `<role>_model` | 設定済 | 変更しない (`<v>`) | 候補 1 | 候補 2 | 既定に戻す (codex 側デフォルト) |
| codex | `<role>_model` | 未設定 | 変更しない (codex 側デフォルト) | 候補 1 | 候補 2 | 候補 3 |
| claude | plan / review effort | 設定済 | 変更しない (`<v>`) | `xhigh` | `max` | 既定に戻す (`xhigh`) |
| claude | plan / review effort | 未設定 | 変更しない (既定 `xhigh`) | `xhigh` | `max` | `high` |
| claude | exec effort | 設定済 | 変更しない (`<v>`) | `high` | `xhigh` | 既定に戻す (`high`) |
| claude | exec effort | 未設定 | 変更しない (既定 `high`) | `high` | `xhigh` | `max` |
| codex | plan / review effort | 設定済 | 変更しない (`<v>`) | `xhigh` | `high` | 既定に戻す (`xhigh`) |
| codex | plan / review effort | 未設定 | 変更しない (既定 `xhigh`) | `xhigh` | `high` | `medium` |
| codex | exec effort | 設定済 | 変更しない (`<v>`) | `high` | `xhigh` | 既定に戻す (`high`) |
| codex | exec effort | 未設定 | 変更しない (既定 `high`) | `high` | `xhigh` | `medium` |

**codex の行に `max` は 1 つも現れない。**

**codex model の「候補」**は、`runners.json` 全体に出現する codex model 文字列
（全 runner の `plan_model` / `review_model` / `exec_model` のうち `engine: codex` の
レコードに属するもの）を重複除去したリスト。空のときは First-run setup の先例
（"for codex offer free text (e.g. `gpt-5.6-sol`)"）に従い `gpt-5.6-sol` を 1 件だけ
出す。AskUserQuestion は最低 2 選択肢を要求するので、この 1 件で下限を満たす。
**ダミーの選択肢は置かない。**

枠から溢れた値（claude の `fable`、`low` / `medium`、codex の `minimal` など）は
自動 "Other" 自由入力から到達できる。

##### 自由入力の扱い

- **effort の "Other"** — engine 別 allowlist と照合する。範囲外なら警告して
  **その 1 問だけ**を再質問する（1 回まで）。2 回目も範囲外ならそのフィールドは
  変更せず、警告を S6 のプレビューへ持ち越す。`--setup` は永続化するので、
  `--override` のように黙って既定へフォールバックすると「入力した値と違う値が
  保存される」ことになり、あとから気づけない。
- **model の "Other"** — 検証しない。そのまま採用する。
- **空文字** — どちらの次元でも「変更しない」として扱う。

#### 2.5 S6 — プレビューと確認

プレビューが 2 ファイル分になる。

- `config.json` の before / after（既存どおり）
- `runners.json` は**編集対象の runner レコードだけ**の before / after。ファイル全体を
  出すと登録数に比例して長くなり、差分が埋もれる。

S3-M で持ち越した警告があればここに列挙する。確認は従来どおり「書き込む / 中止」の
1 問。中止は何も書かない。

#### 2.6 S7 — 書き込み

```
1. runners-edit.sh を最大 1 回（全 --set / --unset を 1 コールに載せる）
2. config-edit.sh  を最大 1 回（全 --set / --unset を 1 コールに載せる）
3. 双方を --show で表示する
```

**この順序**にする。役割キー（`design_runner` など）は runner を名前で参照するので、
config を書く時点でレジストリ側が確定している方が読み手にとって自然である。ここでは
runner の追加も削除もしないので順序が結果を変えることはないが、順序を決めておくこと
自体に価値がある。

**2 ファイルは 1 トランザクションではない**ことを明記する。各呼び出しは個別に原子的
だが、両者をまたぐ原子性は無い。`runners-edit.sh` が失敗したら `config-edit.sh` を
実行せず、残りのコマンドを提示して停止する。逆順の失敗（runners は成功、config が
失敗）では、成功した分を報告したうえで失敗を伝える。

---

### 3. ドキュメント同期

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールと、`setup-mode.md` /
`setup-mode-ja.md` のミラー規則の両方に従う。

| ファイル | 変更 |
|---|---|
| `references/setup-mode.md` | S1 / S2 / S3 / S6 / S7 の改訂、`### S3-M` の新設。`## All writes go through config-edit.sh` を `## All writes go through the edit scripts` へ改題し、`runners-edit.sh` の契約を併記 |
| `references/setup-mode-ja.md` | 同一構造の日本語版。**見出し数を英語版と一致させる** |
| `SKILL.md` | `## Setup Mode` の委譲節に「役割別 model / effort も設定できる」旨を 1 文追加。「Both modes write exclusively through `scripts/config-edit.sh`」を `config-edit.sh` と `runners-edit.sh` の 2 つへ |
| `references/guide-ja.md` | 上記 SKILL.md 変更の 1:1 訳 |
| `README.md` | `### 設定（--setup）` に model / effort 設定を追記 |
| `apps/cmux-team-dispatch-task/CLAUDE.md` | ファイル構成表に `runners-edit.sh` を追加。保守手順 28 に runners-edit の契約と新テスト名を追加 |

**言語規則**: `SKILL.md` と `references/` 配下の `*-ja.md` でないファイルには日本語を
1 文字も書かない。`README.md` / `CLAUDE.md` / `*-ja.md` は日本語。
`node scripts/check-doc-lang.mjs` が硬いゲートとして効く。

**既存テストが grep する文字列を壊さない**:

- `test-setup-skill.sh` SU5 は `setup-mode.md` の平坦化テキストから
  `Never hand-assemble a jq invocation` / `merges instead of replacing` /
  `writer-specific` / `mktemp "$CONFIG.XXXXXX"` / `only when jq succeeded` /
  `single atomic move` / `shell_ready_ms` を探す。**すべて温存する。**
- SU1 は `SKILL.md` に `scripts/config-edit.sh` があることを求める。**温存する。**
- SU8 は `setup-mode.md` と `setup-mode-ja.md` の H1-H3 見出し数の一致を求める。
  `S3-M` を両方へ足す。

---

### 4. テスト

#### 4.1 新規 `test/test-runners-edit.sh`（動的ユニットテスト）

`test-config-edit.sh` と同型。実際に一時ディレクトリへ `runners.json` を作り、
スクリプトを実行して結果を検証する。

| id | 不変条件 |
|---|---|
| RE1 | `--set` が指定 runner のフィールドだけを更新し、他 runner と `default` を変えない |
| RE2 | allowlist 外のフィールド名（`engine` / `name` / `default` / 綴り違い）は exit 2 |
| RE3 | engine 別 effort allowlist。claude runner に `minimal`、**codex runner に `max`** はどちらも exit 2 |
| RE4 | model 文字列は検証されず、任意の文字列が通る |
| RE5 | `--unset` が該当フィールドだけを削除し、同レコードの他フィールドを残す |
| RE6 | 未知の `--name` は exit 2 かつファイル無変更 |
| RE7 | 複数の `--set` / `--unset` が 1 回の呼び出しでまとめて反映される |
| RE8 | 壊れた JSON では exit 1 かつ元ファイルを破壊しない |
| RE9 | 書き込み後に `runners.json.XXXXXX` の残骸が残らない |
| RE10 | `--get` / `--show` は非破壊。未設定フィールドは空文字で exit 0 |
| RE11 | モードの同時指定（`--set` と `--show` など）は exit 2 |
| RE12 | 編集対象レコード内の allowlist 外フィールドが生存する（置換ではなくマージ） |
| RE13 | `--runners` が存在しないファイルを指すと exit 2（レジストリを新規作成しない） |

#### 4.2 `test/test-setup-skill.sh` の拡張（SU10〜SU14）

既存の SU1〜SU9 は変更しない。ドキュメント回帰として追加する。

| id | 不変条件 |
|---|---|
| SU10 | `setup-mode.md` が S3 の 4 択と `S3-M` を、6 フィールド名すべてとともに記載している |
| SU11 | `setup-mode.md` が `runners-edit.sh` と、その原子的書き込み契約を記載している |
| SU12 | `setup-mode.md` / `setup-mode-ja.md` の codex effort 選択肢に `max` が現れない |
| SU13 | `SKILL.md` と `references/guide-ja.md` の両方が `runners-edit.sh` に言及している |
| SU14 | `runners-edit.sh` が存在し実行可能で、引数なしで usage を出して exit 2 |

**SU12 は否定アサーションなので、grep の前に対象ファイルの存在を確認する。**
存在しないファイルへの grep は 0 件ヒットになり、テストが黙って通ってしまう。
既存の SU4 も同じ形の否定アサーションだが、ファイル存在はスクリプト冒頭の
必須ファイルチェックで担保されている。SU12 も同じ担保の内側に置く。

#### 4.3 テストに関する注意

- 追加する 2 つのテストは **`prewarm-panes.sh` を一切呼ばない**。したがって
  「テストは worktree ディレクトリを `mkdir -p` してから `prewarm-panes.sh` を
  呼ぶこと」というリポジトリの規約に抵触する箇所は生じない。実装時にうっかり
  `prewarm-panes.sh` を呼ぶテストを足さないこと。
- シェルスクリプトは **bash 3.2 互換**（macOS 既定）。`set -u` 下で空になりうる配列を
  展開するときは `${arr[@]+"${arr[@]}"}` を使う。`config-edit.sh` の
  `JQ_ARGS` がまさにこの形。連想配列（bash 4+）は使わない。

---

## 検証ゲート

worktree ルートから次をすべて実行し、全スイートが通ること。

```bash
cd apps/cmux-team-dispatch-task
for t in test/*.sh; do printf '%-46s ' "$t"; if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fi; done
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins/.worktrees/setup-model-effort && pnpm check
```

`check-doc-lang` が OK を出すこと。`@tanaka-yui/token-meter` の
`noNonNullAssertion` 警告 4 件は既知のノイズで失敗ではない。

テスト実行後、残骸が無いことを確認する。

```bash
git worktree list
git branch --list 'feat/pg*' 'feat/is*' 'feat/ov*'
```

## リスクと対処

| リスク | 対処 |
|---|---|
| `setup-mode.md` の改題で SU5 の grep 対象が消える | 改題するのは見出しだけ。SU5 が探す 7 つの文字列は本文にあるので、本文を消さない。テストで確認する |
| 英日の見出し数がずれて SU8 が落ちる | `S3-M` を両ファイルへ同時に足す。SU8 がそのまま検知する |
| `SKILL.md` に日本語が混入する | `pnpm check:doc-lang` が硬いゲート。`pnpm check` にも組み込み済み |
| codex に `max` が漏れる | ドキュメント側は SU12 が、スクリプト側は RE3 が検知する。**2 層で守る** |
| `runners-edit.sh` の jq 式が対象外の runner を落とす | RE1 / RE12 が検知する |
| 6 フィールドが 1 コールに収まらない | M2 / M3 の 2 コールに分割済み。各 3 問 × 4 選択肢で上限内 |
