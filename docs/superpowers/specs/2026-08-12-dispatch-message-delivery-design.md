# cmux-team-dispatch-task 配送レイヤーの設計

対象: `apps/cmux-team-dispatch-task`

## 背景

ディスパッチ中、子セッションへ送った指示が **Claude Code TUI の入力欄に残ったまま送信されない**事故が発生した。

観測された状態（`infra-struct-rollout` ワークスペースの opus ペイン）:

```
❯ code review round 1: the codex implementer finished and committe[Pasted text #1][Pasted text #2]he parent agent and stay sequential; never let two child agents edit files in this worktree at the same time. ...
```

これは Phase B-R のコードレビュー依頼文である。末尾の文言は
`parallel-directive.sh --engine claude --mode review` の出力（**899 文字**）そのもので、
依頼文全体は 1.3〜1.5KB に達する。

### 原因

`cmux send` が 1KB 超を一気に流し込む
→ Claude Code TUI がバースト入力を貼り付けと判定して `[Pasted text #N]` に畳む
（プレースホルダが 2 つ出ているのは複数バーストに割れた証拠）
→ 畳み処理のデバウンス中に直後の `cmux send-key return` が届き、submit ではなく貼り付けバッファに吸われる
→ **テキストだけ残って Enter が効かない。**

`cmux send` + `send-key return` を無遅延ペアで発行する箇所は現在 7 箇所あり、すべて同じ問題を踏む。

ユーザー報告によれば、長文では必発、短い完了通知でも稀に同じ取りこぼしが起きる。
つまり原因は **サイズ由来の貼り付け判定** と **タイミング揺らぎ** の 2 層である。

### 前提の再検証

SKILL.md は「agmsg push は idle セッションを起こせない（watcher がバックグラウンド Bash で、
プロセス終了まで出力が注入されない）」を根拠に dual-send を必須としている。

この前提は **claude 宛てに限り古い**。agmsg 1.1.13 の claude-code ドライバは delivery mode `monitor` で
**Monitor ツール（`persistent: true`）** を張る方式であり、ドライバ本体が
`monitor — Real-time push (~5s latency)` と明記している。

一方 **codex には Monitor が無い**（agmsg ドライバ内に `Codex skips the wait (no Monitor)` の明記）。
codex の monitor は app-server bridge（beta）で、本設計の執筆時点でこの環境に未インストール。

cmux-team-dispatch-task は「レビュアーは常に実装者の逆 engine」が設計の根幹なので、
claude ↔ codex の往復は必ず発生する。したがって codex 宛ての扱いを設計上分離する必要がある。

### codex bridge の実測（設計時点）

| 項目 | 結果 |
|------|------|
| codex バージョン | 0.147.0 |
| `codex app-server --listen ws://127.0.0.1:0` | 正常起動。agmsg が port 検出に使う `listening on: ws://127.0.0.1:<port>` 形式のログも一致 |
| shim の引数保存 | `codex --remote <url> <元の全引数>` を exec するため、`--dangerously-bypass-approvals-and-sandbox` も初期プロンプト positional もそのまま通る |
| cmux 起動経路との相性 | cmux は codex を `zsh -ic "..."` で起動する（`-i` が `.zshrc` を読む）ため、`.zshrc` に shim 関数を置けば dispatch の codex 起動も自動的に shim を通る |
| 未検証 | `codex-bridge.js` のスレッド探索（`thread/loaded/list`）と注入 |

agmsg 側のフォールバック文言が
`Codex app-server interface changed in 0.142+. Fix in progress` と言っており、
agmsg 自身が新しい codex での不調を認識している。壊れたときは fail-open（plain codex 起動 + stderr 警告）だが、
**dispatch の自動フローは stderr を読まないので実質サイレントに配送が止まる**。

## 目的

1. 長文の指示が入力欄に詰まって届かない事故をなくす
2. 短文通知の稀な取りこぼしをなくす
3. `message_type` の `send-message` / `agmsg` 二択を廃止し、agmsg 前提に一本化する

## 設計

### 1. 配送レイヤー `send-prompt.sh`

現在タイプ入力による配送は 7 箇所に散っている:

