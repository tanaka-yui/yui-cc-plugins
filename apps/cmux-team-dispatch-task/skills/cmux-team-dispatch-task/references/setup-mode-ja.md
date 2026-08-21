# 設定の明示操作（`--setup` / `--reset`）

`--setup` と `--reset` が唯一の機械的 entry point である。どちらもディスパッチを行わず、worktree・workspace・ペインを一切作らない。ここが両モードの実行時 SoT である。

これらが無い場合、役割キーは実際のディスパッチ中に「常に〜」と答えた副作用としてしか永続化されない。設定を見直す／消すだけのためにダミータスクを投げる必要があった。

## 対象範囲

対象は次の 2 系統のファイルだけである。

| ファイル | 保持するもの |
|---|---|
| `~/.claude/cmux-team-dispatch-task/config.json`（グローバル） | 役割キーと、他コンポーネントが所有するキー |
| `<repo>/.dispatch/config.json`（プロジェクト。グローバルより優先） | 役割キー |
| `~/.claude/cmux-team-dispatch-task/runners.json` | runner レジストリ |

役割キーはこの 5 つで全部である。

| キー | 値 |
|---|---|
| `design_runner` | `runners[].name` または `"ask"` |
| `review_runner` | `runners[].name` または `"ask"` |
| `exec_choice` | `"claude"` / `"codex"` / `"ask"` |
| `review_mode` | `"on"` / `"off"` / `"ask"` |
| `prewarm` | `true` / `false` |

どちらのモードも `.dispatch/<task-slug>/`・worktree・`feat/*` ブランチ・稼働中のセッションには一切触れない。それらの削除は SKILL.md のディスパッチ末尾の Cleanup prompts の担当である。

## 三値セマンティクス

各役割キーには区別すべき 3 状態があり、`--setup` はその全てを作れる。まとめてしまわないこと。

- **固定値** — 対応する質問が全ディスパッチで完全に省略される
- **`"ask"`** — 質問は出るが、永続化の選択肢は表示されない
- **キー削除** — 質問が永続化の選択肢付きで出る

`review_mode` だけは実行時に `"ask"` とキー削除の挙動が同じである。このキーは「毎回質問に戻す」を提示し、`"ask"` を保存せずキーを削除する。

## フィールド単位の書き込みは全て edit スクリプトを通す

これらのファイルに対して jq を手で組み立ててはならない。1 回の呼び出しで全変更が単一の原子的置換として反映される。

```bash
bash <SKILL_DIR>/scripts/config-edit.sh --config <path> \
  --set design_runner=codex --set prewarm=true --unset review_mode
```

このスクリプトはキーと値を検証し、置換ではなくマージし（`terminal-wait.sh` が所有する `shell_ready_ms` が生き残る）、writer 固有の `mktemp "$CONFIG.XXXXXX"` に書き、jq が成功したときだけ mv する。exit code は 0 が成功、1 がファイルを変更しないまま失敗、2 が usage・検証エラー。`--get <key>` と `--show` は書き込まずに読む。

2 つの edit スクリプトが担うのは**フィールド単位**の更新だけである。`runners.json` を新規作成することと作り直すことは First-run setup（SKILL.md Step 1f）の担当のままで、ファイルは First-run setup 自身が書く。`runners-edit.sh` は既存レジストリを編集するだけで、**ファイル不在なら exit 2** になる。

`runners-edit.sh` は `runners.json` に対して同じ形を踏む。runner レコード単位で:

```bash
bash <SKILL_DIR>/scripts/runners-edit.sh --runners <path> --name 'ccenec' \
  --set 'plan_model=opus[1m]' --unset exec_model
```

`runners-edit.sh` は `--runners` と `--name` を取り、続けて `--set` / `--unset`（`--dry-run` 併用可）、`--get`、`--show` のいずれか 1 つを取る。
このスクリプトは役割別の model / effort 6 フィールドを検証し、置換ではなくマージし（`name` / `command` / `engine`、他の runner、関係の無いフィールドはすべて生き残る）、writer 固有の `mktemp "$RUNNERS.XXXXXX"` に書き、jq が成功したときだけ mv する。exit code の意味は `config-edit.sh` と同じ: 0 が成功、1 がファイルを変更しないまま失敗、2 が usage・検証エラー。`--get <field>` と `--show` は書き込まずに読む。

