---
allowed-tools: Bash
description: "Claude の rules/CLAUDE.md を Codex 用 AGENTS.md にネスト生成する"
---

# /codex-bridge

`.claude/rules/*.md` の frontmatter `codexTargets` に従って各ディレクトリの `AGENTS.md` を生成し、
root `CLAUDE.md` を root `AGENTS.md` に変換する。`--global` 指定時は `~/.claude/CLAUDE.md` を
`~/.codex/AGENTS.md` に変換する（Codex を日本語応答にするため）。

## 実行

引数なし（プロジェクト生成）:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.ts"
```

`$ARGUMENTS` に `--global` が含まれる場合はグローバル生成:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.ts" $ARGUMENTS
```

実行後、生成/スキップ/警告のサマリをユーザーに提示する。手書き（センチネル無し）の `AGENTS.md` は
上書きされずスキップされる点、32KB 超過ファイルは切り捨てリスクがある点を必要に応じて伝える。
