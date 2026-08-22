# 子セッションを最後まで完走させる — completion gate 設計

作成: 2026-08-22
状態: **設計。未実装。** 実装計画の最初のタスクは G-T1 / G-T2 の実測（後述）。

## 1. 解こうとしている問題

dispatch の子セッションが、claude / codex いずれでも**タスクの途中で止まる**ことがある。実装が
最後まで行かない、レビューが verdict を出す前に終わる、といった形で、ユーザーが手で「続けて」と
打ち直して再開させている。

これは `docs/notification-gaps.md` の U1（「status.json を書かずに沈黙する」）と同じ事象である。
U1 は v2.0.0 で「親の 90 分タイマーが起床して気づく」ようになったが、**検知しているだけで
再開はしていない**。90 分待ってユーザーへ報告するのは、止まった 3 分後に自分で再開するのと
比べて何時間も遅い。

したがって本設計の目的は検知ではなく**継続**である。

## 2. 確認済みの事実

判断の根拠を明示する。実測していないものは 6 節に分けて書く。

| ID | 内容 | 根拠 |
|----|------|------|
| G1 | Claude Code の `/goal` は **session-scoped な prompt-based Stop hook のラッパー**である。ターン終了ごとに評価器（既定 Haiku）が条件を判定し、未達なら制御を返さず次のターンを開始する | 公式 doc `code.claude.com/docs/ja/goal` |
| G2 | `/goal` の評価器は**会話に現れた内容しか見られない**。独立してコマンドを実行したりファイルを読んだりしない | 同上 |
| G3 | `/goal` は**設定した瞬間にターンを開始する**（条件自体がディレクティブになる） | 同上 |
| G4 | `/goal` は v2.1.139 以降。手元は v2.1.239。`disableAllHooks` / `allowManagedHooksOnly` は未設定 | `claude --version`、settings 確認 |
| G5 | Claude Code の hook は `type` に `"prompt"` / `"agent"` / `"command"` を取れる | 公式 doc `code.claude.com/docs/ja/hooks` |
| G6 | codex にも goal 機能がある（`~/.codex/goals_1.sqlite` の `thread_goals`。status は active / paused / blocked / usage_limited / budget_limited / complete）。実使用履歴あり（objective「最後まで続けて」が 470,580 tokens / 約 2.6 時間で `complete`） | DB 実物 |
| G7 | **`.codex/hooks.json` は project-local に実在する**。スキーマは claude と同形の `{"hooks":{"<Event>":[{"matcher":"","hooks":[{"type":"command","command":"..."}]}]}}` | `influencer-platform` / `freelance-jp-app` の実物 |
| G8 | codex の hook 出力スキーマは `additionalProperties: false`。Stop の許可キーは `continue` / `decision`（`"block"` のみ）/ `reason` / `stopReason` / `suppressOutput` / `systemMessage` の 6 つ | `apps/cmux-team-dispatch-task/CLAUDE.md` |
| G9 | `launch-workspace.sh:515` は**全 codex 経路に `--dangerously-bypass-hook-trust` を付与済み**。理由は「worktree ごとに新しい `.codex/hooks.json` パスが生成され毎回未信頼になり、起動直後に承認待ちで停止する」から | `launch-workspace.sh:510-515` |

## 3. `/goal` をそのまま使わない理由

ユーザーの当初の提案は「実装やレビューの開始時に `/goal` を打つ」だった。採らない。G1-G3 から
**dispatch の待機 protocol と正面衝突する**ためである。

### 3-1. verdict 待ちを破壊する（G1）

dispatch の実装者は `review-code:` を送ったら**停止して push を待つ**。goal がアクティブだと、
その待機ターンの終わりに hook が発火し「未達」と判定され、制御を返さず次のターンが始まる。
レビュー依頼の二重送信や、待つべき場面での勝手な作業になる。

### 3-2. タスク到着前に空回りする（G3）

prewarm したペインはタスクが agmsg で届くまで idle で待つ。`/goal` は設定した瞬間にターンを
開始するので、起動時に張ると「まだ何も来ていないのに動き出し、評価器が未達と言い続ける」
空回りになる。

### 3-3. 張るタイミングを作れない

タスク到着後に子が自分で `/goal` を打つ経路が無い。`/goal` は組み込みコマンドであり Skill
ツールからは起動できない。ペインへタイプ入力する案は、v2.0.0 で配送から排除した経路を
別の理由で復活させることになるうえ、**未実測**である。

### 3-4. 判定材料が会話にしか無い（G2）

評価器は Claude の発言しか見られないので、「実装が終わったか」をモデルの自己申告から推測する
ことになる。誤判定すれば待機を壊すか空回りする。**dispatch の完了条件は既にディスク上に
materialize されている**（`status.json`、`.deferred`、findings ファイル）ので、推測に賭ける
理由が無い。

## 4. 設計