書き込みは last-write-wins で、symlink は通常ファイルに置き換わり、temp の mode が結果に残る。

## S: `--setup`

### S0. Preflight

```bash
bash <SKILL_DIR>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

ロックが生きている場合は拒否して停止する。issue ループはバッチ間でこの設定を読むため、ループ中に `runners.json` を消すと確実に壊れる。

`--setup` は `--loop` / `--reset` / `--override` と排他である。複数指定されたら推測せず、競合を報告してどれを実行するか聞く。恒久化したいなら `--setup`、その回限りなら `--override` を使う。

### S1. 現状表示

役割キー 5 つについて、プロジェクト値・グローバル値・解決値の 3 列を持つ素の markdown 表を出す。両レイヤーに無いキーは空欄ではなく「未設定」と明示する。

ここでは box drawing の Template A/B/C を使わない。あれはタスク一覧・進捗・最終サマリー専用であり、設定一覧はそのどれでもない。

続けて `runners.json` のレジストリを `runners-edit.sh --runners <path> --show`（ファイル全体）から作り、runner ごとに**転置形**で出す。見出し 1 行 + 表 5 行（ヘッダ・区切り・役割 3 行）= 1 runner あたり 6 行。

```
runner: ccenec (command: ccenec, engine: claude)

| role   | model              | effort          |
|--------|--------------------|-----------------|
| plan   | opus[1m]           | max             |
| review | default (opus[1m]) | default (xhigh) |
| exec   | fable              | default (high)  |
```

未設定のフィールドは空欄ではなく**実効値**を見せる: `既定（<値>）`。ただし codex model は実効既定値が無いので 2 つの例外がある:

- codex runner の `plan_model` / `exec_model` が未設定 → `未設定（codex 側デフォルト）`
- codex runner の `review_model` が未設定 → `未設定（レビュアーに選べません）` — codex reviewer は `review_model` が必須なので、これは「既定へフォールバックする」ではなく「今このレビュアーには選べない」ことを意味する

これは上の役割キー 5 つの見せ方とはあえて違える。役割キーは三値（固定値 / `"ask"` / 未設定）なので状態そのものを見せる必要があり「未設定」と書くが、runner フィールドは二値（設定済み / 未設定）で必ず実効値が決まるので、値を見せる方が有用である。

`engine` が `claude` / `codex` のどちらでもない runner（欠落、または `gemini` など）には実効既定値も codex 例外も適用できない。model / effort の全セルを `-` にし、engine 欄に `engine 不明 — ここでは編集できません` と添える。

登録が 5 件を超えるときは、転置形を出すのを**優先集合**（`default` が指す runner、`design_runner` / `review_runner` が解決する runner、`exec_choice` の engine から Step 1f が解決する exec runner）だけに絞る。`exec_choice` は runner 名ではなく engine 選択（`"claude"` / `"codex"` / `"ask"`）なので、`runners[].name` へ直接引くと現在の exec runner が静かに落ちる。優先集合が空（`default` が不正で役割キーが全部 `"ask"` / 未設定 / 不正）なら登録順の先頭 5 件を使う。残りは 1 行要約にする（値はすべて実効値。未設定の codex model は `-`）:

`- <name> (<engine>): models <plan>/<review>/<exec>, efforts <plan>/<review>/<exec>`

この 5 件という閾値は**表示上の**閾値であり、後述の M1 の「5 件以上なら先頭 4 件を提示する」という選択閾値とは無関係である。6 runner で既に 36 行になり実用に耐えない。

見出し行・表ヘッダ（`| role | model | effort |`）・1 行要約の `models` / `efforts` / `-` は識別子なので、英日どちらの doc でも ASCII のままにする。訳すのは `既定（<値>）` のような状態ラベルだけ。

### S2. 質問コール① — 2 問

1. **書き込み先** — グローバル `~/.claude/cmux-team-dispatch-task/config.json`（既定。「常に〜」の回答が書き込むレイヤー）か、プロジェクト `<repo>/.dispatch/config.json`（このリポジトリでのみグローバルを上書きする）。
2. **対象**:

   | # | ラベル | description |
   |---|---|---|
   | 1 | `役割キーのみ` | 役割別の model / effort はレジストリ側にあります。2 か 3 を選ぶと到達できます |
   | 2 | `runners.json（役割別 model / effort を含む）` | — |
   | 3 | `両方 — 役割キーとレジストリ（役割別 model / effort を含む）` | — |

プロジェクトレイヤーへの書き込みは「永続化はグローバル config のみ」という規約の唯一の例外であり、ユーザーがここで明示的に選んだ場合にだけ成立する。

### S3. `runners.json`（対象に含まれるときだけ）

ファイルが無ければ SKILL.md Step 1f の **First-run setup** をそのまま実行し、そのまま S4 へ進む — S3-M はこの経路では出さない。既にあれば次を聞く:

| # | ラベル |
|---|---|
| 1 | `runner を追加` |
| 2 | `登録済み runner の model / effort を編集` |
| 3 | `レジストリを作り直す` |
| 4 | `そのまま` |

選択肢 1 / 3 は従来どおり First-run setup の対話を再利用し、そのまま S4 へ進む — 追加・作り直しの直後も S3-M は出さない。続けて編集したい場合は `--setup` を再実行する。選択肢 2 は下の **S3-M** へ進む。選択肢 4 はそのまま S4 へ進む。

この経路では First-run setup の review 方針の質問をスキップする。`review_runner` は S4 で設定するため、2 回聞くと両者が食い違い得る。

**S3-M へ到達しない経路:**

- S2 の質問②で選択肢 1（役割キーのみ）を選んだ — S3 自体が走らない。
- ファイル不在 — 上記の First-run setup が走る。
- `runners-edit.sh --show` が非 0 で返る（レジストリ破損） — S1 が `runners[]` を列挙できていないので、選択肢 2 を出さず選択肢 3（作り直し）へ誘導する。
- 選択肢 1（追加）/ 3（作り直し）の後 — 上記のとおりそのまま S4 へ。
- `runners[]` が空配列、または下の M1 の除外後に選択可能な runner が 0 件 — 選択肢 2 自体を出さない（M1 の選択肢が 0 件になり AskUserQuestion の最低 2 選択肢を満たせないため）。
- 選択可能な runner が「ちょうど 1 件」— 選択肢 2 は出すが、M1 は出さずその 1 件を黙って採用して M2 へ進む。runner 1 件は最も普通の構成であり、リポジトリにも先例がある（`CLAUDE.md` 保守項目 37「runner 数分岐（1 件は黙って採用・質問なし）」）。
- `engine` が `claude` / `codex` でない runner、または `'` を含む名前の runner は、警告付きで M1 の選択肢から除外する。
- 1 回の `--setup` で編集できる runner は 1 件。2 件目は `--setup` を再実行する。

