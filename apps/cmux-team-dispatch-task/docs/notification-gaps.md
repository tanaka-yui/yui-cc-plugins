# 通知欠落・無限待機パターン一覧

dispatch の通知経路と待機条件を確認するときの参照資料。設計は
`docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md` と、monitor 専用化に
ついては `docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md` を正とする。
行番号はこの版の調査時点のものなので、参照時は前後の文脈も確認する。

## 修正したパターン

`U*` の ID は、旧「未解決として記録するパターン」表からこちらへ移したものである。ID は
履歴を辿るためのキーなので、解消しても改番しない。

この表は「いつ何が壊れていて、どう直したか」の履歴記録である。退役済みの旧名で grep して
当時の判断へ辿り着けることに価値があるので、現行仕様から消えた名前を意図的に残している。
その行には `stale-vocab-exempt: <名前>` を行内マーカーとして置き、
`test/test-doc-stale-vocab.sh` の DS1 / DS2 からその名前だけを除外する。

| ID | 症状 | 根拠 | 影響 | 対応 |
|---|---|---|---|---|
| P1 | 実装者に error 時の通知手順が無い | `SKILL.md:1209-1216` | 親と reviewer が無期限待機 | ABORT/ESCALATION を追加 |
| P2 | idle 残留で親通知に到達しない | `launch-workspace.sh:831-835` | 通知経路が断絶 | status.json watcher を追加 |
| P3 | 子の error を done が上書きする | `launch-workspace.sh:925-953` | abort が done に化ける | 終端 status を sticky 化 |
| P4 | レビュアーが error 時に待機し続ける | `SKILL.md:1275-1278` | reviewer が解放されない | abort と watcher wake を追加 |
| P5 | error 分岐に通知指示が無い | `SKILL.md:1437-1441`、`SKILL.md:1481-1485` | error 通知が暗黙依存 | 必須通知を明記 |
| P6 | 無人ループ文面に abort 経路が無い | `references/unattended/code-review-block.md:1` | loop で通知不能 | 文面を追加 |
| P7 | workspace 起動に --defer-status が無い | `SKILL.md:1513-1534` | Child が孫の status を上書き | フラグを追加 |
| P8 | assigned から deferred の窓で二重通知する | `SKILL.md:741-801` | 二重通知 | foreign assignment を watcher が抑止 |
| P9 | agmsg watcher が起動せず inbox 記録が全ロールで落ちる | `SKILL.md` の AGMSG-DIRECTIVE 依存 | Monitor ツールを持たないハーネスで watcher ゼロ | setup guard `ensure-agmsg-ready.sh` を追加（v1.20.0）。**v1.21.0 で guard ごと廃止** — watcher は SessionStart hook が要求する `Monitor` tool 自身であり、スキルは `verify-agmsg-ready.sh` で生存を確認するだけになった <!-- stale-vocab-exempt: ensure-agmsg-ready.sh --> |
| U1 | status.json を書かずに沈黙する | `SKILL.md:1159-1172`。terminal 遷移が無く watcher は発火できない | 親が無期限待機 | **解消（v1.21.0）**: 親はペイン起動直後に 90 分の単発タイマーを武装する。その起床で `.dispatch/*/status.json` と `history.sh` の `[ready]` を読み直し、ペイン生存を 1 回リトライ付きで確認して再武装（3 回上限）または `error` 確定へ進む |
| U9 | `/clear` 後に watcher が戻らない | guard は初期プロンプトから 1 回だけ走るので、新しい session id で旧 watcher が自己終了したあと再実行する経路が無かった | そのペインの inbox 記録が止まる | **解消（v1.21.0）**: guard を廃止し、watcher は SessionStart hook が要求する `Monitor` tool になった。`/clear` はその hook を再発火させるので watcher は自力で戻る |

## 未解決として記録するパターン

