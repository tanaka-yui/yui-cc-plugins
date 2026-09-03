# 実運用で失われた成果物を機構で守る — 2026-09-02 loop 運用レポート対応 (第1弾)

作成: 2026-09-03
状態: **設計。未実装。**
入力: `.dispatch-findings/2026-09-02-loop-run.md`（CyberAgentAI/influencer-platform, bug ラベル 8 issue / 2 batch / review_mode=on / integration=pr）

## 1. 解こうとしている問題

2026-09-02 の実運用で 8/8 が PR 到達した一方、**8 件中 6 件で親の手動介入が必要**だった。
介入しなければ成果物が失われていた不具合が 9 件（F1〜F9）報告されている。

本 spec はそのうち **F1〜F6 と F9 を扱う**。F7（codex reviewer の sandbox）と F8（親の safety
timer 連続 kill）は原因が未実測で、修正案を確定できない。両者は 9 節の調査タスクとして切り出し、
実測結果を得てから第2弾の spec を書く。

共通する構造は 1 つである。**「こうせよ」と指示している手順が守られず、守られなかったことを
機構が検知できない。** したがって本設計の方針は、指示の追記ではなく、
**手順を機構へ移す / 守られなかった状態をディスク上で判定可能にする** の 2 つに限る。

## 2. 確認済みの事実

実測またはコード読解で裏が取れたものだけを挙げる。推測は 9 節に分ける。

| ID | 内容 | 根拠 |
|----|------|------|
| R1 | `phase-b-deliver.sh` の `STATUS_PROTOCOL` に push / PR 作成の手順は**一切無い**。`pr_url` は「既存値を保存せよ」としか書かれておらず、書き方の指示が無い | `scripts/phase-b-deliver.sh:122` |
| R2 | loop モードの子プロンプトにも PR 手順は無い。`For PR integration include Closes #<issue>` の 1 行のみ | `scripts/render-loop-prompt.sh:139` |
| R3 | SKILL.md は「PR per task → child prompts include push + `gh pr create` instructions」と宣言しているが、その実装は存在しない | `SKILL.md:201` と R1 / R2 の差 |
| R4 | `review_select_active` は point を区別せず `review/*.md` 全体から最新 1 件を選ぶ | `scripts/review-state.sh:4-66` |
| R5 | R4 の結果、exec が `code-round-N-request.md` を持たないと design 点の VERDICT 付きファイルが「最新」として選ばれ、`RS_ANSWER_PENDING=0` / `RS_FINDINGS_UNFINISHED=0` となり判定 5/5b をすり抜けて判定 7 に落ちる | `scripts/completion-gate.sh:341-358` と R4 |
| R6 | 依頼ファイルを書く指示は `phase-b-deliver.sh` の Phase B-R 本文に**存在する**（`REQUEST_PATH`）。F1 は指示の欠落ではなく不遵守である | `scripts/phase-b-deliver.sh:177,198` |
| R7 | `prewarm.json` が publish されるのは**全ペインの起動・配線が完了した後**。起動済みペインの Stop hook はそれより前に発火する | `scripts/prewarm-panes.sh:466-514` |
| R8 | 配線中に発火した design ペインの gate は `block "...prewarm.json is missing... Report this to parent"` を返す。誤報告の文面はゲート自身が指示している | `scripts/completion-gate.sh:315` |
| R9 | `prewarm.json` のスナップショット契約は 3 か所が独立に厳格検証する。プレースホルダ JSON を同じファイルに書くと 3 か所すべてが `invalid prewarm snapshot` で失敗する | `phase-b-deliver.sh:57-116` / `loop-cleanup.sh:73-146` / `SKILL.md:1580-1626` |
| R10 | codex reviewer には `--add-dir '<status-dir>/review'` が**実際に渡っている**。`prewarm-panes.sh` は全 review role へ `--status-dir` を渡し、`launch-workspace.sh` はそれを `REVIEW_SANDBOX_DIR` として `--add-dir` に展開する | `scripts/prewarm-panes.sh:386` / `scripts/launch-workspace.sh:807-810,1168-1171` |
| R11 | codex CLI に `--add-dir <DIR>`（"Additional directories that should be writable alongside the primary workspace"）は実在する | `codex --help` |
| R12 | `loop-cleanup.sh` は cmux の surface / workspace を**閉じない**。`leave.sh` のみ呼ぶ | `scripts/loop-cleanup.sh:185-190` |
| R13 | `references/loop-mode.md` は「cleanup が `close-surface` する」と書いている。R12 と矛盾する | `references/loop-mode.md:164-167` |
| R14 | surface / workspace の close は親側の Step 4 インラインブロックが行う | `SKILL.md:1628-1657` |
| R15 | `DISPATCH_GATE_ROLE` は各ペインの環境変数として注入済みで、そのペインで走るスクリプトから読める | `scripts/completion-gate.sh:62-65` |
| R16 | `report-status.sh` は引数にクォートを要求しない位置引数契約を意図的に維持している（execute モードの inner prompt が `zsh -ic "..."` の内側に素で置かれるため） | `scripts/report-status.sh:5-13` |
| R17 | influencer-platform の remote は 3 つ（origin=CyberAgentAI / fork=個人 / tanaka-yui=無関係リポジトリ）。子は fork を選んだ | `git remote -v` とレポート F3 |

