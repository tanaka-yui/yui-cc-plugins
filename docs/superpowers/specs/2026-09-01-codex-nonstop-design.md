# codex ペインが作業途中で停止するのを構造的に止める

- 日付: 2026-09-01
- 対象: `apps/cmux-team-dispatch-task`
- ブランチ: `feat/codex-nonstop`
- 種別: 設計仕様（チェックポイント 1）

## 1. 発注

> 原因を見つけて、勝手なエージェントの判断ではなく、最後まで絶対に止まらないようにしたい。

停止した codex ペイン自身の自己申告は「途中経過の final を送ってターンを終え、再開用の継続処理を
残さなかった」であった。**この自己申告を対策として採用してはならない。** 「以後は途中で final を
送らず継続します」はエージェントの判断に委ねる約束であり、今回の原因そのものだからである。

したがって本仕様が満たすべき条件は 1 つに集約される。

> **ペインが停止してよいかどうかは、ディスク上の状態から機械的に決まらなければならない。**

## 2. 調査で確定した事実

### 2.1 gate は「executing なのに止まる」を既に止めている

発注の仮説 1 は「status=executing かつレビュー待ちでもない状態が allow に落ちているのでは」で
あった。**これは偽である。** gate を隔離した合成 STATUS_DIR に対して直接実行し、ロール × ディスク
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
結果、**ALLOW された codex ペインは agmsg メッセージが来るまで二度と動かない。**

これは意図された代償として記録されている（`launch-workspace.sh:689-690`）。しかし同時に、
gate の設計が前提としていた力学を変えている。**以前は誤 ALLOW のコストが「1 サイクル遅れる」で
あったが、今は「永久停止」である。** 既存の ALLOW 集合はこのコスト変化を反映して見直されていない。

### 2.3 `wait_guard` は事実上死んでいる

`ce948cd` が入れた `wait_guard` は「auto-restart された待機だけを block する」層である。block に
到達する条件は 3 つの同時成立である（`completion-gate.sh:226-242`）。

1. 直前の stamp が存在する
2. `now - prev <= 90s`（＝直前のターン終了から 90 秒以内に再び Stop が来た）
3. `elapsed_min < 30`

条件 2 は **auto-restart が起きているときにしか成立しない**。`98860e5` がその auto-restart を
消したので、`wait_guard` はもはや発火しない。

帰結は重大である。`wait_guard` の 30 分予算は、予算切れ時に **allow を返す**（`:241`）。つまり
現在の設計では **待機に上限が無い**。レビュアーが死んでも、依頼者は永久に待てる。

### 2.4 `.assigned-<agent>` 欠落による素通しは実際に起きている

`5ed0dcf` のコミット本文に実測が記録されている（lead-psp-liff の member、2026-08-31）。
手書きの引き継ぎ文で実装が始まり、`.assigned-member-exec` が作られなかった。gate は
判定 3 で毎回素通りし、実装ペインは一度も拘束されなかった。

`5ed0dcf` が入れた 3 層（`.dispatch-handoff.json` / 判定 7 の `REVIEW_HINT` / 親側の検出）は
いずれも**素通し自体を止めていない**。判定 3 に到達すれば今も無条件 ALLOW である。

### 2.5 identity が無ければ gate は存在しない

`completion-gate.sh:74-77` は `DISPATCH_GATE_{STATUS_DIR,ROLE,AGENT}` のいずれかが空なら
stdout 無出力で `exit 0`（＝ ALLOW）する。この env を export するのは **生成 runner script だけ**
である（`launch-workspace.sh:1279-1282`）。

runner を経由しない起動（人手の `codex resume`、ペイン再接続、shell 入れ替え）では env が失われ、
そのペインは**毎ターン黙って通る**。goals=false と組み合わさると、そこで永久に停止する。

fail-open 自体は正しい判断である（同じ worktree を開いた無関係の手動セッションを無期限拘束しては
ならない、かつ Stop hook の `exit 2` は blocking error であって no-op ではない）。問題は
**fail-open が観測不能である**ことにある。

### 2.6 claude ペインでは脱出手段の案内が壊れている（実測）

注入されるコマンドがエンジンで異なる。

| engine | Stop hook |
|---|---|
| claude | `zsh '<repo>/…/completion-gate.sh' --gate-id …` |
| codex | `bash '<repo>/…/completion-gate.sh' --gate-id …` |

`completion-gate.sh:124` は `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`。
`BASH_SOURCE` は zsh に存在しない。同一ファイルを両シェルで起動して実測した。

- `bash <file>` → スクリプト実体のディレクトリ（正）
- `zsh <file>` → `BASH_SOURCE[0]: parameter not set` を stderr に出し、**cwd に化ける**（誤）

結果、claude ペインが受け取る判定 7 の reason は `bash <worktree>/report-status.sh …` という
存在しないパスを指す。実体は `apps/cmux-team-dispatch-task/skills/…/scripts/report-status.sh`。
本設計セッション自身がこの誤った reason を受け取って確認した。

