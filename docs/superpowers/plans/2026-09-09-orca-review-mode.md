# orca-team-dispatch-task レビューモード（Stage B / spec の F-b）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orca-team-dispatch-task` に `review_mode` を実装し、**`design` の成果に対して `design_review` が verdict を返す往復が 1 回通る**ところまでを出荷する。設定は Stage A で入った `config.json`（`roles.<role>.{agent,model,effort}`）にロールを足す形で拡張し、`--setup` が `review_mode` も尋ねるようにする。

**Architecture:** reviewer は **同じ Run 上の 2 本目の worker**（自分の Task と Dispatch を持ち、**自分の worktree**を持つ）。レビュー往復はラウンドごとに Task を作らず、`orchestration send --to dispatch:<id>` / `check` の直接やり取りで行う（実測 O38）。往復のファイルは**タスク単位で共有する `<status-dir>/review/`**（親 repo 側の絶対パス）に置き、ロール別 status dir の外に出す。**2 つの agent を同じ checkout に同居させない** — 理由は下の「U-B4 を測らずに閉じた理由」。

**Tech Stack:** bash + jq、Orca CLI（`$ORCA_BIN`）、テストは自作の bash ランナーと `test/lib/orca-stub.sh`

**Spec:** `docs/superpowers/specs/2026-09-04-orca-team-dispatch-task-design.md` の 5-1（T4a/T4b）・6（メッセージング）・7（レビュー）・9-1（per-role status dir）・11（cleanup decision table）。本計画は同 spec の follow-up 表の **F-b** に対応する。**F-a（Phase B 委譲）を前提にしない** — `exec` / `exec_review` と Phase B-R は本計画の範囲外である。

**前段:** Stage A（並列 dispatch）と F-g のうち agent / model / effort の設定は実装済み（commit `7a2cad1`）。本計画はその `config.json` にロールと `review_mode` を足す。

## Global Constraints

- Orca CLI は PATH に無いことがある。**常に `$ORCA_BIN`** 経由で呼ぶ。ユーザーに見せるコマンド文字列も同じ
- `skills/orca-team-dispatch-task/SKILL.md` は **英語のみ**。日本語は `references/guide-ja.md` にだけ書く（`scripts/check-doc-lang.mjs` が検査）
- SKILL.md の frontmatter 直後の `## Output Language` ブロック 3 行は**一字一句そのまま**維持する
- SKILL.md と `guide-ja.md` の **bash ブロックはバイト一致**（`test-docs.sh` の SK8d が `cmp` で比較）。訳を書くときは正本からブロックを機械的に写す
- 両文書の **`[Cn]` の ID 集合が一致**（SK8）、**`## Known limitations` 表の行数が一致**（SK8c）、**H2 見出しの並びが一致**（SK8e。新しい H2 は `test-docs.sh` の `normalise_headings()` に登録する）
- **`test-docs.sh` の SK4 は本計画で更新する。**現在 `review_mode` / `design_review` / `exec_review` の語が SKILL.md に現れると落ちる。Task 9 で「まだ実装していない語」の集合から `review_mode` と `design_review` を外し、**`exec_review` と `merge_ready` は残す**（F-a / F-d は未実装のままなので、宣言を防ぐガードは要る）
- 完了条件は毎回 `cd apps/orca-team-dispatch-task && bash test/run-all.sh` が **ALL GREEN**
- リポジトリ全体では `node scripts/check-doc-lang.mjs apps/orca-team-dispatch-task` が通ること
- バージョンは `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json` の 3 箇所を同期する
- **使わなくなったコード・ファイル・テスト fixture は同じ commit で消す**
- コミットメッセージは日本語。末尾に `Claude-Session: https://claude.ai/code/session_01EYLFvy1d56wB4ZwoNroYrx` を付ける

## Task 1 の結果（実測済み 2026-09-09）

計画時の未知は 4 つとも決着した。spec 2-1 の O38〜O42 が正本である。