## 3. 決定事項

実装前にユーザーへ確認し、合意した項目。

| # | 論点 | 決定 |
|---|------|------|
| D1 | 対象範囲 | F1〜F6・F9 を第1弾とする。F7 / F8 は調査を先に走らせ、結果を見て第2弾の spec を書く |
| D2 | ガード強度 | F2 / F4 は `report-status.sh` が**拒否**（非ゼロ終了）。F5 は**警告のみ**で拒否しない |
| D3 | PR 作成先 | 親が dispatch 時に `origin` の `owner/repo` を解決して子のプロトコルへ埋め込む。子に remote 選択を任せない。config による上書きは設けない |

## 4. F1 — レビュー依頼の原子化

### 4-1. 問題

再現率 4/7。exec が `code-round-N-request.md` を書かずに `review-code:` を送る。R6 のとおり
指示は存在し、親から追加で明示指示を送っても再発した（#77 は 2 回指示しても書かず、#74 は
「更新しました」と報告しながら実ファイルが存在しなかった）。

結果は R5 の経路である。gate は判定 7 に落ち、その reason が提示する唯一の出口 `error` を
codex exec が取り、進行中のレビューが「verdict が返らない」として中断される。

### 4-2. 新設 `scripts/review-request.sh`

ファイル書き込みと送信を 1 コマンドで原子的に行う。

```
review-request.sh --review-dir <dir> --point <design|code> --round <N> \
                  --team <team> --from <agent> --to <agent>   < 本文
```

**本文は stdin で受ける。** `--body-file` にすると「子が先にファイルを書く」という、いま失敗
している手順がそのまま残る。stdin ならヒアドキュメント 1 回で完結し、2 手順のうち 1 手順を
飛ばす失敗モードが構造的に消える。位置引数で本文を渡す案は、複数行かつ引用符を含む依頼文が
`zsh -ic "..."` の内側で壊れるため採らない。

処理順:

1. 引数を検証する。`--review-dir` は非 symlink のディレクトリ、`--point` は `design` または
   `code`、`--round` は 1〜5、`--team` / `--from` / `--to` は `[A-Za-z0-9._-]+`
2. stdin を読む。空なら usage エラー（exit 2）
3. `<review-dir>/<point>-round-<N>-request.md` へ mktemp + mv で書く（同一ディレクトリの
   mktemp。共有名の `.tmp` は並列書き込みで壊れる）
4. `send.sh <team> <from> <to> "<prefix><本文>"` を呼ぶ。prefix は `design` → `review-plan: `、
   `code` → `review-code: `
5. **send が非ゼロなら request ファイルを削除して非ゼロ終了する。** ディスクに嘘の待機を
   残さない。gate は「依頼が出ている」と誤認してはならない

終了コード: 0 = 成功 / 1 = 送信失敗（ファイルは削除済み） / 2 = 使用法エラー。

同一ラウンドの request ファイルが既に存在する場合は**上書きする**。待機プロトコルは
「同じラウンドを 1 度だけ再送する」を許しており、上書きは mtime を更新して gate の
`RS_ANSWER_PENDING` 判定を正しく成立させる。

### 4-3. 呼び出し側の統一

レビュー依頼から `send.sh` の直接呼び出しを排除する。

