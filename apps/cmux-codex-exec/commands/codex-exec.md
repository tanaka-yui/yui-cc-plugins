---
allowed-tools: Bash
description: "plan を対話 codex にカレントdir で実装させ、完了を agmsg 経由で待って通知する"
---

# /codex-exec

claude/superpowers が作成した plan を、新しい cmux ペインで**対話 codex**（gpt-5.6-sol / xhigh）に
実装させる。codex は完了時に agmsg で通知し、親（このセッション）は短命 watcher の完了で wake される。

## 手順

### Step 1: agmsg identity を解決

```bash
~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
```

- `agent=<parent> teams=<team,...>` が返れば PARENT / TEAM を記憶。複数 team なら使う team をユーザーに確認。
- `not_joined=true` / `suggest=true` なら、ユーザーに team 名と親 agent 名を尋ねて join:
  `~/.agents/skills/agmsg/scripts/join.sh <team> <parent> claude-code "$(pwd)"`

### Step 2: bin を実行して codex ペインを起動

`$ARGUMENTS`（任意の plan パスや `-d down` 等）に `--team <TEAM> --parent <PARENT>` を足して実行:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-exec" $ARGUMENTS --team <TEAM> --parent <PARENT>
```

出力の `token=` / `codex_agent=` / `surface=` を記憶する。

### Step 3: 送信元 codex agent を team に pre-join

codex が完了通知（send.sh）を撃てるよう、`codex_agent` を team に登録する（agmsg 1.1.8 は未登録 from を拒否）:

```bash
~/.agents/skills/agmsg/scripts/join.sh <TEAM> <codex_agent> codex "$(pwd)"
```

### Step 4: 短命 watcher を background task で起動して待機

**Bash tool を `run_in_background: true` で** 次を起動する（token は Step 2 の出力値）:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-wait" <TEAM> <PARENT> <token> --timeout 3600
```

起動したらこのターンを終える。watcher の完了通知（`<task-notification>`）で親が wake される。

### Step 5: wake 後の分岐

watcher task の出力を確認する:

- `status=done`: 「codex-exec 完了（plan: …）。未コミット変更を codex-review でレビューしますか?」とユーザーに確認。
  Yes なら `/codex-review`（cmux-codex-review）を起動。
- `status=timeout`: 「codex の完了を検知できませんでした。ペイン `<surface>` を確認してください」と伝える。
