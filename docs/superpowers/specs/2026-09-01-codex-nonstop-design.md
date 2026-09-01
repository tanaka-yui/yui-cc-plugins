# codex ペインが作業途中で停止するのを構造的に止める

- 日付: 2026-09-01
- 対象: `apps/cmux-team-dispatch-task`
- ブランチ: `feat/codex-nonstop`
- 種別: 設計仕様
- 改訂: round 3（round 2 の needs_work を反映）

## 1. 発注

> 原因を見つけて、勝手なエージェントの判断ではなく、最後まで絶対に止まらないようにしたい。

停止した codex ペイン自身の自己申告は「途中経過の final を送ってターンを終え、再開用の継続処理を
残さなかった」であった。**この自己申告を対策として採用してはならない。** 「以後は途中で final を
送らず継続します」はエージェントの判断に委ねる約束であり、今回の原因そのものだからである。

> **ペインが停止してよいかどうかは、ディスク上の状態から機械的に決まらなければならない。**

## 2. 調査で確定した事実

### 2.1 gate は「executing なのに止まる」を既に止めている

発注の仮説 1 は偽である。gate を隔離した合成 STATUS_DIR に対して直接実行し、ロール × ディスク
状態の全数を実測した。

| STATE | design | design_review | exec | exec_review |
|---|---|---|---|---|
| executing のみ | BLOCK | ALLOW | BLOCK | ALLOW |
| request 未応答 | ALLOW | BLOCK | ALLOW | BLOCK |
| findings に VERDICT 無し | ALLOW | BLOCK | ALLOW | BLOCK |
| VERDICT 到着済み | BLOCK | ALLOW | BLOCK | ALLOW |
| **`.assigned-<agent>` 欠落** | **ALLOW** | ALLOW | **ALLOW** | ALLOW |
| `.deferred` | ALLOW | ALLOW | BLOCK | ALLOW |
| `.escalated` | ALLOW | ALLOW | ALLOW | ALLOW |
| done | ALLOW | ALLOW | ALLOW | ALLOW |
| status.json 破損 | BLOCK | ALLOW | BLOCK | ALLOW |
| status.json 無し | BLOCK | ALLOW | BLOCK | ALLOW |

`.assigned-<agent>` が在る限り、実装中の exec は判定 7 で必ず block される。gate の中核は
正しく動いている。**原因は判定 7 に到達する前に ALLOW へ落ちる経路にある。**

### 2.2 ALLOW は goals=false 以後「恒久的な死」になった

`98860e5` が `-c features.goals=false` を全 codex 起動点に入れ、codex の自己再開経路を消した。
**ALLOW された codex ペインは agmsg メッセージが来るまで二度と動かない。**

これは意図された代償として記録されている（`launch-workspace.sh:689-690`）。しかし誤 ALLOW の
コストは「1 サイクル遅れ」から「永久停止」へ変わった。既存の ALLOW 集合はこの変化を反映して
見直されていない。

### 2.3 V1 決着: block は goals と独立に codex を再駆動する（実測）

round 1 で最大の未確定事項だった点を、対象バイナリ `codex-cli 0.149.1` で実測した。

隔離した一時ディレクトリに `.codex/hooks.json` を置き、Stop hook を「1 回目だけ
`{"decision":"block","reason":"…marker に BANANA と書いてターンを終えよ…"}` を返し、2 回目
以降は無出力（allow）」とした。`-c features.goals=false` 付きで実行した。

**`codex exec`（非対話）と対話 TUI の両方**で測定した。対話側は dispatch と同じ経路
（cmux ペイン + `zsh -ic` + 同じフラグ）で起動した。

| 観測 | `codex exec` | 対話 TUI |
|---|---|---|
| Stop hook 発火回数 | **2** | **2** |
| 発火間隔 | 23 秒 | 26 秒 |
| `marker` の内容 | **`BANANA`** | **`BANANA`** |

対話側は画面上でも確認した。block の reason を受けた次ターンで
`printf %s BANANA > …/marker` を実行している。

