# token-meter 設計書

- **日付**: 2026-06-18
- **作成者**: Claude Code (yui のブレインストーミングセッションより)
- **配置先リポ**: `tanaka-yui/yui-cc-plugins`
- **配置パス**: `apps/token-meter/`

## 1. 目的とスコープ

3つのClaude Code向け token圧縮ツール (rtk / caveman / headroom) を
**並行有効化** したまま、各ツールの効きを Claude Code の hooks 経由で観測し、
JSONL に記録・集計するための計測機構と周辺スキルを提供する。

### 解決したいこと

- 3つの圧縮プラグインを Claude Code で同時に動かしたい
- 各プラグインが実際にどれだけ token を削っているか / どの tool で効いているかを定量的に見たい
- 個別 ON/OFF を切り替えて A/B 比較できるようにしたい
- 圧縮プラグインを将来増やす際に、設定 1 ファイルで拡張できるようにしたい

### スコープ外

- 圧縮プラグイン本体の改造
- Anthropic API への直接アクセスや料金計算
- 複数 Claude アカウント間のログ統合 (将来 `claude-link` 経由で可能)

## 2. アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code (global ~/.claude/settings.json)                    │
│   hooks.PreToolUse  → bin/hook-pre-tool-use                     │
│   hooks.PostToolUse → bin/hook-post-tool-use                    │
│   hooks.Stop        → bin/hook-stop                             │
└─────────────────────────┬───────────────────────────────────────┘
                          │ stdin: JSON event payload
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ apps/token-meter/ (Bun + TypeScript)                            │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐         │
│  │ config.ts    │←→ │ targets.ts   │   │ tokenizer.ts │         │
│  │ state.json   │   │ 観測対象定義  │   │ Anthropic BPE│         │
│  └──────────────┘   └──────────────┘   └──────────────┘         │
│          ↓                  ↓                   ↑                │
│  ┌────────────────────────────────────────────────┐             │
│  │ lib/plugins.ts ← 圧縮plugin (rtk/caveman/...)  │             │
│  │   - 各pluginのenable/disable/isEnabled         │             │
│  └────────────────────────────────────────────────┘             │
│          ↓                                                       │
│  ┌────────────────────────────────────────────────┐             │
│  │ lib/handler.ts  ← 3つのhookエントリが共有       │             │
│  │   - フラグ判定 → OFFなら即exit 0               │             │
│  │   - tool判定 (rtk/MCP圧縮/通常)                 │             │
│  │   - tokenize → record build → logger.append    │             │
│  └────────────────────────────────────────────────┘             │
│          ↓                                                       │
│  ┌────────────────────────────────────────────────┐             │
│  │ lib/logger.ts → JSONL append (atomic, lock不要) │             │
│  └────────────────────────────────────────────────┘             │
└─────────────────────┬───────────────────────────────────────────┘
                      ▼
       ~/.claude/token-meter/logs/YYYY-MM-DD.jsonl
                      ↑
                      │
   ┌──────────────────┴────────────────────┐
   │ /token-measure list/on/off/status     │
   │ /token-plugins list/on/off/install    │
   │ /token-stats   集計レポート            │
   │ /token-clear   履歴削除                │
   └────────────────────────────────────────┘
```

### 設計判断

- 3つの hook エントリは薄い shim、本体ロジックは `lib/handler.ts` に集約
- 計測対象 tool と圧縮 plugin は **設定ファイル駆動**
- フラグ OFF 時は数行で exit、応答へのオーバーヘッドゼロ

## 3. データフロー

### 3.1 hook イベント受信

| hook | stdin payload | 取得情報 |
|---|---|---|
| `PreToolUse` | `{session_id, tool_name, tool_input}` | tool名、Claude→tool 入力 |
| `PostToolUse` | `{session_id, tool_name, tool_input, tool_response}` | tool→Claude 出力 |
| `Stop` | `{session_id, transcript_path}` | セッション識別子 |

### 3.2 共通処理パイプライン (`lib/handler.ts`)

```
stdin読込
  ↓
