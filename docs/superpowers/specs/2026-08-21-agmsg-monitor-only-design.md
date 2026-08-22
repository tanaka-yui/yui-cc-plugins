# agmsg monitor 専用化 設計

対象: `cmux-team-dispatch-task` / `cmux-codex-review` / `cmux-codex-exec`

## 目的

セッション間の配送と待機を **agmsg monitor モード 1 本**に統一する。タイプ入力による
配送（`cmux send` + `send-key`）と、状態ファイル・メッセージ履歴のポーリング待機を
全廃し、待機ループを 1 つも残さない。

削除見込みは 3 プラグイン合計で約 1,200 行と、それに付随する静的検査・単体テスト群。

## 背景: 前提が逆転した経緯

この設計は過去 2 回、前提の取り違えで方向を誤っている。三度目を防ぐため経緯を残す。

| 時点 | 判断 | 実際 |
|------|------|------|
| 2026-08-12 の設計 | 「agmsg push は idle セッションを起こせる」= 完全 agmsg 化が可能 | **誤り**。Monitor ツールがハーネスに無く、`watch.sh` は nohup Bash で動くため、相手が次にターンを持つまで届かなかった |
| 2026-08-13 の検証 (V1) | 「agmsg push は idle セッションを起こせない」= dual-send が正しい | **当時は正しい**。ただし原因は agmsg ではなく**ハーネスに Monitor ツールが無かったこと** |
| 2026-08-21 の再検証 | Monitor ツールが存在するので前提が復活する | 下表のとおり **成立する**。V1 の fail 原因は消滅し、V2 は seat 記録を足せば通る |

V1 の記録は `docs/superpowers/specs/2026-08-12-delivery-verification-results.md`。
同ファイルには今回の再検証結果を追記し、削除はしない。

## 実測結果 (2026-08-21)

| ID | 検証内容 | 結果 | 観測 |
|----|---------|------|------|
| B1 | Monitor イベントは idle な claude セッションを起こすか | **pass** | 親セッションがターンを閉じた後、20 秒後に届いた agmsg で再起動された |
| B2 | ターンを一度も持っていないペインは受信できるか | **fail (制約)** | ready sentinel が作られず無反応。V1 の観測 2 と同じ |
| B3 | codex bridge の導入状況 | **pass** | `~/.zshrc.local:47` に `codex()` 関数が定義済み。`codex-shim.sh` 経由で app-server bridge に載る |
| V2a | seat 未記録の idle codex は受信するか | **fail** | メッセージは inbox に未読で滞留。`delivery.sh status` は `has no session recorded, though one thread is loaded` |
| V2b | seat 記録後の idle codex は受信するか | **pass** | `codex-record-session.sh` 実行後の再送で inline 配信され、codex が応答した |
| B5 | `ready.<team>__<agent>` sentinel は存在するか | **存在しない** | agmsg 1.2.1 の `watch.sh` に書くコードが無く、`run/` に 1 つも無い。readiness の実体は `run/watch.<session_id>.pid` (claude) と `run/codex-bridge.<team>.<agent>.thread` (codex) |