`SCRIPT_DIR` の参照は reason 生成の 1 行のみなので判定ロジックは無傷。壊れているのは
**唯一の脱出手段の案内**である。案内どおり実行すると ENOENT となり終端ステータスを書けず、
次ターンも同じ block が返る。**指示に忠実なエージェントほど block ループに嵌まる。**

### 2.7 未解決の最重要問題: block は本当に codex を再駆動するか

gate は block しか持たない。「reason が次ターンのガイダンスとして届き、モデルがそれに従う」ことの
根拠は 2026-08-22 の実測（spec §6 G-T1/G-T2）である。しかし `features.goals=false` は
2026-08-31 の変更である。

**当時観測された「codex が reason に従った」が、block による再駆動なのか goal continuation に
よる再駆動なのかが切り分けられていない。** 後者なら、goals を切った時点で gate の強制力そのものが
消えている。

`ce948cd` のコミット本文には示唆的な記述がある。

> 完走ゲートはこの 6 ターンすべてで正しく allow していた。allow は stdout へ何も書かないので、
> ゲートは待機中のターンに発言できず、その allow こそが次の継続を許す状態だった。

これは「継続の駆動源は goals であった」と読める。実ペインでの再検証が必須である。

## 3. 問題の定式化

現在の gate の ALLOW 集合を、「停止後、**誰が**そのペインを起こすのか」という観点で並べ直す。

| ALLOW 状態 | 起こす主体 | 期限 | 期限切れの扱い |
|---|---|---|---|
| status done/error | 不要 | — | — |
| `.deferred`（design） | 不要 | — | — |
| `.escalated` | parent | **無し** | **無し** |
| `.assigned` 欠落 | design / parent | **無し** | **無し** |
| 待機（request 未応答） | reviewer | 名目 30 分 / **到達不能** | **allow（＝放置）** |
| 待機（findings に VERDICT 無し） | reviewer | 同上 | 同上 |

**下 4 行が構造的な穴である。** いずれも「外部の誰かが起こしてくれる」ことに賭けており、
その誰かが来なかった場合の期限も回復手段も、ディスク上に存在しない。

そして「その誰か」を実際に動かしているのは、親セッションが `work-signal.sh` を回して
`dispatch-nudge:` を送るという **SKILL.md の散文指示** である。これはまさに発注が禁じた
「エージェントの自主性への依存」である。

したがって本件の原因は 1 つのバグではない。

> **gate は「止まってよい状態」を列挙しているが、「止まったあと誰がいつ起こすか」を
> 列挙していない。前者だけでは、goals を切った世界で ALLOW は静かな死になる。**

## 4. 設計方針

### 原則

> **ペインが停止してよいのは、「ディスク上に名指しされた起こし手」と「期限」が両方
> 存在するときに限る。期限が切れたら、gate は必ず発言する。**

`allow` は stdout に何も書かないため、gate は allow したターンで発言できない。発言できる唯一の
手段が block である。したがって「期限切れ」は block として表現するしかない。ただし
**block の reason は必ず有限手数で終わる出口を提示しなければならない**（過去の誤 block 事故の
再発防止）。

### 変更 C1: 待機に到達可能な期限を入れる（`wait_guard` の反転）

現行は「予算切れ → allow」。これを **「予算内 → allow（静かな待機）、予算切れ → block」** に
反転する。auto-restart 判定（条件 2）は予算内の早期 block を抑えるためだけに残す。

block の reason は有限手数の出口を示す。

1. `verify-agmsg-ready.sh` でレビュアーの到達性を 1 回確認する
2. 同じラウンドを 1 回だけ再送する
3. それでも予算 2 周目が切れたら `<point>-round-<N>-abort.md` を書く（`round_aborted()` が
   レビュアーを解放する）か `.escalated` を touch する

`.escalated` は既に全ロール ALLOW なので、ループは必ず終端する。

- 既定 `DISPATCH_GATE_WAIT_MINUTES=30` は据え置き
- `0` で無効化できる性質も据え置き
- **auto-restart 中の待機を早期 block しない**という `ce948cd` の不変条件は維持する

### 変更 C2: 割り当て欠落の素通しを止める

判定 3（`.assigned-<agent>` 欠落 → 無条件 ALLOW）を、**「まだ割り当てられていない standby」と
「割り当てられたのに marker が無い配線failure」を区別する**形に変える。

区別材料はディスク上に既にある。

- `review/code-review.json` が在る＝この task には exec レビューが配線済み
- `.dispatch-handoff.json` が worktree 直下に在る＝この worktree は dispatch 配下

配線済みなのに `.assigned-<exec agent>` が無い状態は、`5ed0dcf` が「親が検出せよ」と書いた
**配線failure そのもの**である。gate 自身がこれを検出し、素通しではなく block して
「配線failure を parent へ報告し、`.escalated` を書け」と指示する。