config.ts: shouldMeasure(tool_name)
  ├─ state.enabled === false           → exit 0
  ├─ state.tools[tool] === false       → exit 0
  ├─ state.tools[tool] === true        → 続行
  ├─ scope.exclude match               → exit 0
  └─ scope.include match               → 続行
       ↓
targets.ts: tool_name を分類
  ├─ rtkプラグインの detect.pattern にマッチ → kind="rtk"
  ├─ compressionTools[]にマッチ            → kind="compression"
  └─ それ以外                              → kind="normal"
       ↓
tokenizer.ts: input_text / output_text を token化
       ↓
record build → logger.append → exit 0
```

### 3.3 Stop hook 集計

`Stop` 時点で当日 JSONL を読み、本セッションの全レコードを集計。
集計結果を 1 レコード (`kind: "stop"`) としてさらに追記する。

## 4. 設定駆動の中核

### 4.1 `lib/targets.ts` — 計測対象 / 観測ルール

```typescript
import type { TargetConfig } from "./types"

export const TARGETS: TargetConfig = {
  scope: {
    include: ["*"],
    exclude: ["TodoWrite", "TodoRead"],
  },

  rtkWrappers: [
    {
      tool: "Bash",
      detectField: "tool_input.command",
      pattern: /^\s*rtk\s+(.+)$/,
      savingsField: "tool_response.metadata.rtk_saved_tokens",
    },
  ],

  compressionTools: [
    {
      tool: "mcp__headroom__compress",
      inputField: "tool_input.text",
      outputField: "tool_response.compressed",
      label: "headroom",
    },
    {
      tool: "mcp__caveman-shrink__compress",
      inputField: "tool_input.body",
      outputField: "tool_response.body",
      label: "caveman",
    },
  ],

  output: {
    dir: "${HOME}/.claude/token-meter/logs",
    rotation: "daily",
    maxFileSizeMB: 100,
  },

  tokenizer: {
    mode: "anthropic",
    fallbackToApprox: true,
  },
}
```

新しい MCP 圧縮 plugin を観測対象に加える場合は `compressionTools` に
1 エントリ追加するだけ。

### 4.2 `lib/plugins.ts` — 圧縮 plugin の定義と ON/OFF 実装

```typescript
export const COMPRESSION_PLUGINS: CompressionPlugin[] = [
  {
    name: "rtk",
    description: "Rust Token Killer — Bashコマンド出力を圧縮",
    install: { method: "brew", pkg: "rtk-ai/tap/rtk" },
    isInstalled: () => commandExists("rtk"),
    enable: async () => writeGate("rtk", true),
    disable: async () => writeGate("rtk", false),
    isEnabled: () => readGate("rtk"),
    detect: { tool: "Bash", pattern: /^\s*rtk\s+(.+)$/ },
  },
  {
    name: "caveman",
    description: "出力テキストを 'caveman talk' に圧縮",
    install: {
      method: "curl-sh",
      url: "https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh",
    },
    isInstalled: () => fs.existsSync(`${HOME}/.claude/skills/caveman`),
    enable: async () => fs.writeFileSync(`${HOME}/.claude/caveman.session.flag`, ""),
    disable: async () => fs.rmSync(`${HOME}/.claude/caveman.session.flag`, { force: true }),
    isEnabled: () => fs.existsSync(`${HOME}/.claude/caveman.session.flag`),
    detect: { /* MCP tool名で検出 */ },
  },
  {
    name: "headroom",
    description: "tool出力・履歴を圧縮するMCPサーバ",
    install: { method: "pip", pkg: "headroom-ai[all]" },
    isInstalled: () => commandExists("headroom"),
    enable: async () => mcpToggle("headroom", true),
    disable: async () => mcpToggle("headroom", false),
    isEnabled: () => mcpStatus("headroom"),
    detect: { /* MCP tool名で検出 */ },
  },
]
```

### 4.3 `state.json` — ランタイム状態

```json
{
  "enabled": true,
  "tools": {
    "Bash": true,
    "WebFetch": false
  },
  "plugins": {
    "rtk": true,
    "caveman": false,
    "headroom": true
  }
}
```

| キー | 役割 |
|---|---|
| `enabled` | 計測機構全体の ON/OFF |
| `tools.<name>` | tool 単位の上書き (true/false)。未指定は `targets.scope` で判定 |
| `plugins.<name>` | 圧縮 plugin 単位の ON/OFF。各 plugin の `enable()`/`disable()` を呼び出し |

### 4.4 判定の優先順位 (`lib/config.ts`)

```typescript
export function shouldMeasure(toolName: string): boolean {
  const state = readState()
  if (!state.enabled) return false                     // 1. 全体OFF
  const override = state.tools?.[toolName]
  if (override !== undefined) return override          // 2. tool別上書き
  return matchesScope(toolName, TARGETS.scope)         // 3. defaultスコープ
}
```

### 4.5 圧縮プラグインの ON/OFF メカニズム

3 プラグインは仕組みが違うので共通インタフェース `CompressionPlugin` で吸収する。

| plugin | enable/disable の実装 |
|---|---|
| rtk | rtk hook を gate ラッパで囲み、ゲートファイルで制御 |
| caveman | caveman skill が見る session flag を touch/rm |
| headroom | `.mcp.json` の `headroom` エントリの `enabled` を書換 |

headroom の `.mcp.json` 書換が Claude Code の再起動を要するかは実装時に確認する。

## 5. JSONL スキーマ

```typescript
type LogRecord =
  | { kind: "pre",            ts: string, session: string, tool: string,
       input_tokens: number, input_bytes: number }
  | { kind: "post.normal",    ts: string, session: string, tool: string,
       input_tokens: number, output_tokens: number, output_bytes: number,
       duration_ms: number }
  | { kind: "post.rtk",       ts: string, session: string, tool: "Bash",
       raw_command: string, wrapped_command: string,
       output_tokens: number, rtk_saved_tokens: number | null }
  | { kind: "post.compress",  ts: string, session: string, tool: string,
       label: string,
       input_tokens: number, output_tokens: number, ratio: number }
  | { kind: "stop",           ts: string, session: string,
       summary: SessionSummary }
