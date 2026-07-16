# 設計: cmux-codex-exec 新規プラグイン + cmux-codex-review 完了通知

- 日付: 2026-07-16
- 対象リポジトリ: `yui-cc-plugins`
- 関連: `apps/cmux-codex-review`（既存）, `apps/cmux-team-dispatch-task`（通知パターンの参照元）, agmsg 1.1.8

## 背景と目的

`cmux-codex-review` は cmux ペインで codex コードレビューを起動するが、**完了を親セッションに通知しない**。
また、claude/superpowers が作成した plan を codex に実装させ、完了を待って親がレビューへ進む一連のフローが存在しない。

本設計で次を実現する:

1. **`cmux-codex-exec`（新規プラグイン）**: plan を読み込み、対話 codex に**カレントディレクトリ**で実装させ、
   完了を親セッションが agmsg 経由で検知して wake、確認のうえレビューへ繋ぐ。
2. **`cmux-codex-review`（修正）**: ヘッドレス `codex review` を**対話 `codex "/review"`** に変更し、
   完了通知（agmsg ベース）を追加する。後方互換を維持する。

## 確定済みの前提（ブレスト合意事項）

| 項目 | 決定 |
|------|------|
| codex 起動形態 | **対話型（通常の codex TUI）**。ヘッドレス（`codex exec` / `codex review`）は使わない |
| 実行ディレクトリ | **カレント dir**（親と同一 worktree）。codex の変更をそのまま親が `--uncommitted` レビューできる |
| plan 指定 | 引数でパス指定、省略時は `docs/superpowers/plans/` の最新 `*.md` を自動選択 |
| 完了通知トランスポート | **agmsg**（`send.sh`）。wake は「完了時に exit する短命 watcher」の task 完了通知で担保 |
| 完了後の挙動 | 親は通知を受けたら要約提示し、ユーザーに確認してから `cmux-codex-review` を起動 |
| モデル/effort | `gpt-5.6-sol` / reasoning effort `xhigh`（review・exec 共通のデフォルト、`-c` で上書き可） |

## 完了通知アーキテクチャ（両プラグイン共通）

### 課題

対話 codex TUI はタスク完了後も **exit せず開いたまま**なので、ヘッドレスの `codex ... ; 通知` のような
プロセス終了フックが使えない。かつ agmsg の**常駐 monitor stream は idle な claude 親を wake できない**
（Claude Code は「バックグラウンド task の *完了*」時にのみ `<task-notification>` で idle セッションを再起動する。
常駐 stream は完了しないので注入されない。これは agmsg core のバグではなく harness 仕様であり、agmsg 1.1.8 でも不変）。

> **実測で確認済み（2026-07-16）**: 捨てteam でこの現象をライブテストした。delivery=monitor で watch.sh を
> 常駐 background task として起動し、別の detached プロセスから idle 親へ agmsg メッセージを送信 → **メッセージは
> transport で到達し watcher stream も検知したが、idle 親は wake しなかった**（ユーザーが手動入力するまで沈黙）。
> harness には "Monitor" tool 自体が存在しないことも確認。よって「agmsg monitor push で idle 親を起こす」案は棄却。

### 解決

```
codex(対話・開いたまま)
   └─ 作業完了時の最終アクション ──▶ send.sh <team> <codex-agent> <parent> "DONE <token>"
                                              │ (agmsg inbox に記録)
親: 短命 watcher（background task）
   └─ inbox/history を polling、<token> 検知で exit
        └─ task 完了 ──▶ harness が <task-notification> ──▶ idle 親を wake ✅
```

- **codex は対話型のまま**（ユーザーが見て介入でき、完了後も追質問できる）。
- codex のプロンプト末尾に「作業完了時、最後に次の通知コマンドを実行せよ」を注入。codex は shell 実行可（bypass）なので撃てる。
- 親は起動直後に **完了時 exit する短命 watcher** を background task（`run_in_background: true`）で起動。
  これは agmsg 常駐 monitor とは別物で、**exit が harness の wake トリガーになる**点が肝。
- **フォールバック**: codex が最終送信を忘れても watcher が timeout（デフォルト 30 分）で exit し、
  親は「codex 完了を検知できず。ペインを確認して」と wake される。破綻しない。

### 通知トークンとメッセージ

