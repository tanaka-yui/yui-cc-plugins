# codex ペインが作業途中で停止するのを構造的に止める

- 日付: 2026-09-01
- 対象: `apps/cmux-team-dispatch-task`
- ブランチ: `feat/codex-nonstop`
- 種別: 設計仕様
- 改訂: round 6（round 5 の needs_work を反映。レビュー上限に達したため parent へエスカレーション中）

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
**これはエージェントではなくプロセスである。** 新しいループは作らない（I10）。

#### C1-0: 判断は loop-free な 1 tick ヘルパーへ切り出す（round 4 の Q3）

状態遷移が 15 を超えるため、判断ロジックを runner のヒアドキュメントに埋め込まない。

    scripts/recovery-tick.sh --status-dir <dir> --role <role> --agent <name> \
                             --team <team> --send-command <path>

- **ループを持たない。** 1 回呼ばれて 1 手だけ進め、終了する
- 既存の runner ループが 15 秒ごとにこれを呼ぶ。ループの寿命・停止・所有権は runner に残る（I10）
- テストは合成 STATUS_DIR と stub `send.sh` に対して直接実行できる

#### C1-1: ファイルと単一書き手

| ファイル | 唯一の書き手 | 唯一の削除者 | 内容 |
|---|---|---|---|
| `.gate-seq-<role>` | **gate** | **誰も削除しない** | 単調増加カウンタ（下記 C1-2） |
| `.gate-wait-<role>` | **gate** | **gate** | `{generation, lease_seq, deadline_epoch}` |
| `.gate-nudge-<role>` | **recovery-tick** | **recovery-tick** | `{generation, lease_seq_at_send, nudges, state, ack_deadline, notified}` |

**削除も書き込みである**（I16）。両ファイルとも同一ディレクトリ内 `mktemp` + `mv` で
原子的に置換する。

#### C1-2: ABA を排除した `lease_seq`（round 4 の指摘 1）

round 4 は「lease を削除して作り直すと `lease_seq` が 0 へ戻り、ack baseline と同じ値へ戻る
ABA が起きる」と指摘した。正しい。round 4 の記述は「単調増加」と「削除で 0 へ戻る」が
矛盾していた。

**カウンタを lease から分離する。**

- `.gate-seq-<role>` は gate だけが書き、**誰も削除しない**。gate が lease を書くたびに
  読んで +1 して書き戻す
- `lease_seq` はその値のスナップショットである
- lease を削除して作り直しても、カウンタは継続する。**値は status dir × role の寿命全体で
  再利用されない**（I20）

ack は「`lease_seq` が `lease_seq_at_send` と異なること」で判定する。大小比較はしないが、
値が再利用されないので ABA は起きない。

#### C1-3: generation から `request_mtime` を外す（round 4 の指摘 1 後半）

round 4 は「同じ request の再保存・rsync・touch という意味を変えない操作で予算が 0 に戻る」と
指摘した。正しい。

    generation = (point, round, role, agent)

**同一 round の request ファイルは immutable として扱う。** 本文を変えたければ round を
上げる。これは既存プロトコル（round ごとに request / findings / abort を分ける）と一致する。

#### C1-4: acknowledgement は mtime ではなく `lease_seq`

round 3 の指摘どおり `mtime_of()` は秒精度で、同一秒の 2 回置換を区別できない。実測した。

    1 回目: mtime=1788231903 inode=284084367
    2 回目: mtime=1788231903 inode=284084368   <- mtime 同一、inode のみ変化

**mtime を correctness の根拠にしない**（I15）。診断情報としてのみ残す。

#### C1-5: tick ごとの評価順（round 4 の指摘 2 / round 5 の指摘）

round 5 は「`.escalated` が closure と lease 欠落に負けて C1b へ到達しない」と指摘した。
**実測で再現した。**

    合成 STATUS_DIR: status=executing / .assigned / VERDICT 済み findings / .escalated / lease
    -> gate は ALLOW し、**lease を削除した**

原因は 2 つある。