```

実例:

```jsonl
{"kind":"pre","ts":"2026-06-18T11:14:02.301Z","session":"a1b2","tool":"Read","input_tokens":18,"input_bytes":54}
{"kind":"post.normal","ts":"2026-06-18T11:14:02.412Z","session":"a1b2","tool":"Read","input_tokens":18,"output_tokens":1842,"output_bytes":7421,"duration_ms":111}
{"kind":"post.rtk","ts":"...","session":"a1b2","tool":"Bash","raw_command":"git status","wrapped_command":"rtk git status","output_tokens":42,"rtk_saved_tokens":318}
{"kind":"post.compress","ts":"...","session":"a1b2","tool":"mcp__headroom__compress","label":"headroom","input_tokens":4521,"output_tokens":612,"ratio":0.135}
{"kind":"stop","ts":"...","session":"a1b2","summary":{"tool_calls":42,"output_tokens_total":124000,"by_tool":{"Read":56000,"Bash":32000},"rtk":{"calls":8,"saved":2544},"compression":{"headroom":{"calls":3,"saved":11727},"caveman":{"calls":2,"saved":890}}}}
```

### 設計判断

- 1 イベント 1 行 (jq/awk で集計しやすい)
- `kind` で discriminated union 化、TypeScript で型安全
- `ratio = output_tokens / input_tokens` (小さいほど圧縮率高)
- 圧縮 tool ごとに `label` を持ち、summary で plugin 別集計可能

## 6. スキル一覧

### 6.1 `/token-measure` — 計測機構の制御

| コマンド | 役割 |
|---|---|
| `/token-measure on` / `off` | 計測機構の全体 ON/OFF |
| `/token-measure on <tool>` / `off <tool>` | tool 別上書き |
| `/token-measure reset [<tool>]` | tool 別上書きを消去 |
| `/token-measure status` | state.json の整形ダンプ |
| `/token-measure list [--since 7d]` | 観測実績 + 各 tool の現在 ON/OFF 判定一覧 |

#### `/token-measure list` 出力例

```
> /token-measure list --since 7d
計測機構: ON  (state.enabled=true)