### S3-M. runner の model / effort を編集する

S3 の選択肢 2 を選んだときだけ走る。happy path は **AskUserQuestion 3 コール**（下の再質問経路 3 本により最悪 +3 = 6 コール）。

下位見出しは `####` を使う（本文より 1 段深い）。英日で `setup-mode.md` / `setup-mode-ja.md` の見出しレベル・個数・順序を一致させるため。

#### M1. どの runner か

選択肢は `runners[]` のエントリ（label = `name`、description = `command (engine)`）。5 件以上登録されている場合は先頭 4 件を提示し、残りは自動 "Other" 自由入力で受ける — `design_runner` に S5 が使うのと同じ規約。

"Other" に未登録の名前が入力されたら、警告して**もう一度だけ**同じ質問を出す。2 回目も未登録なら S3-M を中止して S4 へ進む（無限ループにしない）。S3-M は新規 runner を作らない — 追加は S3 の選択肢 1 の担当。

`'` を含む runner 名は選択肢から除外し、除外を報告する。

#### M2. model 3 問（1 コール）

`plan_model` / `review_model` / `exec_model` を 1 コールで聞く。

#### M3. effort 3 問（1 コール）

`plan_effort` / `review_effort` / `exec_effort` を 1 コールで聞く。

#### 役割単位ではなく次元単位にした理由