> **B5 の追記（2026-08-22、コード確認によるスパイク）**: 「sentinel は存在しない」という
> 計測結果は現在の agmsg では**成立しない**。`lib/actas-lock.sh:69-73` の `agmsg_ready_path`
> が `run/ready.<team>__<agent>` を組み立て、`watch.sh` が購読解決後に作成して exit で削除する
> （「present iff a live watcher is currently receiving for that role」）。(team, agent) キー
> なので**形としては親から観測できる**。
>
> **ただし dispatch では使えない。** sentinel を作るのは **actas（排他）watcher だけ**である
> （`watch.sh` の `if [ -n "$ACTIVE_NAME" ]`。コメントも "Only exclusive (actas) watchers
> signal" と明示）。SessionStart hook が role-filtered ディレクティブ（`watch.sh` の第 4 引数に
> agent 名を付ける形）を出すのは、そのセッションの bare sid が既に role の seat として
> 記録済みのときだけで（`session-start.sh:313-333`、#339）、記録するのは `actas-claim.sh` か
> codex actas である。dispatch はどちらも呼ばないため、**現行の子ペインは sentinel を 1 つも
> 作らない**。したがって `[ready] <name>` の自己申告が唯一の手段であるという結論は変わらない。
>
> **採用しない判断**: sentinel を子 readiness に使うには全ロールペインを actas 化する必要が
> ある。actas watcher は claim 失敗時に `exit 1` で落ちる（`watch.sh:479-483`）ので、ペイン
> 起動時の致命パスが 1 本増える。`[ready]` の自己申告は両 engine で動いていてコストが無いため、
> 動いているものを新しい致命パスと引き換えに捨てる取引になる。
>
> **記録に値する副産物**: actas 化は read cursor 競合（上記「read cursor の排他」）を**構造的に**
> 解く。unfiltered watcher は他セッションが保持するペアを購読集合から外すからである
> （`watch.sh:452-460` の `skipped` 分岐）。今回実装した `sharing=` が事後の警告なのに対し、
> こちらは競合そのものを消す。ただし親の identity は `parent` なので**子を actas にしても親の
> ペアは守られず**、親も actas 化するとディスパッチ中に Monitor を張り替える問題へ戻る。
> 「ロール群をまるごと actas 化する」は一貫した将来設計だが、スパイクではなく設計判断である。
>
> なお `spawn --wait-ready` は既にこの sentinel をポーリングしている（#108）。agmsg 側には
> readiness 待ちの正式な primitive が存在するが、spawn / actas に紐付いている。
>
> **この結論は 2026-08-22 に一部撤回した（未解決）。** 上で「dispatch の子ペインは sentinel を
> 1 つも作らない」と書いたが、稼働中のディスパッチの live watcher を数えたところ
> `influencer-platform` の 4 ロールと `parent` は**全て role-filtered（actas）** であり、
> `unfiltered` は 1 つも無かった（`run/watch.*.filter` の 1 行目が role 名）。対応する
> `run/ready.<team>__<agent>` も実在する。つまりどこかで actas になる経路があり、
> 「dispatch は actas を呼ばない」という前提が実態と合っていない。
>
> **その経路を特定するまで、この節の採否判断は保留とする。** 経路が判明すれば
> 「sentinel は使えない」という結論も、それを根拠にした「actas 化は大きな変更」という
> 評価も、両方とも見直しになる。特定作業は未着手。
>
> 本文の B5 依存箇所は当時の計測として残す。
| E2E | codex 系プラグインの実起動 1 本で、親が Monitor の push だけで完了を検知できるか (B4 の代替) | **pass** | 2026-08-21。`/codex-review --base main` を surface:40 / token=`codex-review-40` / team=`yui-cc-plugins` / reviewer=`cxrev-monitor-e2e` / parent=`parent` で起動。(1) 旧ポーリング watcher の bin もプロセスも不在 (2) background task は `sleep` 1 本だけ (3) codex 完了後、`06:26:40Z \| yui-cc-plugins \| cxrev-monitor-e2e → parent \| DONE codex-review-40: レビュー完了 agents=6` の 1 行で idle の親が起床 (4) token 一致・`agents=6` も転記 (5) codex 側で 3 テストスイート / turbo check / check-doc-lang / `bash -n` が全 pass。上記 (1)-(5) がこの行に転記した観測そのもので、これが証拠である（実行時の作業ログは git-ignored なスクラッチにしか残らないため、参照先としては挙げない） |
| D-E2E | dispatch の縮小 E2E（prewarm から実ペインを起動し、readiness / 配送 / 完了通知を実測） | **pass** | 2026-08-21。scratch repo に design(claude) + codex executor を prewarm 起動。(1) readiness プロンプトが `zsh -ic "claude ... 'PROMPT'"` の二重引用を無傷で通過（クォート破綻・グロブ展開なし、「末尾ピリオド禁止」「1 引数で渡す」の指示も到達）(2) codex の seat が `run/codex-bridge.<team>.<agent>.thread` に記録され V2a の未読滞留は再現せず (3) `[ready] e2e-mon-codex` と `[ready] e2e-mon` が**末尾ピリオドなし**の正確なワイヤフォーマットで両エンジンから到着（B4 の未実施分もここで回収）(4) 親→codex 子へ agmsg push でタスクが届き、worktree の `src/a.js` が実際に編集された (5) `DONE e2e-mon-codex` が親へ返った |
| D-T2 | **codex は自分宛の遅延メッセージでタイマーを張れるか** | **fail** | 2026-08-21。2 形式とも不発。`( sleep 60; send.sh ... ) &` も `setsid nohup bash -c '...' &` も codex のターン終了で消える（指示から 2 分以上後に `e2e-mon-codex → e2e-mon-codex` のメッセージ 0 件、残存プロセスも 0）。**codex の待機者には保険が存在しない。** 詳細は下記「E2E が見つけた欠陥」 |
| T1 | バックグラウンドの単発 `sleep` タスクは exit でセッションを起こすか | **pass (60 秒で 1 回のみ)** | 2026-08-21。Bash ツールの `run_in_background: true` で `sleep 60` を張り、06:42:38Z → 06:43:38Z にちょうど 60 秒で exit。その exit が `<task-notification>` としてセッションへ注入され、reap もされなかった。**60 分 / 90 分の実測ではなく、compaction を跨いだ生存も未観測**（60 秒では compaction が起きないため）。この 2 点は依然として明文化されていない仮定である |