1. 既存契約では、ラウンド上限に達した子は **findings に `VERDICT:` が書かれた後に**
   `.escalated` を touch する（`SKILL.md:989-994`）。round 5 の評価順では closure（順 2）が
   先に成立し、`.escalated`（順 5）へ到達しない
2. `.escalated` の判定は `allow()` を直接呼ぶ（`completion-gate.sh:264-266`）。`allow()` は
   wait 経路でない限り lease を削除する（`:151-154`）。したがって次の tick は
   「lease 欠落」で終了し、やはり C1b へ到達しない

**closure を 1 つに畳んだことが誤りだった。** hard closure と soft closure を分け、
`.escalated` をその間に置く。

| 順 | 条件 | 動作 |
|---|---|---|
| 1 | `WAIT_MINUTES == 0` | 何もしない（C1-8） |
| 2 | **hard closure**: `status` が done か error | 記録を削除して終了（task は本当に終わっている） |
| 3 | **`.escalated` が在る** | **C1b へ**（lease の有無によらない） |
| 4 | **soft closure**: 当該 point/round の findings に `VERDICT:` / abort ファイル | 記録を削除して終了 |
| 5 | lease が無い | 記録を削除して終了（待機ではない） |
| 6 | lease の generation が記録と異なる | 新 generation を初期化（C1-7） |
| 7 | 上記以外 | state 別の処理（C1-6） |

- **hard closure が `.escalated` に勝つ**: task が終わっているならエスカレーションは無意味である
- **`.escalated` が soft closure と lease 欠落に勝つ**: これがラウンド上限の実運用順序である（I25）
- closure と generation 変化は依然として ack より先である（I21）

#### C1-6: state 別の処理（排他的 guard）

round 4 は「`waiting` の 2 事象が独立して並んでおり、2 回目の nudge が ack された直後に
『上限到達』が成立して、新しい deadline を待たずに escalation する」と指摘した。正しい。

**`waiting` の guard を排他にする。**

| state | 条件（排他） | 動作 |
|---|---|---|
| `waiting` | `now <= deadline_epoch` | **no-op**（`nudges` の値によらない） |
| `waiting` | `now > deadline_epoch` かつ `nudges < max` | 送信直前に lease を再読して generation と `lease_seq` を再検証。変わっていれば中止。一致すれば self-nudge を送り、`lease_seq_at_send` と `ack_deadline = now + ack_grace` を記録し `nudges += 1` → `ack_pending` |
| `waiting` | `now > deadline_epoch` かつ `nudges >= max` | `.escalated` を書き `terminal(pending)` へ |
| `ack_pending` | `lease_seq != lease_seq_at_send` | **ack 成功** → `waiting`。gate が書いた**新しい** `deadline_epoch` まで待つ |
| `ack_pending` | `now > ack_deadline` かつ `lease_seq` 不変 | **配送不達**。`nudges` を戻す（予算を消費しない）→ `terminal(pending)` |
| `ack_pending` | `now <= ack_deadline` | **no-op**（二重送信しない） |
| `terminal(pending)` | — | parent へ 1 回送る。成功なら `terminal(done)`、非ゼロなら `terminal(pending)` のまま次 tick で再試行 |
| `terminal(done)` | — | no-op |

`send.sh` が非ゼロを返した場合は、`ack_grace` を待たず**直ちに** `terminal(pending)` へ移り、
`nudges` を消費しない。

これにより escalation は「2 回目の nudge を送った瞬間」ではなく、**「2 回目が届き、新しい
期限まで待っても完了しなかった時点」**で起きる（I22）。

#### C1-7: generation 変化時の扱い（round 4 の Q4）

新 generation を初期化するとき、旧 state が `terminal(pending)`（parent へ未送信の通知が
残っている）だった場合の規則を一意に定める。

1. 旧 generation の parent 通知を **1 回だけ**試みる
2. 成功・失敗にかかわらず、新 generation を `waiting` / `nudges=0` で初期化する
3. 失敗した場合は新記録に `superseded_from=<旧 generation>` を残す

旧通知を無期限に持ち越さない。新 generation が生まれたということは、そのペインが実際に
前進したということであり、旧 escalation の前提は既に失われている。

