# 通知欠落・無限待機パターン一覧

dispatch の通知経路と待機条件を確認するときの参照資料。設計は
`docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md` を正とする。

## 修正したパターン

| ID | 症状 | 根拠 | 影響 | 今回の対応 |
|---|---|---|---|
| P1 | 実装者に error 時の通知手順が無い | `SKILL.md:1183` | 親と reviewer が無期限待機 | ABORT/ESCALATION を追加 |
| P2 | idle 残留で親通知に到達しない | `launch-workspace.sh:743-744` | 通知経路が断絶 | status.json watcher を追加 |
| P3 | 子の error を done が上書きする | `launch-workspace.sh:787-808` | abort が done に化ける | 終端 status を sticky 化 |
| P4 | レビュアーが error 時に待機し続ける | `SKILL.md:1237-1240` | reviewer が解放されない | abort と watcher wake を追加 |
| P5 | error 分岐に通知指示が無い | `SKILL.md:1394-1435` | error 通知が暗黙依存 | 必須通知を明記 |
| P6 | 無人ループ文面に abort 経路が無い | `references/unattended/code-review-block.md:1` | loop で通知不能 | 文面を追加 |
| P7 | workspace 起動に --defer-status が無い | `SKILL.md:1506-1515` | Child が孫の status を上書き | フラグを追加 |
| P8 | assigned から deferred の窓で二重通知する | `SKILL.md:740-802` | 二重通知 | foreign assignment を watcher が抑止 |

## 未解決として記録するパターン

| ID | 症状 | 根拠・判断理由 |
|---|---|---|
| U1 | status.json を書かずに沈黙する | `SKILL.md:1153-1172`。terminal 遷移が無く watcher は発火できない |
| U2 | handoff 失敗時の所有権移譲 | `SKILL.md:740-802`。cmux send の終了値だけでは配信を判定できない |
| U3 | spawn fallback の起動確認 | `launch-workspace.sh:538-674`。runner 側 acknowledgement が必要 |
| U4 | send 成功・send-key 失敗の部分配信 | `launch-workspace.sh:817-825`。cmux 側の回復機能が必要 |
| U5 | cmux コマンドの hang | `docs/superpowers/specs/2026-07-29-dispatch-error-notification-design.md:107-113`。macOS に timeout / gtimeout は無く、今回の対象外 |
| U6 | dispatch 世代の PID 排他 | `launch-workspace.sh:691-827`。generation token と親側 lock が必要 |
| U7 | agmsg 記録失敗の再試行 | `SKILL.md:1863-1869`。wake は cmux が担うため記録失敗は警告に留める |
| U8 | 最初の poll 前の signal 終了 | `launch-workspace.sh:778-785`、`test/test-runner-signal-exit.sh:97-100`。既存 signal guard の重複通知抑止を維持する |

## この一覧の使い方

- 通知が届かない事象では P1〜P8 の退行を確認する。
- U1〜U8 は既知の残余リスクとして扱い、根拠を添えて更新する。
