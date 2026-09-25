# cmux-e2e

cmux の表示中ブラウザを使う E2E テスト実行基盤です。

## Output Language

ユーザー向けの質問、選択肢、表、進捗報告は日本語で表示する。

## コマンド

| コマンド | 用途 |
| --- | --- |
| `up [--profile <name>]` | この worktree のブラウザサーフェスを作成または再利用する。 |
| `auth save <name> [--check-url <url> --check-selector <css>]` | state と任意の有効性確認条件を保存する。検証フラグは両方指定する。 |
| `auth load|check|list|delete <name>` | 保存済み state の適用、確認、列挙、削除を行う。 |
| `run <scenario> [--auth <name>] [--allow-js-errors] [--no-guard]` | シナリオを実行し、証跡を集約する。 |
| `down [--sweep]` | 記録済みのブラウザサーフェスを閉じる。 |

## 呼び出し方

スクリプトは `PATH` に追加されない。プラグインのディレクトリから次のように呼び出す。

```bash
bash "<PLUGIN_ROOT>/skills/cmux-e2e/scripts/up.sh"
bash "<PLUGIN_ROOT>/skills/cmux-e2e/scripts/auth.sh" save admin --check-url "http://localhost:5173/home" --check-selector "#avatar"
bash "<PLUGIN_ROOT>/skills/cmux-e2e/scripts/run.sh" login-flow --auth admin
bash "<PLUGIN_ROOT>/skills/cmux-e2e/scripts/down.sh"
```

`<PLUGIN_ROOT>` はこのプラグインのインストール先。Bash ツールへこれを運ぶ環境変数は無いので、一度だけ
解決し、その実パスを書き込む。

- Claude Code: スキル起動時に表示される `Base directory for this skill` の 2 階層上。
- Codex: スキル一覧が示すこの SKILL.md の置き場所（ディレクトリ）の 2 階層上。
- その行が無い Claude Code: `jq -er '.plugins["cmux-e2e@yui-cc-plugins"][0].installPath' ~/.claude/plugins/installed_plugins.json`。

plugin cache の下から新しそうな版のディレクトリを選ばない（古い版が残っている）。開発用リポジトリの
checkout へフォールバックしない。どちらもインストール済みとは別の版を走らせる。上のどれでも解決できなければ、
止まってユーザーへ伝える。

## 安全性

ブラウザ操作では必ず `--surface <ref>` を使う。サーフェスは UUID で追跡し、ロックは自動回収しない。シナリオ実行中にサーフェスを閉じないこと。

## シナリオ契約

シナリオは `.cmux-e2e-scenarios/<name>.sh` に置き、`cmux-e2e-browser` を呼ぶ。成果物は `.cmux-e2e-results/<name>/` に置かれる。

## シナリオファイルのテンプレート

```bash
#!/usr/bin/env bash
set -euo pipefail

cmux-e2e-browser goto "http://localhost:${VITE_PORT}/login"
cmux-e2e-browser wait --load-state complete --timeout-ms 10000
cmux-e2e-browser snapshot --interactive > "$RESULTS_DIR/01-login.txt"
```

シナリオには `CMUX_E2E_SURFACE`、`WORKTREE_ROOT`、`RESULTS_DIR` が渡される。

## CLI 呼び出しの規約

`--surface <ref>` と `--selector` などの名前付きフラグを使う。タイムアウトは `--timeout-ms` を使い、
stderr ではなく cmux の終了コードで分岐する。browser `import` は呼び出さない。

## 関連スキル

ブラウザ操作と認証の詳細は `cmux-browser` スキルを読む。ヘッドレス CI 向けには `e2e-test` を使う。

## 環境

`.env.dispatch` がある場合は source せず data として読む。シナリオへ渡るのは
`COMPOSE_PROJECT_NAME`、`PROJECT`、`SLOT`、`*_PORT` のみである。

## 認証

`up` の後に可視サーフェスでログインし、両方の検証フラグ付きで `auth save <name>` を実行する。
`run --auth <name>` は digest と検証条件を確認してから state を適用する。

## 成果物

成果物にはセッション情報が含まれうる。共有前に内容を確認すること。利用側プロジェクトでは
`.cmux-e2e-scenarios/` と `.cmux-e2e-results/` を `.gitignore` に追加する。

## 失敗モード

exit `2` は引数エラー、exit `1` はサーフェス・ロック・シナリオ・証跡収集・未許可の JavaScript エラーを表す。