#### C1-8: `WAIT_MINUTES=0` は watcher にも効く（round 4 の指摘 3）

`completion-gate.sh:222` は `[[ "$WAIT_MINUTES" -gt 0 ]] || return 0` で、`0` を
「待機防衛の無効化（常に allow）」として固定している（CG34）。

round 4 は「round 4 仕様の deadline 規則をそのまま適用すると `deadline_epoch = now + 0` に
なり、watcher が次の poll で self-nudge を始めて既存契約を逆転させる」と指摘した。正しい。

- `WAIT_MINUTES == 0` のとき、**gate は lease を arm しない**。既存の lease があれば削除する
- `recovery-tick.sh` は評価順 1 で `WAIT_MINUTES == 0` を見て**何もしない**
- **self-nudge も parent 通知も一度も行わない**（I23）

#### C1-9: gate 側の 3 分岐（`wait_guard` の修正）

| 予算 | rapid restart | 判定 |
|---|---|---|
| 予算内 | 無し | **ALLOW**（静かな待機。従来どおり） |
| 予算内 | 有り | **BLOCK**（`ce948cd` の goal continuation 暴走防止。従来どおり） |
| 予算切れ | — | **BLOCK**（有限の回復手順へ） |

gate は待機を ALLOW するたびに `deadline_epoch = now + WAIT_MINUTES*60` を書き、
`.gate-seq-<role>` を進めて `lease_seq` を更新する。§2.3 により block は実際に次ターンを
駆動するので、第 3 分岐の reason は実効的である。

### C1b: `.escalated` は lease に依存しない独立経路にする

`.escalated` の **sentinel を書く/消すのは子**（回復予算の超過時は tick も書く）だが、
**判断する owner と waker は parent** である。この 2 つを混同しない（round 5 の指摘 4、I26）。
self-nudge はしない（I14）。

#### lease も記録も無い状態から始められること（round 5 の指摘 2）

`.escalated` は gate が `allow()` を直接呼ぶ経路なので、C1b が動くとき **lease は既に消えて
いる**。したがって C1b は lease にも `lease_seq` にも generation にも依存してはならない。

**identity は sentinel の有無の遷移そのものとする。** mtime も seq も使わない（I15 と整合）。

`.gate-nudge-<role>` に `mode` を持たせ、`wait` と `escalated` を区別する。

| 現在の記録 | `.escalated` | 動作 |
|---|---|---|
| 無い | 在る | `mode=escalated, state=terminal(pending)` で**新規作成** |
| `mode=wait` | 在る | `mode=escalated, state=terminal(pending)` へ切り替える（待機予算は破棄する。エスカレーションが上書きする） |
| `mode=escalated, terminal(pending)` | 在る | parent へ **1 回**送る。成功なら `terminal(done)`、非ゼロなら pending のまま次 tick で再試行（I18） |
| `mode=escalated, terminal(done)` | 在る | **no-op**（dedupe） |
| `mode=escalated`（任意の state） | **無い** | 記録を**削除**する（エスカレーション解決。次に現れるものは別の escalation） |

子が `.escalated` を消して再開し、後で再び touch した場合、記録は一度削除されているので
**新しいエスカレーションとして再通知される**。これが正しい。

`.escalated` は §3 のとおり保証の対象外であり、これで閉じる。

### C2: 委譲が記録されていない design を停止させない

判別を **受け手（exec）から委譲側（design）へ移す。** exec の判定 3 には触れないので、
standby exec を block しない（I4）。

#### C2-1: design ロールの評価順（round 4 の指摘 3 後半）

round 4 は「C2-2 の prewarm fail-closed と C2-3 の `status=error` ALLOW が矛盾する」と
指摘した。正しい。**評価順を明示して解消する。**