- `<token>`: 起動ごとにユニークな識別子。**bin が分割で得た surface id から決定的に導出**する
  （例: `codex-exec-<surface>`。surface はペインごとに一意なので乱数/時刻不要）。
  bin はこの token を (1) codex プロンプトに埋め込み、(2) 標準出力に echo する。
  `/codex-exec` コマンドは bin の出力から token を読み取り、同じ token で watcher を起動する。
- **レース安全性**: watcher は `history.sh`（非破壊読み取り）を polling するため、
  codex が watcher 起動前に通知を撃っても history に残っており取りこぼさない。
- メッセージ本文例: `DONE codex-exec-<surface>: <plan名> の実装が完了`。

### watcher スクリプト（新規、両プラグインで共有）

- 配置案: 各プラグインの `bin/` に個別実装、または共通ヘルパー。本設計では**各プラグイン bin に内包**（プラグイン独立性を優先）。
- 動作: 引数 `<team> <parent-agent> <token> [--timeout <sec>]`。
  `history.sh`（**非破壊読み取り**、`inbox.sh` は既読化するので使わない）を `sleep 5` 間隔で polling し、
  `<token>` を含むメッセージを検知したら `status=done` を出力して exit 0。timeout 到達で `status=timeout` を出力し exit 3。

## コンポーネント A: `cmux-codex-exec`（新規プラグイン）

### ディレクトリ構成

```
apps/cmux-codex-exec/
├── .claude-plugin/plugin.json      # Plugin マニフェスト（version 1.0.0）
├── .codex-plugin/plugin.json       # Codex 版マニフェスト
├── bin/cmux-codex-exec             # plan 解決 + ペイン起動 + codex プロンプト組み立て
├── bin/cmux-codex-wait             # 短命 watcher（history polling → token 検知で exit）
├── commands/codex-exec.md          # /codex-exec スラッシュコマンド
├── skills/codex-exec/SKILL.md      # トリガー定義
├── CLAUDE.md
└── README.md
```

### `/codex-exec [plan-path]` フロー

1. **前提チェック**: `CMUX_SOCKET_PATH` あり、`codex` on PATH。無ければ明示エラー。
2. **plan 解決**: 引数があればそのパス。無ければ `docs/superpowers/plans/*.md` を更新時刻降順で最新を選択。
   どちらも無ければ「plan が見つからない」と伝えて中断。
3. **agmsg identity 解決**: `whoami.sh` で `<team>` / `<parent>` を得る。
   - 未参加なら join を案内（agmsg の join フロー再利用）。参加後に続行。
4. **codex agent を pre-join**: `<slug>-codex` を `<team>` に join（`join.sh`。1.1.8 は未登録 from/to を拒否するため送信元登録が必須）。
5. **一意 slug 決定**: `<plan basename>-<親が決める短い接尾辞>`。token = `codex-exec-<slug>`。
6. **ペイン起動**: `cmux new-split <dir>` → 分割先で対話 codex を起動:
   ```bash
   codex --dangerously-bypass-approvals-and-sandbox \
     -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" \
     "<plan本文>

   上記 plan をこのリポジトリに実装せよ。作業がすべて完了したら、最後に必ず次を1回実行して完了を通知せよ:
   ~/.agents/skills/agmsg/scripts/send.sh <team> <slug>-codex <parent> 'DONE codex-exec-<slug>: <plan名> 実装完了'"
   ```
   - `<plan本文>` はサイズが大きい場合を考慮し、**プロンプトにはパスと要旨のみ**を渡し「plan は <path> を読め」と指示する方式も可（実装時に選択、既定はパス参照）。
7. **報告**: bin は `surface` / `slug` / `token` / `plan` を1行で出力。
8. **親 watcher 起動（コマンド側）**: `/codex-exec` コマンドが `bin/cmux-codex-wait <team> <parent> codex-exec-<slug> --timeout 1800` を
   **background task**（`run_in_background: true`）で起動し、ターンを終える（親は idle）。
9. **wake 後**: watcher task 完了通知で親が起きる。
   - `status=done`: 親は「codex-exec 完了。未コミット変更をレビューしますか?（cmux-codex-review）」とユーザーに確認 → Yes で review 起動。
   - `status=timeout`: 「完了を検知できず。ペイン `<surface>` を確認して」と伝える。

### bin/cmux-codex-exec の引数