standby（配線前）は `code-review.json` が無いか、あってもまだ Phase B に入っていないので
従来どおり ALLOW を維持する。**standby を止め続けない**という不変条件は維持する。

### 変更 C3: fail-open を観測可能にする

identity 欠落時の ALLOW は維持する（無関係な手動セッションを拘束しないため）。ただし
**黙って通すのをやめる**。`.dispatch-handoff.json` が worktree に在る場合に限り、その隣へ
`.gate-open-<timestamp>` の痕跡を残す。

これにより「gate が一度も効いていないペイン」が親から検出可能になる。判定は変えないので
誤 block のリスクは無い。

### 変更 C4: `SCRIPT_DIR` を zsh でも正しく解決する

`BASH_SOURCE` に依存しない形へ変える。`$0` は `bash <file>` / `zsh <file>` の双方で
スクリプトパスになるため、`${BASH_SOURCE[0]:-$0}` で両対応できる。あわせて注入側を
`zsh` から `bash` へ揃えることも検討する（gate の shebang は `#!/usr/bin/env bash`）。

**回帰テストは「zsh で起動したとき reason が実在するパスを指すこと」を直接検査する。**

### 変更 C5: `latest_round` を point でスコープする

`latest_round` は `review/*round*.md` を mtime 最新で 1 個選ぶだけで、`spec-` / `plan-` /
`code-` を区別しない。前フェーズの古い round ファイルが最新だと、実装中の exec が
「待機中」と誤判定され ALLOW される。

判定に使う round ファイルを、対応する request の point に限定する。

## 5. 検証しなければならない未解決事項

### V1（最優先）: block は codex のターンを再駆動するか

実ペインで確認する。確認できるまで、本設計は「block が再駆動する」ことに賭けない。

- **再駆動する場合**: C1/C2 の block はそのまま継続の駆動力になる
- **再駆動しない場合**: block は「次に何か入力が来たときのガイダンス」でしかなく、
  停止したペインを起こすのは agmsg のみになる。この場合 C1/C2 の価値は
  「期限切れを親から検出可能にする」ことに縮退し、**別途 agmsg 経路での起こし手が必要**になる

**この分岐を実装フェーズの最初のタスクとし、結果を計画に反映する。**

### V2: `.escalated` の期限

`.escalated` は全ロール無条件 ALLOW で期限が無い。parent が来なければ永久停止する。
本仕様では変更しない（明示的に記録された hand-off であり、5 ラウンド上限などの正当な
終端状態として使われている）が、V1 の結果次第では期限が必要になる可能性がある。

## 6. 不変条件（回帰させてはならないもの）

過去の実測事故から、以下は絶対に壊さない。

| # | 不変条件 | 根拠 |
|---|---|---|
| I1 | 素の待機（auto-restart でない）を早期 block しない | `ce948cd` |
| I2 | 連続 block に既定の上限を設けない | `74e9c70`（2026-08-25 実ペイン） |
| I3 | `block()` は諦めるとき `allow()` を呼ばない | `a8a2707` |
| I4 | 割り当て前の standby を止め続けない | `launch-workspace.sh:1478` |
| I5 | レビューペインに `.assigned-*` を作らせない | `c70a690` |
| I6 | 出力キーは `decision` / `reason` の 2 つだけ | codex hook schema |
| I7 | identity 欠落時は `exit 0`（`exit 2` は blocking error） | `0a13479` |
| I8 | 判定はディスクのみ。cmux / network / モデル評価を使わない | 設計の中核 |
| I9 | block の reason は必ず有限手数の出口を含む | `c70a690`（110 秒で error を書いた事故） |

## 7. スコープ

- 変更は `apps/cmux-team-dispatch-task` 内に閉じる
- 回帰テストを先に書き、赤を確認してから直す
- `pnpm check` と `pnpm check:doc-lang` を通す
- SKILL.md を変えたら `references/guide-ja.md` を同じ commit で更新する
- バージョンを上げるなら plugin.json 2 つと marketplace.json を同期する
- PR は作らない。`feat/codex-nonstop` にコミットを積み、parent がマージする

## 8. 本仕様が採用しなかった案

| 案 | 却下理由 |
|---|---|
| プロンプトに「止まるな」と書き足す | 発注が明示的に禁じている。今回の原因そのもの |
| gate から `work-signal.sh` を呼ぶ | cmux IPC にタイムアウトが無く Stop hook でハングし得る。gate の「ディスクのみ」不変条件（I8）も壊す。親の比較基準ファイルも汚す |
| `DISPATCH_GATE_MAX_BLOCKS` に既定の上限を戻す | `74e9c70` が実ペインで踏んだ「長い作業が永久に毎ターン停止する」事故の再現 |
| goals を再有効化する | `ce948cd` の abort 事故（81 秒 / 111 秒）の再現 |
| gate にポーリングループを足す | `CLAUDE.md` item 33 / 48 が明示的に禁止 |
