---
allowed-tools: Bash
description: "agmsg inbox を確認し、新ペインで対話 codex (gpt-5.6-sol/xhigh) にコードレビューさせる"
---

# /codex-review

agmsg の受信箱を確認してから、新しい cmux ペインで**対話 codex** にコードレビューさせる。
モデル **gpt-5.6-sol**、effort **xhigh**、対象はデフォルトで**未コミット変更**。
引数無指定時は Step 0 で候補を提示してユーザーに確認する。
親が agmsg team 参加済みなら、レビュー完了を親へ通知する配線も行う。

## 手順

### Step 0: レビュー対象を確定する

`$ARGUMENTS` の `--` より前の部分に `--uncommitted` / `--base` / `--commit` / `--path` のいずれかが
含まれていれば対象は明示済み。**`--` 以降のカスタムレビュー指示テキストは判定対象から除外する**
（例: `-- セキュリティ観点で --path の使い方を見て` のようなフリーテキストは対象指定とみなさない）。
**何も尋ねずに** Step 1 へ進む。

含まれていなければ候補を列挙する:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" --list-targets
```

出力は 1 行 1 候補の TSV（`target<TAB>kind<TAB>value<TAB>label`）。行数で分岐する:

- **0 行**: 「レビュー対象が検出できませんでした」と伝え、対象のパスかブランチをユーザーに尋ねる。
  回答を `--path <file>` / `--base <branch>` に変換して Step 1 へ。
- **1 行**: そのまま採用する（確認は不要）。`kind=uncommitted` なら `--uncommitted`、`kind=path` なら
  `--path <value>` に変換する。採用した対象は Step 4 の報告に含める。
- **2 行以上**: AskUserQuestion で 1 つ選ばせる。選択肢は次の優先順で最大 4 枠:

| 枠 | 内容 | 変換後の bin 引数 |
|----|------|------------------|
| 1 | 未コミット変更（`kind=uncommitted` の行があれば） | `--uncommitted` |
| 2 | spec 最新（label が `spec /` で始まる先頭行） | `--path <spec>` |
| 3 | plan 最新（label が `plan /` で始まる先頭行） | `--path <plan>` |
| 4 | spec + plan をまとめて（枠 2 と 3 が両方あるときだけ） | `--path <spec> --path <plan>` |

`--list-targets` は spec / plan を各 3 件まで返すが、枠に載せるのは各先頭 1 件だけ。
残りの候補は質問文に列挙し、ユーザーが Other で指定できるようにする。

multiSelect は使わない。bin の対象指定は単一種別なので「未コミット + path」の混在は作れない。
複数ファイルのレビューは枠 4（`--path` の繰り返し）で表現する。

確定した引数は Step 2 の bin 実行にそのまま渡す。

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
- **`suggest=true` が返ったら、このプロジェクトは未参加**。この出力に含まれる `teams=` / `agents=` は
  **他プロジェクトの登録**であり、**そのまま使ってはいけない**（別 team へ誤配線すると codex の通知先と
  watcher の待ち先がズレて、通知が永久に届かない）。ユーザーに確認する:
  - **参加する**: `available_teams=` から選ぶか新規 team 名と、親 agent 名を尋ねて join:
    `~/.agents/skills/agmsg/scripts/join.sh <team> <parent> claude-code "$(pwd)"`
    join できたら、その TEAM / PARENT で Step 2 の通知配線へ進む。
  - **参加しない**: 「agmsg 未参加のため完了通知はスキップ」と添えて通知なしで Step 2 へ。
- `not_joined=true` / 未インストールなら「agmsg 未参加のため通知はスキップ」と添えて Step 2 へ（レビュー起動は止めない）。

### Step 2: 通知を配線するか決める

`<TARGET_ARGS>` は Step 0 で確定した対象引数（`--uncommitted` / `--base <branch>` / `--commit <sha>` /
`--path <file>...`。Step 0 をスキップした＝ユーザーが既に対象を明示していた場合は空）。
**`$ARGUMENTS` は必ず最後に置くこと。`--` 以降はカスタムレビュー指示として吸われ、後続のフラグが解釈されなくなるため。**

- 親が team 参加済み: reviewer agent を pre-join し（送信元登録）、bin に通知引数を渡す。
  ```bash
  # surface 確定前なので reviewer 名は起動後に join する。まず起動:
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" <TARGET_ARGS> --team <TEAM> --reviewer <REVIEWER> --parent <PARENT> $ARGUMENTS
  ```
  `<REVIEWER>` は `cxrev-review` 等の一意名。bin 出力の `token=`/`surface=` を記憶。
  起動後すぐ reviewer を join:
  `~/.agents/skills/agmsg/scripts/join.sh <TEAM> <REVIEWER> codex "$(pwd)"`
- 未参加: 通知なしで起動（後方互換）:
  ```bash
  "${CLAUDE_PLUGIN_ROOT}/bin/cmux-codex-review" <TARGET_ARGS> $ARGUMENTS
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
Step 0 で候補から自動採用した場合は、どの対象を選んだかも明記する。