tool                              calls    out_tokens   state            根拠
──────────────────────────────────────────────────────────────────────────────
Read                              156      452,000      ON               scope.include="*"
Bash                              88       201,400      ON  (override)   state.tools.Bash=true
  └─ rtk経由                      31       62,000       —                rtk plugin enabled
Grep                              42       18,200       ON               scope.include="*"
Edit                              68       3,400        ON               scope.include="*"
mcp__headroom__compress           8        3,210        ON               compressionTools
mcp__caveman-shrink__compress     3        1,820        ON               compressionTools
TodoWrite                         12       0            OFF (excluded)   scope.exclude
WebFetch                          5        12,400       OFF (override)   state.tools.WebFetch=false
──────────────────────────────────────────────────────────────────────────────
合計: 9 tools observed / 7 active / 2 disabled / 7日累計 692,650 tokens
```

オプション: `--since today|1d|7d|30d|all`, `--sort calls|tokens|name`,
`--show-disabled`, `--only-active`

### 6.2 `/token-plugins` — 圧縮 plugin の制御

| コマンド | 役割 |
|---|---|
| `/token-plugins list` | 圧縮 plugin 一覧 + インストール済み / 有効 / 最近の効果 |
| `/token-plugins on <name>` / `off <name>` | plugin 個別 ON/OFF (`enable()`/`disable()`) |
| `/token-plugins install <name>` | Makefile 経由でインストール |
| `/token-plugins status <name>` | 1 plugin の詳細 (インストール先・設定パス・観測実績) |

#### `/token-plugins list` 出力例

```
plugin     installed  enabled   calls(7d)  saved_tokens   description
─────────────────────────────────────────────────────────────────────
rtk        ✓          ✓         62         18,420         Rust Token Killer — Bash output
caveman    ✓          ✗         0          —              Caveman talk output compressor
headroom   ✓          ✓         11         12,840         Headroom MCP compressor
─────────────────────────────────────────────────────────────────────
合計: 3 installed / 2 enabled / 31,260 tokens saved (7d)
```

### 6.3 `/token-stats` — トータルレポート

期間オプション `--since 7d` 等。tool 別 / plugin 別の token ボリュームと
圧縮効果を 1 ページにまとめて表示する。

### 6.4 `/token-clear` — 履歴削除

`/token-clear --before 30d` のように、保持期間を指定して
JSONL ファイルを削除する。

## 7. プロジェクト構造

```
apps/token-meter/
├── .claude-plugin/plugin.json
├── bin/
│   ├── hook-pre-tool-use.ts      # PreToolUse hook (Bun shebang)
│   ├── hook-post-tool-use.ts     # PostToolUse hook
│   └── hook-stop.ts              # Stop hook
├── lib/
│   ├── handler.ts                # 共通処理パイプライン
│   ├── config.ts                 # state.json 読み書き、shouldMeasure 判定
│   ├── targets.ts                # 観測対象定義 (設定ファイル)
│   ├── plugins.ts                # 圧縮plugin定義 (設定ファイル)
│   ├── tokenizer.ts              # @anthropic-ai/tokenizer ラッパ
│   ├── logger.ts                 # JSONL append
│   └── types.ts                  # 全型定義
├── scripts/
│   ├── hook-link.ts              # settings.json 安全編集
│   ├── status.ts                 # make status の中身
│   └── doctor.ts                 # 健全性チェック
├── skills/
│   ├── token-measure/SKILL.md
│   ├── token-plugins/SKILL.md
│   ├── token-stats/SKILL.md
│   └── token-clear/SKILL.md
├── __tests__/
│   ├── unit/
│   │   ├── targets.test.ts
│   │   ├── tokenizer.test.ts
│   │   ├── logger.test.ts
│   │   ├── config.test.ts
│   │   └── handler.test.ts
│   └── integration/
│       ├── hook-pre.test.ts
│       ├── hook-post.test.ts
│       ├── hook-stop.test.ts
│       └── e2e-flag.test.ts
├── Makefile
├── package.json
├── tsconfig.json
├── README.md
├── CLAUDE.md
└── LICENSE
```

## 8. Makefile とセットアップ

### 8.1 主要ターゲット

```makefile
.PHONY: setup
setup: deps install-plugins hook-link state-init    ## 1コマンド完全セットアップ

