# codex ペインが作業途中で停止するのを構造的に止める

- 日付: 2026-09-01
- 対象: `apps/cmux-team-dispatch-task`
- ブランチ: `feat/codex-nonstop`
- 種別: 設計仕様
- 改訂: round 2（round 1 の needs_work を反映）

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

## 3. 全 ALLOW 状態の再列挙

レビュー再条件 4 に対応する。gate が停止を許すすべての状態を、
**owner（その状態の責任者）/ waker（起こす主体）/ deadline / terminal** で列挙する。

| # | ALLOW 状態 | gate の行 | owner | waker | 現状の deadline | 本仕様後 |
|---|---|---|---|---|---|---|
| A1 | status done/error | `:246-249` | 本人 | 不要（terminal） | — | 変更なし |
| A2 | `.deferred`（design のみ） | `:252-254` | design | 不要（terminal） | — | **C2: 委譲が記録されている場合のみ** |
| A3 | `.escalated` | `:264-266` | parent | parent | **無し** | **C1: lease + 有界 nudge** |
| A4 | `.assigned` 欠落（design/exec） | `:351` | design/parent | phase-b-deliver | **無し** | 変更なし（C2 で上流を閉じる） |
| A5 | findings に VERDICT 無し | `:355-358` | reviewer | reviewer | 名目 30 分 / **到達不能** | **C1: lease + 有界 nudge** |
| A5b | request 未応答 | `:363-366` | reviewer | reviewer | 同上 | **C1: lease + 有界 nudge** |
| A6 | review 側: round も request も無い | `:373` | design/exec | 依頼者 | **無し** | 変更なし（後述の境界） |
| A6b | `round_aborted()` | `:377-379` | 依頼者 | 依頼者 | — | 変更なし |
| A7 | review 側 fall-through | `:388` | — | — | — | 変更なし |
| A8 | `MAX_BLOCKS` 到達（既定では無効） | `:167-174` | 設定者 | 無し | **無し** | **保証の対象外と明記** |
| A0 | identity 欠落（fail-open） | `:74-77` | 起動経路 | 無し | **無し** | **C3: 観測可能にする** |

### 保証の境界（明示）

本仕様が「絶対に止まらない」を保証するのは、**runner script 経由で起動され、
`DISPATCH_GATE_*` を持つ design / exec ロールのペイン**である。以下は保証の対象外であり、
それぞれ理由がある。

- **A0（identity 欠落）**: 保証できない。gate が自分の管轄を知らないため。
  ただし C3 で「gate が一度も効かなかったペイン」を親から検出可能にする。
- **A8（`MAX_BLOCKS > 0`）**: 明示設定で保証を放棄する経路。既定は無制限なので通常は無効。
  設定した時点で本仕様の保証が外れることをドキュメントに書く。
- **A6（割り当て前の review standby）**: レビューペインは依頼が来るまで止まってよい。
  依頼者側（design/exec）が C1 の lease で守られるため、依頼が消えることは無い。
- **A4（割り当て前の exec standby）**: 受け手側では判別不能（§2.5）。上流の A2 を閉じることで
  「委譲したのに記録が無い」状態を作れなくする。

## 4. 変更

### C1: 期限の執行者を gate の外に置く

**gate は期限を課せない（§2.4）。したがって期限は、停止したペインの外側で動き続けている
実体が執行する。**

その実体は既に存在する。生成 runner script は、子セッションと並行して `status.json` を
15 秒間隔で poll する常駐サブシェルを持つ（`launch-workspace.sh:1391-1432`）。
セッションの寿命だけ生き、停止要求に 1 秒以内で追随する。**これはエージェントではなく
プロセスである。**

新しいポーリングループを足すのではなく、**この既存ループに条件を 1 つ足す**。

#### lease の書き手 = gate

gate が待機（A5 / A5b）または `.escalated`（A3）を ALLOW する瞬間、
`.gate-wait-<role>`（既存の stamp ファイル）を lease レコードへ拡張して書く。

    { point, round, request_mtime, deadline_epoch, agent, nudges }

#### lease の執行者 = runner watcher

既存ループの各周回で、lease が在り `now > deadline_epoch` かつ当該ラウンドが未応答
（point スコープの round ファイルに `VERDICT:` が無い）なら:

1. `dispatch-nudge:` を **1 通だけ** agmsg でその待機者へ送る（agmsg 配送はペインを起こす）
2. `nudges` を加算し、deadline を延長する
3. `nudges` が上限（既定 2）に達したら `.escalated` を書き、parent へ 1 通通知して終わる

**agent の判断は 1 つも介在しない。**

#### gate 側の 3 分岐（`wait_guard` の修正）

レビュー指摘 1 のとおり、現行の rapid-restart 防衛は残す。

| 予算 | rapid restart | 判定 |
|---|---|---|
| 予算内 | 無し | **ALLOW**（静かな待機。従来どおり） |
| 予算内 | 有り | **BLOCK**（`ce948cd` の goal continuation 暴走防止。従来どおり） |
| 予算切れ | — | **BLOCK**（有限の回復手順へ。到達するのは外部起床後） |

第 3 分岐は「次に何らかの外部入力でこのペインが起きたとき、期限切れを検出して発言する」層で
ある。**期限そのものを発火させるのは runner watcher であり、gate ではない。** 両者の役割を
分離することで、レビュー指摘 1 の「到達不能な期限」を解消する。

`§2.3` により block は実際に次ターンを駆動するので、第 3 分岐の reason は実効的である。

### C2: 委譲が記録されていない design を停止させない

レビュー指摘 2 のとおり、**受け手（exec）側では正常な standby と配線failure を区別できない。**
したがって判別を **委譲する側（design）** へ移す。