B4 として子 claude 上での B1 再現も予定していたが、probe 用の子が別アカウントの
weekly limit に当たりターンを持てなかったため未実施。B1 は親セッションで観測済みで、
子と親でハーネスは同一のため、B4 は E2E で確認した（上表の E2E 行。dispatch の子 claude
での再現は dispatch 側の E2E に残る）。

### E2E が見つけた欠陥（2026-08-21）

静的検査は 9 タスク分すべて緑で、各タスクのレビューも通っていたが、実ペインを起動して初めて
分かった欠陥が 3 件ある。**動かすまで分からない種類がここに集中している。**

#### F1 (Critical) codex の待機者には保険が存在しない

`( sleep N; send.sh ... ) &` も `setsid nohup bash -c '...' &` も、**codex のターン終了で消える**
（D-T2 の実測）。したがって「codex は自分宛の遅延メッセージでタイマーを張る」という指示は
**動かない手段を指示していることになる**。影響を受けるのは Phase A-R の design ペイン、
Phase B-R の実装者、親オーケストレータのいずれかが codex のとき。

親が claude なら親の 90 分タイマーが最後に拾うが、**all-Codex 構成では誰も拾わない**。
`review-verdict` や完了通知が失われた瞬間、その待機者は永久に眠る。

**動かないと実測で分かった手段を指示文に残すのは、手段が無いと書くより悪い**（待機者は保険が
あるつもりで眠る）。最低限、指示を実態に合わせる必要がある。より良い機構
（`launch-workspace.sh` は codex のサンドボックス外で動くので、そこで張る等）は後続の課題。

**2026-08-22 の対処（v2.0.0 で merge する範囲）**: 機構は変えず、指示文を実態に合わせた。

- codex 待機者・codex 親の分岐から自己タイマーの指示を全削除し、「**この engine には保険が
  無い**」と明記した（`SKILL.md` Phase A-R / Phase B-R / Step 1g / Step 3、
  `launch-workspace.sh` の `REVIEW_INSTRUCTION`、`references/unattended/code-review-block.md`
  と `review-block.md`、`guide-ja.md` / `README.md` / `CLAUDE.md`）
- 代替として、codex 待機者には「待機に入る前に依頼相手の到達性を確認し、待機に入ったことを
  親へ `dispatch-notify:` で 1 通報告する」を課した
- **無人ループ（`--unattended`）× codex 親は `prewarm-panes.sh` が die する**ようにした
  （`test-prewarm-unattended.sh` の U10 / U10b が固定）。無人ループには聞ける相手がいないので、
  保険ゼロの構成を走らせない
- `review-timer:` / `dispatch-timer:` label は**予約のまま残す**が、現在これを送る箇所は無い
  （後続の timer broker が再利用できるようにするため）
- 検査は `test-delivery-callsites.sh` の CS7 を engine 別に分割し（claude=タイマーがある /
  codex=保険が無いと書かれている + 自己タイマーの指示が復活していない）、
  `test-launch-workspace-review-config.sh` の T3b を同じ形にした

#### F2 (Important) 「待て」とだけ言うと codex がポーリングを再発明する

readiness 句の「Then wait idle. Execution instructions will arrive as an agmsg message.」を
受けた codex は、**自分で `inbox.sh` のポーリングループを書いた**:

```
for i in {1..11}; do agmsg_inbox_output="$(bash .../inbox.sh <team> <agent>)";
  if [ "$agmsg_inbox_output" != 'No new messages.' ]; then printf '%s\n' "$..."; exit 0; fi;
  sleep 5; done
```

害は 2 つ。(1) 「待機ループを 1 つも作らない」という設計の目的そのものを子が破る。
(2) **`inbox.sh` は row を既読にする**ので、`[ready]` 直後にタスクを配送すると bridge ではなく
子の自作ループが飲み込むレースになる（この設計自身が「`history.sh` を使い `inbox.sh` は
使うな」と定めている理由と同じ）。

