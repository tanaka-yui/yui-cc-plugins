# account-failover 設計

Claude / Codex のアカウントが利用上限（limit）に当たったとき、Orca のアカウント切り替えで別アカウントへ移り、止まったセッションを `--resume` で引き継いで作業を続けさせる Orca プラグイン。

## 意図と背景

ユーザーは Claude と Codex の両方を設計・実装・レビューに日常的に使っている（例: 実装やレビューに Codex、設計やレビューに Claude）。どちらかが limit に当たると作業がそこで止まる。ユーザーはその場にいるときも、夜間に回しっぱなしで誰も見ていないときもある。どちらの場合でも、人の操作なしに次を行ってほしい:

1. 別アカウントへ自動で切り替える
2. 止まったセッションを `--resume` で会話の続きから引き継ぐ
3. 作業を最後まで進める

親セッション自身が limit で止まると、親は自分の停止を検知できない。そのため、検知はセッションの外側（Orca 側）で常駐して行う必要がある。

## ゴール

- Orca 上で動く **すべての** Claude / Codex セッションを対象にする（orca-team-dispatch-task の親・worker、ユーザーが手で開いたセッションを区別しない）。
- limit で止まったセッションを検知し、同じ種類（claude / codex）の別アカウントへ切り替え、同じ会話を resume して作業を続けさせる。
- 夜間など無人でも完結する。
- 何が起きたかを後から追えるようにする。

## 非ゴール

- limit に当たる前の予防的な切り替え（85% 警告での先回りなど）。
- limit に当たっていない、同じアカウント上の他のセッションの移動。
- アカウントの追加・ログイン（`orca account add` はユーザーが手で行う）。
- limit 以外の API エラー（overloaded、server_error など）からの復旧。
- Orca 以外の端末（素の Terminal.app など）で動くセッション。

## アンチゴール（動いても失敗とみなすもの）

- **同じセッションを 2 つのプロセスで同時に resume すること。** Claude の公式ドキュメントにある通り、メッセージが混ざって会話が壊れる。古いプロセスを確実に終わらせてから resume する。
- limit ではないもの（ユーザー自身の Ctrl+C、通常の完了、他のエラー）を limit と誤検知して、セッションを勝手に閉じて起動し直すこと。
- 全アカウントが上限のときに、切り替えと再起動を延々と繰り返すこと。
- 会話を引き継がずに、新しい空のセッションで再開すること（引き継ぎに失敗したら、黙って作り直さずに通知して止まる）。

## 調査で分かった前提・制約

### Orca CLI（Orca 1.4.255 で確認）

- `orca account list [--agent claude|codex] [--json]` / `orca account select --agent <claude|codex> --account <id|email|label|system> [--json]` が存在する。
- **選択が効くのは、そのあとに起動したエージェントだけ**（ヘルプの記述）。動作中のセッションのアカウントは変わらない。そのため「古いセッションを終わらせる → 切り替える → resume で起動し直す」の流れになる。
- 選択はホスト全体に効く（ステータスバーのアカウント切り替えと同じ）。
- 現状の登録はそれぞれ 1 アカウント（＋`system`）。`system` は別契約なので、現状でも 2 アカウント間で乗り換えられる。さらに増やすときは、ユーザーが `orca account add` で足す。
- ペインを閉じる操作は `orca terminal close`、出力の読み取りは `orca terminal read`。

### orca-team-dispatch-task との関係

dispatch は親・worker をターミナルのハンドルで識別している（`apps/orca-team-dispatch-task/bin/orca-start.ts` の worker プロンプト、`workers.json`、`run.json`、`orca-recover.ts`）。乗り換えでハンドルを変えないことが前提になる。

### アカウントごとの保存場所

- Claude: Orca は `CLAUDE_CONFIG_DIR=~/Library/Application Support/orca/claude-profiles/<account-id>/home` で起動する。既存プロファイルでは `projects` → `~/.claude/projects` がシンボリックリンクになっていて、会話の記録（`projects/<project>/<session-id>.jsonl`）がアカウント間で共有されている。新しく追加したアカウントでも同じリンクが張られるかは未確認。
- Claude 公式: `claude --resume /絶対パス/<session-id>.jsonl` で jsonl を直接指定できる。履歴フォルダが共有されているかどうかに依存しない確実な方法。
- Codex: `CODEX_HOME=~/Library/Application Support/orca/codex-accounts/<account-id>/home`。`sessions/` はアカウントごとの実ディレクトリで共有されていない。`thread_history_1.sqlite` もアカウントごとにある。別アカウントでそのまま `codex resume <id>` しても見つからない見込み。