### 4-1. 機構

`/goal` が内部でやっていること（Stop hook）を、モデル評価ではなく**決定論的なスクリプト**で
行う。両 engine とも project-local な hook 設定へ `type: "command"` の Stop hook を 1 本注入する。

| engine | 注入先 | 方式 |
|---|---|---|
| claude | `.claude/settings.local.json` | 既存の `ExitPlanMode` hook 注入経路を流用 |
| codex | `.codex/hooks.json` | agmsg の SessionStart / SessionEnd と **jq でマージ**（上書き禁止） |

出力は両 engine 共通:

- 継続させたいとき: `{"decision":"block","reason":"<次に何をすべきか>"}`
- それ以外: 無出力（停止を許す）

使うキーを `decision` / `reason` だけに限るのは G8 のためである。security-guidance が `metrics`
を出して codex に毎ターン拒否されている事例（CLAUDE.md）と同じ轍を踏まない。

G9 により、worktree に新しい `.codex/hooks.json` を書いても信頼確認で止まらない。

### 4-2. 判定（`completion-gate.sh`、新規）

引数は `--status-dir <dir>` と `--role <design|design_review|exec|exec_review>`。
**ディスクだけを読む。モデル評価もネットワークアクセスも行わない。**

判定はこの順:

| # | 条件 | 判定 | 理由 |
|---|------|------|------|
| 1 | `status.json` の `status` が `done` / `error` | 停止を許す | 仕事は終わっている |
| 2 | role が design で `.deferred` が存在 | 停止を許す | Phase B を委譲済み。design はここで終わるのが正しい |
| 3 | そのロールの「タスク未着」信号（下表） | 停止を許す | **タスク未着**。待つのが正しい状態 |
| 4 | review 依頼済みで、対応する findings に `VERDICT:` 行が無い | 停止を許す | **verdict 待ち**。待つのが正しい状態 |
| 5 | 上記以外 | **block して継続** | 仕事の途中で止まろうとしている |

3 と 4 がこの設計の要点である。「待って良い状態」を推測ではなく**ディスク上の事実**で判定
できるので、3-1 と 3-2 の衝突が構造的に起きない。

**「タスク未着」の信号はロールごとに違う。** 単一の marker で書いてはならない:

| role | 未着の判定 | 根拠 |
|---|---|---|
| `exec` | `<status-dir>/.assigned-<exec-agent>` が無い | `phase-b-deliver.sh:189` がこれを送信前に作る |
| `design` | Phase A の依頼を受けていない（`status.json` が `launched` のまま） | design ペインは standby ではないので `.assigned-<slug>` を持たない |
| `design_review` / `exec_review` | `<status-dir>/review/` に当該ラウンドの request ファイルが無い | **レビューペインは `.assigned` を一切使わない**（`launch-workspace.sh:21`）。依頼側が request と findings を `review/` へ書いてから送る |

`.assigned` をレビューロールへ流用してはならない。runner wrapper の所有権判定
（`launch-workspace.sh:1190-1197`）が同じ marker 群を見ており、レビューペインが `.assigned-*`
を作ると foreign assignment と誤認されて status 書き込みが抑止される。

### 4-3. 暴走防止（機能の一部であり、任意のオプションではない）

Stop hook が永久に block すると無限ループになる。連続 block 回数を
`<status-dir>/.gate-blocks` に記録し、**上限 10 回**で block をやめる。

- 上限に達したら block せず、`reason` にその旨を残し、`status.json` の `message` にも記録する
- 親は起床時の再導出でこれを読み、ユーザーへ報告できる
- カウンタは「ターンが進んだ」ことではなく「block したこと」を数える。判定 1-4 で停止を許した
  ときは **0 にリセットする**（待機から復帰したあとに前の回数を持ち越さないため）

上限値を 10 にしたのは、正常な実装が 10 回連続で「途中で止まろうとする」ことは考えにくく、
かつ 10 ターンあれば大半の中断は自力で回復できるという見積もりによる。実測で調整する。

### 4-4. 適用範囲

待ちを跨がない区間だけに入れる。

| role | 完走させる区間 |
|---|---|
| `exec` | タスク受領 〜 `status.json` が終端になるまで |
| `design_review` / `exec_review` | 依頼受領 〜 findings に `VERDICT:` を書き verdict を送るまで |
| `design` | 判定 3・4 でカバーされるので同じ gate で安全に含める |

### 4-5. 副次的に直るもの

`.codex/hooks.json` を、`.claude/settings.local.json` と同じく repo-shared `info/exclude` へ
追加する。現在このファイルは worktree で git 差分として現れ、実装ペインへ「コミット対象に
混ぜるな」と口頭で伝える運用になっている。除外すれば伝える必要がなくなる。

## 5. 不変条件