**ポーリングは消えたのではなく移動しうる。** 親から消しても、子に「待て」とだけ言えば子が
再発明する。指示文に「ポーリングするな。メッセージは自動で注入される」と明示する必要がある。

#### F3 (Important・既存バグ) prewarm の検証と runner 解決が食い違う

`prewarm-panes.sh` の検証は `--exec-runner` **または** `--codex-runner` のどちらでも通すが
（`exec_choice=codex requires --exec-runner or --codex-runner`）、解決は
`--exec-choice codex` のとき `--exec-runner` しか読まない。`--codex-runner` だけを渡すと
**検証を通過したうえで runner が空になり `claude` にフォールバックする**。

結果として、codex 向けのプロンプト（`codex-record-session.sh` を呼べ）を渡された **claude ペイン**
が立ち上がる。`main` と同一のコードなので**このブランチの退行ではない**が、monitor 専用化で
深刻度が上がった: 以前は engine が違ってもタイプ入力で配送されたが、今は **engine ごとに
readiness の確立手段が違う**ので、不一致は静かな不通に直結する。

### 制約として扱う 3 点

1. **各ペインは初回ターンを 1 回持つ必要がある** (B2)。claude は Monitor 起動、
   codex は bridge 起動がそのターンで行われる。
2. **codex ペインは seat 記録が必要** (V2a/V2b)。現行の `prewarm-panes.sh:411` は
   `delivery.sh set monitor codex` までは行うが seat を記録しないので、親→codex の
   配送を agmsg に切り替えた瞬間に未読滞留で止まる。
3. **claude 子の readiness は親から観測できない** (B5)。readiness シグナルが
   session id キー (`run/watch.<session_id>.pid`) で、親は子の session id を知らない。
   よって claude 子の readiness は **agmsg による自己申告 (`[ready] <slug>`) が唯一の
   確認手段**である。codex 子は `run/codex-bridge.<team>.<agent>.thread` が team/agent
   キーなので親から観測できる。

### 副産物: 現行の inbox 記録は既に死んでいる

`send-prompt.sh` の「watcher が生きていれば inbox にも記録する」半分は、B5 のとおり
sentinel 自体が存在しないため **agmsg 1.2.1 では一度も発火していない**。現行の dual-send
は実質タイプ入力のみで動いている。`cmux-team-dispatch-task/CLAUDE.md` の検証項目 17 が
求める「親の watcher が生きていれば同一文が inbox にも記録される」は現バージョンでは
成立しないので、この機会に記述を正す。

## 配送コントラクト

配送手段は `~/.agents/skills/agmsg/scripts/send.sh` の 1 本だけ。`cmux send` /
`cmux send-key` は配送から消え、残るのは「シェルにペイン起動コマンドを打鍵する」
用途のみ (既存の `send-prompt-exempt:` マーカーと同じ位置づけ)。

### readiness の 3 要件

全ペイン共通。3 つ揃って初めてそのペインは配送先になれる。

1. team に join 済み — `join.sh <team> <name> <type> <cwd>`
2. そのプロジェクトが monitor モード — `delivery.sh set monitor <type> <cwd>`
3. ペインが初回ターンを 1 回持った。その結果として:
   - claude → Monitor ツールが起動し `run/watch.<session_id>.pid` が出る
     (session id キーなので**親からは観測できない**。B5 / 制約 3)
   - codex → bridge が起動し `run/codex-bridge.<team>.<agent>.thread` に seat が記録される
     (team/agent キーなので親から観測できる)

### read cursor の排他（要件）

**read cursor は (team, agent) 単位で 1 つしかない。** `storage_watch_after` は既読 row を
除外するので、同じ (team, agent) を購読する watcher が 2 つあると**先に poll した方が row を
取り、他方は何も見ない**（`watch.sh:619-626`）。取られた row は read マークされるため、
`inbox.sh` も「新着なし」と正直に答える。

しかも既定のディレクティブは**フィルタ無し**である。`session-start.sh:367-378` は
`watch.sh <instance> <project> <type>` を第 4 引数（agent 名）**なし**で起動するため、その
プロジェクトに登録された全 (team, agent) を購読する（`watch.sh:432-435`）。同じチェックアウトで
2 セッションを開くだけで競合が成立する。

よって配送コントラクトに次を要件として加える（**2026-08-22 に検出のみを実装して確定**）:

> **親は同一プロジェクトを見る競合 unfiltered watcher が居ないことを確認し、居れば報告する。**

- **採用（実装済み）— 検出**: `verify-agmsg-ready.sh --parent` が
  `~/.agents/skills/agmsg/run/watch.*.filter` を走査する。1 行目 = role または `unfiltered`、
  2 行目 = プロジェクトパス、3 行目 = owner pid。自分以外に live な unfiltered watcher が同じ
  プロジェクトに居れば `sharing=<N>` として数え、Step 1g と起床時検査が正の数のときだけ 1 行
  警告する。**到達可能かどうかの判定は変えない**（exit code に影響しない）: 競合していても
  自分が row を取る可能性は残るので、止めるのは過剰である。判定できないときは `0` ではなく
  `sharing=unknown` を返す。比較対象のプロジェクトは推測せず、**自分の filter ファイルの
  2 行目**、すなわち agmsg 自身が記録したプロジェクトを使う。
- **見送り — 排他の主張**: `actas-claim.sh <project> <type> <name> <session_id>`。手順として
  Monitor の `TaskStop` と `<name>` 付き再起動を要求する（`actas-claim.sh` のヘッダが
  join → claim → Monitor 再起動の順を明示している）。ディスパッチの最中に親自身の受信チャネル
  を張り替えることになり、塞ごうとしている穴より大きい危険を持ち込む。**採らない。**

**agmsg 自身も同じ検出を持つ**（`watch.sh:279-337`、#683。この設計を書いた時点では未確認
だった）。ただし出力は `watch_log` 経由で **stderr** へ出る。Monitor tool がイベント化するのは
stdout だけなので、その警告は親セッションに届かない。dispatch 側で数え直す理由はこれである。

この穴は codex 系プラグインだけの問題ではない。dispatch は単一の `parent` identity を
`[ready]` / `dispatch-notify` / `review-verdict` の**全部**に再利用するため、そのままでは
親のチェックアウトにある第 2 のセッションがどのメッセージでも消費しうる。

### 起きたら永続記録を読む（全経路の規則）

上記の競合、watcher の自己終了（`watch.sh:426-429` の `_install_changed`。agmsg の `scripts/`
が起動時より新しいと watcher は黙って自己終了する）、`send.sh` のハング、相手が指示に従わない、
といった経路では**メッセージだけが失われて成果物はディスク上にある**。したがって:

> **どの経路で起床しても、何かを判断する前に永続記録を 1 回読む。**

| 待っているもの | 起床時に読む永続記録 |
|---|---|
| 子 → 親の完了 / abort | `.dispatch/*/status.json` |
| レビュアー → 依頼者の verdict | `<point>-round-<N>.md` の `VERDICT:` 行 |
| 子 → 親の readiness (`[ready]`) | `history.sh <team> <agent> N`（**`inbox.sh` は不可**。取られた row は既読になる） |
| codex 系の完了通知 | `history.sh <team> <parent> 30 \| grep -F "DONE <token>:" \| tail -1` |

`history.sh` を使い `inbox.sh` を使わないこと、直近 N 行に限って**最も新しい一致**を採ること
（token はペイン番号由来で再利用されうる）を規則として固定する。

**照合は接尾の区切りまで含めて行う。** token もスラッグも裸で `grep -F` すると前方一致で衝突する
（`codex-review-4` は `codex-review-40` の前方一致、スラッグ `api` は `api-v2` の前方一致）。
完了通知の本文は必ず `DONE <token>: <text>`、readiness は必ず `[ready] <slug>` で行末に来るので、
前者は `grep -F "DONE <token>:"`、後者は `grep -E '\[ready\] <slug>$'` で照合する。裸の照合は
**進行中を完了と誤報告する**——通知の見逃しより悪い誤答である。メッセージが来ないことを
「相手が失敗した」と読み替えてはならない。盗られた `[ready]` を理由に健全な子を error に
落とすのは、この規則を破った典型である。

### 起動プロンプト

現在プロンプト無しで idle 起動している standby / review ペインも、**readiness 確立
だけを行う短い起動プロンプト**を持って立ち上げる。内容はエンジン別:

- claude: SessionStart hook の AGMSG-DIRECTIVE に従って Monitor ツールを起動する
- codex: `codex-record-session.sh <team> <name>` を実行して seat を記録する

いずれも末尾に「確立したら親へ `[ready] <slug>` を送り、以後 idle で待機する」を置く。
タスク本体は後から agmsg で届く。