### limit の検知手段

- Claude の TUI は `You've hit your session limit · resets 3:45pm`、`You've hit your weekly limit · resets Mon 12:00am`、`You've hit your Opus limit · resets 3:45pm` の形式で表示する（公式 errors ドキュメント）。解除時刻は必ず含まれ、時刻または曜日＋時刻の形式。
- Claude Code には `StopFailure` hook がある。API エラーでターンが終わったときに発火し、`error: "rate_limit"` と共通入力の `session_id` / `cwd` を受け取れる。止める・再開するといった操作はできない。解除時刻のフィールドはない。
- Codex には limit 用の hook がなく、表示される文言もドキュメントにない。画面の読み取りで判定する。文言は実物から確定する。

### Orca プラグイン（`orca skills get orca-plugin-authoring` で確認）

- `trusted-worker` プロファイルの `main`（Node。`.ts` は Orca が変換する）が Orca アプリ内で常駐する。
- イベント `agent.status.changed`（`agent:read`）: `{ workspaceId, paneKey, terminalId?, title?, state: working|blocked|waiting|done, mainAgent?: { state, outcome?: success|failure|... } }`。
- worker の host API: `terminal.read`（最大 2000 行）、`terminal.create({ workspaceId, command })`、`terminal.sendText`、`agent.launch({ workspaceId, agent, prompt })`、`agents.list`、`workspace.list`、`notifications.show`、`storage.*`、`statusBar.update`、`settings.*`。
- hook: `agent.launch.before` で起動コマンドの書き換えや env の追加ができる（保存済みセッションの復元は対象外）。
- **アカウント選択と terminal close の host API はない。** worker から `orca` CLI を子プロセスで呼ぶ想定。trusted-worker から子プロセスを起動できるかは未確認。
- インストール: `orca plugin install <dir|owner/repo[@ref]|git-url>`。コードを動かすプラグインは `approval_required` で止まるので、`--approve <fingerprint>` を付けて再実行する。開発中は `orca plugin dev watch <dir>` でリロードできる。
- **id は `orca-` で始められない**（公式カタログ専用）。

### Orca 内部に既存機能の可能性

- `~/Library/Application Support/orca/rate-limit-pty-cwd`（現状は空）と `codex-session-backfill` があり、Orca が rate limit やセッションの引き継ぎを内部で扱っている可能性がある。ビルダーは実装前に確認し、使えるなら使う。

## 決めたこと

### ユーザーが決めたこと

- 対象は Orca 上の全セッション（親を含む）。
- 自動で切り替え、セッションを引き継いで続ける。人がいてもいなくても同じ動作。
- 置き場所はこのリポジトリの `apps/<name>`。
- 乗り換えたセッションは、同じ Orca ペイン（同じターミナルハンドル）で続ける。orca-team-dispatch-task 側は変更しない。
- 乗り換え先に `system`（Orca 外の通常ログイン）を含める。`system` は登録済みのアカウントとは別の契約。そのため現状（claude / codex とも登録 1 件＋`system`）でも 2 アカウント間で乗り換えられる。
- インストール用の Make（等）を用意する。

### 私（設計者）の判断

- **名前は `account-failover`、置き場所は `apps/account-failover`。** `orca-` 始まりは id として使えないため。
- **形態は Orca プラグイン（trusted-worker）。** Claude Code プラグインではない。そのため `.claude-plugin/marketplace.json` には載せない。
- **流れ:**
  1. `agent.status.changed` を受け取り、working 以外になったペインを候補にする。
  2. `terminal.read` で末尾を読み、limit の文言があるかで判定する。Claude は上記の形式、Codex は実物から確定する。
     - Claude は `StopFailure` hook を補助の合図に使ってよい（session_id を確実に取れる利点がある）。どう組み合わせるかはビルダーに任せる。
  3. そのセッションの session_id・種類・workspace・作業ディレクトリを控える。
  4. 古いエージェントのプロセスだけを終わらせる。**ペインは閉じない**。
  5. `orca account select` で同じ種類の次のアカウントへ切り替える。以後の新規起動もそのアカウントになる。
  6. **同じペインに残ったシェル**に、次の resume コマンドを打ち込む（`terminal.sendText`）。続けて、続きを促すプロンプトを送る。
     - コマンドは、新しいアカウントの `CLAUDE_CONFIG_DIR` / `CODEX_HOME` を明示し、控えておいた元の起動引数に resume の指定を足したもの。
     - Claude: `claude --resume <jsonl の絶対パス>` を使う。
     - Codex: 引き継ぎ先アカウントの `CODEX_HOME` へ会話の記録を引き継いでから `codex resume <id>` する。