| 引数 | 意味 | 既定 |
|------|------|------|
| `[plan-path]` | plan ファイル | `docs/superpowers/plans/` 最新 |
| `-d, --dir` | 分割方向 | `right` |
| `-m, --model` | codex モデル | `gpt-5.6-sol` |
| `-e, --effort` | reasoning effort | `xhigh` |
| `--team` / `--parent` / `--slug` | 通知配線（コマンドが解決して渡す） | — |
| `--plan-mode inline\|path` | plan をプロンプトに全文埋め込むかパス参照か | `path` |

## コンポーネント B: `cmux-codex-review`（修正）

### 変更点

1. **対話化**: bin の送信コマンドを `codex review --uncommitted ...`（ヘッドレス）から
   **対話 `codex -c model=... -c model_reasoning_effort=... "/review"`** に変更。
   - `--base` / `--commit` 指定時は `/review` に対象を伝える初期プロンプトにする（例 `"/review main との差分"`）。
     codex TUI の `/review` が対象指定を解釈できない場合は自然言語プロンプトにフォールバック（実装時に確認）。
2. **完了通知の追加（任意）**: 新しい任意引数を追加:
   - `--team <team>` / `--reviewer <name>` / `--parent <agent>` / `--slug <slug>`
   - 指定時、codex 初期プロンプトに「レビュー提示が終わったら最後に `send.sh <team> <reviewer> <parent> 'DONE codex-review-<slug>'` を実行」を注入。
   - `commands/codex-review.md` が親 identity と slug を解決し、review 起動と同時に `bin/cmux-codex-wait`（cmux-codex-review 側にも内包）を background task で起動。
3. **後方互換**: 通知引数が無ければ（`!cmux-codex-review` 直叩き等）、通知配線なしで対話 review を起動するだけ。既存の使い方を壊さない。
4. **watcher 内包**: `cmux-codex-exec` と同等の `bin/cmux-codex-wait` を review 側にも配置（プラグイン独立性のため重複を許容）。
5. **バージョン**: `1.0.0 → 1.1.0`。`.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` / ルート `marketplace.json` を同期。

### review の完了定義

対話 `/review` は findings を提示後 idle になる。「完了」= codex が findings を提示し終えた時点とし、
codex にその直後の通知送信を指示する。ユーザーはペインを開いたまま追質問できる。

## 境界（重複回避）

| プラグイン | 役割 | 本設計との差分 |
|-----------|------|----------------|
| `cmux-team-dispatch-task` | worktree 隔離の複数タスク並列オーケストレーション | 通知機構は概念的に近いが、こちらは**単発・カレントdir・plan1本**の軽量フロー |
| `cmux-fork` | 会話を新ペインにフォーク | 送信コマンドが codex 実装/レビューに固定 |
| `cmux-codex-review` | codex レビュー起動 | exec はその前段（plan 実装）を担い、完了後に review を呼ぶ |

各 `CLAUDE.md` の「関連プラグインとの境界」表に本プラグインの行を追記する。

## エラーハンドリング

| 事象 | 挙動 |
|------|------|
| cmux 外（`CMUX_SOCKET_PATH` 無し） | bin が明示エラーで中断 |
| `codex` 未インストール | bin が明示エラー |
| plan が見つからない | コマンドが中断し理由提示 |
| 親が agmsg 未参加 | コマンドが join を案内、参加後続行 |
| codex が完了通知を忘れる | watcher timeout（30分）→ 親は「未検知、ペイン確認」で wake |
| watcher 起動失敗 | 親は通知なしで手動確認にフォールバック（ペイン surface を提示） |

## テスト方針

- **静的**: 全 JSON の妥当性、`bash -n`、biome format。
- **bin ロジック**: `cmux` / `send.sh` / `history.sh` をスタブし、plan 解決・プロンプト組み立て・token 埋め込み・引数上書きを検証。
- **watcher**: スタブ history にトークンを注入して `status=done`、注入せず timeout で `status=timeout` を検証。
- **実機（cmux 内・任意）**: 小さな plan で `/codex-exec` → codex が実装 → 通知 → 親 wake → review 起動、までを1回通す。

## 非目標（YAGNI）

- worktree 隔離（カレントdir で足りる）。
- 複数 plan の並列実行（dispatch-task の領分）。
- codex 以外のエンジン対応。
- review findings の構造化パース／集計。