**`decision:block` は goal continuation とは独立にターンを再駆動し、モデルは reason の指示を
実行した。** レビュアーが Context7 の `/openai/codex` source で確認した「同期 Stop hook の
block は continuation prompt を注入する」という記述が、対象バイナリ上で裏付けられた。

したがって **gate の block は単なるガイダンスではなく実効的な強制力を持つ。**
これはレビュー再条件 3 を満たす。

### 2.4 しかし gate は「停止したペイン」に期限を課せない

round 1 のレビューで指摘された、本設計の中心的な制約である。

**gate は Stop のときにしか実行されない。** ALLOW した瞬間にそのペインは静止し、次の Stop は
発生しない。したがって gate 内にどんな期限を書いても、その期限時刻に gate が呼ばれることは
ない。「予算切れ → block」は原理的に到達不能である。

これは `wait_guard` の現状を説明する。block 到達には「直前の Stop から 90 秒以内に再び Stop が
来る」ことが必要で、これは auto-restart 中にしか起きない。`98860e5` がその auto-restart を
消した以上、`wait_guard` はもう発火しない。**待機に上限が無い。**

> **期限を課せるのは、停止したペインの外側で動き続けている実体だけである。**

### 2.5 `.assigned-<agent>` 欠落による素通しは実際に起きている

`5ed0dcf` のコミット本文に実測が記録されている（lead-psp-liff の member、2026-08-31）。
手書きの引き継ぎ文で実装が始まり、`.assigned-member-exec` が作られなかった。gate は
判定 3 で毎回素通りし、実装ペインは一度も拘束されなかった。

`5ed0dcf` が入れた 3 層はいずれも素通し自体を止めていない。判定 3 に到達すれば今も無条件
ALLOW である。

**ただし受け手側（exec）でこれを判別することはできない。** `review/code-review.json` は
`review-gate.sh` が exec_review の readiness 確認直後、**設計タスクを開始する前に**書く
（`SKILL.md:469-488`）。実際、本 dispatch の STATUS_DIR には Phase A の現時点で既に
`code-review.json` が在り、`.assigned-<exec agent>` は無い。**正常な standby exec が
Phase A の全期間この状態にある。** `.dispatch-handoff.json` も `--status-dir` 付きペインへ
事前配置されるポインタであり、Phase B 到達の証拠ではない。

### 2.6 identity が無ければ gate は存在しない

`completion-gate.sh:74-77` は `DISPATCH_GATE_{STATUS_DIR,ROLE,AGENT}` のいずれかが空なら
stdout 無出力で `exit 0`（ALLOW）する。この env を export するのは **生成 runner script だけ**
である（`launch-workspace.sh:1279-1282`）。runner を経由しない起動では env が失われ、
そのペインは毎ターン黙って通る。

fail-open 自体は正しい（無関係な手動セッションを無期限拘束してはならず、Stop hook の
`exit 2` は blocking error であって no-op ではない）。問題は **fail-open が観測不能である**
ことである。

### 2.7 claude ペインでは脱出手段の案内が壊れている（実測）

| engine | Stop hook |
|---|---|
| claude | `zsh '<repo>/…/completion-gate.sh' --gate-id …` |
| codex | `bash '<repo>/…/completion-gate.sh' --gate-id …` |

`completion-gate.sh:124` は `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`。
`BASH_SOURCE` は zsh に存在しない。同一ファイルを両シェルで起動して実測した。

- `bash <file>` → スクリプト実体のディレクトリ（正）
- `zsh <file>` → `BASH_SOURCE[0]: parameter not set` を stderr に出し、**cwd に化ける**（誤）

結果、claude ペインが受け取る判定 7 の reason は存在しない `report-status.sh` を指す。
本設計セッション自身がこの誤った reason を受け取って確認した。案内どおり実行すると ENOENT と
なり終端ステータスを書けず、次ターンも同じ block が返る。**指示に忠実なエージェントほど
block ループに嵌まる。**

## 3. 全 ALLOW 状態の再列挙と保証境界

