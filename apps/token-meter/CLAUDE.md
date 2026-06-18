# token-meter

Claude Code の hook 経由で圧縮プラグインの効きを観測する計測機構。
3 hook (PreToolUse / PostToolUse / Stop) を **fail open** で受け、
`~/.claude/token-meter/logs/*.jsonl` に追記する。

## アーキテクチャ

- 3 hook entry (`bin/hook-*.ts`) は薄い shim
- 本体は `lib/handler.ts` の `handlePre/handlePost/handleStop`
- 設定は `lib/targets.ts` (観測対象) と `lib/plugins.ts` (圧縮 plugin) の 2 ファイルに集約
- 状態は `~/.claude/token-meter/state.json` (atomic write)
- ログは JSONL daily rotation、O_APPEND で並列 safe

## 設計原則 (厳守)

1. **fail open**: hook が失敗しても Claude Code 本体を妨げない。`try/catch + exit 0`。
2. **stdout 禁止**: hook の stdout はパーサが消費するため、何も書かない。エラーは `~/.claude/token-meter/error.log`。
3. **設定ファイル駆動**: 新観測対象は `targets.ts` / 新 plugin は `plugins.ts` に 1 エントリ追加で済むこと。
4. **atomic write**: `state.json` / `settings.json` / `.claude.json` の編集は tmpfile + rename 必須。バックアップを残す。
5. **生コンテンツ非保存**: JSONL に `tool_input` / `tool_response` の原文を書かない。token 数と tool 名、`raw_command` (コマンド名のみ) など最小限。

## 開発フロー

```bash
cd apps/token-meter
bun test              # 全テスト
bun test __tests__/unit/handler.test.ts        # 単体
pnpm --filter=@tanaka-yui/token-meter check    # tsc + biome
make status           # ローカル状態
make doctor           # 健全性チェック
```

## ファイル責務

| ファイル | 責務 |
|---|---|
| `lib/types.ts` | 全型定義 (LogRecord discriminated union 等) |
| `lib/tokenizer.ts` | `@anthropic-ai/tokenizer` ラッパ + 256KB 超サンプリング + approx fallback |
| `lib/logger.ts` | JSONL append (daily rotation), error.log, readTodayRecords |
| `lib/config.ts` | state.json 読み書き (atomic), shouldMeasure 純粋関数 |
| `lib/targets.ts` | TARGETS const と classify() (rtk / compression / normal の振り分け) |
| `lib/plugins.ts` | COMPRESSION_PLUGINS と enable/disable 抽象 (gate file / session flag / .claude.json) |
| `lib/handler.ts` | 3 hook 共通のパイプライン + 集計 |
| `bin/hook-*.ts` | stdin → handler → exit 0 の薄い shim (各 ≤30 行) |
| `scripts/hook-link.ts` | ~/.claude/settings.json への安全 append (backup + atomic + 冪等) |
| `scripts/status.ts` | 現在の状態を表示 |
| `scripts/doctor.ts` | 健全性チェック (bun / plugins / hook / tokenizer 動作) |

## 関連プラグインとの境界

| プラグイン | 役割 | token-meter との境界 |
|---|---|---|
| rtk (外部) | Bash 出力圧縮 | token-meter は **観測のみ**、rtk 本体は触らない |
| caveman (外部) | 出力 caveman 化 | 同上 |
| headroom (外部) | tool 出力・履歴圧縮 | 同上、ON/OFF だけ `.claude.json` 経由で操作 |
| cmux-team | マルチエージェント | 無関係。同じ hook には共存可能 |

## オープン項目 (spec §15)

将来の実測で確定:
- rtk の `tool_response.metadata.rtk_saved_tokens` の有無
- headroom MCP の hot reload 可否
- caveman session flag の正確なパス
- 大規模 JSONL の tokenizer 性能 (`make doctor` で実測)

## コーディング規約

ルート `CLAUDE.md` (`yui-cc-plugins/CLAUDE.md`) を参照。
