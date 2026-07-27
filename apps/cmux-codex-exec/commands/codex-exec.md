---
allowed-tools: Bash
description: "plan を対話 codex にカレントdir で実装させ、完了を agmsg 経由で待って通知する"
---

# /codex-exec

claude/superpowers が作成した plan を、新しい cmux ペインで**対話 codex**（gpt-5.6-sol / xhigh）に
実装させる。codex は完了時に agmsg で通知し、親（このセッション）は短命 watcher の完了で wake される。

## 手順

### Step 0: 実装対象の plan を確定する

`$ARGUMENTS` に plan のパス（`.md` で終わる位置引数）が含まれていれば、それを使う。
**何も尋ねずに** Step 1 へ進む。

含まれていなければ候補を列挙する:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-exec" --list-targets
```

出力は 1 行 1 候補の TSV（`target<TAB>plan<TAB><path><TAB><label>`）。行数で分岐する:

- **0 行**: 「plan が見つかりません」と伝え、plan のパスをユーザーに尋ねる。
- **1 行以上**: **候補が 1 件でも必ず** AskUserQuestion で確認する。選択肢は候補の上位 3 件
  （label の `committed` / `untracked` と更新時刻を description に添える）。該当が無ければ
  ユーザーは Other でパスを指定できる。

exec は誤った plan を掴むとリポジトリを書き換えるため、review と違って 1 件でも確認を省かない。

確定した plan パスは Step 2 の bin 実行に**明示的に**渡す（bin 側の mtime 最新フォールバックに委ねない）。

### Step 1: agmsg identity を解決

```bash
~/.agents/skills/agmsg/scripts/whoami.sh "$(pwd)" claude-code
```

- `agent=<parent> teams=<team,...>` が返れば PARENT / TEAM を記憶。複数 team なら使う team をユーザーに確認。
- `not_joined=true` / `suggest=true` なら、ユーザーに team 名と親 agent 名を尋ねて join:
  `~/.agents/skills/agmsg/scripts/join.sh <team> <parent> claude-code "$(pwd)"`

### Step 2: bin を実行して codex ペインを起動

Step 0 で確定した plan パスと `$ARGUMENTS`（`-d down` 等）に `--team <TEAM> --parent <PARENT>` を
足して実行する:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-exec" <PLAN> $ARGUMENTS --team <TEAM> --parent <PARENT>
```

Step 0 をスキップした（＝ `$ARGUMENTS` に plan パスが既に含まれている）場合は `<PLAN>` は付けず、
`$ARGUMENTS` のみを渡す。

出力の `token=` / `codex_agent=` / `surface=` / `plan=` を記憶する。

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
  Yes なら対象を明示して `/codex-review --uncommitted`（cmux-codex-review）を起動する
  （ユーザーは既に対象を回答済みのため、Step 0 で候補を再度尋ねさせない）。
- `status=timeout`: 「codex の完了を検知できませんでした。ペイン `<surface>` を確認してください」と伝える。