gate が停止を許すすべての状態を、**owner / waker / deadline / terminal** で列挙する。

| # | ALLOW 状態 | gate の行 | owner | waker | 現状の deadline | 本仕様後 |
|---|---|---|---|---|---|---|
| A1 | status done/error | `:246-249` | 本人 | 不要（terminal） | — | **C2: design の `done` のみ制限** |
| A2 | `.deferred`（design のみ） | `:252-254` | design | 不要（terminal） | — | **C2: 委譲が記録されている場合のみ** |
| A3 | `.escalated` | `:264-266` | parent | parent | 無し | **C1b: parent へ有界通知して terminal** |
| A4 | `.assigned` 欠落（design/exec） | `:351` | design/parent | phase-b-deliver | 無し | 変更なし（C2 で上流を閉じる） |
| A5 | findings に VERDICT 無し | `:355-358` | reviewer | reviewer | 名目 30 分 / 到達不能 | **C1: lease + 有界 nudge** |
| A5b | request 未応答 | `:363-366` | reviewer | reviewer | 同上 | **C1: lease + 有界 nudge** |
| A6 | review 側: round も request も無い | `:373` | design/exec | 依頼者 | 無し | 変更なし |
| A6b | `round_aborted()` | `:377-379` | 依頼者 | 依頼者 | — | 変更なし |
| A7 | review 側 fall-through | `:388` | — | — | — | 変更なし |
| A8 | `MAX_BLOCKS` 到達（既定では無効） | `:167-174` | 設定者 | 無し | 無し | 保証対象外 |
| A0 | identity 欠落（fail-open） | `:74-77` | 起動経路 | 無し | 無し | **C3: 観測可能にする** |

### 保証の対象と、その外側

本仕様が保証するのは次の 1 点である。

> **runner script 経由で起動され `DISPATCH_GATE_*` を持つ design / exec ロールのペインが、
> 作業の途中で、誰にも起こされないまま静止したままになることは無い。**

保証の外側を漏れなく列挙する。round 2 の指摘 3 に対応し、`.escalated` と bridge 不達を
ここへ明記した。round 2 の仕様には「§3 の対象外一覧に A3 が無いのに、別節で A3 を対象外と
述べている」という矛盾があった。A3 を一覧へ入れて解消する。

| 対象外 | 理由 | 代わりに何をするか |
|---|---|---|
| **A3 `.escalated`** | 人間または parent の判断を待つ状態であり、自動で進めてはならない | C1b で parent へ有界通知し、そこで terminal とする |
| A0 identity 欠落 | gate が自分の管轄を知らない | C3 で「gate が効かなかったペイン」を検出可能にする |
| A8 `MAX_BLOCKS > 0` | 明示設定で保証を放棄する経路。既定は無制限 | ドキュメントに保証が外れる旨を書く |
| A4 / A6 割り当て前の standby | 依頼が来るまで止まってよい。ペインの静止と task の停止は別 | 依頼者側が C1 の lease で守られる |
| **bridge が live/current でない** | agmsg 配送がペインへ届かない状態は dispatch の外にある | C1 の配送確認（§4 C1-4）で検出し parent へ委譲する |

### 脅威モデル（round 2 の指摘 3 / Q5 に対応）

本仕様が防ぐのは **記録の欠落とドリフト**である。**エージェントによるガード状態の意図的な
偽造は防がない。**

gate はディスクを読み、エージェントはディスクを書ける。したがって「正しい sentinel を
自分で作る」「虚偽の terminal status を書く」ことは、ディスクベースの gate では原理的に
防げない。防ぐには Phase B 遷移と terminal 遷移の所有権を helper 側へ完全に移し、
エージェントが偽造できない provenance を gate が検証する必要がある。これは本仕様の範囲を
超えるため、**将来課題として記録する**（§7）。

ただし C2 は、**現場で実際に起きた経路**（手書き引き継ぎで marker が作られない、
`5ed0dcf` の実測）を通れなくする。これは偽造ではなく欠落であり、脅威モデルの内側である。

