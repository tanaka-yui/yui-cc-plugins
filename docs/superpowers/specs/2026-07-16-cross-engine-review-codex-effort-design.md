# クロスエンジンレビュー + codex effort 指定 設計 (cmux-team-dispatch-task v1.7.0)

日付: 2026-07-16
対象: `apps/cmux-team-dispatch-task`
前提バージョン: v1.6.3 (Phase A-R / B-R 実装済み)

## 背景 / 課題

現状の Phase A-R / B-R は「設計 = claude (opus)、レビュー = codex」を前提に固定されている。

1. Step 1f で runner に codex engine を選ぶと設計セッションが codex になるが、Phase A-R の
   レビューペインも codex (`review_model`) のままで、同族レビューになってしまう。
2. codex セッションの reasoning effort を役割別に制御する手段がない。
   `~/.codex/config.toml` のグローバル値 (`model_reasoning_effort = "high"`) が一律適用される。

## 決定事項

### 1. 基本原則: レビュアーは常に相手方 engine

設計・実装のどちらのレビューでも「作った側と逆の engine がレビューする」を単一ルールとする。

- **Phase A-R**: 設計 engine の逆がレビュー
  (opus 設計 → codex レビュー / codex 設計 → opus レビュー)
- **Phase B-R**: 実装者 engine の逆がレビュー
  (opus 1m・sonnet 実装 → codex レビュー / codex 実装 → opus レビュー)

### 2. runners.json スキーマ拡張

```json
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude",
      "review_model": "claude-opus-4-7[1m]" },
    { "name": "codex", "command": "codex", "engine": "codex",
      "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra",
      "plan_effort": "xhigh", "review_effort": "xhigh", "exec_effort": "high" }
  ]
}
```

- **claude runner に `review_model` を追加** (optional): codex 設計時にレビューペインで
  起動するモデル。未設定なら `claude-opus-4-7[1m]` (既存 `OPUS_MODEL` 定数) にフォールバック。
- **codex runner に effort 3 フィールドを追加** (optional、値: `minimal` | `low` | `medium` |
  `high` | `xhigh`):
  - `plan_effort` — Phase A 設計セッション (plan / superpowers mode)
  - `review_effort` — レビューペイン (review mode)
  - `exec_effort` — 実行系 (execute / standby mode)
  - 未設定なら `-c` フラグを付けず `~/.codex/config.toml` の既定に任せる (破壊的変更なし)。
- First-run setup / カスタム登録の対話質問にも上記フィールドを追加する。

### 3. effort のコマンド反映 (launch-workspace.sh)

原則は `--runner` と `--mode` からの内部解決とするが、prewarm 経路の設計 codex ペインは
`--mode standby` で idle 起動される（MODE 解決では exec_effort が当たる）ため、明示
`--effort <value>` フラグを `launch-workspace.sh` に追加する。優先順位:
明示 `--effort` > runner フィールド（MODE 対応表） > 無指定（config.toml 既定）。
prewarm-panes.sh は設計 codex ペイン起動時に runner の `plan_effort` を `--effort` で明示する。

| MODE | 適用フィールド |
|------|--------------|
| plan / superpowers | `plan_effort` |
| review | `review_effort` |
| execute / standby | `exec_effort` |

`codex -c model_reasoning_effort="xhigh"` がセッション単位で config.toml を上書きできる
ことは実機確認済み (`-c, --config <key=value>`)。

### 4. Phase A-R クロスレビュー

- **design=claude** (現行): 変更なし。codex レビューペイン (`review_model` + `review_effort`)。
- **design=codex** (新規): レビューペインを **claude engine** で起動 —
  ディスパッチ時に選択した claude runner の `command` + その `review_model` +
  `--dangerously-skip-permissions`。
- **レビュアー runner の選択**: codex 設計タスクが 1 つでもあるディスパッチでは、
  claude engine runner の一覧から AskUserQuestion で毎回選択する。
  claude engine runner が 1 つしか無い場合は自動選択して質問を省略する。
- **REVIEW_ENABLED 判定**を設計 engine で分岐:
  - design=claude → 「`review_model` 付き codex runner が存在」(現行条件)
  - design=codex → 「claude engine runner が存在」
  - `review_mode` 設定キー (on / off / ask) と Step 1g の質問文は共通のまま。

### 5. Phase B / B-R — 4 ペインロールスワップ

