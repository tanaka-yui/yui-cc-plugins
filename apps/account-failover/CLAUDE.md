# account-failover

Claude / Codex のセッションが利用上限（limit）で止まったら、Orca の別アカウントへ切り替え、**同じペイン**で同じ会話を resume して作業を続けさせる Orca プラグイン（`trusted-worker`）。Claude Code プラグインではない。

- 設計: `docs/superpowers/specs/2026-11-11-account-failover-design.md`
- 実装計画: `docs/superpowers/plans/2026-11-11-account-failover.md`
- 実環境での検証結果（文言・パス・Orca のシェル関数の挙動）: `docs/spike-findings.md`

## Make

| ターゲット | 内容 |
|-----------|------|
| `make install` | Orca にインストール。インストール済みなら更新。承認が要るときは権限を表示し、`[y/N]` で確認してから `--approve` を付ける |
| `make dev` | `orca plugin dev watch .`。保存するたびにリロードされ、ログが流れる。Ctrl-C で外れる |
| `make test` | `orca plugin test .`（`src/*.test.ts` を node:test で実行） |
| `make check` | `orca plugin types .` → `tsc --noEmit` → biome |
| `make validate` | マニフェストの検証 |

## 流れ（`src/failover.ts`）

1. `agent.status.changed` で working 以外になったペインの画面を `orca terminal read --screen` で読む。limit の文言が無ければ、ここで終わる（`src/limit-detect.ts`）。
2. そのペインのエージェントのプロセスを 1 つに特定する（`src/agent-process.ts`）。条件は次の 3 つで、候補がちょうど 1 つのときだけ進む。
   - 環境変数 `ORCA_TERMINAL_HANDLE` がペインのハンドルと一致する
   - 親がシェルである
   - 同じ tty に Orca がペインを開いた `/usr/bin/login` がいる
3. 画面の判定は、そのプロセスの種類（claude / codex）の文言で行う。
4. session を解決する。
   - Claude: `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` → `projects/*/<id>.jsonl`。
   - Codex: `lsof` で開いている rollout から取る。
5. **Claude は transcript の末尾を照合する。** 最後の user / assistant エントリが `isApiErrorMessage: true` かつ `error: "rate_limit"` のときだけ本物の limit とみなす。そのエントリの uuid を、同じ limit かどうかの目印にする。
6. 同じペインで 1 時間に 3 回乗り換えていたら、通知して止める。
7. cooldown を記録し、次のアカウントを選ぶ（`src/accounts.ts`。`orca account list` の順で、system は最後）。全部 cooldown 中なら、一番早い解除まで待つ。
8. `orca account select` を実行する。失敗したら、プロセスには触らずに通知する。
9. プロセスだけを止める（SIGTERM → SIGKILL）。**ペインは閉じない。**
10. Codex は、rollout を乗り換え先の `CODEX_HOME/sessions/` に上書きでコピーする。A → B → A と戻ったときに、古い rollout で resume しないため。
11. 同じペインのシェルに resume コマンドを打ち込む（`src/resume-command.ts`）。打ち込みが拒否されたら通知する。
12. 20 秒後に結果を確かめる。
    - フォルダや hook の信頼確認で止まっていたら、通知する（自動では答えない）。
    - 新しいエージェントのプロセスが起動していなければ、失敗として通知する。
    - 起動していれば、成功を通知する。
13. 同じペインで同じ内容の通知は、繰り返し出さない。

## 守っている前提と、その理由

- **ペインを保つ。** orca-team-dispatch-task は親と worker をターミナルハンドルで識別している（worker プロンプトの `--from <handle>`、`workers.json`、`run.json`、`orca-recover.ts`）。ハンドルが変わると dispatch が壊れるので、同じペインで続ける。
- **Claude の resume コマンドに環境変数を付けない。** Orca の `claude` シェル関数は、起動のたびに `claude-profiles/selected-host` を読み、選択中のアカウントの `CLAUDE_CONFIG_DIR` で起動する。`orca account select` のあとに素の `claude` を打てば足りる。
- **Codex は `CODEX_HOME` を明示する。** シェル起動時の値で固定されているため。
  - managed へ乗り換えるとき: `CODEX_HOME='<home>' codex resume ...`
  - system へ乗り換えるとき: `(unset CODEX_HOME; codex resume ...)`。`env -u` を使うと Orca の `codex` 関数を通らなくなる。
- **起動フラグはホワイトリストで引き継ぐ**（`src/config.ts`）。ps のコマンドラインは引数の境界を失う（prompt の空白や `'` を復元できない）ため。
  - Orca の codex 関数が付け直す `--no-daemon` と `-c shell_environment_policy.*` は除く。
  - **見るのは先頭のフラグ列だけ。** フラグでない最初の語（prompt）で止める。prompt 本文に書かれた権限フラグを拾わないため（issue 本文などの外部の文章を含む dispatch の worker で、権限を上げられないように）。
  - パスを値に取るフラグ（`--plugin-dir` など）は、ps ではパスの空白で値が分かれる。そのため、**ディスク上に実在するパスになる最長の語の並び**だけを値とする。確かめられなければ、prompt との境目が分からないので、そこで読み取りをやめる（後ろの権限フラグは引き継がない側に倒す）。
- **画面の文言だけで乗り換えない。**
  - Claude の TUI は、モデルの返答が limit の文言と同じだと、エラーと同じ見た目（`⎿` と `/usage-credits` の案内）で表示する。そのため transcript で照合する。resume したセッションが過去の limit を描き直しても、transcript の最後は新しいやり取りになるので、拾わない。
  - Codex は、エラー行の印 `■` で始まる行から後ろだけを見る（本文は `•`）。`■` の後ろに本文（`•`）が続いていれば、limit の後に作業が再開しているとみなして拾わない。
- **別のプロセスを止めない。** tmux や nvim の `:terminal` の中のエージェントは、環境変数のハンドルが同じでも、tty に login がいないので外れる。入れ子で同じペインに 2 つ以上いるときも何もしない。
  - 前提: Orca がペインを `/usr/bin/login` 経由で開くこと（`config.ts` の `PANE_SESSION_LEADER`）。
- **同じ limit の再判定。** 解除待ちの後に、同じプロセスで同じ limit を読み直したときは、cooldown を足さない。時計の時刻だけの解除時刻は、読み直すと翌日に繰り上がるため。Codex は、同じ表示かどうかを解除時刻の日単位の余りで比べる。
- **ループを防ぐ。** 同じペインで 1 時間に 3 回を超えて乗り換えたら、通知して止める。

## 文言が変わったとき

limit の文言は CLI の版で変わりうる。変わったら `src/config.ts` の `CLAUDE_LIMIT_PATTERN` / `CODEX_LIMIT_PATTERN` / `CODEX_RESET_PATTERN` / `BLOCKING_DIALOG_PATTERNS` を直し、`src/limit-detect.test.ts` に実物の文言を足す。

- Claude: 本物の limit は transcript に `isApiErrorMessage: true` として残る。`grep -rh '"isApiErrorMessage":true' ~/.claude/projects | grep "hit your"` で集める。
- Codex: バイナリの文字列から集める（`docs/spike-findings.md` の 7 節）。

## 未検証

- 本物の limit での通しの乗り換え。部品は実環境で確かめた（kill → 同じペインでの別アカウント resume、Codex の rollout のコピー、イベントの購読、画面の読み取り、transcript の照合による誤検知の除外）が、手順全体は単体テストだけで確かめている。
