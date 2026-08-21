# 通知欠落・無限待機パターン一覧

dispatch の通知経路と待機条件を確認するときの参照資料。設計は
`docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md` を正とする。
行番号はこの版の調査時点のものなので、参照時は前後の文脈も確認する。

## 修正したパターン

| ID | 症状 | 根拠 | 影響 | 今回の対応 |
|---|---|---|---|---|
| P1 | 実装者に error 時の通知手順が無い | `SKILL.md:1209-1216` | 親と reviewer が無期限待機 | ABORT/ESCALATION を追加 |
| P2 | idle 残留で親通知に到達しない | `launch-workspace.sh:831-835` | 通知経路が断絶 | status.json watcher を追加 |
| P3 | 子の error を done が上書きする | `launch-workspace.sh:925-953` | abort が done に化ける | 終端 status を sticky 化 |
| P4 | レビュアーが error 時に待機し続ける | `SKILL.md:1275-1278` | reviewer が解放されない | abort と watcher wake を追加 |
| P5 | error 分岐に通知指示が無い | `SKILL.md:1437-1441`、`SKILL.md:1481-1485` | error 通知が暗黙依存 | 必須通知を明記 |
| P6 | 無人ループ文面に abort 経路が無い | `references/unattended/code-review-block.md:1` | loop で通知不能 | 文面を追加 |
| P7 | workspace 起動に --defer-status が無い | `SKILL.md:1513-1534` | Child が孫の status を上書き | フラグを追加 |
| P8 | assigned から deferred の窓で二重通知する | `SKILL.md:741-801` | 二重通知 | foreign assignment を watcher が抑止 |
| P9 | agmsg watcher が起動せず inbox 記録が全ロールで落ちる | `SKILL.md` の AGMSG-DIRECTIVE 依存 | Monitor ツールを持たないハーネスで watcher ゼロ | `ensure-agmsg-ready.sh` を追加 |

## 未解決として記録するパターン

| ID | 症状 | 根拠・判断理由 |
|---|---|---|
| U1 | status.json を書かずに沈黙する | `SKILL.md:1159-1172`。terminal 遷移が無く watcher は発火できない |
| U2 | handoff 失敗時の所有権移譲 | `SKILL.md:740-802`。cmux send の終了値だけでは配信を判定できない |
| U3 | spawn fallback の起動確認 | `launch-workspace.sh:538-674`。runner 側 acknowledgement が必要 |
| U4 | send 成功・send-key 失敗の部分配信 | `launch-workspace.sh:778-779`。cmux 側の回復機能が必要 |
| U5 | cmux コマンドの hang | `docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md:107-113`。macOS に timeout / gtimeout は無く、今回の対象外 |
| U6 | dispatch 世代の PID 排他 | `launch-workspace.sh:691-827`。generation token と親側 lock が必要 |
| U7 | agmsg 記録失敗の再試行 | `SKILL.md:1858-1865`。wake は cmux が担うため記録失敗は警告に留める |
| U8 | 最初の poll 前の signal 終了 | `launch-workspace.sh:925-931`、`test/test-runner-signal-exit.sh:97-100`。既存 signal guard の重複通知抑止を維持する |
| U9 | `/clear` 後に watcher が戻らない | guard は初期プロンプトから 1 回だけ走る。Monitor 非搭載ハーネスではそのペインの watcher が復帰しない |

## monitor 専用化の残余リスク

`docs/superpowers/specs/2026-08-21-agmsg-monitor-only-design.md` が要求する記録。
**2026-08-21 時点で `cmux-codex-review` / `cmux-codex-exec` に実在する**（dispatch は未移行）。

| ID | 症状 | 根拠・判断理由 |
|---|---|---|
| R1 | ペイン死亡の即時検知が失われた | 旧ポーリング watcher は `--surface` の生存確認で即時に検知していた。monitor 専用化でその経路が消え、検知は単発タイマーが発火する T 分後まで遅れる。monitor 専用化の代償として受け入れる。タイマーで起きたときは (a) 判断の前に `history.sh` で完了 row を確認し、(b) ペイン消滅を断定する前に `cmux read-screen` を 1 回リトライし、(c) 再武装に上限を設ける（`commands/codex-review.md` Step 3b / `commands/codex-exec.md` Step 5） |
| R2 | codex の seat 喪失（セッション再起動で thread が変わる） | `run/codex-bridge.<team>.<agent>.thread` の seat が古いままだと、`send.sh` は成功するのにメッセージは未読で滞留する。**新規の残余リスク**。codex 系 2 プラグインの codex は送信専用なので現時点では影響しないが、親→codex の追撃指示を足した瞬間に事故になる |

read cursor の競合（同じ (team, agent) を購読する watcher が 2 つあると先に poll した方が
row を取る）は残余リスクではなく**配送コントラクトの要件**として spec 側に記載した。
検出と排他の手段はそちらを参照する。

## この一覧の使い方

- 通知が届かない事象では P1〜P8 の退行を確認する。
- U1〜U8 は既知の残余リスクとして扱い、根拠を添えて更新する。
- R1 / R2 は monitor 専用化で新たに生じた残余リスク。dispatch を移行するときは U1 / U9 の
  解消可否も併せて見直す。