| 箇所 | 変更 |
|------|------|
| `scripts/phase-b-deliver.sh` | Phase B-R 本文の「`$REQUEST_PATH` へ書いてから `$AGMSG_SEND` を呼べ」を、`review-request.sh` 1 回の呼び出しへ置換 |
| `scripts/phase-a-review-wait.sh` | 同様に Phase A-R の依頼手順を置換 |
| `scripts/launch-workspace.sh:1071` | `REVIEW_INSTRUCTION` 内の依頼手順を置換 |
| `references/unattended/review-block.md` | Phase A-R の依頼手順を置換 |
| `references/unattended/code-review-block.md` | Phase B-R の依頼手順を置換 |
| `scripts/completion-gate.sh:416` | `REVIEW_HINT` 末尾の「request ファイルを書いてから send せよ」を `review-request.sh` の呼び出しへ置換 |

いずれにも「レビュー依頼に `send.sh` を直接呼んではならない」を明記する。`review-verdict:` /
`abort-reviewer:` / `dispatch-notify:` の送信は従来どおり `send.sh` を直接呼ぶ（依頼ではないので
ディスクへ materialize する対象ではない）。

### 4-4. `review-state.sh` の point スコープ化

4-2 だけでは R5 の経路は閉じない。ヘルパーを呼ばない子が残る可能性に加え、**design 点の
VERDICT が exec の状態をマスクする**という判定の欠陥そのものが残るためである。

`review_select_active <status-dir> [point-spec]` に省略可能な第 2 引数を足す。`<name>` は
その point だけを候補にし、`!<name>` はその point だけを除外する。`completion-gate.sh` は
role から固定して渡す。

| role | point-spec | 意味 |
|------|-----------|------|
| `design` / `design_review` | `!code` | `code` 以外のすべて |
| `exec` / `exec_review` | `code` | `code` のみ |

**包含で書けるのは code 側だけである。** design 側を literal `design` へ包含スコープする案を
一度採ったが、これは誤りだった（実装中に発覚。ruling R-T2-1）。Phase A-R は **checkpoint を
2 つ持ち**（spec 後・plan 後。`SKILL.md:688-689` / `apps/cmux-team-dispatch-task/CLAUDE.md`
項目 14）、point 名は固定ではない — `SKILL.md:911` は実測された checkpoint 名を
`spec` / `plan` / `design` / `code` と明記している。固定名で包含すると superpowers モードの
design ペインが自分の `spec-round-*` / `plan-round-*` を見失い、**いま塞いでいる masking が
design 側へ移る**。`code` だけが固定名である（`phase-b-deliver.sh:168,177,196` と
`launch-workspace.sh:1071` に焼き込まれている）ため、design 側は「`code` 以外」として表す。

**未スコープへのフォールバックは設けない。** 空振り時に全体走査へ退避すると、いま塞ごうと
している masking を再現するだけである。スコープが空振りした exec は判定 7 に落ち、既存の
`REVIEW_HINT`（`completion-gate.sh:416`）がレビュアー名と依頼ファイルのパスを名指しで渡す。
これは 4-2 のヘルパーを呼ばせるための正しい誘導であり、`error` を勧める文面ではない。

## 5. F2 / F3 — PR プロトコルの埋め込みと検証

### 5-1. 問題

- F2（#79）: 実装とコードレビュー approve まで完了したが `git push` も `gh pr create` も実行
  せず、`result.md` に `Closes #79` と書いて完了扱いにした。ブランチはリモートに存在しなかった
- F3（#75）: R17 の 3 remote 環境で `git push` が fork に、`gh pr create` が fork 内 PR を作った。
  issue は origin 側にあるため `Closes #75` も効かない

R1〜R3 のとおり、いずれも機構側に PR 手順が存在しないことに起因する。宣言（R3）と実装の差を
埋める。

### 5-2. `<status-dir>/integration.json` — 親が解決した PR 先を配る

`phase-b-deliver.sh` は**子（design ペイン）が呼ぶ**スクリプトである（`SKILL.md:742`）。
そこへフラグを足すと、D3 が要求する「親が origin を解決する」を子のコマンドライン組み立てに
依存させることになり、子がフラグを落とせば静かに元の挙動へ戻る。

したがって値は**親が書き、子は読むだけ**にする。書き手は `prewarm-panes.sh` とする。親が
直接呼ぶスクリプトで、`--status-dir` と `--slug` を既に受け取っており、`BRANCH_NAME="feat/$SLUG"`
も既に計算している（`scripts/prewarm-panes.sh:252`）。

`prewarm-panes.sh` に追加するオプション:

```
--integration <pr|merge>    既定 merge
--pr-repo <owner/repo>      integration=pr のとき必須
--pr-base <branch>          integration=pr のとき必須
--pr-issue <N>              任意（loop モードでのみ渡る）
```

`--pr-repo` は親が `git remote get-url origin` から解決する（D3）。子に remote 選択を任せない。