### データフロー

| 経路 | 手段 |
|------|------|
| 親 → 子 (タスク委譲) | `send.sh` 1 回。長文の outbox 退避も Enter 検証も不要 (inbox に貼り付け判定は無い) |
| 子 → 親 (完了 / abort) | `status.json` 書き込み + `send.sh` 1 回 |
| レビュアー → 親 (verdict) | verdict ファイル書き込み + `send.sh` 1 回。親はファイルをポーリングせず通知で起きて読む |
| 子 → 親 (readiness) | `send.sh` 1 回 (`[ready] <slug>`) |
| 親の待機 | **待機コードなし**。ターンを閉じて idle になり、Monitor イベントで起きる |

メッセージ本文の先頭には現行の label を prefix として残す (`[dispatch-notify]` など)。
Monitor は 1 メッセージを 1 行で届けるので、親はこの prefix で種別を識別する。

### 親の状態管理

親に監視ループが無くなる代わりに、**起きるたびに `.dispatch/*/status.json` から状態を
再導出する**。`status.json` の形式・終端 status の sticky 化・`--defer-status` は不変で、
むしろ唯一の永続状態として重要度が上がる。

親自身の readiness は Step 1 で確認する (自分の sentinel の存在)。無ければ「この
ハーネスに Monitor ツールが無い」と明示して停止する。agmsg 未インストールも同様に
fail-fast とし、`AGMSG_INSTALLED` による true/false の二系統分岐は廃止する。

**この確認は起動時 1 回では足りない。起床ごとに再確認する。** 親自身の watcher は dispatch や
レビューの途中で死にうる（`watch.sh:426-429` の `_install_changed` による自己終了、`/compact`
と TaskStop の競合）。死んだ後は全ての子の通知が黙って失われ、頼れるのはタイマー 1 本だけに
なる。よって `verify-agmsg-ready.sh --self` は各 wake とタイマー発火のたびに再実行する。

### タイマー保険

子が quota 切れなどで一度も起動しなければ readiness 通知も完了通知も来ない。
ここだけ時間ベースの手段を残すが、ポーリングではなく**単発タイマーを 1 本**張る:

```
nohup sh -c 'sleep <T>' &   # プロセスの exit が親を起こす
```

親はこのタイマーで起きたら `status.json` を再評価し、terminal でないものを error に
するか延長する。`T` は既存の `task_timeout_min` を流用する。ループは残らない。

タイマーには次の 4 つの規則を必ず付ける。E2E で 3 つ目を実際に踏み、手で停止する必要があった。

1. **起きたら永続記録を先に読む。** 前節の規則をそのまま適用する。タイマーが問うべきは
   「相手は生きているか」ではなく「**メッセージは着いたか**」である。相手のペインの生存だけを
   見て再武装すると、対話ペインは終了しないので答えは常に「再武装」になる。
2. **再武装に上限を設ける。** 進捗のない再武装が N 回（既定 3）続いたら、黙って再武装せず
   `cmux read-screen` の内容を添えてユーザーへ報告する。上限の無い再武装は、エスカレーションも
   報告も無い無限ループである。
3. **完了を受け取ったらタイマーを止める。** 止めないと 60/90 分後に `sleep` が exit し、
   ユーザーが既に別の話題へ移った会話へ無駄な wake が注入される。Claude Code では `TaskStop`
   に task id を渡す（そのため `commands/*.md` の `allowed-tools` に `TaskStop` が必要）。
   放置すると再武装分岐へ入り、これも無限に続く。
4. **存在しないフラグ名を注釈に書かない。** Bash ツールに `--wake-after` のようなパラメータは
   無い。造語を注釈に書くと、読んだモデルがそれを渡そうとする。手段は散文で書き、静的検査は
   `run_in_background` + `sleep` に紐付ける。

## プラグインごとの変更

### cmux-codex-review / cmux-codex-exec

両者はほぼ同型。

**削除**

- `bin/cmux-codex-wait` (89 行 × 2 コピー) と `test/test-cmux-codex-wait.sh`
- SKILL.md / `commands/*.md` の「background task として wait を起動して待つ」手順
- `--timeout` / `--interval` / `--liveness-interval` / `--surface` の説明一式

**変更**

- 起動を報告したらターンを閉じる。完了は codex の `send.sh` が Monitor 経由で届く
- `token` は wait のマッチ用ではなく「どの依頼の完了か」を親が識別するラベルとして残す
  (並行レビュー時に必要)