## 4. 変更

### C1: 期限の執行者を gate の外に置く

**gate は期限を課せない（§2.4）。** 期限は、停止したペインの外側で動き続けている実体が
執行する。その実体は既に存在する。生成 runner script の常駐サブシェルである
（`launch-workspace.sh:1391-1432`、15 秒ポーリング、セッション寿命、停止要求に 1 秒以内で追随）。
**これはエージェントではなくプロセスである。**

新しいループは作らない。既存ループに条件を 1 つ足す（I10）。

#### C1-1: ファイルを分けて単一書き手にする（round 2 の指摘 1 に対応）

round 2 は「gate と watcher が同じ `.gate-wait-<role>` を共有すると、lost update が起き、
gate が `nudges: 0` で再武装して上限へ永久に到達しない」と指摘した。正しい。

**共有可変状態を作らない。2 ファイルに分け、それぞれ書き手を 1 つに固定する。**

| ファイル | 唯一の書き手 | 読み手 | 内容 |
|---|---|---|---|
| `.gate-wait-<role>` | **gate のみ** | watcher | lease（下記 generation と `deadline_epoch`） |
| `.gate-nudge-<role>` | **watcher のみ** | watcher | `{generation, nudges, last_nudge_at, ack_baseline, state}` |

gate は nudge 予算に触れられない。watcher は lease を書き換えない。**lost update が構造的に
起きない。** 両ファイルとも同一ディレクトリ内 `mktemp` + `mv` で原子的に置換する
（`work-signal.sh:128-135` と同じ形）。

#### C1-2: generation と単調な予算

lease generation は次の組で一意に定める。

    generation = (point, round, request_mtime, role, agent)

- watcher が読んだ lease の generation が `.gate-nudge-<role>` の記録と **一致**するとき、
  `nudges` は単調増加のみ。ゼロに戻さない
- **異なる**ときだけ `nudges = 0` から始める（新しい待機が本当に始まった場合）
- gate が同じ generation の lease を何度書き直しても、watcher 側の予算は巻き戻らない

#### C1-3: 終端規約

`.gate-nudge-<role>.state` は `active` / `terminal` を取る。`terminal` の generation に対して
watcher は二度と nudge しない。

lease と nudge 記録を削除・終端化する契機:

| 契機 | 動作 |
|---|---|
| 当該 point/round の findings に `VERDICT:` が現れた | 両ファイルを削除（待機は正常終了） |
| 当該 round の abort ファイルが現れた | 両ファイルを削除 |
| generation が変わった（新しい request） | nudge 記録を新 generation で初期化 |
| `status.json` が done/error になった | 両ファイルを削除 |
| `nudges` が上限（既定 2）に達した | `.escalated` を書き、parent へ 1 通通知し、`state=terminal` |
| 配送不達を検出した（C1-4） | nudge に数えず、直ちに parent へ通知し `state=terminal` |

#### C1-4: 配送の確認（round 2 の指摘 2 に対応）

round 2 は「`verify-agmsg-ready.sh --codex` は seat の live/current 性を証明しない」と指摘した。
実装を確認したところ正しい。`verify-agmsg-ready.sh:160-170` は
`[[ -s "$thread_file" ]]` すなわちファイルが非空かだけを見ており、bridge の生存も、記録された
thread が現行 TUI thread かも、注入可能かも確認していない。**seat の存在を到達性の根拠に
してはならない。**

代わりに **結果で確認する**。agmsg の内部状態には触らない。

nudge がペインを起こせば、そのペインは必ずターンを終える。ターン終了で gate が走り、
gate は lease（`.gate-wait-<role>`）を書き直す。したがって:

> **nudge 送信後 `ack_grace`（既定 120 秒）以内に `.gate-wait-<role>` の mtime が進まず、
> かつ verdict も来ていなければ、その nudge はペインに届いていない。**

watcher は nudge 直前の lease mtime を `ack_baseline` に記録し、次の周回で比較する。
不達と判定した場合:

- **その nudge を `nudges` に数えない**（届かない相手に予算を使わない）
- 直ちに parent へ 1 通通知し、`state=terminal` にする
- 以後この generation では nudge しない

これで「送っただけで満足する」経路が無くなり、bridge 不達は parent へ確実に浮上する。

#### C1-5: gate 側の 3 分岐（`wait_guard` の修正）

| 予算 | rapid restart | 判定 |
|---|---|---|
| 予算内 | 無し | **ALLOW**（静かな待機。従来どおり） |
| 予算内 | 有り | **BLOCK**（`ce948cd` の goal continuation 暴走防止。従来どおり） |
| 予算切れ | — | **BLOCK**（有限の回復手順へ） |

第 3 分岐に到達するのは、外部（C1 の nudge を含む）でこのペインが起きたときである。
**期限そのものを発火させるのは watcher であり、gate ではない。** §2.3 により block は
実際に次ターンを駆動するので、この reason は実効的である。

### C1b: `.escalated` は self-nudge と別扱いにする（round 2 の指摘 1 後半）

`.escalated` の owner と waker は parent であって本人ではない。本人へ nudge を送るのは誤りで
ある。watcher は `.escalated` を見つけたら:

1. parent へ **1 通だけ** 通知する
2. `state=terminal` にして、以後この generation では何もしない

gate が同じ generation を再武装しても、watcher 側が `terminal` なので再通知は起きない。
`.escalated` は §3 のとおり**保証の対象外**であり、これで閉じる。

### C2: 委譲が記録されていない design を停止させない

判別を **受け手（exec）から委譲側（design）へ移す。** exec の判定 3 には触れないので、
standby exec を block しない（I4 を保つ）。

#### C2-1: 期待される exec agent の完全一致（round 2 の Q3 に対応）

round 2 は「任意の foreign `.assigned-*` より、検証済み `prewarm.json` の `exec.agent` に
対応する marker を完全一致で要求すべき」と指摘した。採用する。

design が停止してよいのは次を**すべて**満たすときとする。

- `.deferred` が在る
- `$STATUS_DIR/.assigned-<prewarm.json の .exec.agent>` が在る（**完全一致**）

前方一致は使わない（`codex-nonstop` と `codex-nonstop-exec` を取り違えないため）。
`prewarm.json` が読めない、または `.exec.agent` が空の場合は、従来どおり `.deferred` のみで
許す（レビュー無し構成を壊さないため）。

#### C2-2: design の `done` 経路を閉じる（round 2 の指摘 3 に対応）

round 2 は「design が委譲せず `done` を書けば判定 1 が先に ALLOW する」と指摘した。正しい。

このプロトコルでは **design は必ず Phase B へ委譲する**。したがって design ロールに限り、
`status=done` は C2-1 の marker が在るときだけ許す。無ければ block し、reason で
`phase-b-deliver.sh` の実行を指示する。

`status=error` は変更しない。作業が本当に失敗した場合の正当な終端であり、
これを塞ぐと `c70a690` の「逃げ道が無くて虚偽を書く」事故を再発させる（I9）。

#### C2-3: 残る経路（脅威モデルの外側）

design が `.assigned-<exec agent>` を**手で作る**場合は依然として通る。これは欠落ではなく
偽造であり、§3 の脅威モデルの外側である。将来課題として §7 に記録する。

### C3: fail-open を有界かつ非自己攪乱に観測可能化

判定は変えない（ALLOW を維持）。痕跡だけ残す。

- 置き場所は worktree ではなく `.dispatch-handoff.json` が指す status dir
- **固定名 1 ファイル**（`.gate-open`）。原子的に置換し、増えない
- 内容は最終観測時刻と累計回数
- `.dispatch-handoff.json` が無ければ何も書かない

Stop ごとに worktree へ未追跡ファイルを増やすと `work-signal.sh` の入力
（`git status --porcelain` と dirty パスの mtime）を自分で攪乱する（I11）。

### C4: `SCRIPT_DIR` を zsh でも正しく解決する