| id | 問い | 結果 | Task 3 以降への影響 |
|---|---|---|---|
| U-B1 | worker → worker の `send --to dispatch:<B>` が届き、B が `check` で読めるか | **通る**（O38）。`--help` の Notes は "coordinator guidance" としか書いていないが、worker からも届く | 計画どおり。Task 4 の adapter を書いてよい |
| U-B2 | その message が親の Run メールボックスにも来るか | **来ない**（O39）。親には `worker_done` だけが入った | **Task 7 は「来ないことを固定する回帰テスト」だけでよい。**`orca-wait.sh` の改修は不要 |
| U-B3 | `--type status` で subject のラベルが壊れないか | **壊れない**（O38）。subject / body とも無傷 | ラベル方式のまま。`--payload` へ移す必要は無い |
| U-B4 | 同じ worktree に 2 本目の worker を入れられるか | **測っていない**（下記の判断により不要になった） | reviewer は**自分の worktree**を持つ |

### U-B4 を測らずに閉じた理由

**reviewer と design を同じ worktree に入れない**と決めたため、U-B4 は前提から外れた。

- レビューの受け渡しは spec 7 節のとおり**タスク単位で共有する `<status-dir>/review/`**（親 repo 側の絶対パス）で行う。worker がどの worktree に居ても読み書きできるので、同居する必要が無い
- 同居させると **2 つの agent が同じ checkout を同時に触る**。reviewer がビルドやテストを走らせると design の編集と衝突する。分けるほうが安全である

worktree が 1 タスクにつき 2 つになるのはコストだが、**同居の危険と引き換えにする理由が無い。**

### スパイクが暴いた出荷済みコードのバグ 2 件（修正済み）

| | 症状 | 修正 |
|---|---|---|
| O40 | `worktree list` の receipt に `.name` は無い（`.displayName`）。`orca-start.sh` の再利用検出が**常に 0 件**で、再利用も「同名が複数」の防御も一度も動いていなかった | `.displayName` で照合。ST40 / ST6b が固定。fixture も実機の形へ直した |
| O41 | worker の shell に `ORCA_BIN` は無いのに、Task spec が「The Orca CLI is at `$ORCA_BIN`, already exported」と書いていた。STATUS PROTOCOL の `worker_done` が空コマンドになる | spec に**実値を焼き込む**。ST42 が固定。旧 ST4 は「変数名が spec に出ること」を期待していた（バグを固定していた）ので直した |

---

### Task 1: U-B1〜U-B4 を実機で確定させ、spec に追記する — **完了**

**コードを 1 行も書かない。**実機に当てて事実を記録する Task である。Stage A の Task 1 と同じ構えで、**測れなかったものは「測れなかった」と書く**（推測で埋めない）。

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-orca-team-dispatch-task-design.md`（2-1 の Orca 事実表に O 番号を追記）
- Modify: 本計画（U-B の結果に応じて Task 2 以降を書き換える）

- [x] **Step 1: 使い捨ての Run に 2 本の worker を立てる**

スパイク専用の slug（`spike-rv-a` = 送信側 / `spike-rv-b` = 受信側）を使い、同じ Run に相乗りさせた。**同一 worktree は試していない**（U-B4 の項を参照）。モデルは sonnet / effort low — 測るのはメッセージ経路であってモデルの賢さではない。

- [x] **Step 2: worker A から worker B へ送り、B が読めるかを見る（U-B1 / U-B3）**

A の端末で `send --to dispatch:<B> --type status --subject 'review-plan: round 1' --body ...` を実行し、B の端末で `check --terminal <B の handle> --peek --json` を読む。**`--peek` を使い、cursor を進めない。**

- [x] **Step 3: 親の Run メールボックスを覗く（U-B2）**

親端末で `check --terminal <親 handle> --peek --json` を読み、Step 2 の message が batch に混ざっているかを確かめる。**ここでも ack しない。**

- [x] **Step 4: 事実を spec へ書き、スパイクの資源を片付ける**

O 番号を採番して 2-1 の表に追記する。`worker-release` → `worktree rm` → `.dispatch/spike-rv-*` の順で片付け、**残渣ゼロを `terminal list` と `git worktree list` で確認する**。

**Verify:** spec に O38〜O42 の 5 行が増えた。`worker-release` × 2 → `worktree rm` × 2 → `.dispatch/spike-rv-*` 除去で、`worker-list` は `released` × 2、`git worktree list` と `git status` に残渣なしを確認済み。

---

### Task 2: `config.json` に `review_mode` と `design_review` の tuple を足す — **完了**

ユーザーが `--setup` で**レビューモードを選べる**ようにする。Task 3 以降がこの設定を読む。

**Files:**
- Modify: `skills/orca-team-dispatch-task/scripts/config-lib.sh`（`dispatch_role_names` に `design_review`、`review_mode` の検証を追加）
- Modify: `skills/orca-team-dispatch-task/scripts/config-resolve.sh`（`review_mode` の解決と、`off` のときロールを `design` だけに絞る）
- Modify: `skills/orca-team-dispatch-task/scripts/config-edit.sh`（`review_mode` キーの set / unset）
- Modify: `test/test-config.sh`

**Interfaces:**
- Produces: `config-resolve.sh` の出力に `review_mode` が増え、`roles` が `review_mode` に応じて 1 個 / 2 個になる

```json
{ "review_mode": "on",
  "roles": { "design":        {"agent":"claude","model":"opus[1m]","effort":"xhigh"},
             "design_review": {"agent":"codex","model":"gpt-6-astra","effort":"xhigh"} } }
