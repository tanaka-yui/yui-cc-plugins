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

## 書き込みは全て `config-edit.sh` を通す

これらのファイルに対して jq を手で組み立ててはならない。1 回の呼び出しで全変更が単一の原子的置換として反映される。

```bash
bash <SKILL_DIR>/scripts/config-edit.sh --config <path> \
  --set design_runner=codex --set prewarm=true --unset review_mode
```

このスクリプトはキーと値を検証し、置換ではなくマージし（`terminal-wait.sh` が所有する `shell_ready_ms` が生き残る）、writer 固有の `mktemp "$CONFIG.XXXXXX"` に書き、jq が成功したときだけ mv する。exit code は 0 が成功、1 がファイルを変更しないまま失敗、2 が usage・検証エラー。`--get <key>` と `--show` は書き込まずに読む。

## S: `--setup`

### S0. Preflight

```bash
bash <SKILL_DIR>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

ロックが生きている場合は拒否して停止する。issue ループはバッチ間でこの設定を読むため、ループ中に `runners.json` を消すと確実に壊れる。

`--setup` は `--loop` / `--reset` / `--override` と排他である。複数指定されたら推測せず、競合を報告してどれを実行するか聞く。恒久化したいなら `--setup`、その回限りなら `--override` を使う。

### S1. 現状表示

役割キー 5 つについて、プロジェクト値・グローバル値・解決値の 3 列を持つ素の markdown 表を出し、続けて `runners.json` のレジストリ（name / command / engine と各 engine が使うモデル）を出す。両レイヤーに無いキーは空欄ではなく「未設定」と明示する。

ここでは box drawing の Template A/B/C を使わない。あれはタスク一覧・進捗・最終サマリー専用であり、設定一覧はそのどれでもない。

### S2. 質問コール① — 2 問

1. **書き込み先** — グローバル `~/.claude/cmux-team-dispatch-task/config.json`（既定。「常に〜」の回答が書き込むレイヤー）か、プロジェクト `<repo>/.dispatch/config.json`（このリポジトリでのみグローバルを上書きする）。
2. **対象** — 役割キーのみ / `runners.json` のみ / 両方。

プロジェクトレイヤーへの書き込みは「永続化はグローバル config のみ」という規約の唯一の例外であり、ユーザーがここで明示的に選んだ場合にだけ成立する。

### S3. `runners.json`（対象に含まれるときだけ）

ファイルが無ければ SKILL.md Step 1f の **First-run setup** をそのまま実行する。既にあれば「runner を追加 / 作り直し / 変更しない」を聞き、同じ First-run setup の対話を再利用する。

この経路では First-run setup の review 方針の質問をスキップする。`review_runner` は S4 で設定するため、2 回聞くと両者が食い違い得る。

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

### S7. 書き込み

プロジェクト宛なら先に `mkdir -p .dispatch` する。その上で全ての `--set` / `--unset` を載せた `config-edit.sh` を **1 回だけ**呼び、結果全体が単一の mv で反映されるようにする。完了後に `--show` で結果を表示する。

書き込み先がプロジェクトレイヤーだった場合は、このリポジトリではグローバルより優先されることをユーザーに伝える。

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