| 順 | 条件 | 判定 |
|---|---|---|
| 1 | `status == error` | **ALLOW**（prewarm が欠けていても。I9 を守る） |
| 2 | `.escalated` が在る | ALLOW（A3。従来どおり） |
| 3 | `prewarm.json` が欠落・破損、または `.exec.agent` が空 | **BLOCK**（fail-closed。I19） |
| 4 | `status == done` | `.deferred` と exact marker の**両方**が在れば ALLOW、無ければ BLOCK |
| 5 | `.deferred` が在る | exact marker が在れば ALLOW、無ければ BLOCK |
| 6 | 上記以外 | 従来どおり判定 5 / 5b / 7 へ |

`status == error` を最優先にするのは、`c70a690` の「逃げ道が無くて虚偽を書く」事故を
再発させないためである。**作業が本当に失敗したペインを、snapshot が壊れているという理由で
閉じ込めてはならない。**

#### C2-2: 委譲の完了は 2 条件

`phase-b-deliver.sh:206-211` の順序を確認した。

    : > "$STATUS_DIR/.assigned-$EXEC_AGENT"      # 送信の前
    bash "$AGMSG_SEND" ... || die
    : > "$STATUS_DIR/.deferred"                  # 送信成功の後

**marker だけが在り `.deferred` が無い状態は、送信が失敗した half-transition** である。
完了扱いしてはならない。marker は `prewarm.json` の `.exec.agent` と**完全一致**で照合する
（前方一致は使わない。`codex-nonstop` と `codex-nonstop-exec` を取り違えないため）。

#### C2-3: 残る経路（脅威モデルの外側）

design が `.assigned-<exec agent>` と `.deferred` を**手で作る**場合は依然として通る。
これは欠落ではなく偽造であり、§3 の脅威モデルの外側である（§7 に将来課題として記録）。

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

すべて **修正前に赤くなることを確認してから**実装する。gate 側は既存
`test/test-completion-gate.sh` の形式（`bash "$BIN"` を副プロセスで起動、`mktemp -d` の
合成 STATUS_DIR、`pass`/`bad`）に合わせる。

**watcher 側は `recovery-tick.sh` を直接実行する**（C1-0）。round 4 の Q3 への回答どおり、
`launch-workspace.sh` の heredoc 断片を `awk` + `eval` する方式は escape 後の生成物を
検証できないので採らない。runner への配線は別途 1 件（T44）で、**実際に生成された runner
artifact** に対して固定する。実 cmux・実 agmsg・ネットワークには触れない（`382ed4e`）。

### 識別子（round 4 の指摘 1）

| # | ケース | 期待 |
|---|---|---|
| T35 | lease を削除して同一 generation で作り直す | `lease_seq` が**再利用されない**（ABA が起きない） |
| T36 | `ack_pending` 中に lease 削除 → 同一 generation で再作成 | ack と誤認しない。closure 判定が先に走る |
| T37 | request ファイルを touch し直す（内容同一） | generation は変わらず、`nudges` はリセットされない |
| T2 | round を上げて新しい request を書く | generation が変わり `nudges` が 0 から再開する |
| T20 | **同一秒**に lease を原子的置換する | `lease_seq` の変化で ack できる（mtime 同一でも成立） |

### 評価順と排他 guard（round 4 の指摘 2）

| # | ケース | 期待 |
|---|---|---|
| T38 | `nudges == max` かつ `now <= deadline_epoch` | **no-op**（escalation しない） |
| T1 | 期限超過が 2 回起き、いずれも ack される | 2 回目の ack 後は**新しい deadline まで待つ**。その時点では escalation しない |
| T39 | 2 回目 ack 後、新しい deadline も超過する | ここで初めて `.escalated` + parent 通知 |
| T40 | 同一 tick で generation 変化と `lease_seq` 変化が同時成立 | generation 変化として扱う（ack と誤認しない） |
| T23 | `ack_pending` 中に VERDICT / abort / terminal status | 正常終了。不達通知しない |
| T24 | `ack_pending` 中に lease が消える（closure 証拠なし） | closure 扱い。不達通知しない |
| T21 | nudge 送信直前に lease が削除される | stale nudge を送らない |
| T22 | nudge 送信直前に lease が別 generation へ置換される | stale nudge を送らない |
| T25 | `ack_pending` 中は二重送信しない | `ack_deadline` まで再送 0 回 |
| T41 | `waiting` 中に `.escalated` が現れる | self-nudge せず C1b の `terminal(pending)` へ |
| T42 | `terminal(pending)` 中に generation が変わる | 旧通知を 1 回だけ試み、新 generation を `nudges=0` で初期化する |
| T43 | `terminal(done)` 中に同一 generation の tick | no-op（再通知しない） |