```

- [x] **Step 1: `review_mode` の既定を決めて、テストを先に書く**

**既定は `off`。**Stage A の利用者の挙動を変えないため（Stage A の CF1 / ST31 と同じ理由）。`on` は明示的に設定したときだけである。

```bash
# CF18: review_mode 未設定なら off で、ロールは design だけ
# CF19: review_mode=on ならロールは design と design_review の 2 つ
# CF20: review_mode は on / off 以外を警告して落とす（層をまたいでも）
# CF21: review_mode=off のとき design_review の tuple は解決結果に出さない
#       （設定は残るが「使っていないロールの設定」を dispatch に見せない）
```

- [x] **Step 2: `config-lib.sh` にロールと検証を足す**

`dispatch_role_names` は `review_mode` を引数に取る形へ変える。**`design_review` を無条件に返してはならない** — `off` のとき `config-edit.sh` が存在しないロールのキーを書けてしまう。

- [x] **Step 3: `config-resolve.sh` に `review_mode` の解決を足す**

解決順は tuple と同じ override → project → global。`design_review` の既定 agent も `claude`。

- [x] **Step 4: `config-edit.sh` に `review_mode` を足す**

`--set review_mode=on|off` と `--unset review_mode`。**`--unset roles` は `review_mode` を消さない**（別のキーである）。`--reset` は両方消す。

**Verify:** CF18-25 の 8 本を追加して green（commit `66a800d`）。`--review-mode` の 1 回きり上書きも足した。

---

### Task 3: `orca-start.sh` が `review_mode=on` のとき 2 ロールを起動する

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.sh`
- Modify: `apps/orca-team-dispatch-task/test/test-start.sh`

**Interfaces:**
- Produces: `workers.json` の `roles` に `design_review` が増える

- [ ] **Step 1: 起動順を T4a → T4b にする（reviewer が先）**

spec 5-1 T4a の理由をそのまま採る: **design は起動直後に review を依頼しうる**ので、その時点で reviewer のアドレスが解決できなければ依頼が宛先不明になる。`design_review` を先に `worker-start` し、`workers.json` へ publish してから `design` を起動する。

- [ ] **Step 2: 失敗の巻き戻し境界を決める**

reviewer が起動できなかったら **design を起動しない**。中途半端に design だけ走ると、依頼先の無いレビュー要求で止まる。逆に **design の起動に失敗したら reviewer は保持する**（Stage A と同じく、Task 成立後は削除しない）。

```bash
# ST35: review_mode=on なら worker-start が 2 回、design_review が先
# ST36: reviewer の起動に失敗したら design を起動しない
# ST37: design の起動に失敗しても reviewer の資源は消さない（identity を出して止まる）
# ST38: review_mode=off なら worker-start は 1 回のまま（Stage A の挙動）
# ST39: 2 ロールはそれぞれ自分の worktree を持つ（同じ checkout に同居させない）
```

