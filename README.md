# yui-cc-plugins

cmux ターミナルマルチプレクサ向けツール集。

## インストール（プラグイン）

```bash
# マーケットプレイスを登録して個別インストール
/plugin marketplace add tanaka-yui/yui-cc-plugins
/plugin install cmux-fork@yui-cc-plugins
/plugin install cmux-using@yui-cc-plugins
/plugin install cmux-team-dispatch-task@yui-cc-plugins
/plugin install cmux-codex-review@yui-cc-plugins
/plugin install cmux-codex-exec@yui-cc-plugins
/plugin install dev-up@yui-cc-plugins
/plugin install e2e-test@yui-cc-plugins
/plugin install token-meter@yui-cc-plugins

# または一括インストール
bash install.sh
```

> **既にマーケットプレイスを登録済みの環境**で新しいプラグインが一覧に出ない場合は、カタログを更新する:
> ```bash
> claude plugin marketplace update yui-cc-plugins
> ```
> `/reload-plugins` はインストール済みプラグインの再読込のみで、マーケットプレイスのカタログは更新しない。

> **`cmux-team` は廃止されました。** 既にインストール済みの環境では手動で削除してください:
> ```bash
> claude plugin uninstall cmux-team@yui-cc-plugins
> ```

---

## 一覧

### Plugins

| プラグイン | 概要 | 詳細 |
|-----------|------|------|
| cmux-fork | 会話を新しい cmux ペインにフォーク | [README](apps/cmux-fork/README.md) |
| cmux-using | cmux 操作スキル（サブエージェント起動・監視） | [README](apps/cmux-using/README.md) |
| cmux-team-dispatch-task | 並列タスクディスパッチ（worktree 分離） | [SKILL](apps/cmux-team-dispatch-task/SKILL.md) |
| cmux-codex-review | 新 cmux ペインで対話 codex にコードレビューさせる（workspace-write・完了通知可） | [README](apps/cmux-codex-review/README.md) |
| cmux-codex-exec | plan を対話 codex に実装させ、完了を親が agmsg 経由で検知してレビューへ繋ぐ | [README](apps/cmux-codex-exec/README.md) |
| dev-up | worktree 分離された dev stack ライフサイクル（compose + 直接コマンド） | [README](apps/dev-up/README.md) |
| e2e-test | agent-browser ベースの E2E テスト（dev-up と連携） | [README](apps/e2e-test/README.md) |
| token-meter | hook 経由で圧縮プラグイン (rtk/caveman/headroom) の効きを観測・JSONL 集計 | [README](apps/token-meter/README.md) |