.PHONY: deps
deps:
	@cd $(REPO_ROOT) && pnpm install --filter=token-meter

.PHONY: install-plugins
install-plugins: install-rtk install-caveman install-headroom

.PHONY: install-rtk
install-rtk:
	@command -v rtk >/dev/null || brew install rtk-ai/tap/rtk
	@rtk init -g --hook-only

.PHONY: install-caveman
install-caveman:
	@test -d $(HOME)/.claude/skills/caveman || \
	  curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash

.PHONY: install-headroom
install-headroom:
	@command -v headroom >/dev/null || pipx install "headroom-ai[all]"
	@headroom mcp install --scope user --skip-existing

.PHONY: hook-link
hook-link:
	@bun run scripts/hook-link.ts

.PHONY: hook-unlink
hook-unlink:
	@bun run scripts/hook-link.ts --remove

.PHONY: state-init
state-init:
	@mkdir -p $(HOME)/.claude/token-meter/logs
	@chmod 700 $(HOME)/.claude/token-meter
	@test -f $(HOME)/.claude/token-meter/state.json || \
	  echo '{"enabled":true,"tools":{},"plugins":{"rtk":true,"caveman":true,"headroom":true}}' \
	  > $(HOME)/.claude/token-meter/state.json

.PHONY: status doctor test uninstall purge
status:    ; @bun run scripts/status.ts
doctor:    ; @bun run scripts/doctor.ts
test:      ; @cd $(REPO_ROOT) && pnpm --filter=token-meter test
uninstall: hook-unlink
	@echo "settings.jsonからtoken-meter hookを除去しました"
purge: uninstall
	@rm -rf $(HOME)/.claude/token-meter
```

### 8.2 `scripts/hook-link.ts` の振る舞い

1. `~/.claude/settings.json` を読み込み
2. `settings.json.backup-YYYY-MM-DD-HHMM` にバックアップ
3. `hooks.PreToolUse / PostToolUse / Stop` に token-meter エントリを追加
   - 既存 hook 配列に append (rtk hook 等と共存)
   - 既に token-meter のパスが含まれていれば skip (冪等)
4. atomic write (tmpfile → rename)

追記される hook 形式:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "", "hooks": [
        { "type": "command",
          "command": "$HOME/.claude/token-meter/bin/hook-pre-tool-use" }
      ]}
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [
        { "type": "command",
          "command": "$HOME/.claude/token-meter/bin/hook-post-tool-use" }
      ]}
    ],
    "Stop": [
      { "matcher": "", "hooks": [
        { "type": "command",
          "command": "$HOME/.claude/token-meter/bin/hook-stop" }
      ]}
    ]
  }
}
```

### 8.3 symlink 構造

```
~/.claude/token-meter/
├── bin/           → symlink to apps/token-meter/bin/
├── lib/           → symlink to apps/token-meter/lib/
├── node_modules/  → symlink to apps/token-meter/node_modules/
├── state.json     (実体, ユーザー編集可)
├── logs/          (JSONL 出力先)
└── error.log
```

リポを編集すると即反映。複数 Claude アカウント横断は既存
`claude-link` パターンと整合させる。