`--override`（Step 1g-2）は「どの役割か」を先に聞いてから役割ごとに 1 コールを出すが、S3-M はこの形を採らない。

- `--override` はタスクごとに engine が変わりうるので役割単位が自然だが、S3-M では編集対象の runner が呼び出し全体で固定されており、6 フィールドすべてが同じ engine で解釈される。役割ごとに分ける理由がない。
- 各問の第 1 選択肢が常に「変更なし」なので、「この役割は触らない」は選択肢 1 で表現できる。役割選択の前置き質問は情報を増やさない。
- 結果として **3 コール**（M1 + M2 + M3）になる。`--override` を 1 タスク・全 3 ロールに適用すると 5 コール（Call 1 + Call 2 + Call 3×3）なので、同条件で 2 コール少ない。

#### 選択肢の組み立て

**静的な選択肢表は作らない。** 既定値を明示的に書くこととフィールドを削除することが実効同値になる組み合わせが多く（S1 の二値の注記を参照。runner フィールドは必ず実効値へ解決される）、表に固定すると 4 枠のうち 1〜2 枠が常に死ぬ。First-run setup の effort 選択肢（SKILL.md Step 1f の「plan_effort / review_effort / exec_effort」）も重複なしで組んでいる。

各問は次の規則で組み立てる。

1. **opt1 = 変更なし。**

   | 状態 | ラベル |
   |---|---|
   | 設定済み | `変更なし（現在: <現在値>）` |
   | 未設定・実効既定値あり | `変更なし（既定: <d>）` |
   | 未設定・codex `plan_model` / `exec_model` | `変更なし（未設定 — codex 側デフォルト）` |
   | 未設定・codex `review_model` | `変更なし（未設定 — レビュアーに選べません）` |

2. **opt2 以降 = 候補プールから順に埋める。** プールから**現在値**と**実効既定値**を除外したうえで、先頭から順に取る。
3. **最終枠。規則 2 より優先して確保する。** 先に規則 2 で 4 枠を埋めてしまうと、フィールドを未設定へ戻す唯一の経路が消える（空文字の "Other" は「変更なし」扱いなので代替にならない）。

   | 条件 | ラベル |
   |---|---|
   | 設定済み かつ 実効既定値が存在し、それと異なる | `既定に戻す（<d>）` |
   | 設定済み かつ codex `plan_model` / `exec_model` | `未設定に戻す（codex 側デフォルト）` |
   | 設定済み かつ codex `review_model` | `未設定に戻す（レビュアーに選べません）` — description: `この runner はレビュアーに選べなくなります` |
   | 設定済み かつ 実効既定値と一致（claude model / 両 engine の effort） | 出さない（opt1 と実効同値になるため） |
   | 未設定 | 出さない |

4. 4 枠に収まらない候補は自動 "Other" 自由入力から到達できる。**ダミーの選択肢は置かない。**

**選択肢は必ず 2 つ以上になる。** 規則 2 の除外は高々 2 件（現在値と実効既定値が一致すれば 1 件）なので、最小のプールである claude `*_model`（3 件）でも最低 1 件は残る。設定済みなら規則 3 がさらに 1 枠を足す。codex model は候補導出 step 3 の `gpt-5.6-sol` 補充が下限を保証する。

**候補プール**（engine 別、この順序）:

| target | pool |
|---|---|
| claude `*_model` | `opus[1m]` / `sonnet` / `fable` |
| codex `*_model` | see the codex candidate derivation below |
| claude `*_effort` | `max` / `xhigh` / `high` / `medium` / `low` |
| codex `*_effort` | `xhigh` / `high` / `medium` / `low` / `minimal` |