- **ペインを保つ理由（ユーザーの決定）:** orca-team-dispatch-task は親・worker をターミナルのハンドルで識別している（worker のプロンプトに埋め込まれた `--from <handle>`、`workers.json` の `terminal`、`run.json` の `parent_handle`、`orca-recover.ts` の消失判定）。ハンドルが変わると、dispatch の待機や連絡が壊れる。また、代わりの worker が重複して起動するおそれがある。同じペインで続ければ、dispatch 側は変更不要になる。
- **起動時の設定を引き継ぐ:** resume するときは、元の起動時の設定（model、effort、Claude の permission mode、Codex の sandbox / approval policy など）を再現する。古いプロセスを終わらせる前に、そのプロセスの起動引数を `ps` などで控え、それに resume の指定を足して起動し直す。こうすると、手で開いたセッションや保存から復元されたセッション（`agent.launch.before` の対象外）でも同じ方法で扱える。既定値で起動し直すと、夜間に弱いモデルで動いたり、権限確認のプロンプトで止まったりして「無人で最後まで」が崩れるため。
- **アカウントの順番:** `orca account list` に並んでいる順に回す（`system` も 1 つの候補として含める）。直前に limit になったアカウントは、解除時刻を過ぎるまで候補から外す。
- **全アカウントが上限のとき:** 記録した解除時刻のうち一番早いものまで待ち、そのアカウントで resume する。解除時刻が読めない場合は一定間隔で再判定する（間隔はビルダーに任せる）。
- **他のセッションの扱い:** limit に当たったセッションだけを移す。同じアカウント上の他のセッションは、それぞれが当たった時点で個別に処理する。
- **記録:** 切り替えのたびに Orca のデスクトップ通知を出し、プラグインのログにも残す。ステータスバーには現在のアカウントや待機状態を出す（任意）。
- **インストール:** `apps/account-failover/Makefile` を用意する。
  - `make install`: `orca plugin install` を実行し、approval_required なら fingerprint を表示してユーザーに承認を促すか、`--approve` で再実行する。
  - `make dev`: `orca plugin dev watch`。
  - `make test`: プラグインのテスト。
  - ルートの `install.sh` から `make install` を呼ぶ。ただしコードを動かすプラグインの承認はユーザーの確認が要るので、無言では承認しない。
- **言語と規約:** TypeScript（`any` / `unknown` 禁止、class 禁止）。biome とリポジトリの `pnpm check` に乗せる。ドキュメントは日本語。`apps/account-failover/CLAUDE.md` を置く。

## ビルダーに任せること

- 画面からの limit 判定の正規表現、Codex の文言の確定（実物を見る）。
- session_id の取り方。Claude は `StopFailure` hook / 画面 / Orca の agent-session-journal など、Codex は `CODEX_HOME/sessions` の最新 rollout など。
- Codex の会話の記録をアカウント間で引き継ぐ方法（rollout ファイルのコピー、`thread_history_1.sqlite` の扱い、`sessions` の共有リンク化のどれにするか）。
- 古いエージェントのプロセスの終わらせ方（limit 画面での終了キー送信、プロセスへのシグナルなど）。条件は 2 つ: ペインとシェルを残すこと、resume する前にプロセスが確実に消えていること。
- 誤検知を防ぐ条件の細部、待機中の再判定の間隔、同時に複数のセッションが limit に当たったときの直列化。
- worker から `orca` CLI を呼べない場合の代替手段。

## 未確認のリスク（実装の最初に検証する）

0. **エージェントのプロセスが終わったあとも、Orca のペイン（シェル）が残るか。** `orca agent launch` で起動したペインも含めて確認する。残らない場合は (a) 案が成立しないので、実装を止めてユーザーに相談する（代わりの案は、新しいペイン＋dispatch 側のハンドル付け替え、または通知のみ）。
1. trusted-worker から子プロセス（`orca account select` / `orca terminal close`）を起動できるか。
2. `agent.status.changed` が focused workspace 以外の全エージェントについて届くか。
3. 新しく追加したアカウントの Claude プロファイルでも `projects` が共有されるか（jsonl の絶対パス指定で回避できる見込み）。
4. Codex の resume が別アカウントの `CODEX_HOME` で成立するか。
5. `orca plugin install` が monorepo のサブフォルダ（GitHub の tree URL）から入れられるか。ローカルフォルダからは入れられる。
