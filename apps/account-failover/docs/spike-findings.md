# 前提の検証結果（Task 0）

検証日: 2026-11-11 / Orca 1.4.255 / Claude Code（Haiku 5.5 で試験）/ Codex CLI 0.167.0 / macOS

## 1. エージェント終了後もペインは残る（成立）

- `orca agent launch --agent claude --surface terminal` で起動したペインでは、`claude` の親プロセスが `-/bin/zsh -l` だった。
- `claude` に SIGTERM を送ると、プロセスは消え、ペインは `connected: true` / `writable: true` のまま残る。
  - その後 `orca terminal send --terminal <handle> --text 'echo ...' --enter` も通る。
  - Claude は終了時に `Resume this session with: claude --resume <session-id>` を表示する。
- Codex も同じ（親は `-/bin/zsh -l`）。
- 注意: `orca agent launch` には `--surface chat` がある。chat として開いたエージェントにはシェルが無いので対象外。ターミナルのペインだけを扱う。
- dispatch の worker も、`orca agent launch` と同じ経路でターミナルとして起動される。

## 2. worker から子プロセスを起動できる（成立）

- trusted-worker の `node:child_process.execFile` で、`orca account list --json` と `/bin/ps -E -ww -Ao pid=,command=` を実行できた。
  - `orca` は worker の PATH から解決できる。
  - ps の出力には、各プロセスの `ORCA_TERMINAL_HANDLE=` が含まれる。
- worker の環境変数:
  - `HOME` はある。
  - `ORCA_CLI_BIN_DIR` と `ORCA_USER_DATA_PATH` は **無い**。そのため Orca のデータフォルダは `<homedir>/Library/Application Support/orca` を既定にする。

## 3. agent.status.changed の中身

- `terminalId` は、プロセスの環境変数 `ORCA_TERMINAL_HANDLE`（`term_...`）と同じ値。
- 応答を終えると `state: "done"` が届く。**同じペインの done が 2〜3 回続けて届く**ため、重複を排除する必要がある。
- 別のペイン（`term_d56bc389-...`）のイベントも届いた。focused なペイン以外の分も届く。
- 実物の payload には `worktreeId` も入っている（型には無い）。

## 4. プラグインの terminal.read は TUI に使えない

- host API の `terminal.read` は、Claude の TUI では描画途中の 1〜5 行しか返さなかった（ストリームを元にしているため）。
- CLI の `orca terminal read --terminal <handle> --screen --json` は、`result.terminal.tail` に現在の画面全体を行ごとに返す。**画面の読み取りは CLI の `--screen` を使う。**

## 5. Claude の resume（別アカウントで成立）

- `claude --resume '<jsonl の絶対パス>' '<prompt>'` で、別アカウント（system）でも会話が引き継がれ、prompt が最初のメッセージとして送られた。
  - 画面の usage 表示が変わったことで、アカウントが替わったことを確認した。
- **Orca の `claude` シェル関数**（`shell-wrappers/*/shell-ready/zsh/.zshenv`）は、起動のたびに `ORCA_CLAUDE_PROFILE_POINTER`（`claude-profiles/selected-host`）を読み、選択中のアカウントの `CLAUDE_CONFIG_DIR` で起動する。中身が空なら system で起動する。
  - そのため、`orca account select` のあとにペインのシェルへ素の `claude ...` を打てば、新しいアカウントで起動する。環境変数の前置きは不要。前置きすると関数の判定が変わる。
- `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` に `pid` / `sessionId` / `cwd` がある。
- transcript は `<home>/projects/<cwd を - に置換>/<sessionId>.jsonl`。managed のプロファイルでは `projects` が `~/.claude/projects` へのリンクになっている。
- **フォルダの信頼確認**: 乗り換え先のアカウントでまだ信頼していないフォルダだと、起動直後に `Quick safety check: Is this a project you created or one you trust?` が出て止まる。
  - 選択肢は `❯ No, exit` / `Yes, I trust this folder` で、番号は無い。↓ と Enter で選ぶ。
