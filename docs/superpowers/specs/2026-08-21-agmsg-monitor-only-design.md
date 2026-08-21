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

B4 として子 claude 上での B1 再現も予定していたが、probe 用の子が別アカウントの
weekly limit に当たりターンを持てなかったため未実施。B1 は親セッションで観測済みで、
子と親でハーネスは同一のため、B4 は E2E で確認する。

### 制約として扱う 2 点

1. **各ペインは初回ターンを 1 回持つ必要がある** (B2)。claude は Monitor 起動、
   codex は bridge 起動がそのターンで行われる。
2. **codex ペインは seat 記録が必要** (V2a/V2b)。現行の `prewarm-panes.sh:411` は
   `delivery.sh set monitor codex` までは行うが seat を記録しないので、親→codex の
   配送を agmsg に切り替えた瞬間に未読滞留で止まる。

## 配送コントラクト

配送手段は `~/.agents/skills/agmsg/scripts/send.sh` の 1 本だけ。`cmux send` /
`cmux send-key` は配送から消え、残るのは「シェルにペイン起動コマンドを打鍵する」
用途のみ (既存の `send-prompt-exempt:` マーカーと同じ位置づけ)。

### readiness の 3 要件

全ペイン共通。3 つ揃って初めてそのペインは配送先になれる。

1. team に join 済み — `join.sh <team> <name> <type> <cwd>`
2. そのプロジェクトが monitor モード — `delivery.sh set monitor <type> <cwd>`
3. ペインが初回ターンを 1 回持った。その結果として:
   - claude → Monitor ツールが起動し `run/ready.<team>__<agent>` sentinel が出る
   - codex → bridge が起動し seat (thread id) が記録される

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

### タイマー保険

子が quota 切れなどで一度も起動しなければ readiness 通知も完了通知も来ない。
ここだけ時間ベースの手段を残すが、ポーリングではなく**単発タイマーを 1 本**張る:

```
nohup sh -c 'sleep <T>' &   # プロセスの exit が親を起こす
```

親はこのタイマーで起きたら `status.json` を再評価し、terminal でないものを error に
するか延長する。`T` は既存の `task_timeout_min` を流用する。ループは残らない。

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
  せず確認だけ行う。claude は sentinel の存在、codex は `delivery.sh status` が seat
  recorded かつ bridge running を返すことを見る

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

V1 の教訓は「静的検査だけで通したら前提が間違っていた」である。E2E を省略しない。

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

## 適用範囲外

- codex bridge のインストール手順の自動化 (`~/.zshrc` への関数追加)。導入済み前提とし、
  未導入なら fail-fast で案内する
- 親→codex の追撃指示経路 (codex-review / codex-exec)。現行仕様に無い
- `terminal-wait.sh` の EMA ベースライン機構