**`max` は claude のプールにしか無い。** codex 側のどの経路（プール / 既定 / "Other" の受理）にも現れない。

例（claude runner、`plan_effort` 未設定、実効既定 `xhigh`）:
`変更なし（既定: xhigh）` / `max` / `high` / `medium`（`xhigh` は既定なので除外、`low` は枠外で "Other" 送り）。

例（claude runner、`plan_effort: "max"`。実効既定 `xhigh` と異なる）:
`変更なし（現在: max）` / `high` / `medium` / `既定に戻す（xhigh）`（`max` は現在値、`xhigh` は実効既定なのでプールから除外。規則 3 が最終枠を先に確保するので候補は 2 件で止まる）。

例（claude runner、`plan_effort: "xhigh"`。実効既定と一致）:
`変更なし（現在: xhigh）` / `max` / `high` / `medium`（規則 3 は最終枠を出さない。`low` は "Other" 送り）。

例（codex runner、`review_model: "gpt-5.6-sol"`、レジストリ中の codex model がこれ 1 種類だけ）:
`変更なし（現在: gpt-5.6-sol）` / `未設定に戻す（レビュアーに選べません）`（候補プールは空。床の 2 択は規則 3 が支える）。

#### codex model 候補の導出

`runners.json` 全体に出現する codex model 文字列（`engine: codex` のレコードに属する `plan_model` / `review_model` / `exec_model` の値）を集め、次の順序で確定する。

1. **編集中の当該フィールドの現在値を除外**する（除外しないと opt1 と重複する）。
2. 重複除去し、`runners[]` の**登録順**（同一 runner 内では `plan_model` → `review_model` → `exec_model` の順）に並べる。
3. 枠が余ったら First-run setup の先例に従い `gpt-5.6-sol` を 1 件だけ補充する。**補充するのは `gpt-5.6-sol` が step 2 のプールにも「現在値」にも一致しないときだけ**（現在値が `gpt-5.6-sol` のとき step 1 が除去した直後に補充し直すと opt1 と重複する。all-Codex の正典例 `gpt-5.6-sol` / `gpt-5.6-sol` / `gpt-5.6-terra` でまさに起きる）。
4. それでも枠が余ったら**枠を減らす**。ダミーは置かない。床（opt1 + 1 件）を実際に支えているのは step 3 の `gpt-5.6-sol` 補充である。`engine: codex` の runner はいるがどの codex runner も 3 つの model を 1 つも設定していない状態（First-run setup で全部空欄にした直後）では、step 1 が何も除去しなくても step 2 のプールは空になるため。

#### codex review_model を unset するときの警告

codex reviewer は `review_model` が必須で、未設定のまま reviewer に選ばれると `prewarm-panes.sh` が `die "codex reviewer runner '<name>' requires review_model"` で**起動時に落ち、ディスパッチそのものが失敗する**。`--setup` の数日後に踏むと原因に辿り着く手がかりが無い。3 段で防ぐ。

- **(a) S1** — `未設定（レビュアーに選べません）` と表示する（上記）。
- **(b) M2** — 規則 3 の `未設定に戻す（レビュアーに選べません）` 選択肢の description に `この runner はレビュアーに選べなくなります` と書く。
- **(c) S6** — unset した結果その runner が現在の `review_runner`（project / global のどちらか）だった場合は、S6 の警告リストに次の 1 行を載せる:
  `<runner> の review_model を削除します。現在の review_runner なので、次回のディスパッチは起動に失敗します`

#### 自由入力の扱い

| 場面 | メッセージ |
|---|---|
| M1 "Other" が未登録名 | `<name> という runner は登録されていません。一覧から選んでください` |
| M1 が `'` を含む名前を除外 | `runner <name> は名前に ' を含むためここでは編集できません。runners.json を手で編集してください` |
| M1 が engine 不明の runner を除外 | `runner <name> は engine が不明なためここでは編集できません` |
| effort "Other" が範囲外 | `<value> は <engine> engine の effort として不正です` |
| model "Other" が拒否条件に触れた | `<value> はモデル名に使えません（空・前後に空白・シェルメタ文字・制御文字のいずれか）` |
| S6 の警告リスト見出し | `警告:` |