`${BASH_SOURCE[0]:-$0}` にする。`$0` は `bash <file>` / `zsh <file>` の双方でスクリプトパスに
なる。あわせて claude 注入を `zsh` から `bash` へ揃えることを検討する。

回帰テストは **zsh で起動したとき reason が実在するパスを指すこと**を直接検査する。

### C5: round ファイルを point でスコープする

`latest_round` は `spec-` / `plan-` / `code-` を区別せず mtime 最新の 1 個を選ぶ。前フェーズの
古い round ファイルが最新だと、実装中の exec が「待機中」と誤判定され ALLOW される。

request / findings / abort を **同一 point に束ねて**選ぶ。

## 5. 回帰テストで固定すること

round 2 の再レビュー条件 1 が求めた交差実行テストを含む。

| # | ケース | 期待 |
|---|---|---|
| T1 | gate が同一 generation の lease を 3 回書き直す間に watcher が 2 回期限到達 | `nudges` は 2 で上限に達し `terminal` になる（巻き戻らない） |
| T2 | 新しい request（generation 変化）が来る | `nudges` が 0 から再開する |
| T3 | nudge 後 `ack_grace` 内に lease mtime が進む | 不達判定にならず `nudges` が加算される |
| T4 | nudge 後 `ack_grace` を過ぎても lease mtime が進まない | nudge に数えず parent へ通知し `terminal` |
| T5 | findings に `VERDICT:` が現れる | lease と nudge 記録が削除される |
| T6 | abort ファイルが現れる | 同上 |
| T7 | `.escalated` が在る | self-nudge せず parent へ 1 通のみ、以後無音 |
| T8 | design + `.deferred` + 期待 exec marker 在り | ALLOW |
| T9 | design + `.deferred` + marker 無し | BLOCK、reason に `phase-b-deliver.sh` |
| T10 | design + `.deferred` + 似た名前の marker のみ（`codex-nonstop`） | BLOCK（前方一致で通さない） |
| T11 | standby exec（`code-review.json` 在り、assigned 無し） | **ALLOW**（I4） |
| T12 | design + `status=done` + marker 無し | BLOCK |
| T13 | design + `status=error` + marker 無し | ALLOW（I9） |
| T14 | `prewarm.json` が無い構成で design + `.deferred` | ALLOW（後方互換） |
| T15 | zsh で gate を起動 | reason の `report-status.sh` パスが実在する |
| T16 | `spec-round-1.md`（VERDICT 済み）より新しい `plan-round-1-request.md` | 判定に使うのは plan 側 |
| T17 | 逆順（plan の findings が spec の request より新しい） | 同上、point で束ねて判定 |
| T18 | identity 欠落 + `.dispatch-handoff.json` 在り | ALLOW かつ `.gate-open` が 1 ファイルだけ更新される |
| T19 | identity 欠落 + `.dispatch-handoff.json` 無し | ALLOW かつ何も書かない |

すべて **修正前に赤くなることを確認してから**実装する。テストは既存の
`test/test-completion-gate.sh` の形式（`bash "$BIN"` を副プロセスで起動、`mktemp -d` の
合成 STATUS_DIR、`pass`/`bad`）に合わせ、実 cmux・実 agmsg・ネットワークに触れない
（`382ed4e` の hermetic 規約）。

## 6. 不変条件（回帰させてはならないもの）