**seat 記録は不要**。この 2 プラグインの codex は送信専用で、受信するのは親だけである。
親→codex の追撃指示を agmsg で送る経路は現行仕様に無いので、スコープ外とする。

### cmux-team-dispatch-task

**削除**

| 対象 | 行数 |
|------|------|
| `monitor-dispatch.sh` + heartbeat / `--resume` / `.monitor.log` / `.monitor.pid` / DIED 通知 | 229 |
| `send-prompt.sh` + `agmsg-path.sh` + outbox 退避一式 | 207 |
| `batch-wait.sh` (loop mode は「バッチの子が agmsg で報告するまで idle」に変更) | 55 |
| SKILL.md の verdict ポーリングブロック × 2 (Phase A-R / Phase B-R) | 約 80 |
| `AGMSG_INSTALLED` の true/false 二系統分岐 | SKILL.md 各所 |
| `test-send-prompt.sh` (SP0a-SP26) / `test-send-prompt-callsites.sh` (CS1-CS3 は後述のとおり置換) / `test-agmsg-ready.sh` (AR1-AR34) / `test-message-type-removed.sh` (MT1-MT3) | 多数 |

**置換**

- `ensure-agmsg-ready.sh` (505 行) → `verify-agmsg-ready.sh` (約 80 行)。watcher は起動
  せず確認だけ行う。判定は B5 の実測に従う:
  - 自セッション (親) → `run/watch.<session_id>.pid` の存在
  - codex ペイン → `run/codex-bridge.<team>.<agent>.thread` の存在
  - claude ペイン → **判定しない**。`[ready]` の自己申告を待つ (制約 3)

  `delivery.sh status` の出力は判定に使わない。V2b の時点で `not running` と報告しながら
  bridge プロセスは実在し配信も成功していたため、これを fail-closed の条件にすると
  動いているペインを不通と誤判定する。

- `agmsg-path.sh` (37 行) は削除する。`ready.<team>__<agent>` を組み立てる唯一の用途が
  B5 で消滅した (`codex-bridge.<team>.<agent>.*` は team/agent をそのまま使う)

**変更**

- `launch-workspace.sh` — standby / review も readiness プロンプト付きで起動する。
  codex ペインの起動プロンプトには seat 記録を含める (V2a の fail がそのまま事故になる箇所)
- `prewarm-panes.sh` — `delivery.sh set monitor` は既にある (411 行目) ので流用する。
  `prewarm.json` の `delivery` / `watcher` キーは意味を失うので `ready` (bool) へ置換
- `terminal-wait.sh` は残す。agmsg とは無関係のシェル起動検知であり、配送待機ではない

## エラー処理と残余リスク

| ID | 事象 | 現状 | 新設計 |
|----|------|------|--------|
| U1 | 子が status.json も通知も出さず沈黙 | 未解決 | タイマー保険で検出 → **解消** |
| U9 | `/clear` 後に watcher が戻らない | 未解決 | SessionStart hook が再発火して Monitor を張り直す (実証済み) → **解消** |
| R1 | codex ペインの死亡 | `--surface` 生存確認で即時検知 | タイマー保険のみ。**検知が T 分後まで遅れる**。monitor 専用化の代償として受け入れる |
| R2 | codex の seat 喪失 (セッション再起動で thread が変わる) | 該当なし | 送信は成功するが未読滞留。**新規の残余リスク**として記録する |

R1 / R2 は `docs/notification-gaps.md` に追記し、U1 / U9 は解消として更新する。

## テスト

- **CS1 の強化**: 「`send-prompt.sh` 以外に `cmux send` 直書きが無い」→「**配送目的の
  `cmux send` がどこにも無い**」。例外はペイン起動の打鍵のみ (`send-prompt-exempt:` マーカー)
- **新規 `test-agmsg-only-delivery.sh`**: 起動プロンプトに (1) claude なら Monitor 起動
  指示、(2) codex なら `codex-record-session.sh`、(3) readiness 通知、(4) タイマー保険の
  指示が含まれること
- **`verify-agmsg-ready.sh` の単体テスト**: sentinel あり/なし × seat あり/なし ×
  bridge running/not の組み合わせ
- **E2E を必須とする**: 実ディスパッチ 1 本 (2 タスク並列 / design=claude / exec=codex /
  レビュー有効)。outbox が 1 つも生成されないこと、親が agmsg だけで全フェーズを進むこと、
  子 claude で B1 が再現すること (B4) を実測する