現行の判定 2 は「`.deferred` が在れば design は停止してよい」である。`.deferred` は
`phase-b-deliver.sh` が書くが、**design agent が自分で touch することもできる。** 手書きの
引き継ぎ文を送って `.deferred` を touch すれば、記録の無い委譲が成立してしまう。

変更: **判定 2 を「`.deferred` が在り、かつ自分以外の `.assigned-*` が在る」に絞る。**

- `.assigned-<exec agent>` を書けるのは `phase-b-deliver.sh:207` だけである
- レビューペインには `.assigned-*` を作らせない規約（I5）があるので、自分以外の
  `.assigned-*` の存在は「実装ロールへ委譲した」ことと一意に対応する
- 条件を満たさない design は block され、reason が `phase-b-deliver.sh` の実行を指示する

これは **exec 側の判定 3 に一切触れない**ので、正常な standby exec を block しない（I4 を保つ）。

#### 残る限界（明記）

C2 は「委譲したのに記録が無い」を塞ぐが、次の 2 経路は塞がない。

1. **design が `.assigned-<exec agent>` を手で touch する。** `phase-b-deliver.sh` を通らずに
   マーカーだけ作れば素通る。
2. **design が委譲せずに `done` を書く。** 判定 1（A1）が先に ALLOW するため C2 に到達しない。

いずれも「Phase B 遷移の所有権が agent の任意操作にある」ことに由来する。完全に塞ぐには
遷移を機械的な境界へ移す必要があり、本仕様の範囲を超える。**この限界を仕様に残し、
将来の課題として記録する。** レビュー指摘 2 が求めた「限界の明記」に対応する。

### C3: fail-open を有界かつ非自己攪乱に観測可能化

判定は変えない（ALLOW を維持）。痕跡だけ残す。

レビュー指摘 4 のとおり、Stop ごとに worktree へ新しい未追跡ファイルを作ると
`work-signal.sh` の入力（`git status --porcelain` と dirty パスの mtime）を自分で変え続け、
停滞検知を壊す。したがって:

- 置き場所は **worktree ではなく `.dispatch-handoff.json` が指す status dir**
- 名前は **固定** の 1 ファイル（`.gate-open`）
- 内容は「最終観測時刻と累計回数」。原子的に置換し、**増えない**
- `.dispatch-handoff.json` が無ければ何も書かない（無関係な手動セッションを汚さない）

### C4: `SCRIPT_DIR` を zsh でも正しく解決する

`${BASH_SOURCE[0]:-$0}` にする。`$0` は `bash <file>` / `zsh <file>` の双方でスクリプトパスに
なる。あわせて claude 注入を `zsh` から `bash` へ揃えることを検討する（gate の shebang は
`#!/usr/bin/env bash`）。

回帰テストは **zsh で起動したとき reason が実在するパスを指すこと**を直接検査する。

### C5: round ファイルを point でスコープする

`latest_round` は `review/*round*.md` を mtime 最新で 1 個選ぶだけで、`spec-` / `plan-` /
`code-` を区別しない。前フェーズの古い round ファイルが最新だと、実装中の exec が
「待機中」と誤判定され ALLOW される。

request / findings / abort を **同一 point に束ねて**選ぶ規則にする。回帰ケースは
「`spec-round-1.md`（VERDICT 済み）より新しい `plan-round-1-request.md` が在るとき、
判定に使われるのは plan 側であること」および逆順を含める。

## 5. 残る検証事項

### V1 / V1b: 決着済み

§2.3 のとおり、非対話・対話の両モードで実測し確定した。未解決事項ではなくなった。

### 実装時に確認すること（設計の骨格には影響しない）

- **自己宛 nudge が届くか**: C1 の runner watcher は、同一ペインの待機者へ agmsg を送る。
  codex では bridge seat（`run/codex-bridge.<team>.<agent>.thread`）が古いと send は成功
  するのにメッセージが読まれない（記録済みの R2）。watcher は送信前に
  `verify-agmsg-ready.sh --codex` を 1 回実行する。
- **watcher の早期 `continue` を跨ぐこと**: 既存ループは `.deferred` / 未割り当て standby /
  他ペインの `.assigned-*` で `continue` する。lease 判定はこれらの手前に置く。
- **`.assigned-<SLUG>` と `.assigned-<AGENT>` の一致**: runner は `$SLUG`、gate は `$AGENT` を
  見ている。C2 は「自分以外の `.assigned-*`」を完全一致で除外して判定する
  （`codex-nonstop` と `codex-nonstop-exec` を前方一致で取り違えないこと）。

### V2: `.escalated` の期限

C1 の lease 機構を `.escalated` にも適用する（A3）。parent が来なければ有界回数の通知の後、
`error` ではなく `.escalated` のまま留まる。**エスカレーションは正当な終端状態であり、
「止まらない」保証の対象外であることを明記する。**

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
| I11 | 痕跡ファイルが `work-signal.sh` の入力を攪乱しない | 本レビュー指摘 4 |

I10 について: C1 は新しいループを作らず、**既存の runner watcher に条件を 1 つ足す**。
このループは `98860e5` の「復帰は agmsg 経路へ一本化する」という方針の実装先でもある。

## 7. スコープ

- 変更は `apps/cmux-team-dispatch-task` 内に閉じる
- 回帰テストを先に書き、赤を確認してから直す
- `pnpm check` と `pnpm check:doc-lang` を通す
- SKILL.md を変えたら `references/guide-ja.md` を同じ commit で更新する
- バージョンを上げるなら plugin.json 2 つと marketplace.json を同期する
- PR は作らない。`feat/codex-nonstop` にコミットを積み、parent がマージする

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