| # | 場所 | 内容 |
|---|------|------|
| 1 | `launch-workspace.sh` `notify_parent()` | 親への完了通知 |
| 2 | `launch-workspace.sh` `notify_reviewer_once()` | abort 通知 |
| 3 | `launch-workspace.sh` `REVIEW_INSTRUCTION` / `ABORT_*_STEP` | spawn 経路の埋め込みプロンプト |
| 4 | `monitor-dispatch.sh` `send_to_parent()` | heartbeat / 完了 / DIED |
| 5 | `SKILL.md` L804 / L1425 | Phase B 実行指示（sonnet / codex standby） |
| 6 | `SKILL.md` L1071 / L1202 | Phase A-R / B-R レビュー依頼 |
| 7 | `SKILL.md` L1739 | Phase A タスク投入（opus） |

これを `skills/cmux-team-dispatch-task/scripts/send-prompt.sh` 1 本に集約する。

```
send-prompt.sh --to-surface <id> [--to-workspace <id>]
               [--agmsg-team <t> --agmsg-to <agent> --agmsg-from <name>]
               --label <short-label> [--outbox-dir <path>]
               [--] <text>
```

#### 経路選択（宛先ごとに 1 経路だけ。dual-send を廃止）

- `--agmsg-*` が揃い、かつ `~/.agents/skills/agmsg/run/ready.<team>__<agent>` が存在する
  → **agmsg のみ**。`send.sh` で全文を push して終了。タイプ入力は一切しない
- それ以外 → **タイプ入力経路**

#### タイプ入力経路

1. 本文が閾値（**400 文字**）以下 → そのまま `cmux send`
2. 超える → 全文を `<outbox-dir>/<label>-<seq>.md` に書き出し、
   タイプするのは `<label>: read <path> and follow every instruction in it.` の 1 行だけ。
   **長文が入力欄を通らなくなる**。
   `<seq>` は同一 `<label>` の既存ファイル数から決める連番で、過去の送信内容を上書きしない。
   `--outbox-dir` の既定値は `<STATUS_DIR>/outbox`
3. 送信後 **0.5 秒** の settle sleep → `send-key return`
4. `read-screen` で入力欄行（`❯` / `>` 始まり）を検査。空でなければ Enter を再送（最大 3 回・1 秒間隔）
5. 3 回とも残っていたら `exit 1` + stderr に理由。呼び出し側が失敗を検知できる

閾値 400 文字の根拠: 詰まった実例が 1.3〜1.5KB で `[Pasted text #N]` が 2 つに割れていたこと、
`parallel-directive.sh` 単体が 899 文字であること。
完了通知（`[dispatch] task "x" finished (status: done)` = 約 50 文字）は閾値以下なので、
これまで通り素のテキストとして届き、Enter 検証だけが追加される。

#### 依存する前提

agmsg 経路は「**agmsg push が idle な claude セッションを起こす**」が真であることに全面的に依存する。
ready sentinel は watcher プロセスの生存を示すだけで、idle 中に注入されるかまでは保証しない。
このため次節の検証を実装の先頭に置く。

### 2. 検証ゲート

実装の先頭に 2 つの検証を置く。どちらも「前提が真か」を実測で決めるもの。

**V1: agmsg push は idle な claude セッションを起こすか**

cmux に claude ペインを 1 枚立て、agmsg に join して delivery mode を `monitor` にし、
**何も打たずに idle にした状態**で別セッションから `send.sh` する。
タイプ入力なしでペインが反応すれば成功。

**V2: codex bridge は codex 0.147 で通るか**

`.zshrc` に shim 関数を入れ、対象プロジェクトを `delivery.sh set monitor codex` にし、
cmux から `zsh -ic "codex ..."` で起動。`run/` 配下に bridge の pid が立つか、
idle 中の `send.sh` が注入されるかを見る。
app-server の起動と port 検出は実測済みなので、残る未知は bridge.js のスレッド探索と注入だけ。

**検証結果による分岐**（設計は変えず、経路の有効範囲だけが決まる）:

| | 成功 | 失敗 |
|---|------|------|
| V1 | claude 宛ては agmsg push のみ | claude 宛てもタイプ入力経路に留める |
| V2 | codex 宛ても agmsg push のみ、`cmux send` 全廃 | codex 宛てはタイプ入力経路 |

