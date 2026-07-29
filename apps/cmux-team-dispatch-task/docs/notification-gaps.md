# 通知欠落・無限待機パターン一覧

dispatch の通知経路と待機条件を確認するときの参照資料。設計は
`docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md` を正とする。

## 修正したパターン

| ID | 症状 | 根拠 | 今回の対応 |
|---|---|---|---|
| P1 | 実装者に error 時の通知手順が無い | `SKILL.md` 共通プロトコル | ABORT/ESCALATION を追加 |
| P2 | idle 残留で親通知に到達しない | `launch-workspace.sh` 子待機 | status.json watcher を追加 |
| P3 | 子の error を done が上書きする | `launch-workspace.sh` exit パス | 終端 status を sticky 化 |
| P4 | レビュアーが error 時に待機し続ける | `SKILL.md` orphan guard | abort と watcher wake を追加 |
| P5 | error 分岐に通知指示が無い | `SKILL.md` status protocol | 必須通知を明記 |
| P6 | 無人ループ文面に abort 経路が無い | `references/unattended/code-review-block.md` | 文面を追加 |
| P7 | workspace 起動に --defer-status が無い | `SKILL.md` launch example | フラグを追加 |
| P8 | assigned から deferred の窓で二重通知する | `SKILL.md` Phase B | foreign assignment を watcher が抑止 |

## 未解決として記録するパターン

| ID | 症状 | 判断理由 |
|---|---|---|
| U1 | status.json を書かずに沈黙する | terminal 遷移が無く watcher は発火できない |
| U2 | handoff 失敗時の所有権移譲 | cmux send の終了値だけでは配信を判定できない |
| U3 | spawn fallback の起動確認 | runner 側 acknowledgement が必要 |
| U4 | send 成功・send-key 失敗の部分配信 | cmux 側の回復機能が必要 |
| U5 | cmux コマンドの hang | macOS に timeout / gtimeout は無く、今回の対象外 |
| U6 | dispatch 世代の PID 排他 | generation token と親側 lock が必要 |
| U7 | agmsg 記録失敗の再試行 | wake は cmux が担うため記録失敗は警告に留める |
| U8 | 最初の poll 前の signal 終了 | 既存 signal guard の重複通知抑止を維持する |

## この一覧の使い方

- 通知が届かない事象では P1〜P8 の退行を確認する。
- U1〜U8 は既知の残余リスクとして扱い、根拠を添えて更新する。