| ID | 症状 | 根拠・判断理由 |
|---|---|---|
| U3 | spawn fallback の起動確認 | `launch-workspace.sh:538-674`。runner 側 acknowledgement が必要 |
| U5 | cmux コマンドの hang | `docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md:107-113`。macOS に timeout / gtimeout は無く、今回の対象外 |
| U6 | dispatch 世代の PID 排他 | `launch-workspace.sh:691-827`。generation token と親側 lock が必要 |
| U7 | agmsg 配送失敗の再試行 | 配送は `send.sh` の 1 回呼び出しだけになった。非ゼロ終了は「配送されなかった」ことを意味するので必ず報告し、runner wrapper は notify marker を更新せず次の poll で再試行する。呼び出し側の自動リトライは 1 回まで |
| U8 | 最初の poll 前の signal 終了 | `launch-workspace.sh:925-931`、`test/test-runner-signal-exit.sh:97-100`。既存 signal guard の重複通知抑止を維持する |

U2（handoff 失敗時の所有権移譲）と U4（send 成功・send-key 失敗の部分配信）は、どちらも
`cmux send` / `cmux send-key` による配送の観測不能性が根拠だった。v1.21.0 で配送経路が
agmsg `send.sh` の 1 回呼び出しに置き換わり、配送の成否は終了コードで確定するようになったため
**この 2 件は削除した**。

## monitor 専用化の残余リスク

`docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md` が要求する記録。
**2026-08-21 の v1.21.0 で dispatch も移行済み**（`cmux-codex-review` / `cmux-codex-exec` は先行）。

| ID | 症状 | 根拠・判断理由 |
|---|---|---|
| R1 | ペイン死亡の即時検知が失われた | 旧ポーリング watcher は `--surface` の生存確認で即時に検知していた。monitor 専用化でその経路が消え、検知は単発タイマーが発火する T 分後まで遅れる（dispatch の親は 90 分、verdict 待ちは 30 分）。monitor 専用化の代償として受け入れる。タイマーで起きたときは (a) 判断の前に `history.sh` で `[ready]` / 完了 row を確認し、(b) ペイン消滅を断定する前に `cmux read-screen` を 1 回リトライし、(c) 再武装に上限（3 回）を設ける |
| R2 | codex の seat 喪失（セッション再起動で thread が変わる） | `run/codex-bridge.<team>.<agent>.thread` の seat が古いままだと、`send.sh` は成功するのにメッセージは未読で滞留する。dispatch は親→codex ペインへ実際に追撃指示を送るため、**この経路は現に有効**。`verify-agmsg-ready.sh --codex --team <t> --name <agent>` で「seat 未記録」と「ペイン死亡」を切り分け、前者ならそのペインに `codex-record-session.sh` を再実行させる |
| R3 | タイムアウト検知の粒度が粗くなった | 旧 loop 待機スクリプトは 5 秒間隔で `claimed_at` を見ていたが、現行は 90 分の単発タイマーで起きたときにしか評価しない。`loop.task_timeout_min` を 90 分未満に設定しても、timeout の検知は次の起床までずれる。**ポーリング全廃の意図した代償**であり、バグではない。より細かい検知が要るなら、そのタスクだけタイマー間隔を短くして武装する |

read cursor の競合（同じ (team, agent) を購読する watcher が 2 つあると先に poll した方が
row を取る）は残余リスクではなく**配送コントラクトの要件**として spec 側に記載した。
検出と排他の手段はそちらを参照する。`[ready]` の確認に `inbox.sh` ではなく `history.sh` を
使うのはこの競合が理由である。

## この一覧の使い方

- 通知が届かない事象では P1〜P8 の退行を確認する。
- U3 / U5〜U8 は既知の残余リスクとして扱い、根拠を添えて更新する。
- R1〜R3 は monitor 専用化で新たに生じた残余リスク。挙動が「遅い」と感じたときは、まず
  R1 / R3 の粒度の話なのか、本当の欠落なのかを切り分ける。
