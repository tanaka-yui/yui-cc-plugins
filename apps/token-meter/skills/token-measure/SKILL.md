---
name: token-measure
description: >
  Use when the user invokes `/token-measure` or asks to enable/disable the
  token-meter measurement system, list per-tool measurement state, or override
  a single tool. Provides ON/OFF control and JSONL-backed activity listing.
---

# token-measure: 計測機構の制御

`~/.claude/token-meter/state.json` を編集し、token-meter の計測機構全体および
tool 別の ON/OFF を制御するスキル。JSONL ログから観測実績を集計して
`/token-measure list` で表示する。

## 引数仕様

| サブコマンド | 動作 |
|---|---|
| `on` | `state.enabled = true` |
| `off` | `state.enabled = false` |
| `on <tool>` | `state.tools[<tool>] = true` |
| `off <tool>` | `state.tools[<tool>] = false` |
| `reset` | `state.tools` を `{}` に戻す |
| `reset <tool>` | `state.tools[<tool>]` を削除 |
| `status` | `state.json` を整形ダンプ |
| `list [--since 7d] [--sort calls\|tokens\|name] [--show-disabled] [--only-active]` | tool 別観測実績 + 現在 ON/OFF 判定 |

## 実装手順

1. `STATE=$HOME/.claude/token-meter/state.json` を読み込む。存在しなければ `{"enabled":true,"tools":{},"plugins":{}}` を使う。
2. サブコマンドに応じて Bun ワンライナーで JSON を書換える:
   ```bash
   bun -e "import { readState, writeState } from '$HOME/.claude/token-meter/lib/config.ts'; const s = readState('$STATE'); s.enabled = true; writeState('$STATE', s)"
   ```
   (atomic write は writeState が保証する)
3. `list` の場合は当日 JSONL から `kind` ごとに集計して表形式で出力。`--since` は `today|1d|7d|30d|all`。
4. 出力形式は spec の §6.1 に従う box drawing (`──`).

## 注意

- state.json を直接書き換えるときは必ず `writeState` 経由 (tmpfile + rename)。手書きで JSON を上書きしない。
- `list` の表示で各 tool の「根拠」列を必ず出す (override / scope.include / scope.exclude のどれか)。
- スキル単体で hook を再配線したりはしない (`make hook-link` の責務)。