### 配送失敗と fallback

| # | ケース | 期待 |
|---|---|---|
| T3 | nudge 後 `ack_grace` 内に `lease_seq` が進む | ack 成功。`waiting` へ戻り更新後の期限まで待つ |
| T4 | nudge 後 `ack_grace` を過ぎても `lease_seq` 不変 | 不達。`nudges` を消費せず parent へ通知し `terminal(pending)` |
| T26 | self-nudge の `send.sh` が非ゼロ | `ack_grace` を待たず直ちに fallback。`nudges` を消費しない |
| T27 | parent 通知が非ゼロ | `terminal(done)` にせず次 tick で再試行 |
| T28 | parent 通知が成功した後 | 再通知しない |
| T29 | `ack_grace` を超えるターン | parent へ escalate されても、通知失敗で永久 terminal にならない |
| T7 | **ラウンド上限の実運用順序**: findings に `VERDICT:` + 子が `.escalated` を touch + **lease も記録も無い** | parent へ **1 通**送る（soft closure に負けない） |
| T48 | 同上で parent 送信が非ゼロ | 次 tick で再試行する |
| T49 | 同上で送信成功後、`.escalated` が残っている | **再送しない**（dedupe） |
| T50 | `.escalated` が削除される | C1b の記録を削除する（次に現れるものは別の escalation） |
| T51 | `.escalated` 削除 → 再 touch | **新しい escalation として再通知する** |
| T52 | `status=done` と `.escalated` が同時に在る | hard closure が勝つ。parent 通知しない |
| T53 | `mode=wait` の記録がある状態で `.escalated` が現れる | `mode=escalated` へ切り替わり、待機予算は破棄される |

### `WAIT_MINUTES=0`（round 4 の指摘 3 前半）

| # | ケース | 期待 |
|---|---|---|
| T45 | `DISPATCH_GATE_WAIT_MINUTES=0` で gate を走らせる | lease を arm しない。既存 lease があれば削除する |
| T46 | `WAIT_MINUTES=0` で `recovery-tick.sh` を何度呼んでも | self-nudge も parent 通知も **一度も**行わない |
| CG34 | 既存: `WAIT_MINUTES=0` で待機防衛が切れる | 維持（回帰させない） |

### 委譲と terminal（round 3・4 の指摘 3）

| # | ケース | 期待 |
|---|---|---|
| T8 | design + `.deferred` + 期待 exec marker 在り | ALLOW |
| T9 | design + `.deferred` + marker 無し | BLOCK、reason に `phase-b-deliver.sh` |
| T10 | design + `.deferred` + 似た名前の marker のみ（`codex-nonstop`） | BLOCK（前方一致で通さない） |
| T11 | **standby exec**（`code-review.json` 在り、assigned 無し） | **ALLOW**（I4） |
| T12 | design + `done` + marker 無し | BLOCK |
| T30 | design + `done` + marker 在り + `.deferred` 無し | **BLOCK**（送信失敗の half-transition） |
| T31 | design + `done` + marker 在り + `.deferred` 在り | ALLOW |
| T13 | design + `error` + marker 無し | ALLOW（I9） |
| T47 | **managed design + `error` + `prewarm.json` 欠落** | **ALLOW**（評価順 1 が 3 より先。I9） |
| T32 | managed design + 非終端 + `prewarm.json` 欠落 | **BLOCK**（fail-closed） |
| T33 | managed design + `prewarm.json` が壊れた JSON | **BLOCK** |
| T34 | managed design + `.exec.agent` が空 | **BLOCK** |

### その他

