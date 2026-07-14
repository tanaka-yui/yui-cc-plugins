# cmux-team-dispatch-task: Phase A plan/spec の codex レビュー 設計

日付: 2026-07-14
対象: `apps/cmux-team-dispatch-task`

## 背景 / 目的

Phase A では常に opus が plan / spec を作成し、そのまま Phase B（実行モデル選択）へ進む。
plan の品質は opus 単独の自己レビューに依存しており、別系統のモデルによるチェックが無い。

これを次のとおり改善する:

1. **codex による plan/spec レビュー**: codex runner が登録され、レビュー用モデル
   （例: `gpt-5.6-sol`）が設定され、config の `review_mode` が on のとき、Phase A の
   成果物を codex にレビューさせる **Phase A-R（Review）** を Phase A と Phase B の間に
   新設する。
2. **approve までループ**: codex の指摘を opus が plan/spec に反映し再レビューを依頼する。
   各レビューポイント最大 3 往復。approve が出なければユーザー判断に委ねる。
3. **レビュー専用ペイン**: pre-warm レイアウトを 2×2 グリッドに拡張し、右上をレビュー用
   codex ペインとして常駐させる。1 ペインを全レビューポイントで再利用する。

## 有効化条件

以下が**すべて**満たされたときのみ Phase A-R が発動する:

- `~/.claude/cmux-team-dispatch-task/runners.json` に `engine: "codex"` の runner が存在する
- その runner エントリに `review_model` フィールドが設定されている
- config の `review_mode` が `"on"` である（下記の解決フロー参照）

いずれかを欠く場合は現行フローと完全に同一（後方互換）。レイアウトも現行のまま
（codex runner ありなら縦 3 分割、無しなら縦 2 分割）。判定は親が Step 1f / 1g で行い、
子プロンプトのプレースホルダー `{{REVIEW_BLOCK}}` に焼き込む。

### config: `review_mode` の解決フロー（`message_type` と同パターン）

`~/.claude/cmux-team-dispatch-task/config.json`（プロジェクト側 `.dispatch/config.json` が
存在すれば優先）に `review_mode: "on" | "off"` を追加する:

1. config に `review_mode` があればその値を使う（質問しない）
2. config に無く、`review_model` 付き codex runner が存在する場合のみ初回質問:
   「plan/spec の codex レビュー (Phase A-R) を有効にしますか？」
3. Yes / No どちらの回答も config.json に永続化する（次回以降は質問しない）

`review_model` 付き runner が存在しない環境では質問せず off 扱い。一時的に無効化したい
場合は config の `review_mode` を `"off"` に書き換える（runners.json はそのまま残せる）。

## runners.json スキーマ拡張

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude" },
    { "name": "codex",  "command": "codex",  "engine": "codex", "review_model": "gpt-5.6-sol" }
  ]
}
```

- `review_model`（optional / `engine: codex` の runner のみ有効）: レビューペイン起動時に
  `--model <review_model>` として codex コマンドに付与する。
- First-run setup（runners.json 初回生成）の質問に「codex runner に plan レビューを
  担当させますか？（担当させる場合はモデル名を入力）」を追加する。

## 全体フロー（子セッション視点）

`MANDATORY MODEL SELECTION SEQUENCE` に Phase A-R を挿入した 3 フェーズ構成:

```
Phase A   — opus で plan / brainstorming（現行どおり）
Phase A-R — codex レビューループ（review_model 設定 + review_mode: on のときのみ・新設）
  - plan モード:        plan 完成後に 1 レビューポイント
  - superpowers モード: spec(design doc) 完成後 + plan 完成後の 2 レビューポイント
  - 各ポイント最大 3 往復（修正 → 再レビュー）。approve で次へ
  - 3 往復で approve が出ない → 残指摘を要約し AskUserQuestion で
    「このまま Phase B へ進む / さらに修正」をユーザーに確認
