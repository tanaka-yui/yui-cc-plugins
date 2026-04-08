# cmux-team-dispatch-task 開発ガイド

cmux ワークスペースを活用した並列タスクディスパッチスキル。
各タスクに独立した git worktree + Claude Code セッションを割り当て、親セッションがオーケストレーションを行う。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `skills/cmux-team-dispatch-task/SKILL.md` | メインスキル定義（8ステップワークフロー） |
| `skills/cmux-team-dispatch-task/references/guide-ja.md` | 日本語リファレンスガイド |
| `skills/cmux-team-dispatch-task/scripts/launch-workspace.sh` | ワークスペース/スプリット起動スクリプト |
| `skills/cmux-team-dispatch-task/scripts/launch-session-splits.sh` | 複数セッション一括起動ラッパー（superpowers 連携用） |
| `skills/cmux-team-dispatch-task/scripts/cmux-grid.sh` | split モード用グリッドレイアウト整列スクリプト |
| `.claude-plugin/plugin.json` | Plugin マニフェスト |
| `README.md` | 人間向けガイド |
| `CLAUDE.md` | この開発ガイド |
| `LICENSE` | MIT ライセンス |

## 言語ルール

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語

## SKILL.md の編集ルール

- **8ステップワークフローの構造を維持する**（Collect → Discover → Route → Plan → Layout → Launch → Monitor → Completion）
- `<this-skill-dir>` はスキルランタイムで SKILL.md の所在ディレクトリに解決される — パスはこのプレースホルダーを基準にする
- **ステータスプロトコル**（status.json / result.md）の仕様変更時は guide-ja.md も同期する
- **スクリプトのオプション追加**時は SKILL.md 内の使用例とスクリプト本体の `usage()` を同期する
- テーブル形式・コード例を多用し、散文は最小限に

## 関連プラグインとの境界

| 観点 | cmux-team-dispatch-task | cmux-team | cmux-using |
|------|------------------------|-----------|-----------|
| 対象 | 独立タスクの並列ディスパッチ | 4層マルチエージェントオーケストレーション | 汎用的な cmux 操作 |
| 実行単位 | 独立したタスク群 | Master→Manager→Conductor→Agent | 単一操作 |
| 隔離 | git worktree（タスクごと） | git worktree（Agent ごと） | なし |
| 永続プロセス | なし（スキルのみ） | daemon（Manager） | なし |

**重複を避ける**: cmux-team 固有の機能（4層管理、daemon）や cmux-using 固有の機能（基本 cmux 操作）を含めない。

## メンテナンス手順

1. `launch-workspace.sh --help` の出力と SKILL.md の使用例を突き合わせて整合性を確認
2. `launch-session-splits.sh --help` の出力と SKILL.md・guide-ja.md の使用例を突き合わせて整合性を確認
3. ステータスプロトコル（status.json スキーマ）が SKILL.md と guide-ja.md で一致しているか確認
4. superpowers 連携セクション（Step 6 の Execution Handoff）が superpowers プラグインの最新仕様と整合しているか確認

## テスト方法

```bash
# plugin.json が有効な JSON か確認
cat .claude-plugin/plugin.json | jq .

# スキルディレクトリ構造の確認
ls -R skills/cmux-team-dispatch-task/

# スクリプトの実行権限確認
ls -la skills/cmux-team-dispatch-task/scripts/
```

### E2E テスト（cmux セッション内で実行）

1. 2つ以上の独立タスクを指定してスキルを発動
2. workspace モード: 各タスクが別タブで起動すること
3. split モード: 各タスクが同一ワークスペース内のペインで起動すること
4. `.dispatch/*/status.json` が更新されること
5. 完了シグナルが正しく発火すること
