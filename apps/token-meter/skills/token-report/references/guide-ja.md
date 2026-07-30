# token-report: 効果分析レポート

## Output Language

ユーザーへの質問・選択肢ラベル・表・進捗報告はすべて日本語で表示する。SKILL.md 本文が英語なのは記述の統一のためであり、ユーザーへの提示言語は変えない。

token-meter のログ + rtk gain + transcript を横断集計して、
「どんな処理にどのプラグインを使うと効くか」の質的レポートを生成する。

## 引数仕様

| 引数 | 動作 |
|---|---|
| `--since today\|1d\|7d\|30d\|all` | 集計期間。デフォルトは `7d` |

## 実装手順

1. 集計エンジンを呼び出す:
   ```bash
   bun run "$CLAUDE_PROJECT_DIR/apps/token-meter/scripts/token-report.ts" --since 7d
   ```
   出力は単一の JSON。フィールドは次の通り:
   - `tool_summary`: tool 別 calls / input / output / ratio (output 降順)
   - `rtk.jsonl`: token-meter 計測の rtk savings
   - `rtk.gain`: `rtk gain --format json` の global summary (Claude 外の rtk 使用も含む authoritative 値)
   - `headroom`: post.compress 集計 (input_tokens - output_tokens = saved)
   - `caveman`: prompt mode のため計測不可。transcript の assistant output_tokens × 0.65 を「常時 full モードだった場合の上限値」として推定
   - `top_wasteful_tool_calls`: output_tokens シェア上位 5 件
2. 上記 JSON を読み、以下の構成でレポートを書く:

```
# Token 効果分析レポート (since=<期間>)

## サマリー
- 観測 tool 数: ...
- 観測 plugin: rtk (saved=X), headroom (saved=Y), caveman (推定 ≤Z)

## Plugin 別の効きと使いどころ
### rtk (Bash 出力圧縮)
- 計測: X tokens saved / Y calls
- 効いた典型: ... ← rtk.gain や tool_summary から具体的に
- 効かなかった典型: ...
- 推奨: 「<こういう Bash> のときに使う」

### headroom (大きな text の圧縮)
- 計測: ...
- 効いた典型: 入力 >5K で ratio が小さい call
- 効かなかった典型: router:noop で返るケース (短文 / 保護パターン)
- 推奨: ...

### caveman (応答テキスト短縮)
- 計測: 不可 (prompt mode)
- 推定上限: ~Z tokens (transcript 集計 × 0.65 / sonnet-4 ベンチマーク)
- 使いどころ: 長い説明応答が多い session、自由記述レポート系
- 注意: 推定値は「常時 full モード」前提の上限値。実値は `/caveman:caveman-stats` 参照

## 浪費が大きい上位 tool
| tool | output_tokens | share |
| ... | ... | ... |
コメント: rtk / headroom で削減余地があるものは具体的に提案する。

## 推奨アクション
- 「X tool の出力には rtk を当てる」「caveman を Y 系の応答で ON にする」など、
  数字に裏打ちされた actionable な箇条書きを 3-5 個。
```

3. ratio (output/input) が大きい tool は出力が支配的な call (Read / Edit / Bash の壁打ち)。
   逆に StructuredOutput / Workflow / ToolSearch のように ratio が小さい場合は
   input 課金が支配的なので圧縮プラグインの恩恵は薄い、と読み解く。

## 注意

- `rtk.gain` は Claude 外の rtk 使用も合算する。`rtk.jsonl` との差を「Claude セッション外」と説明できる。
- caveman の推定値は **上限値**。実値ではない旨を必ず明示する。
- `transcript_path` が拾った session が今動かしている session と違うこともある。`current_mode` が null なら caveman は今使われていない。
- 数値の出処を必ず併記する (jsonl 集計 / rtk gain / transcript 推定 のどれか)。