**どちらが失敗しても本件の詰まりは直る** — タイプ入力経路自体が長文ファイル化 + Enter 検証を持つため。
agmsg 化は「詰まる余地をゼロにする」上積みである。

### 3. 設定の単純化（`message_type` 廃止）

現在は `send-message` / `agmsg` の二択を Step 1g で質問し、config に永続化している。
これを廃止し、判定を 1 本にする:

- `~/.agents/skills/agmsg/scripts/send.sh` が存在する → 常に agmsg を配線する（質問しない）
- 存在しない → 全経路がタイプ入力

既存 config の `message_type` キーは読まなくなる（残っていても無害）。

`prewarm.json` の `delivery` フィールドは **残す**。これは「そのペインへの agmsg 配線が実際に成功したか」を持つ
別物であり、`send-prompt.sh` の経路選択が参照する。

`monitor-dispatch.sh` を起動しない条件は「agmsg モードのとき」から
「agmsg がインストール済みのとき」に読み替わる。

影響ファイル: `SKILL.md` / `guide-ja.md` / `README.md` / `CLAUDE.md` /
`launch-workspace.sh` / `prewarm-panes.sh` / `loop-mode.md` / `loop-mode-ja.md` の 8 つ。

### 4. 呼び出し側の書き換え

**スクリプト側（2 ファイル）**

`launch-workspace.sh` の `notify_parent()` / `notify_reviewer_once()` と
`monitor-dispatch.sh` の `send_to_parent()` を `send-prompt.sh` 呼び出しに置換する。
runner wrapper はヒアドキュメントで生成されるため、既存のエスケープ規約（`\$` / `\\\"`）を踏襲する。

**エージェント指示文側（`SKILL.md` 5 箇所 + `REVIEW_INSTRUCTION`）**

「`cmux send` してから `cmux send-key return` しろ」という 2 段手順を、
「`send-prompt.sh` を 1 回呼べ」に置き換える。
副次効果として `launch-workspace.sh:667` の `REVIEW_INSTRUCTION`（現在 1 行で 1.5KB 超）が大幅に縮む。

`parallel-directive.sh` の「`'` `"` `` ` `` `$` `!` `\` を出力しない」制約は **維持** する。
これらの文字列は依然として `zsh -ic "..."` の中に埋め込まれるためで、緩めると別種の事故になる。

### 5. エラー処理

- agmsg 経路で `send.sh` が失敗 → **同一呼び出し内でタイプ入力経路へフォールバック**。
  配送が無言で消える経路を作らない
- タイプ入力経路で Enter 検証が 3 回失敗 → `exit 1`。
  runner は stderr にログを残し、エージェント呼び出し側は再送するか `AskUserQuestion` で人に上げる
- `read-screen` が失敗 or 空出力 → **観測失敗であって配送失敗ではない**とみなし、送信済みとして続行。
  既存の Phase A-R 生存確認と同じ扱いに揃える
- agmsg 経路のメッセージは **改行を含めない**（既存の 1 行規約を維持）。watcher は 1 メッセージ = 1 行で流すため

## テスト

新規 `test/test-send-prompt.sh`。`cmux` と `send.sh` をスタブに差し替えて呼び出しを記録する方式で、次を検証する:

- 閾値超えの本文が outbox にファイル化され、タイプされるのは 1 行のポインタだけであること
- 閾値以下は素のテキストとしてタイプされること
- ready sentinel がある宛先では `cmux` が **1 度も呼ばれない**こと
- sentinel 不在ではタイプ入力経路に落ちること
- `send.sh` 失敗時にタイプ入力経路へフォールバックすること
- 入力欄が空にならない場合に Enter が最大 3 回再送され、最後に `exit 1` すること

既存テストの更新対象:

- `test/test-launch-workspace-review-config.sh`（`REVIEW_INSTRUCTION` の静的検査）
- `test/test-launch-workspace-codex.sh`
- `message_type` に触れる箇所

E2E は V1 / V2 の検証に加えて、実際の dispatch で 1.5KB のレビュー依頼が入力欄に残らず届くことを目視確認する。

## スコープ外

- cmux 本体の変更（別リポジトリ）
- `cmux-using` / `cmux-fork` / `cmux-codex-review` など他プラグインの送信経路
- `parallel-directive.sh` の文字制約の緩和
