# dev-up

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

worktree ごとに隔離された開発スタックのライフサイクル管理。`.dev-up.yaml` を読み込み、
Docker Compose スタックと直接コマンド（Go サーバー、Vite dev サーバーなど）を、
worktree ごとのポート隔離のもとでオーケストレーションする。

## サブコマンド

| サブコマンド | 説明 |
|------------|-------------|
| `setup`    | リポジトリを調査して `.dev-up.yaml` を生成する。**LLM 駆動。** `references/setup-guide.md` を読んで従うこと。 |
| `up`       | スロットを予約し、`.env.dispatch` を生成し、`depends_on` の順にすべてのサービスを起動し、smoke test を実行し、URL を表示する。 |
| `down`     | すべてのサービスを逆順で停止する（コマンドは SIGTERM → 5 秒 → SIGKILL、compose は `docker compose down`）、スロットを解放する。 |
| `status`   | 現在のスロット、稼働中サービス、PID の生存、URL を表示する。 |
| `urls`     | URL テーブルのみを表示する。 |

## CLI フラグ

| フラグ | 効果 |
|------|--------|
| `--slot-range MIN-MAX` | `.dev-up.yaml` の `slot_range` をこの実行だけ上書きする。例: `dev-up up --slot-range 1-20`。 |

## 呼び出し方

どの worktree からでも:

```bash
# セットアップ（初回のみ — LLM 駆動）
bash <skill-dir>/scripts/setup.sh        # 手順を表示する。Claude に進行させること

# 操作
bash <skill-dir>/scripts/compose-up.sh
bash <skill-dir>/scripts/compose-up.sh --slot-range 1-20
bash <skill-dir>/scripts/compose-down.sh
bash <skill-dir>/scripts/status.sh
bash <skill-dir>/scripts/urls.sh
```

このスキルはプロジェクト非依存。各プロジェクトは以下を持つべき:

- `.dev-up.yaml`（`setup` が作成）
- `.env.dispatch`、`.e2e-results/`、`.e2e-scenarios/`、`.dev-up-logs/` 用の `.gitignore` エントリ

## ポート割り当て

`.dev-up.yaml` の各サービスについて、スロット N のホストポートは次のとおり:

```
port = base + (offset_per_slot * N)
```

デフォルト: `slot_range: [1, 9]`、`offset_per_slot: 100`。メインの worktree（環境変数未設定）は
デフォルトの `base` 値を保持するため、既存のワークフローは変更なく動作し続ける。

## スロットレジストリ

予約情報は `~/.cache/cc-skills/dev-up/<project>/slots/<N>/` に置かれる:

- `owner.json`: pid、worktree のパス、compose_project、reserved_at
- `processes.json`: `type: command` の各サービスについて pid/pgid/log_file/depends_on

`slots/<N>/` を作成する `mkdir` 操作はアトミックなので、並行した予約が衝突することはない。
zombie sweep は `reserve-slot` の開始時に毎回実行され、worktree が削除された、または
プロセスがすべて死んでいるスロットを回収する。

## cmux-team-dispatch-task との連携

dispatch タスクの description には以下を含めるべき:

> Bash で動作確認する際は `bash <skill-dir>/scripts/compose-up.sh` を実行すること。
> 完了直前に `bash <skill-dir>/scripts/compose-down.sh` を実行してコンテナを停止しスロットを解放すること。
> URL 一覧を result.md の "## Verification URLs" セクションに転記すること。

`cmux-team-dispatch-task` 自体は変更しない — 連携はプロンプトのみを通じて行う。

## 失敗モード

| 状況 | 挙動 |
|-----------|----------|
| `.dev-up.yaml` が無い | Exit 1、`setup` を実行するヒントとともに。 |
| `yq` 未インストール | Exit 1、`brew install yq` のヒントとともに。 |
| 全スロットが使用中 | Exit 1、`--slot-range` の拡張についてのヒントとともに。 |
| `docker compose up` が失敗 | スロットは予約されたまま。手動での `down` が必要。 |
| `command` サービスが起動直後に死ぬ | Exit 1、ログファイルのパスを表示。 |
| `health_check` タイムアウト | Exit 1、ログファイルのパスを表示。以降の `down` が部分起動をクリーンアップする。 |
| `depends_on` の循環 | `topo-sort` から Exit 1、循環しているペアを表示。 |
| Smoke test 失敗 | WARN のみ、exit 0 を維持。 |
| `down` せずに worktree が削除された | 次回の `up` で zombie sweep がスロットを回収する。 |

## 依存関係

- `yq`（Go 版、`mikefarah/yq`）
- `jq`
- `docker`（`type: docker-compose` を使うサービスがある場合のみ）
- `tsort`（POSIX、coreutils に含まれる）
- `setsid` または `perl`（セッションリーダー用）
- `curl`、`nc`（ヘルスチェック用）
- Optional: `pg_isready`（postgres の smoke）、`redis-cli`（redis の smoke）