**Verify:** `bash test/test-start.sh` green。ST38 が Stage A の挙動を固定していること。

---

### Task 4: `bin/orca-send.sh`（adapter）と addressbook

**U-B1 の結果に依存する。**Task 1 が (b) を返したらこの Task は作り直しである。

**Files:**
- Create: `apps/orca-team-dispatch-task/bin/orca-send.sh`
- Create: `apps/orca-team-dispatch-task/test/test-send.sh`
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.sh`（addressbook の書き出し）
- Modify: `apps/orca-team-dispatch-task/test/run-all.sh`

**Interfaces:**
- Produces: `<status-dir>/addressbook.json`、`orca-send.sh <from-role> <to-role> <body>`

- [ ] **Step 1: sender handle を自分で解決する（推測しない）**

spec 6-2 の裁定をそのまま採る: `ORCA_TERMINAL_HANDLE` から**自分の** handle を取り、`--from` に渡す。**取れなければ Orca の暗黙推定に落ちず exit 1**（候補が 1 つのとき Orca は暗黙に束縛するため。O26）。

- [ ] **Step 2: 宛先はロール名で受け、addressbook で解決する**

未登録の宛先は exit 1（未配送）。settle した Dispatch へ送って黙って失うより、送信側に見えるエラーにする。

```bash
# SN1: 自分の handle が取れなければ何も送らない
# SN2: 未登録のロール名は exit 1
# SN3: body 先頭のラベルを --subject に、残りを --body に載せる
# SN4: 非 0 終了は未配送として扱う（呼び出し側が書いたファイルを消せる）
```

---

### Task 5: `review-request.sh` / `review-state.sh` を移植する

**Files:**
- Create: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/scripts/review-state.sh`（cmux 版から **byte 一致**）
- Create: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/scripts/review-request.sh`（`AGMSG_SEND` の既定を `orca-send.sh` へ）
- Create: `apps/orca-team-dispatch-task/test/test-review.sh`

- [ ] **Step 1: `review-state.sh` を byte 一致で持ち込む**

spec 8-1 のとおり、**呼び出し側が `dispatch_root` を渡す**契約なので byte 一致で残せる。`review-state.sh` は受け取った root に自分で `/review` を足すので、**per-role status dir を渡してはならない**。

- [ ] **Step 2: `review-request.sh` の補償ロジックを保存する**

ファイル書き込みと送信をまとめ、**送信に失敗したら書いたファイルを削除する**。これが「request が findings より新しい = 回答待ち」という gate の唯一の材料を壊さない根拠である。

```bash
# RV1: 送信に失敗したら request ファイルが残らない
# RV2: review dir はタスク単位で共有（roles/<role>/ の外）
# RV3: VERDICT: 行が無い review-verdict は needs_work 扱い
```

---

### Task 6: design 側の Phase A-R ループと gate

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-start.sh`（design の Task spec に Phase A-R の手順を載せる）
- Create: `apps/orca-team-dispatch-task/skills/orca-team-dispatch-task/scripts/review-gate.sh`

- [ ] **Step 1: 親が spec を手書きしない**

spec の裁定（「**親が spec を手書きすることを禁止する**」）を守る。reviewer の agent 名 / review dir / ラウンドファイル規約は**生成器から出す**。

- [ ] **Step 2: ラウンド上限と行き詰まりの扱いを決める**

上限に達したら未解決の findings を `result.md` に書いて先へ進む。reviewer が反応しないときは同じラウンドを 1 回だけ再依頼し、なお無反応ならレビューを飛ばす。**worker は質問できない**（Stage A の制約）ので、判断を親に投げずに閉じる。

---

### Task 7: `orca-wait.sh` がレビュー往復に巻き込まれないようにする

**U-B2 は (b) だった**（O39: レビュー message は親の Run メールボックスに来ない）。よって **`orca-wait.sh` の改修は不要**で、この Task は「来ないことを固定する回帰テスト」だけになる。