これらから `<status-dir>/integration.json` を書く:

```json
{"integration":"pr","repo":"owner/repo","base":"main","head":"feat/<slug>","issue":123}
```

`integration=merge`（既定）のときは `{"integration":"merge"}` のみを書く。ファイルは常に書く —
不在を「merge のことだろう」と推測させない。

`.send-command` と同じ「親が status dir へ置き、子は読むだけ」のパターンである
（`completion-gate.sh:107-108`）。6 節のガードもこのファイルを読む。

### 5-3. `phase-b-deliver.sh` への PR 手順の埋め込み

`phase-b-deliver.sh` は `<status-dir>/integration.json` を読む。**新しいフラグは追加しない。**
ファイルが無い、または壊れている場合は die する（親の配線ミスであり、黙って merge 扱いに
すると F2 が再発する）。

`integration=pr` のとき `STATUS_PROTOCOL` へ次を逐語で埋める。値はすべて JSON から取り、
子に解決させない。

- push は `git push -u origin <head>` に固定する。**他の remote へ push してはならない**
- PR は `gh pr create --repo <repo> --base <base> --head <head>` に固定する
- `issue` が JSON にあるとき、PR 本文へ `Closes #<issue>` を含める。無いときはこの行を出さない
- PR 作成後、`record-pr.sh` を呼んで `pr_url` を記録する。記録は自己申告ではなくスクリプトが行う
- `report-status.sh <status-dir> done` は `record-pr.sh` の成功後にのみ呼ぶ

`integration=merge` のときは PR に関する文言を一切出さない（現行どおり）。

### 5-4. 新設 `scripts/record-pr.sh`

```
record-pr.sh --status-dir <dir> --repo <owner/repo> --head <branch>
```

1. `gh pr list --repo <owner/repo> --head <branch> --json url,state` を実行する
2. **指定リポジトリ上に PR が実在しなければ非ゼロ終了する**
3. 実在すればその URL を `status.json` の `pr_url` へマージする（`report-status.sh` と同じ
   mktemp + mv の原子的置換。既存フィールドは保存する）

子が URL を自己申告する経路を作らない。これにより F3 のフォーク PR は「origin 上に無い」と
して弾かれ、F5 の「報告と実ファイルの乖離」がこの経路では原理的に起きない。

## 6. F2 / F4 / F5 — `report-status.sh` のガード

R16 の位置引数契約は変更しない。判定材料は `<status-dir>` 配下のファイルと R15 の環境変数
だけで、新しい引数も新しい配線も足さない。

| # | 条件 | 挙動 | 由来 |
|---|------|------|------|
| V1 | `integration.json` の `integration` が `pr` かつ `status=done` かつ `status.json` に `pr_url` が無い | **拒否**（exit 1）。stderr に「integration=pr では PR URL の記録が完了条件。`record-pr.sh` を先に実行せよ」 | F2 / D2 |
| V2 | `DISPATCH_GATE_ROLE=design` かつ `.deferred` が存在かつ `status=done` | **拒否**（exit 1）。stderr に「このタスクは exec ロールへ委譲済みで、terminal status の所有者は exec である」 | F4 / D2 |
| V3 | `status=done` かつ `result.md` が不在または空 | 書き込みは**通す**。`status.json` に `result_missing: true` を記録し、stderr に警告 | F5 / D2 |

**`error` は 3 条件すべてで常に許可する。** 本当に壊れたときの出口を塞がない。

V1 は `integration.json` が読めないときには発動しない（fail-open）。ガードの誤判定でタスクが
永久に終わらなくなる事態を避けるためで、配線ミス自体は 5-3 の `phase-b-deliver.sh` の die が
先に捕まえる。

V2 は SKILL.md の状態プロトコル「A delegated design session ... must not overwrite the exec
role's terminal status」（`SKILL.md:807`）を機構で担保するものである。#78 では design ペインが
正しく委譲したうえで `status=done` を書き、実装が 1 行も入っていない状態で done が立った。

V3 を拒否にしないのは D2 の決定による。`result.md` を書けない事情（sandbox / ディスク）が
あると完了不能になるためで、代わりに親が検知できる痕跡を残す。

あわせて SKILL.md の Step 3（wake ごとの再導出）に、`result_missing` を再導出の材料として
読むことと、「完了通知は額面どおり受け取らず、PR 実在と agmsg 履歴で裏を取る」を明記する。

## 7. F6 — 配線中の誤報告

### 7-1. 問題