- **effort の "Other"** — engine 別 allowlist と照合する。範囲外なら警告して**その 1 問だけ**を再質問する（1 回まで）。2 回目も範囲外ならそのフィールドは変更せず、警告を S6 のプレビューへ持ち越す。`--setup` は永続化するので、`--override` のように黙って既定へフォールバックすると「入力した値と違う値が保存される」ことになり、あとから気づけない。
- **model の "Other"** — モデル名としては検証しないが、`runners-edit.sh` の拒否条件は適用される: 空 / 空白のみ / **前後に空白を持つ値** / 5 つのシェルメタ文字（`'` `"` `` ` `` `$` `\`）/ `[[:cntrl:]]` の制御文字。**内部の空白は通る**（`opus 1m` は受理される。値は必ず引用の内側に置かれ、下の記述例も単一引用を規約化しているので引数が割れる経路は無い）。違反したら警告してその 1 問だけを再質問する（1 回まで。effort と対称）。**この事前チェックが S7 のコマンドラインを守る唯一のガードである** — `runners-edit.sh` の deny-list はシェルが解釈した後ろにあるので、そこには届かない。この拒否は S3 の選択肢 2 経由のみに適用される。選択肢 1 / 3 の First-run setup は値を検証しない。
- **空文字** — どちらの次元でも「変更なし」として扱う。

> **語彙について**: 役割キーの EN `back to unset` ↔ JA `未設定に戻す`（S4/S5、`setup-mode.md`、`README.md`、`guide-ja.md`、`SKILL.md` に一貫して出る）とは別の語彙 `既定に戻す（<d>）` を使う。役割キーは三値なので状態を見せ、runner フィールドは二値なので実効値を見せるという上の区別に基づく意図的な差である。**ただし codex `*_model` だけは実効既定値が無いので `未設定` の語形を使う**（規則 3 の例外 2 行）。

### S4. 質問コール② — 4 問

キーごとに 1 問・4 択とし、`AskUserQuestion` の「1 コール 4 問・各 4 択」の上限内に収める。各問では現在の解決値を明示する。

| 質問 | 選択肢 |
|---|---|
| `design_runner` | 固定 runner を選ぶ / `"ask"` / 未設定に戻す / 変更しない |
| `review_runner` | 固定 runner を選ぶ / `"ask"` / 未設定に戻す（legacy 自動解決）/ 変更しない |
| `exec_choice` | 固定 engine を選ぶ / `"ask"` / 未設定に戻す / 変更しない |
| `review_mode` | `on` / `off` / 毎回質問に戻す / 変更しない |

### S5. 質問コール③ — 必要な分だけ最大 4 問

- **`design_runner` の固定先** — `runners[]` の各エントリ。5 件以上登録されている場合は先頭 4 件を提示し、残りは自由入力の「Other」で受ける。
- **`review_runner` の固定先** — review 可能な runner のみ。codex runner は空でない `review_model` が必須、claude runner は `opus[1m]` へフォールバック可。review runner は design runner と engine が同じでも、runner 名が同じでも構わない。
- **`exec_choice` の固定値** — `claude` / `codex`。`codex` は `engine: codex` の runner が登録済みのときだけ、`claude` は claude runner が登録済みのときだけ提示する。
- **`prewarm`** — `true` / `false` / 未設定に戻す（既定 `true`）/ 変更しない。

### S6. プレビューと確認

対象ファイルの変更前後を並べて表示し、「書き込む / 中止」の一問だけ聞く。中止なら何も書かない。

`runners.json` を S3-M で編集する場合、プレビューは 2 ファイル分になる: 従来どおりの `config.json` の before/after に加え、`runners.json` は**編集対象の runner レコードだけ**の before/after を出す:

- **before**: `runners-edit.sh --runners <path> --name <runner> --show`
- **after**: `runners-edit.sh --runners <path> --name <runner> <同じ --set / --unset 群> --dry-run`

両方ともレコード単体を出すので、呼び出し側の jq はゼロになる。S7 に渡すのと完全に同じ `--set` / `--unset` 群を使うことが、プレビューと実書き込みの一致を担保する唯一の手段である。

S3-M で持ち越した警告（effort / model の "Other" 再入力失敗、上記の `review_model` unset のケース）があれば、プレビューの下に `警告:` の見出しで列挙する。これはユーザーへ提示するラベルであって markdown 見出しではない。見出し化すると SU8 が数える見出し数が変わる。

### S7. 書き込み

1. `runners-edit.sh` を最大 1 回、編集対象 runner の全 `--set` / `--unset` を 1 コールに載せて呼ぶ:

   ```bash
   bash <SKILL_DIR>/scripts/runners-edit.sh --runners <path> --name 'ccenec' \
     --set 'plan_model=opus[1m]' --set 'plan_effort=max' --unset exec_model
   ```

   **値は必ず単一引用する。** 上の単一引用は値そのものが `'` を含まないことを前提とする — その前提を保証するのは S3-M の "Other" 事前チェック（上記「自由入力の扱い」参照）であり、`runners-edit.sh` 自身の deny-list ではない。`--name` に渡す runner 名も同じ理由で、M1 が `'` を含む名前を除外することで守られている。
2. プロジェクト宛なら先に `mkdir -p .dispatch` する。
3. その上で全ての `--set` / `--unset` を載せた `config-edit.sh` を **1 回だけ**呼び、結果全体が単一の mv で反映されるようにする。
4. 完了後に両方を `--show` で表示する。
5. 書き込み先がプロジェクトレイヤーだった場合は、このリポジトリではグローバルより優先されることをユーザーに伝える。

レジストリを先に書く（手順 1 を手順 3 より前にする）: 役割キーは runner を名前で参照するので、config を書く時点でレジストリ側が確定している方が読み手にとって自然である。ここでは runner の追加も削除もしないので順序が結果を変えることはないが、順序を決めておくこと自体に価値がある。

**この 2 ファイルは 1 トランザクションではない。** 各呼び出しは個別に原子的だが、両者をまたぐ原子性は無い。どちら向きの失敗でも、成功した分を報告したうえで残りの完全なコマンドラインを提示して停止する:

- 手順 1 が失敗 → 手順 3 を実行せず、`config-edit.sh` の完全なコマンドラインを提示する。
- 手順 3 が失敗 → 手順 1 が成功済みである旨を伝え、`config-edit.sh` の完全なコマンドラインを提示する。

## R: `--reset`

### R0. Preflight

S0 と同一。同じロック確認と同じ排他規則を適用する。

### R1. 対象の決定

引数から取る（`--reset runners` / `--reset config` / `--reset all`）。引数が無ければ質問する（レジストリ / 役割キー / 両方）。認識できない対象はエラーであり、タスク記述として扱わない。

対象に `config` が含まれるときは、どのレイヤーを消すか（グローバル / プロジェクト / 両方）も聞く。

### R2. 実行

- **`runners`** — `RUNNERS_RESET=true` を立て、レジストリだけを削除し（`rm -f -- "$RUNNERS_JSON"`）、config 永続化の質問を全て省略する reset モードで First-run setup を実行する。両方の `config.json` は変更しない。
- **`config`** — 選択したレイヤーごとに `config-edit.sh` を 1 回呼び、役割キー 5 つだけを unset する。`shell_ready_ms` を含む他のキーは全て保持する。ファイルが無いレイヤーはスキップし、新規作成しない。

どちらの分岐でも `.dispatch/`・worktree・ブランチは削除しない。

### R3. 継続の確認

変更内容を報告し、続けて `--setup` を実行するか聞く。実行するなら preflight 済みとして S1 から続ける。