**Files:**
- Modify: `apps/orca-team-dispatch-task/bin/orca-wait.sh`
- Modify: `apps/orca-team-dispatch-task/test/test-wait.sh`

- [ ] **Step 1: レビュー往復が親のキューに来ないことを回帰で固定する**

**`orca-wait.sh` を変更してはならない。**「知らない message は ack しない」という Stage A の安全性はそのまま残す。O39 が将来変わったら気づけるように、実機 E2E（Task 10）でレビュー 1 往復の後に親のキューへ `worker_done` 以外が入らないことを確かめる。

```bash
# WT27: レビュー往復の後も親の batch は worker_done だけ（O39 の回帰）
```

---

### Task 8: cleanup を 2 ロールへ広げる

**Files:**
- Modify: `skills/orca-team-dispatch-task/SKILL.md`（`[C1]` `[C2]` `[C3]` `[C5]` `[C7]`）
- Modify: `skills/orca-team-dispatch-task/references/guide-ja.md`（バイト一致で）
- Modify: `apps/orca-team-dispatch-task/test/test-docs.sh`

- [ ] **Step 1: `roles` を走査する形にする**

現在の各ブロックは `.roles.design.dispatch` を直接読んでいる。**`roles` を全部回す**形にし、ロールが増えてもブロックを書き換えずに済むようにする。

- [ ] **Step 2: ロールごとに worktree を判定する**

ロールが自分の worktree を持つので、**`[C3]` はロールごとに 1 回ずつ判定する**。`workers.json` の `worktree_id` / `worktree_path` / `worktree_created_by_this_run` / `worktree_terminals` を**ロール配下へ移す**（現在はトップレベルの 1 組しかない）。design が merge 済みでも reviewer の checkout が dirty なら reviewer の worktree は消さない、という判定が要る。

**Step 1 の `roles` 走査と合わせて、`workers.json` のスキーマ変更が本 Task の実体である。**`[C1]` `[C2]` `[C5]` `[C7]` も同じ走査へ揃える。

---

### Task 9: SKILL.md / guide-ja.md にレビューモードを書く

**Files:**
- Modify: `skills/orca-team-dispatch-task/SKILL.md` / `references/guide-ja.md`
- Modify: `apps/orca-team-dispatch-task/test/test-docs.sh`（SK4 の禁止語から `review_mode` / `design_review` を外す）
- Modify: `apps/orca-team-dispatch-task/CLAUDE.md` / `README.md`
- Modify: 3 箇所の version

- [ ] **Step 1: `--setup` の質問にレビューモードを足す**

Stage A で入れた S2 の質問に `review_mode` を加える。**`on` を選んだときだけ `design_review` の tuple を尋ねる** — 使わないロールの設定を尋ねない。

- [ ] **Step 2: SK4 のガードを更新する（緩めすぎない）**

`exec_review` と `merge_ready` は禁止語のまま残す。**F-a / F-d が未実装である以上、その語を SKILL.md に書けてしまう状態にしてはならない。**

---

### Task 10: E2E に 1 往復のレビューを足す

**Files:**
- Modify: `apps/orca-team-dispatch-task/test/test-e2e.sh`
- Modify: `apps/orca-team-dispatch-task/test/lib/orca-stub.sh`（`send` / `check` の応答）

- [ ] **Step 1: stub で 1 往復を通す**

`review-plan:` → `review-verdict: VERDICT: approved` の 1 往復が、design の完了まで通ることを固定する。

- [ ] **Step 2: 実機 E2E で 1 往復を通し、制限表を更新する**

Stage A の制限表の行「Failure and edge receipt fixtures are partly simulated」は、実機で取れた receipt の分だけ狭める。**取れていないものを取れたことにしない。**

---

## この計画で扱わないもの

- **F-a**（Phase B 委譲 / `exec` ロール）と **Phase B-R**（`exec_review`）
- **F-c**（PR 統合）、**F-d**（二相コミットの完全形）、**F-e**（generation transition）
- **F-f**（issue ループ / `--issue` モード）— 別計画。F-a / F-c への依存があるため本計画の後に置く
- Orca の `gate-create` / `gate-resolve`