Phase B   — 実行モデル選択（現行どおり・変更なし）
```

指摘の反映は opus の判断に委ねる。全指摘の盲目的受け入れはせず、反論がある場合は
再依頼文に理由を添えて codex に返す。

## レビューペインのライフサイクル

### pre-warm 時のレイアウト（prewarm 有効 + Phase A-R 有効時）

現行の縦 3 分割（上 opus / 中 sonnet / 下 codex）を **2×2 均等グリッド**に変更する:

```
┌─────────────────┬─────────────────┐
│  opus           │  codex レビュー  │
│  (Phase A 実行) │  (idle 待機)     │
├─────────────────┼─────────────────┤
│  sonnet standby │  codex standby  │
│  (Phase B 実行) │  (Phase B 実行)  │
└─────────────────┴─────────────────┘
```

- `prewarm-panes.sh` が 4 ペインを起動する。**下段 2 つ**（sonnet / codex standby）は
  現行どおり standby wrapper 付き（status.json 所有権・`.assigned-<name>` sentinel 方式は不変）。
- **右上のレビューペイン**は status.json の所有権を持たない素の codex セッション
  （`command` + `--model <review_model>`）で idle 起動する。実装上は standby と同じ wrapper 機構に
  乗るが、`.assigned-<slug>-review` を誰も touch しないため wrapper は exit 時に status.json を
  書かない（既存の standby ガードを流用）。
- `prewarm.json` に `review` エントリを追加する:
  `{ "review": { "surface_id": "...", "delivery": "agmsg" | "cmux-send" } }`。
  agmsg モードでは他ペインと同様、起動前に `<task-slug>-review` として配線し、
  失敗時は `cmux-send` にフォールバックする。
- Phase A-R が無効（`review_model` 未設定 / `review_mode: off`）なら 2×2 化しない
  （現行レイアウト維持）。

### フォールバック（prewarm 無効 / split レイアウト時）

最初のレビューポイント到達時に、子が `launch-workspace.sh --mode review` でオンデマンド
spawn する（子ペインの右隣に split）。起動コマンドの組み立ては prewarm 経路と同一。

### 寿命

- spec レビュー → plan レビューまで**同一セッションを使い回す**（前回指摘の文脈を保持）。
  ループ中の再レビューも同一セッションに依頼する。
- 最終レビューポイントの approve（またはユーザー判断での進行決定）後に子がペインを close する。
- Phase B の「未使用 standby close」ロジック（`select(.key != "opus")`）は `review` キーも
  列挙対象に含むため、万一 close 漏れがあっても Phase B で一緒に閉じられる（安全側）。

## 通信プロトコル（message_type によるモード分岐）

レビュー依頼・完了検知は `prewarm.json` の `review.delivery` に従って分岐する
（prewarm の Phase B delivery 分岐と同一思想）。

### 共通（両モード）

verdict はペイン出力のパースではなく**ファイル**で受け渡す。codex への依頼文に
以下のプロトコルを埋め込む:

- レビュー対象ファイルパス（plan / spec）と参照資料のパス
- 指摘は `<STATUS_DIR>/review/<point>-round-<N>.md` に書く
  （`<point>` はレビューポイント識別子: `spec` または `plan`。superpowers モードの
  2 ポイント間でファイル・signal が衝突しないようにする）
- ファイル末尾に `VERDICT: approve` または `VERDICT: needs_work` を必ず記す
- 書き終えたら完了通知（下記のモード別手段）を発行する

子は verdict を `<point>-round-<N>.md` から読む。

### agmsg モード（`delivery: "agmsg"`）

- 依頼: `send.sh "$TEAM" <task-slug> <task-slug>-review "<review依頼文>"`
- 完了検知: codex がレビューファイル書き込み後に
  `send.sh "$TEAM" <task-slug>-review <task-slug> "[review] round <N> done (verdict: ...)"`
  で子に push する。子はターンを終えて idle 待機し、agmsg 着信で再開する。
- 配線失敗時は `cmux-send` 経路へフォールバックする。

### send-message モード（`delivery: "cmux-send"`）

- 依頼: `cmux send --surface <REVIEW_SURFACE> "<review依頼文>"` + `cmux send-key return`
- 完了検知: 子が Bash で verdict ファイル（`<point>-round-<N>.md` の VERDICT 行）を
  ポーリングして待つ（5 秒間隔・15 分タイムアウト）。
  注: 当初は `cmux wait-for --signal` によるブロッキング待ちを想定したが、既存コードで
  `cmux wait-for --signal` は発火側として使われており、待ち受け挙動への依存を避けるため
  ファイルポーリングに変更した。codex 側のプロトコルは「ファイルを書く」だけでよくなり、
  signal 発火の指示遵守も不要になる。

## ループ制御

各レビューポイント（plan モード: 1 箇所 / superpowers モード: 2 箇所）で:

1. round N のレビュー依頼を送信 → 完了待ち
2. `VERDICT: approve` → このポイント完了。次のポイントへ（無ければペイン close → Phase B）
3. `VERDICT: needs_work` → opus が指摘を読み、妥当な指摘を plan/spec に反映 → round N+1 を依頼
4. round 3 でも needs_work → 残指摘を要約して AskUserQuestion:
   「このまま Phase B へ進む / さらに修正を続ける」

## エラーハンドリング

| 状況 | 挙動 |
|------|------|
| verdict ファイルのポーリング timeout（15 分） | レビュー打ち切り。AskUserQuestion で「再依頼 / レビュー省略して Phase B へ」 |
| agmsg 着信が来ない（codex が消費しない） | 実機検証で消費されない場合は review の delivery を常に `cmux-send` に倒す（prewarm E2E 19 と同方針） |
| verdict ファイルが無い / VERDICT 行が無い | needs_work 扱いで再依頼（1 回だけ）。それでも不正なら timeout と同じ分岐 |
| レビューペインの spawn 失敗 | レビューをスキップして警告を出し、現行フロー（Phase B）へ進む。レビューは品質向上機能でありディスパッチ自体を止めない |

## ドキュメント整合（4 ファイルルール）

モデル選択フロー改変に該当するため、**SKILL.md / guide-ja.md / README.md / CLAUDE.md の
4 ファイル同時更新**が必須:

- SKILL.md: `MANDATORY MODEL SELECTION SEQUENCE` に Phase A-R ブロックを追加
  （`{{REVIEW_BLOCK}}` プレースホルダー方式 — Phase A-R 有効時のみ親が焼き込む）。
  runners.json スキーマ、config.json の `review_mode` 解決フロー（Step 1g 相当）、
  prewarm 2×2 レイアウト、prewarm.json `review` キー、`--mode review` の使用例を更新。
- CLAUDE.md: メンテナンス手順に「review フロー整合チェック」項目を追加。E2E テスト項目を追加。
- guide-ja.md / README.md: 同内容を反映。
- `launch-workspace.sh` に `--mode review` を追加したら usage() と SKILL.md 使用例を同期。

## テスト（E2E 観点）

1. `review_model` 未設定 or `review_mode: off` → 現行フロー完全一致（レイアウトも
   縦 3 分割 / 縦 2 分割のまま）
2. Phase A-R 有効（`review_model` 設定 + `review_mode: on`）+ prewarm → 2×2 グリッドで
   4 ペイン起動、右上がレビュー用 idle codex
3. plan モード → plan 後 1 回 / superpowers モード → spec 後 + plan 後の 2 回レビューが走る
4. needs_work → opus が修正して再依頼、**同一ペイン**に送られる（新ペインが生えない）
5. approve → ペイン close → Phase B の質問が出る
6. 3 往復 needs_work → AskUserQuestion（このまま進む / さらに修正）が出る
7. agmsg / send-message 両モードで完了検知が機能する
8. レビューペインの存在が standby の `.assigned-*` / status.json に影響しない
9. prewarm 無効時 → 最初のレビューポイントで `--mode review` によるオンデマンド spawn が行われる
10. `review_mode` 解決: config 未設定 + `review_model` 付き runner ありで初回質問が出て、
    Yes / No どちらでも config.json に永続化されること。config 設定済みなら質問が出ないこと。
    `.dispatch/config.json` の `review_mode` がグローバルより優先されること
