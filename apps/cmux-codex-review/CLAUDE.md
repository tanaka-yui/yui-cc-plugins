# cmux-codex-review

agmsg の inbox 確認 → 新 cmux ペインで codex コードレビュー起動、を 1 アクションにまとめたプラグイン。

## 構成

- `commands/codex-review.md` — `/codex-review` スラッシュコマンド（agmsg inbox 確認 + bin 実行）
- `skills/codex-review/SKILL.md` — レビュー起動スキル（トリガー定義）
- `bin/cmux-codex-review` — ペイン分割 + 対話 codex へのレビュープロンプト送信の本体（`!` 直接実行も可、LLM 不要で高速）
- `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` — Plugin マニフェスト

## 動作

1. agmsg を起動して受信箱を確認（非ブロッキング。未参加・未インストールならスキップ）
2. `cmux new-split <dir>` で新ペインを分割
3. 分割先で**対話 codex にレビュープロンプトを送る**（`codex --dangerously-bypass-approvals-and-sandbox -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" '<レビュー指示>'`）
4. `--team/--reviewer/--parent` 指定時は、レビュー指示に完了通知（agmsg `send.sh`）を注入し、親側は `bin/cmux-codex-wait` で完了を待つ

## デフォルト

| 項目 | 値 | 上書き |
|------|-----|--------|
| model | `gpt-5.6-sol` | `-m` / `--model` |
| reasoning effort | `xhigh`（extra high） | `-e` / `--effort` |
| 対象 | `--uncommitted` | `--base <branch>` / `--commit <sha>` |
| 分割方向 | `right` | 位置引数 `down`/`left`/`up` or `-d` |

## 前提

- cmux セッション内（`CMUX_SOCKET_PATH` が必要）
- `codex` CLI が PATH 上にあること（`gpt-5.6-sol` / `xhigh` が利用可能な認証済み環境）

## 関連プラグインとの境界

- `cmux-fork` は「会話を新ペインにフォーク」する汎用分割。本プラグインは「codex にレビューさせる」専用途で、
  送信するのが対話 codex へのレビュープロンプトに固定されている点が異なる。
- `cmux-team-dispatch-task` の review 機能は dispatch されたタスクの plan/spec を codex が approve する
  オーケストレーション文脈のもの。本プラグインは単発の手元レビュー起動に特化する。
- `cmux-codex-exec`: 本プラグインの前段。exec が plan をカレントdirに実装し、完了後に本プラグインが
  その未コミット変更をレビューする想定の繋ぎ。
