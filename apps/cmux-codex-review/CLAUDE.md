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
3. 分割先で**対話 codex にレビュープロンプトを送る**（`codex --sandbox workspace-write --ask-for-approval never -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" '<レビュー指示>'`）
4. `--team/--reviewer/--parent` 指定時は、レビュー指示に完了通知（agmsg `send.sh`）を注入し、親側は `bin/cmux-codex-wait` で完了を待つ

## テスト

```bash
bash apps/cmux-codex-review/test/test-cmux-codex-review.sh
```

stub の cmux / codex を使い、bin が `cmux send` で送る文字列を**ペインのシェルと同じように再パース**して
codex が実際に受け取る引数を検証する（生文字列の grep では引用符崩れを検知できないため）。守っている不変条件:

- **D1**: sandbox が `workspace-write`（`read-only` への逆戻りを禁止 — 下記の理由）
- **D2**: 通知配線あり → prompt に `send.sh` と token が無傷で届く
- **D3**: 通知配線なし → `send.sh` を注入しない（後方互換）
- **D4**: prompt は常にちょうど 1 引数として codex に渡る（`'\''` エスケープ）
- **D5**: approval policy が `never`（無指定に戻すと codex が承認プロンプトで停止し、無人レビューが accept 待ちになる）
- `--base` の反映 / `-m`・`-e` の不正値拒否

## サンドボックスを read-only にしてはいけない

完了通知の `send.sh` は agmsg の SQLite DB へ INSERT する（＝書き込み）。`~/.codex/config.toml` の
`[sandbox_workspace_write] writable_roots`（agmsg の db/teams/run）は **workspace-write モードにしか
適用されない**ため、`--sandbox read-only` にすると codex が通知を撃てず、親が永久に wake しない。
過去に read-only へ変更して通知が壊れた実績があるので戻さないこと。

## whoami の `suggest=true` に注意

`suggest=true` は「このプロジェクトは未参加」を意味する。出力に含まれる `teams=` / `agents=` は
**他プロジェクトの登録**であり、参加済みと誤読して使うと codex の通知先と watcher の待ち先がズレて
通知が届かなくなる。コマンドの Step 1 は必ず join を確認してから配線する。

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