1. **待って良い状態を block しない。** 判定 3・4 は判定 5 より必ず先に評価する
2. **hook はディスク以外を見ない。** モデル評価・ネットワーク・cmux コマンドを使わない
3. **出力キーは `decision` / `reason` だけ。** G8 に適合しないキーを足さない
4. **注入は冪等。** 同じ worktree を再利用しても hook は二重に入らない
5. **注入失敗は警告のみ。** dispatch を止めない（既存の `ExitPlanMode` hook と同じ扱い）
6. **上限に達したら必ず止まる。** block を無限に返す経路を作らない

## 6. 未実測（実装前に必ず測る）

この設計は次の 2 点が成り立つことに依存している。**成り立たなければ設計ごと作り直す。**
D-T2（codex の自分宛タイマーが不発だった件）の教訓により、動くと確かめるまで指示文に書かない。

| ID | 測ること | 成立しない場合 |
|----|---------|--------------|
| G-T1 | **claude** の Stop hook が `{"decision":"block","reason":"..."}` を返したとき、セッションが実際に次のターンを開始するか。また連続 block に対する組込みガード（`stop_hook_active` 相当）が存在するか | 4-1 を prompt-based hook か別機構へ変更 |
| G-T2 | **codex** の Stop hook が同じ JSON で継続するか。`.codex/hooks.json` を worktree に置いた状態で `--dangerously-bypass-hook-trust` 付き起動が承認待ちにならないか | codex を対象外にし、claude ロールのみへ適用する |

G-T1 の「組込みガード」は公式 doc に記載が無い。存在するなら 4-3 の自前カウンタと二重になる
ので、実測して整合させる。

### 実測結果（2026-08-22）

**G-T1: 成立。** scratch リポジトリに「3 回まで block を返す」probe を Stop hook として置き、
`claude --dangerously-skip-permissions -p 'Say the word "one" and nothing else.'` を実行した。

- hook の起動回数は **4**（= 3 回の block が 3 つの追加ターンを起こした）
- assistant の出力は `one` → `two` → `three` → `four` と進んだ。**`reason` に書いた
  「say the next number word」が次ターンのガイダンスとして届き、モデルがそれに従った**。
  reason は単なるログではなく指示として機能する
- **連続 block に対する組込みの回数上限は無い。** 3 回続けても Claude 側は止めなかった。
  したがって 4-3 の自前上限は必須である
- ただし hook の stdin に **`stop_hook_active`** が入る。1 回目は `false`、2 回目以降は `true`。
  「このターンが自分の block で始まったか」を判定できるので、4-3 のカウンタのリセットは
  「allow したとき」に加えて「`stop_hook_active` が `false` のとき」も条件にすると正確になる
  （セッションが自力で停止した = 前の停滞は解消している）

**G-T2: 成立。** 同じ probe を `.codex/hooks.json` の Stop に置き、
`codex --dangerously-bypass-approvals-and-sandbox exec '...'` を実行した。

- hook の起動回数は **4**。出力は `one` → `two` → `three` → `four`
- ログに `hook: Stop Blocked` が 3 回現れ、`invalid stop hook JSON output` は**出なかった**。
  `decision` / `reason` だけの出力が codex のスキーマに適合することの確認（G8）
- **`--dangerously-bypass-hook-trust` はこの環境では既定で有効**だった。明示的に渡すと
  `the argument '--dangerously-bypass-hook-trust' cannot be used multiple times` で
  起動に失敗する。`launch-workspace.sh` は現在この flag を明示的に付けており、実際の
  ディスパッチは動いているので衝突していないが、**環境によっては二重付与になりうる**点は
  記録しておく。付与経路の特定は本設計の範囲外

**結論: 設計は成立する。Task 2 以降へ進んでよい。** codex を対象外にする分岐（実装計画
Task 1 Step 5 の 2 番目の場合）は発生しない。

## 7. テスト

- `completion-gate.sh` の単体: 判定 1-5 の各分岐、上限到達、カウンタのリセット
- 出力契約: block 時の JSON が `decision` / `reason` のみを含むこと（G8 の回帰）
- 注入: claude / codex 双方で冪等であること、agmsg の既存 hook を破壊しないこと
- `info/exclude` に `.codex/hooks.json` が入ること

## 8. 採らなかった案

- **`/goal` をペインへタイプ入力する**: 3-3 のとおり未実測で、配送から排除した経路の復活になる。
  ただし G-T1 / G-T2 が両方とも不成立だった場合は、この案の実測へ戻る
- **prompt-based Stop hook（`/goal` と同じ機構を設定ファイルで）**: G2 の制約をそのまま受け継ぎ、
  判定材料がディスクにあるのに会話からの推測になる。評価トークンも毎ターン発生する
- **codex の `/goal`（G6）を使う**: 実績はある（2.6 時間 / 470k tokens で `complete`）が、
  claude 側と機構が揃わず、3-1 / 3-2 の衝突は codex でも同じく起きる