| # | 不変条件 | 根拠 |
|---|---|---|
| I1 | 素の待機（auto-restart でない）を予算内に block しない | `ce948cd` |
| I1b | 予算内の rapid restart は従来どおり block する | `ce948cd` |
| I2 | 連続 block に既定の上限を設けない | `74e9c70`（2026-08-25 実ペイン） |
| I3 | `block()` は諦めるとき `allow()` を呼ばない | `a8a2707` |
| I4 | 割り当て前の standby（exec / review）を止め続けない | `launch-workspace.sh:1478` |
| I5 | レビューペインに `.assigned-*` を作らせない | `c70a690` |
| I6 | 出力キーは `decision` / `reason` の 2 つだけ | codex hook schema |
| I7 | identity 欠落時は `exit 0`（`exit 2` は blocking error） | `0a13479` |
| I8 | gate の判定はディスクのみ。cmux / network / モデル評価を使わない | 設計の中核 |
| I9 | block の reason は必ず有限手数の出口を含む | `c70a690`（110 秒で error を書いた事故） |
| I10 | gate にも親スキルにも新しいポーリングループを足さない | `CLAUDE.md` item 33 / 48 |
| I11 | 痕跡ファイルが `work-signal.sh` の入力を攪乱しない | round 1 の指摘 4 |
| I12 | lease と nudge 予算は共有可変状態にしない（書き手を 1 つに固定する） | round 2 の指摘 1 |
| I13 | seat の存在を配送の根拠にしない | round 2 の指摘 2（`verify-agmsg-ready.sh:160-170`） |
| I14 | `.escalated` へ self-nudge しない | round 2 の指摘 1 |

I10 について: C1 は新しいループを作らず、**既存の runner watcher に条件を 1 つ足す**。
このループは `98860e5` の「復帰は agmsg 経路へ一本化する」という方針の実装先でもある。

## 7. スコープ

- 変更は `apps/cmux-team-dispatch-task` 内に閉じる
- 回帰テストを先に書き、赤を確認してから直す
- `pnpm check` と `pnpm check:doc-lang` を通す
- SKILL.md を変えたら `references/guide-ja.md` を同じ commit で更新する
- バージョンを上げるなら plugin.json 2 つと marketplace.json を同期する
- PR は作らない。`feat/codex-nonstop` にコミットを積み、parent がマージする

### 本仕様の範囲外（将来課題として記録する）

Phase B 遷移と terminal 遷移の所有権が、まだエージェントが直接触れる sentinel の上にある。
`.assigned-<exec agent>` を手で作る、`.escalated` を手で作る、といった**意図的な偽造**は
ディスクベースの gate では防げない（§3 脅威モデル）。

これを塞ぐには、遷移を helper だけが書ける形にし、エージェントが偽造できない provenance を
gate が検証する必要がある。設計としては成立するが、`phase-b-deliver.sh` / `report-status.sh` /
runner / gate の 4 者にまたがる変更になり、本件（停止を止める）とは独立した課題である。
**今回は実装せず、ここに記録する。**

## 8. 採用しなかった案

| 案 | 却下理由 |
|---|---|
| プロンプトに「止まるな」と書き足す | 発注が明示的に禁じている。今回の原因そのもの |
| 待機を常に block して回し続ける | `ce948cd` が消した abort 暴走の再現。トークンも焼く |
| gate 内に期限を持たせる（round 1 の C1） | **原理的に到達不能**（§2.4）。本レビューで却下 |
| `code-review.json` を Phase B 到達の証拠に使う（round 1 の C2） | Phase A 全期間で成立し、正常な standby を block する（§2.5）。本レビューで却下 |
| gate から `work-signal.sh` を呼ぶ | cmux IPC にタイムアウトが無く Stop hook でハングし得る。I8 を壊す |
| `DISPATCH_GATE_MAX_BLOCKS` に既定の上限を戻す | `74e9c70` が踏んだ「長い作業が永久に毎ターン停止する」事故の再現 |
| goals を再有効化する | `ce948cd` の abort 事故（81 秒 / 111 秒）の再現 |
| 親スキルにポーリングを足す | `CLAUDE.md` item 33 / 48 が明示的に禁止 |
| gate と watcher が 1 つの lease ファイルを共有する（round 2 の C1） | lost update と予算の巻き戻しが起きる。round 2 の指摘 1 で却下 |
| `verify-agmsg-ready.sh --codex` を配送の根拠にする（round 2 の Q2） | `[[ -s "$thread_file" ]]` だけで seat の live/current 性を証明しない。round 2 の指摘 2 で却下 |
| 「任意の foreign `.assigned-*`」で委譲を判定する（round 2 の C2） | 期待される exec agent と結び付かない。完全一致要求へ変更 |