- **旧契約の語彙に対する否定検査**: 具体名 1 つの grep では陳腐化した記述を捕まえられない。
  旧ポーリング watcher の契約語彙 (`short-lived watcher` / `watcher's wait target` /
  `status=done|gone|timeout` / `--timeout` / `--interval` / `--liveness-interval`) が
  `commands/**` / `skills/**` / `bin/**` に出現しないことを検査する
  (`test-monitor-only.sh` の M6)

V1 の教訓は「静的検査だけで通したら前提が間違っていた」である。E2E を省略しない。
**そして E2E の結果は上の実測結果表に必ず記録する。** 証拠が SDD の作業ディレクトリにしか
無いと、specs を grep した将来の読者は古い結論に先に当たる（I6 で実際に起きた）。

## ドキュメント更新

- `2026-08-12-delivery-verification-results.md` に今回の再検証結果を追記する。**削除しない**。
  何がいつ変わって結論が逆転したのか (Monitor ツールの登場 / seat 記録の欠落) を残さないと、
  同じ混乱が三度繰り返される
- `docs/notification-gaps.md` の U1 / U9 を解消として更新し、R1 / R2 を追加する
- 3 プラグインの `SKILL.md` / `references/guide-ja.md` / `README.md` / `CLAUDE.md`
- `cmux-team-dispatch-task/CLAUDE.md` の検証項目 9 / 12 / 15 / 17 / 26 / 27 を書き換え、
  「readiness 3 要件と fail-fast」を新項目として追加

## バージョン

3 プラグインとも major bump。スクリプトと CLI フラグの削除を含む破壊的変更である。
`apps/<name>/.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` / ルートの
`.claude-plugin/marketplace.json` の 3 箇所を同期する。

## 後続の課題（別 PR）

このブランチ（v2.0.0）では扱わず、記録だけ残す項目。

### F1 の機構変更: timer broker（E2E 必須）

codex の待機者は自分でタイマーを張らず、`timer-request: <round> <seconds>` を claude の親へ
送る。親は期限で `review-timer:` を送り返す。**実測済みの唯一の機構（親の background sleep +
agmsg push）を再利用できる**のが利点で、`review-timer:` / `dispatch-timer:` label をそのまま
使える。codex 親しかいない構成では broker が立たないので、そこは今と同じく「保険なし」の
ままになる。この変更は指示文だけでは閉じないため、実ペインでの E2E を必須とする。

### I3: 配送コントラクトの read cursor 排他が実装にも指示にも無い（**2026-08-22 解消**）

`## 配送コントラクト` は read cursor の排他を要件として書いているが、実装されたのは
「起きたら `history.sh` を読む」という**事後の緩和策だけ**だった。

解消の形は「検出を足し、要件の記述を検出に合わせて下げる」である。`verify-agmsg-ready.sh` に
`--parent` モードを新設し、そこで競合 watcher を数えて `sharing=<N>|unknown` を返すようにした
（回帰は `test-verify-agmsg-ready.sh` の VR13-VR19 と `test-agmsg-guard-block.sh` の
GB9/GB10）。排他の主張は上記のとおり見送った。事後の緩和策（`history.sh` を使う、
`[ready] <slug>` を行末までアンカーする）は競合が起きたあとの回復手段として引き続き必要なので
残している。

### 小さいもの

- **M2**: `render-loop-prompt.sh:34` が `send.sh` のパスをハードコードしている
  （他の呼び出しは `AGMSG_SEND` で差し替え可能）
- **M3**: `prewarm.json` の `wired: true` は常に真の定数フィールド。フォールバックが無い以上
  `false` になる経路が存在しないので、診断としても意味を持たない
- **`guide-ja.md` のタイムアウト粒度の記述が重複**している
- **`prewarm-panes.sh` の死んだ条件**（`--agmsg-team` 必須化以降、後続 9 箇所の
  `[[ -n "$AGMSG_TEAM" ]]` は常に真。`CLAUDE.md` 項目 47）
- **`test-runner-terminal-status.sh` が 84 秒**かかる。テスト全体の直列実行が 2 分を超える
  主因である

## 適用範囲外

- codex bridge のインストール手順の自動化 (`~/.zshrc` への関数追加)。導入済み前提とし、
  未導入なら fail-fast で案内する
- 親→codex の追撃指示経路 (codex-review / codex-exec)。現行仕様に無い
- `terminal-wait.sh` の EMA ベースライン機構