- **permission mode**: 元のセッションは bypass だった（リポジトリの `.claude/settings.json` の `defaultMode: bypassPermissions`）。system アカウントでは `manual mode` で起動した。
  - system アカウントは組織が管理する設定を持つ（"Your organization may apply global configuration"）。アカウント側の方針によるもので、起動引数では変えられない。
- Orca から起動した `claude` の ps 上の引数は `claude` だけだった（フラグは設定ファイルから来ている）。

## 6. Codex の resume（rollout をコピーして成立）

- 実行中の codex に `lsof -p <pid> -Fn` を実行すると、`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` が開いている。ロックファイル `<CODEX_HOME>/thread-writer-locks/<uuid>.lock` も開いている。
- rollout を乗り換え先の `CODEX_HOME/sessions/` の同じ相対パスへコピーするだけで、`codex resume <uuid> '<prompt>'` が乗り換え先で会話を引き継いだ。`thread_history_1.sqlite` の操作は不要だった。
  - weekly の残量表示が変わったことで、アカウントが替わったことを確認した。
- `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`: フラグは session id の **前** に置く。`-m` / `-c` / `-s` / `-a` / `--dangerously-bypass-approvals-and-sandbox` を受け付ける。
- **Orca の `codex` シェル関数**は、`-c shell_environment_policy.set.ORCA_*=...` と `--no-daemon` を自動で付ける。
  - ps に見える引数にはこれらが入っているので、resume のときは引き継がずに除く（関数がもう一度付ける）。
  - `CODEX_HOME` は、シェル起動時の値（`ORCA_CODEX_HOME`）で固定されていて、選択に追従しない。
    - managed へ乗り換えるときは `CODEX_HOME='<home>' codex resume ...` にする（zsh では関数にも一時変数が渡る）。
    - system へ乗り換えるときは `(unset CODEX_HOME; codex resume ...)` にする。`env -u` を使うと関数を通らなくなる。
- **hook の信頼確認**: 乗り換え先のアカウントで初めて開くと、`Hooks need review` / `1. Review hooks` / `2. Trust all and continue` / `3. Continue without trusting` が出て止まる。
- ps 上の引数の例: `codex --no-daemon -c shell_environment_policy.set.ORCA_USER_DATA_PATH='/Users/yui/Library/Application Support/orca' ...`。値の中に空白を含む `'...'` があるので、シングルクォートの内側は 1 つのトークンとして分割する。

## 7. limit の文言（実物）

- **Claude**（`~/.claude/projects` の jsonl から収集）:
  - `You've hit your session limit · resets 5:10pm (Asia/Tokyo)`
  - `You've hit your session limit · resets 12:10pm (Asia/Tokyo) (error type rate_limit, HTTP 429, ...)`
  - `You've hit your session limit`（解除時刻なし）
  - 公式ドキュメントの例: `You've hit your weekly limit · resets Mon 12:00am`、`You've hit your Opus limit · resets 3:45pm`
- **Codex**（0.167.0 バイナリの文字列から収集）:
  - `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits`
  - `You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits`
  - `You've hit your usage limit for <model>. Switch to another model now,`
  - 解除時刻: ` or try again at ` / `Try again at ` に続けて、`%b %-d, %Y %-I:%M %p`（例 `Nov 13, 2026 3:45 PM`）または `%-I:%M %p`（例 `3:45 PM`）が付く。
  - 長い行は画面の幅で折り返すので、末尾の行をつなげてから判定する。
- 誤検知に注意: claude-hud の status line は `Usage Weekly ██░░ 19% (resets in 2d 14h)` を常に表示している。`You've hit your` を必須にする。

## 8. 参考

- `orca plugin dev load` は、コードを動かすプラグインでは `--approve ap1-...` を求める。exit 3 の出力に再実行コマンドが含まれる。
- `codex-session-backfill/` には `audit.jsonl` / `backfill-complete.json` があり、Orca が Codex のセッション一覧を取り込むためのものと見られる。乗り換えには使わない。`rate-limit-pty-cwd/` は空。
- 検証のため、system の `~/.codex/sessions/2026/11/11/` へ rollout を 1 件コピーした。system の Claude で、このリポジトリのフォルダを信頼済みにした。
