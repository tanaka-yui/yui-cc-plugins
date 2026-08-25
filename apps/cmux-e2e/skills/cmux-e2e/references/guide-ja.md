# cmux-e2e

cmux の表示中ブラウザを使う E2E テスト実行基盤です。

## コマンド

| コマンド | 用途 |
| --- | --- |
| `up [--profile <name>]` | この worktree のブラウザサーフェスを作成または再利用する。 |
| `auth save|load|check|list|delete` | 検証付きブラウザ state を管理する。 |
| `run <scenario> [--auth <name>]` | シナリオを実行し、証跡を集約する。 |
| `down [--sweep]` | 記録済みのブラウザサーフェスを閉じる。 |

## 安全性

ブラウザ操作では必ず `--surface <ref>` を使う。サーフェスは UUID で追跡し、ロックは自動回収しない。シナリオ実行中にサーフェスを閉じないこと。

## シナリオ契約

シナリオは `.cmux-e2e-scenarios/<name>.sh` に置き、`cmux-e2e-browser` を呼ぶ。成果物は `.cmux-e2e-results/<name>/` に置かれる。

## 関連スキル

ブラウザ操作と認証の詳細は `cmux-browser` スキルを読む。ヘッドレス CI 向けには `e2e-test` を使う。