全 8 タスクで発生。最多は #74 の 9 通連続。内容は「prewarm.json does not exist / no exec agent
available / awaiting instructions」。#76 と #80 は `.escalated` まで書いた。親のインボックスが
これで埋まる。

R7 / R8 のとおり、prewarm.json の publish 前に design ペインの Stop hook が発火し、gate が
「親へ報告せよ」と指示している。

### 7-2. `.wiring` sentinel

- `prewarm-panes.sh` が**最初のペインを起動する前に** `<status-dir>/.wiring` を touch する
- `mv prewarm.json` の直後に削除する
- 既存の rollback / die 経路でも削除する（`ROLLBACK_ACTIVE` の解除と同じ位置）
- `completion-gate.sh` の design 分岐は、prewarm.json が読めずかつ `.wiring` が存在するとき
  **静かに allow する**（stdout へ何も出さない）

配線中の design ペインは「タスク到着を待つ idle」であり、停止して良い状態である。allow が
正しい。

### 7-3. prewarm.json 自体にプレースホルダを書かない理由

R9 のとおり、スナップショット契約は 3 か所が独立に厳格検証しており、`{"status":"wiring"}` は
3 か所すべてで `invalid prewarm snapshot` になる。別ファイルの sentinel なら契約に一切
触れない。

## 8. F9 — cleanup の可視化と責任の一致

### 8-1. 問題

batch 2（4 タスク）の cleanup が 5 分制限を超えて SIGTERM。ラベル遷移と `.dispatch` 削除、
worktree 3/4 までは完了し、残り 1 つの worktree 削除と cmux workspace の close が未実行のまま
残った。

### 8-2. close の責任を `loop-cleanup.sh` へ寄せる

R12 / R13 / R14 のとおり、ドキュメントは「cleanup が閉じる」と書き、実装は親側の Step 4 に
ある。**ドキュメントに実装を合わせる。**

surface / workspace の close を `loop-cleanup.sh` のタスクループ内、`leave.sh` 呼び出しの直前へ
追加する。検証済みの `cleanup_workspace` と `PREWARM_DOC` は既にその位置にあるため、追加は
surface の列挙・重複除去と `close-surface` / `close-workspace` の呼び出しだけで済む。
SKILL.md:1628-1657 の明示 role 列挙と awk 重複除去の規則はそのまま踏襲する。

これによりタスク単位の後片付けが 1 か所で完結する。途中で SIGTERM されても
「3 タスクは完全に終わり、4 つ目が未着手」という切れ方になり、どこまで終わったかが
worktree の有無から一意に決まる。

**`SKILL.md:1628-1657` の Step 4 インラインブロックは削除しない。** これは loop モード
専用ではなく通常 dispatch の cleanup であり、`loop-cleanup.sh` を通らない経路が使う。
移設ではなく、loop 経路に同等の処理を持たせるという意味である。

### 8-3. 進捗の可視化

`loop-cleanup.sh` は既に `log()` を持つ。各タスクの各段階（WIP 保全 / finalize / ラベル /
worktree / branch / close / leave）を stderr へ 1 行ずつ出す。外から「どこまで終わったか」が
分かるようにする。

`references/loop-mode.md`（および `-ja`）に次を記載する。

- 所要時間の目安（`gh` 呼び出しが 1 タスクあたり 3〜5 回、worktree 削除を含めて数十秒規模）
- 4 タスク規模では Bash tool の timeout を明示的に引き上げること
- R13 の記述を実装に合わせて修正すること

### 8-4. `verify_done` の PR 検索にリポジトリを指定する

`loop-cleanup.sh:56` の `gh pr list --head "feat/$slug"` には `--repo` が無い。F3 と同じ欠陥で、
fork 側に作られた PR を「完了の証拠」として拾ってしまう。5-2 の `integration.json` から
`repo` を読み、`gh pr list --repo <repo> --head <head>` に修正する。

これは 5 節の予防（正しい remote へ作らせる）に対する検知側の対応である。両方が要る —
過去の運用で既に fork 側へ作られた PR が残っている場合、予防だけでは検知が誤ったままになる。

## 9. 未実測の事項（第2弾へ）

### 9-1. F7 — codex reviewer が `.dispatch/*/review/` に書けない

R10 / R11 のとおり `--add-dir` は実在し、実際に渡っている。したがって
「許可漏れ」という当初の仮説は**成立しない**。原因は未特定である。

調査手順:

1. scratch な status-dir を作り、codex の review ペインを 1 枚だけ起動する
2. その配下 `<status-dir>/review/probe.md` への書き込みを試み、成否を記録する
3. 失敗する場合、`-c sandbox_workspace_write.writable_roots=[...]` を明示指定した場合の
   挙動と比較する

結果に応じた選択肢:

- `--add-dir` が効いていない → `writable_roots` の明示指定へ切り替える
- どちらも効かない → gate が読む正規パスを worktree 側へ寄せ、**書ける場所と gate が見る
  場所を一致させる**（レポートの代替案）

#77 では request も findings も**どの命名でもディスクに現れず**、Phase B-R 全体が agmsg
メッセージのみで進行した。この事象が同じ原因かは切り分けが必要である。

### 9-2. F8 — 親の 90 分 safety timer が連続 kill される

`sleep $((90 * 60))` を `run_in_background` で張ったが、arm 2〜5 が 4 回連続で killed
（数分〜30 分で消滅）。原因未特定。

調査手順:

1. 現行方式（Bash `run_in_background` + `sleep`）の生存時間を測る
2. `Monitor`（`persistent: true`）を timer の担体にした場合と比較する

**原因が判明しなくても、次の分岐は SKILL.md Step 3 に入れる**（レポートの提案）。

> N 回（既定 2）連続で timer が killed された場合は再アームを止め、backstop が不在であることを
> ユーザーへ明示する。

今回の運用では親が手動でこの判断を下した。判断を文書化して機構の一部にする。

## 10. 影響範囲

### 新規ファイル

- `skills/cmux-team-dispatch-task/scripts/review-request.sh`
- `skills/cmux-team-dispatch-task/scripts/record-pr.sh`

### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `scripts/review-state.sh` | `review_select_active` に point 引数を追加 |
| `scripts/completion-gate.sh` | role → point を渡す / `.wiring` 時の静かな allow |
| `scripts/report-status.sh` | V1 / V2 の拒否、V3 の警告記録 |
| `scripts/phase-b-deliver.sh` | `integration.json` の読み取りと PR 手順の埋め込み、依頼手順を `review-request.sh` へ |
| `scripts/phase-a-review-wait.sh` | 依頼手順を `review-request.sh` へ |
| `scripts/prewarm-panes.sh` | `--integration` / `--pr-repo` / `--pr-base` / `--pr-issue` の追加と `integration.json` 書き出し、`.wiring` の作成と削除 |
| `scripts/loop-cleanup.sh` | close-surface / close-workspace の追加、段階ログ、`verify_done` の `--repo` 指定 |
| `scripts/launch-workspace.sh` | `REVIEW_INSTRUCTION` の依頼手順を `review-request.sh` へ |
| `references/unattended/review-block.md` | 同上 |
| `references/unattended/code-review-block.md` | 同上 |
| `references/loop-mode.md` | cleanup の責任範囲の訂正、所要時間の目安 |
| `SKILL.md` | PR プロトコル、`result_missing`、safety timer の再アーム停止分岐、`review-request.sh` の参照 |

### 対訳（同一コミットで更新）

- `references/guide-ja.md`（SKILL.md と 1:1 対応）
- `references/loop-mode-ja.md`

`pnpm check:doc-lang` が CI ゲートである。`*-ja.md` 以外に日本語を書かない。

### テスト

更新: `test-review-state.sh` / `test-completion-gate.sh` / `test-completion-gate-injection.sh` /
`test-phase-b-delivery.sh` / `test-delivery-callsites.sh` / `test-loop-cleanup.sh` /
`test-cleanup-close.sh` / `test-prewarm-*.sh` / `test-skill-script-refs.sh` /
`test-review-contract-docs.sh`

新規: `review-request.sh` と `record-pr.sh` のテスト、`report-status.sh` のガード 3 条件の
テスト、`.wiring` 時の gate 挙動のテスト。

### バージョン

3.8.0 → 3.9.0。`apps/cmux-team-dispatch-task/.claude-plugin/plugin.json` /
`.codex-plugin/plugin.json` / ルート `.claude-plugin/marketplace.json` の 3 箇所を同期する。

## 11. 本 spec が扱わないもの

- F7 / F8 の修正（9 節の調査後、第2弾の spec で扱う）
- レポートが「正常に機能した」と記録した経路の変更（`phase-b-deliver.sh` 経由の委譲配線、
  design review の内容、`review-gate.sh` の `code-review.json` 発行、agmsg 配送）
- `report-status.sh` の位置引数契約の変更（R16）
- PR 作成先の config 化（D3 で不採用）