2×2 グリッド (常 4 ペイン) は維持する。design=codex 時の配置:

- 左上 = 設計 codex (plan_effort=xhigh)
- 右上 = claude opus ペイン (reviewer runner + `review_model`)
- 左下 = sonnet standby
- 右下 = codex standby (exec_model=terra, exec_effort=high)

右上ペインは `--mode standby` 相当で起動する (standby wrapper 付き。`.assigned` を
touch されない限り status.json を書かない現行セマンティクスを利用)。このペインは
**A-R レビュアーと opus 1m 実装先の二役**を担う。

design=codex 時の右上ペインの agent 名は `<slug>-opus`（A-R レビュアー兼 opus 1m
実装先）。Phase B opus 1m 委譲時の sentinel は `.assigned-<slug>-opus`、完了 signal
は `<slug>-opus-done`。prewarm.json のキーは役割どおり `review` を維持し、
`agent: "<slug>-opus"` / `engine: "claude"` を記録する。

**B-R レビュアーの統一ルール**: 実装者と逆 engine のペイン。逆 engine が設計 engine と
同じなら設計ペイン (`.deferred` 後 idle)、そうでなければレビューペイン。

| 設計 | Phase B 実装者 | B-R レビュアー | 備考 |
|------|--------------|---------------|------|
| opus | opus 1m (同一セッション続行) | codex レビューペイン | 現行どおり |
| opus | sonnet | codex レビューペイン | **現行変更** (旧: 設計 opus ペイン) |
| opus | codex | 設計 opus ペイン | 現行どおり |
| codex | opus 1m (右上 claude ペインに委譲) | 設計 codex ペイン | 新規 |
| codex | sonnet | 設計 codex ペイン | 新規 |
| codex | codex (右下 standby に委譲) | 右上 claude ペイン | 新規 |

- design=codex では Phase B の 3 択すべてが**委譲**になる (codex セッション内での
  `/model` 切替は行わない)。設計 codex ペインは委譲後に `.deferred` を touch して
  idle 待機し、B-R レビュアーになる場合は plan_effort=xhigh のセッションが
  そのままレビューする (レビュー xhigh の要件を充足)。
- design=opus + sonnet 実装の B-R レビュアー変更 (設計 opus ペイン → codex
  レビューペイン) は意図した行動変更であり、ユーザー承認済み。

### 6. prewarm-panes.sh の変更

- 新フラグ `--design-runner <name>`: engine=codex のとき左上を codex runner で起動し
  (idle standby)、右上を claude reviewer runner + `review_model` で起動する。
- 新フラグ `--reviewer-runner <name>`: ディスパッチ時に選択した claude runner を受け渡す。
- `prewarm.json` に各ペインの `engine` 情報を追加する
  (既存キー `opus` / `sonnet` / `codex` / `review` は互換維持)。
- split layout (prewarm 無し) の spawn フォールバックにも同じ engine 分岐を反映する。

### 7. フォールバック / エラー処理

- claude レビューペインの spawn 失敗 → 現行と同じ「レビュー省略で Phase B へ」。
- design=codex かつ claude engine runner がゼロ → A-R / B-R 無効 (警告表示)。
- effort フィールド未設定 → `-c` フラグ無し (config.toml 既定を継承)。

## スコープ外

- claude engine 側の thinking/effort 制御 (codex のみが対象)。
- claude-teams layout (現行どおり runner 設定を無視)。
- codex セッション内でのモデル切替 (`/model`) の自動化。

## ドキュメント / バージョン

- SKILL.md / guide-ja.md / README.md / CLAUDE.md の 4 ファイル一致規約に従い全て同期する。
- CLAUDE.md のメンテナンスチェックリスト (E2E 項目含む) にクロスレビューと effort の
  検証項目を追加する。
- v1.6.3 → **v1.7.0** (機能追加)。ルート `.claude-plugin/marketplace.json` も同期する。

## 検証方法

1. `launch-workspace.sh` の組み立てコマンドを `--mode` × `--runner` × effort 設定有無の
   組み合わせでログ出力確認 (`-c model_reasoning_effort` の注入位置・クォート)。
2. design=opus / design=codex 各 1 タスクの実ディスパッチで、2×2 グリッドの engine 配置・
   A-R 往復・B-R レビュアー割り当て (上表 6 ケースのうち到達可能なもの) を E2E 確認。
