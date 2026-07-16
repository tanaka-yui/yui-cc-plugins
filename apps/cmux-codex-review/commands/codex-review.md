---
allowed-tools: Bash
description: "agmsg inbox を確認し、新ペインで対話 codex (gpt-5.6-sol/xhigh) にコードレビューさせる"
---

# /codex-review

agmsg の受信箱を確認してから、新しい cmux ペインで**対話 codex** にコードレビューさせる。
モデル **gpt-5.6-sol**、effort **xhigh**、対象はデフォルトで**未コミット変更**。
親が agmsg team 参加済みなら、レビュー完了を親へ通知する配線も行う。

## 手順

### Step 1: agmsg identity を解決し inbox を確認（非ブロッキング）

```bash
if [ ! -d ~/.agents/skills/agmsg ]; then
  installer=$(ls ~/.claude/plugins/cache/fujibee-agmsg/agmsg/*/install.sh 2>/dev/null | head -1)
  [ -n "$installer" ] && bash "$installer" --cmd agmsg
fi
~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
```

- `agent=<parent> teams=<team,...>` が返れば PARENT / TEAM を記憶し、各 team の inbox を確認:
  `~/.agents/skills/agmsg/scripts/inbox.sh <team> <parent>`
- `not_joined=true` / 未インストールなら「agmsg 未参加のため通知はスキップ」と添えて Step 2 へ（レビュー起動は止めない）。

### Step 2: 通知を配線するか決める

- 親が team 参加済み: reviewer agent を pre-join し（送信元登録）、bin に通知引数を渡す。
  ```bash
  # surface 確定前なので reviewer 名は起動後に join する。まず起動:
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" $ARGUMENTS --team <TEAM> --reviewer <REVIEWER> --parent <PARENT>
  ```
  `<REVIEWER>` は `cxrev-<n>` 等の一意名。bin 出力の `token=`/`surface=` を記憶。
  起動後すぐ reviewer を join:
  `~/.agents/skills/agmsg/scripts/join.sh <TEAM> <REVIEWER> codex "$(pwd)"`
- 未参加: 通知なしで起動（後方互換）:
  ```bash
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" $ARGUMENTS
  ```

> reviewer 名は bin 起動前に決めた固定名（例 `cxrev-review`）でよい。surface 由来 token とは別に、
> reviewer agent 名は人間可読の固定名で pre-join しても send.sh は成立する。

### Step 3: 通知配線時のみ watcher を起動して待機

**Bash tool を `run_in_background: true` で**:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-wait" <TEAM> <PARENT> <token> --timeout 1800
```

起動したらターンを終える。`status=done` で wake されたら「レビュー完了」を伝える。
`status=timeout` ならペイン `<surface>` の確認を促す。

### Step 4: 報告

bin の起動サマリ（surface / 方向 / model / effort / 対象）を 1 行で報告する。