| # | ケース | 期待 |
|---|---|---|
| T15 | zsh で gate を起動 | reason の `report-status.sh` パスが実在する |
| T16 | `spec-round-1.md`（VERDICT 済み）より新しい `plan-round-1-request.md` | 判定に使うのは plan 側 |
| T17 | 逆順（plan の findings が spec の request より新しい） | 同上、point で束ねて判定 |
| T18 | identity 欠落 + `.dispatch-handoff.json` 在り | ALLOW かつ `.gate-open` が 1 ファイルだけ更新される |
| T19 | identity 欠落 + `.dispatch-handoff.json` 無し | ALLOW かつ何も書かない |
| T44 | 生成された runner artifact | 既存ループから `recovery-tick.sh` が正しい引数で呼ばれる（実生成物を実行して検証） |
| T5 | findings に `VERDICT:` が現れる | gate が lease を、tick が nudge 記録を削除する |
| T6 | abort ファイルが現れる | 同上 |

**T14 は削除した**（round 3 の指摘どおり prewarm 欠落時の fail-open は誤りで、T32 に置換）。

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
| I15 | mtime を correctness の根拠にしない（秒精度で同値衝突する） | round 3 の指摘 1（実測） |
| I16 | 削除も書き込みであり、削除者も片側に固定する | round 3 の指摘 2 |
| I17 | 送信直前に lease を再検証し、stale nudge を送らない | round 3 の指摘 2 |
| I18 | 通知は成功したときだけ済み扱いにする（失敗は次周回で再試行） | `notify_parent_once()` |
| I19 | managed ペインでの snapshot 欠落・破損は fail-closed。ただし `status=error` より後に評価する | round 3 の指摘 3 / round 4 の指摘 3 |
| I20 | `lease_seq` は status dir × role の寿命全体で再利用しない（ABA を作らない） | round 4 の指摘 1 |
| I21 | closure と generation 変化は ack より先に評価する | round 4 の指摘 2 |
| I22 | escalation は「新しい期限まで待っても完了しなかった時点」で起きる（送信した瞬間ではない） | round 4 の指摘 2 |
| I23 | `WAIT_MINUTES=0` は gate だけでなく watcher も無効化する | round 4 の指摘 3、`completion-gate.sh:222` / CG34 |
| I24 | recovery の判断はループを持たない 1 tick ヘルパーに置く | round 4 の Q3 |
| I25 | `.escalated` は soft closure（VERDICT / abort）と lease 欠落より先に評価する | round 5 の指摘（実測で再現） |
| I26 | sentinel の writer と、判断 owner / waker を混同しない | round 5 の指摘 4 |

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
| lease の mtime 前進を acknowledgement にする（round 3 の C1-4） | `stat` が秒精度で、同一秒の 2 回置換を区別できない。実測で確認。round 3 の指摘 1 で却下 |
| `prewarm.json` が読めないとき `.deferred` だけで許す（round 3 の T14） | 現行の必須契約（`SKILL.md:682-686`）に反し、欠落を偽造と同列に扱っていた。round 3 の指摘 3 で却下 |
| design の `done` を marker だけで許す（round 3 の C2-2） | `.deferred` は送信成功後に書かれるので、marker のみは送信失敗の half-transition である |
| `lease_seq` を lease ファイル内で完結させる（round 4 の C1-2） | lease の削除・再作成で値が再利用され ABA が起きる。round 4 の指摘 1 で却下 |
| generation に `request_mtime` を含める（round 4 の C1-2） | 意味を変えない再保存・touch で回復予算がリセットされる。round 4 の指摘 1 で却下 |
| watcher のロジックを runner の heredoc に埋め込む（round 4 の C1） | escape 後の生成物をテストできず、状態遷移が 15 を超える。round 4 の Q3 で却下 |
| closure を 1 つに畳む（round 5 の C1-5） | ラウンド上限では VERDICT の後に `.escalated` が書かれるので、closure が先に成立して C1b へ到達しない。実測で再現し round 5 の指摘で却下 |
| C1b が lease や `lease_seq` に依存する（round 5 の C1b） | `.escalated` の判定は `allow()` を直接呼び、`allow()` が lease を削除するので、C1b が動くとき lease は存在しない。round 5 の指摘で却下 |
