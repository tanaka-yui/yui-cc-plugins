---
allowed-tools: Bash
description: "agmsg の inbox を確認し、新ペインで codex (gpt-5.6-sol/xhigh) のコードレビューを起動する"
---

# /codex-review

agmsg の受信箱を確認してから、新しい cmux ペインで codex によるコードレビューを起動する。
モデルは **gpt-5.6-sol**、reasoning effort は **xhigh (extra high)**、対象はデフォルトで
**未コミット変更 (`--uncommitted`)**。

## 手順

### Step 1: agmsg の inbox を確認（非ブロッキング）

まず agmsg を起動して受信箱を確認する。未参加・未インストールでもレビュー起動は止めない。

1. 未ブートストラップならブートストラップする:

   ```bash
   if [ ! -d ~/.agents/skills/agmsg ]; then
     installer=$(ls ~/.claude/plugins/cache/fujibee-agmsg/agmsg/*/install.sh 2>/dev/null | head -1)
     [ -n "$installer" ] && bash "$installer" --cmd agmsg
   fi
   ```

2. identity を解決する:

   ```bash
   ~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
   ```

   - `agent=<name> teams=<t1,...>` が返れば、各 team で inbox を確認する:
     `~/.agents/skills/agmsg/scripts/inbox.sh <team> <agent>`
   - `not_joined=true` / agmsg 未インストールなら「agmsg 未参加のためスキップ」と一言添えて Step 2 へ進む。
     ここで team 参加フローには入らない（レビュー起動が主目的）。

3. 未読メッセージがあれば内容を要約して伝える。

### Step 2: codex レビューを新ペインで起動

`$ARGUMENTS` をそのまま bin に渡して実行する（方向・model・effort・対象を上書き可能）。

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" $ARGUMENTS
```

- 引数なし: 右に分割、`gpt-5.6-sol` / `xhigh` で未コミット変更をレビュー。
- `down` / `left` / `up`: 分割方向。
- `--base main`: main との差分をレビュー。
- `-- <指示>`: codex review へのカスタム指示（例: `-- セキュリティ観点を重点的に`）。

### Step 3: 報告

bin が出力する起動サマリ（surface / 方向 / model / effort / 対象）を 1 行で報告する。
codex がレビューを流し始めるので、こちら側でのポーリングは不要。