### 8.4 ユーザー視点のセットアップ手順

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git pull
cd apps/token-meter
make setup
# Claude Code を再起動
```

完了後すぐ使えるコマンド:

- `/token-measure list`
- `/token-plugins list`
- `/token-stats`

## 9. エラー処理ポリシー

hook は **"fail open"** を厳守。失敗しても Claude Code 本体の動作を妨げない。

```typescript
try {
  await handler(process.stdin)
} catch (e) {
  appendErrorLog(e)
}
process.exit(0)
```

| 失敗ケース | 挙動 |
|---|---|
| tokenizer 読み込み失敗 | `targets.tokenizer.fallbackToApprox=true` で文字数近似に切替、ログに degraded flag |
| JSONL 書き込み失敗 | `~/.claude/token-meter/error.log` に stderr 出力、exit 0 |
| stdin payload JSON パース失敗 | error.log に raw ダンプ、exit 0 |
| 設定ファイル不正 | error.log に記録、デフォルト値で続行 |
| フラグファイル無し | 即 exit 0 (正常動作) |

**絶対にやらないこと**: 非 0 exit、stdout への出力、Claude Code 本体の stdin を consume。

## 10. パフォーマンス目標

| シナリオ | 目標 | 仕組み |
|---|---|---|
| 計測 OFF 時 | < 5ms | フラグ判定→exit、tokenizer 未ロード |
| 計測 ON、通常 tool | < 30ms | bun 起動 10ms + tokenize 10ms + I/O 5ms |
| 計測 ON、大出力 (100KB) | < 80ms | tokenizer 一括処理 |
| 並列 tool 呼び出し | 干渉なし | `O_APPEND` で原子的、lockfile 不要 |

出力が 256KB を超える場合は先頭/末尾サンプリング + 文字数近似に
フォールバックして上限を保証する。

## 11. セキュリティ / プライバシー

- JSONL には `tool_input` / `tool_output` の生コンテンツを記録しない
- 記録するのは token 数、tool 名、`raw_command` (コマンド名のみ) など最小限
- `Read` の対象パスは記録、内容は記録しない
- `~/.claude/token-meter/logs/` のパーミッションは `0700`

## 12. テスト戦略

```
apps/token-meter/__tests__/
├── unit/
│   ├── targets.test.ts        # 設定パターンマッチ (rtk検出、MCP圧縮判定、exclude)
│   ├── tokenizer.test.ts      # tokenize結果決定的、approxフォールバック
│   ├── logger.test.ts         # 並列append、ローテーション
│   ├── config.test.ts         # state.json 階層判定の全組み合わせ
│   └── handler.test.ts        # JSONペイロード→record変換
└── integration/
    ├── hook-pre.test.ts       # 実stdinパイプ→JSONL出力検証
    ├── hook-post.test.ts      # rtk/MCP/normal の3ケース
    ├── hook-stop.test.ts      # 集計の正しさ
    └── e2e-flag.test.ts       # フラグON/OFFの観測
```

Bun の `bun:test` を採用 (既に `@types/bun` 入り)。

## 13. リスクと対処

| リスク | 対処 |
|---|---|
| `settings.json` の他 plugin hook を破壊 | バックアップ + 重複検知 + atomic write |
| `rtk init -g` と書き込み競合 | rtk インストール後に `hook-link` 実行 → 共存マージ |
| 大量並列セッションでの JSONL 書き込み競合 | `O_APPEND` + 1 行 write で原子性確保 |
| Bun 未インストール環境 | Makefile 先頭でチェック、なければ `brew install bun` 案内 |
| tokenizer 初回ロード遅延 | hook 単発で 30ms 以内目標。`make doctor` で実測 |
| rtk 実節約量の取得 | rtk 出力に節約量メタが無い場合は `wrapped_tokens` のみ記録 |
| headroom MCP ホットリロード | 実装時に Claude Code 仕様を確認、不可なら再起動を案内 |

## 14. 将来拡張

- 新しい圧縮 plugin → `lib/plugins.ts` に 1 エントリ追加 + `compressionTools` 追加
- 新しい観測ルール → `lib/targets.ts` を編集
- 圧縮効果のダッシュボード化 → 別 plugin (`token-meter-web`) として apps 配下に追加
- 複数アカウント横断レポート → `claude-link` で `~/.claude/token-meter/logs/` 共有

## 15. オープン項目 (実装時に確定)

- rtk が `tool_response` メタに `rtk_saved_tokens` を入れるか (要 rtk 仕様確認)
- headroom MCP の hot reload 可否
- caveman の session flag ファイルの正確なパス
- Bun precompile した tokenizer モジュールのリポ commit 可否 (サイズ次第)
- `make doctor` の合格基準値 (実測してから確定)
