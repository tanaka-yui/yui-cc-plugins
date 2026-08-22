# 明示的な設定（`--setup` / `--reset`）

`--setup` と `--reset` は設定のための唯一の機械的 entry point である。どちらもディスパッチを
行わず、worktree・workspace・pane を作らない。この文書が両モードの実行時 SoT である。

## 対象範囲

設定は次の 3 ファイルに保存する。

| ファイル | 用途 |
|---|---|
| `~/.claude/config/cmux-team-dispatch-task/config.json` | グローバルの `review_mode` と role tuple、および第三者キー。 |
| `<repo>/.dispatch/config.json` | プロジェクトの role tuple override。 |
| `~/.claude/config/cmux-team-dispatch-task/runners.json` | runner registry。 |

4 role は `design`、`design_review`、`exec`、`exec_review` である。各 role tuple は
`runner`、`model`、`effort` からなり、`review_mode` は `on` または `off` である。どちらの
モードも `.dispatch/`、worktree、branch、実行中の session を削除しない。

## フィールド単位の書き込み契約

すべての `config.json` のフィールド単位変更には `config-edit.sh` を使う。jq command を手で
組み立てない。この script は値を検証し、`shell_ready_ms` のような未知キーを保持し、writer 固有の
`mktemp "$CONFIG.XXXXXX"` と `mv` により 1 回の原子的な置換を行う。`runners.json` の新規作成と
作り直しは `SKILL.md` の First-run setup が担当する。

## entry point ごとの書き込み契約

初期 config を書くのは通常 First-run だけであり、初回ディスパッチと `--reset all` の 2 経路に
限られる。英語版と同じ行を持たせるため、表には安定した id を使う。

<!-- entry-contract:start -->
| Entry | `config.json` の効果 | registry の効果 |
|---|---|---|
| `first-run` | registry 後に global の初期 config を作る（`create-initial`）。 | registry を作る。 |
| `setup-config` | 選んだ layer へ `config-edit.sh` をちょうど 1 回呼ぶ（`one-config-edit`）。 | 書かない。 |
| `reset-config-global` | global の所有 2 キーだけを unset する（`unset-two-keys`）。 | 書かない。 |
| `reset-config-project` | project の所有 2 キーだけを unset する（`unset-two-keys`）。 | 書かない。 |
| `reset-runners` | どちらの設定レイヤーも書かない（`no-config-write`）。 | reset mode First-run で作り直すだけ。 |
| `reset-all` | 両方の設定レイヤーを unset して初期 config を作る（`unset-both-then-create-initial`）。 | 削除後に registry を再作成する。 |
<!-- entry-contract:end -->

`--reset all` にレイヤー選択は無く、両方の設定レイヤーを消す。reset は第三者キーを保持する。
初期 config は全 4 role に registry default runner を入れ、必要な Codex review model を集めた場合を
除いて model と effort を省略し、`review_mode` は 1 回だけ尋ねる。

## S: `--setup`

### S0. Preflight

issue-loop の lock check を実行する。`--setup` は `--loop`、`--reset`、`--override` と排他であり、
推測せず競合を報告する。

```bash
bash <SKILL_DIR>/scripts/issue-fetch.sh --state-file .dispatch-loop/loop-state.json lock-check
```

### S1. 現在の状態を表示する

両 config layer、解決済み 4 role tuple、`review_mode`、registry を表示する。無い field は unset と
表示するだけであり、この段階で書き込まない。

### S2. 書き込み先を選ぶ

次の 3 択を 1 問で尋ねる。

1. グローバル config.json。
2. プロジェクト config.json。
3. `runners.json`。

`config.json` を選んだ場合の最初の role 質問は、`review_mode` と編集する role である。role は
`design`、`design_review`、`exec`、`exec_review` の**複数選択**とし、選んだ config layer だけを
書き込む。

### S3. `runners.json`

registry を選んだときだけ、runner を追加する／registry を作り直す／そのまま、の 3 択を尋ねる。
追加または作り直しは **registry-only setup flow** を使い、その registry preview へ進む。normal
First-run を呼ばず、初期 `config.json` も書かない。`--setup` に registry の model / effort を編集する
経路はない。

### S4. 選ばれた role ごとに 1 tuple を尋ねる

選んだ role ごとに runner / model / effort の 3 問を 1 call で尋ねる。runner の選択肢は登録済み
`runners[].name` である。runner が **5 件以上**なら先頭 4 件を表示し、残りは自動の **Other** 入力で
受ける。

### S5. pending tuple の検証

回答は **pending tuple** として保持し、すぐに書き込まない。pending runner から engine を決め、
runner、model、effort の 3 次元すべてをその engine で再検証する。unknown runner、invalid model、
invalid effort は不正である。

不正な次元だけを re-ask する。second 回目も不正なら、その role の pending tuple 全体を unchanged に
する。部分適用してはならない。pending tuple の再質問中も `config.json remains unchanged` であり、
全 pending 変更が有効または破棄されるまで書き込まない。

**コマンドを組み立てる前に**自由入力の runner / model / effort を検証する。空、前後空白、制御文字、
`'`、`"`、`` ` ``、`$`、`\`、`!` を拒否し、該当する次元だけ再質問する。入力を trim したり shell
展開したりしてはならない。

### S6. Preview と確認

選んだ 1 ファイルだけを preview する。対象は選んだ `config.json` layer または `runners.json` である。
before/after を表示して write または abort を尋ねる。abort は何も書かない。

### S7. Write

config destination の場合は次の書き込みを行う。プロジェクト宛なら先に `mkdir -p .dispatch` する。
次に全ての受理済み `--set` と `--unset` を含む `config-edit.sh` をちょうど 1 回呼び、結果全体が単一の
mv で反映されるようにする。`--show` で結果を表示する。project layer を選んだ場合は、このリポジトリではグローバルより優先されることをユーザーに伝える。

registry destination の場合は、S3 の registry-only setup flow で registry を追加または作り直し、その
1 ファイルだけを表示する。normal First-run を呼ばず、`config-edit.sh` も呼ばない。`config.json` は
unchanged のままである。cross-file の書き込み順序規約は無い。

## R: `--reset`

### R0. Preflight

S0 と同じ lock check と排他規則を適用する。

### R1. 対象を決める

`--reset runners`、`--reset config`、`--reset all` を受け付ける。引数が無ければ尋ねる。レイヤーを
尋ねるのは `--reset config` だけで、global / project / both から選ぶ。`--reset all` は尋ねない。

### R2. 実行する

- **`runners`**: `runners.json` だけを削除し、reset mode First-run を実行する。registry だけを再作成し、
  2 つの `config.json` は byte-for-byte で変えない。
- **`config`**: 選ばれた既存 layer ごとに次の 1 call を実行する。

  ```bash
  bash <SKILL_DIR>/scripts/config-edit.sh --config <path> \
    --unset review_mode --unset runner
  ```

  これにより他の全キーを保持し、無い config を新規作成しない。
- **`all`**: 両方の既存 layer にこの 2-key unset call を行い、`runners.json` を削除してから通常モードの
  First-run を行う。registry と global の初期 config を再作成する。

### R3. 続けるか確認する

結果を報告し、S1 から `--setup` を続けるか尋ねる。
