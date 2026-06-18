---
name: token-stats
description: >
  Use when the user invokes `/token-stats` or asks for a token volume /
  compression-effect report across recent days. Aggregates JSONL records by
  tool and plugin into a single page summary.
---

# token-stats: トータルレポート

JSONL ログを期間集計して tool 別 / plugin 別の token ボリュームと圧縮効果を表示する。

## 引数仕様

| 引数 | 動作 |
|---|---|
| `--since today\|1d\|7d\|30d\|all` | 集計期間。デフォルトは `7d` |
| `--by tool\|plugin` | グループ化 (デフォルト両方) |
| `--top N` | 上位 N 件のみ (デフォルト 20) |

## 実装手順

1. `~/.claude/token-meter/logs/*.jsonl` を `--since` でフィルタ。
2. `kind === 'post.normal' | 'post.rtk' | 'post.compress'` を tool 別に集計。
3. `post.rtk` の `rtk_saved_tokens` と `post.compress` の `(input_tokens - output_tokens)` を plugin 別に集計。
4. spec §3.2 のパイプラインと §5 のスキーマに整合する形で `aggregate()` 風の集計を行う。
5. 出力は box drawing 表 (token-measure list と統一)。

## 注意

- `--since all` は全 JSONL を読むためファイル数が多いと遅くなる可能性あり。100 ファイル超なら警告を出す。
- ratio は `output_tokens / input_tokens` (小さいほど圧縮率高)。
