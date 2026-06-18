# token-meter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code の hook 経由で 3 つの圧縮プラグイン (rtk / caveman / headroom) の効きを観測し、JSONL に記録・集計するための token-meter プラグインを実装する。

**Architecture:** PreToolUse / PostToolUse / Stop の 3 hook がそれぞれ薄い shim になり、本体ロジックは `lib/handler.ts` に集約。観測対象 tool と圧縮 plugin は設定ファイル (`lib/targets.ts` / `lib/plugins.ts`) 駆動で拡張可能。状態は `~/.claude/token-meter/state.json` に永続化し、JSONL 出力は `~/.claude/token-meter/logs/YYYY-MM-DD.jsonl` に追記する。

**Tech Stack:** Bun (runtime) + TypeScript 6 + biome 2.4.9 + bun:test。トークナイザは `@anthropic-ai/tokenizer`。設定編集は atomic write (tmpfile → rename) のみ使用。

## Global Constraints

- 言語規約: ドキュメント・コメント・コミットメッセージは日本語。コード（変数名・関数名・CLI フラグ）は英語。
- biome 2.4.9: `lineWidth: 120` / `indentStyle: space` / `indentWidth: 2` / `quoteStyle: 'single'` / `semicolons: 'asNeeded'`。
- 型安全: `any` / `unknown` を直接使わず、システム境界 (hook stdin JSON / `.claude.json` パース) では `zod` v4 スキーマで `.parse()` し型付きオブジェクトに変換する。`class` は `Error` 拡張以外で使用禁止。`Record<string, T>` のような汎用辞書は OK だが、その値を `unknown` にしない。
- 依存追加: `zod` (cmux-team と同じ `^4.3.6`)。`HookPayloadSchema` / `ClaudeConfigSchema` 等を `lib/schemas.ts` (またはタスク内の自然な場所) に定義し、shim/CLI の入口で必ず通す。
- ランタイム: Bun (`bun run` / `bun test`)。`Bun` global と `@types/bun` 前提。
- パッケージ管理: pnpm 10.33.0、`apps/token-meter` 配下に独立 workspace として追加（`pnpm-workspace.yaml` の `apps/*` で自動拾得）。
- ルートの marketplace.json と `apps/token-meter/.claude-plugin/plugin.json` の `version` を同期。
- hook は **fail open**: 例外時も `process.exit(0)`、stdout には何も書かない、Claude Code 本体の stdin を consume しない。
- 出力先: `~/.claude/token-meter/logs/` (mode `0700`)。
- 設定ファイル編集 (`settings.json`) は必ず backup → tmpfile → rename の atomic write。
- 既存 hook 配列に append (rtk 等と共存)、token-meter エントリ重複検知で冪等。

---

## File Structure

```
apps/token-meter/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── bin/
│   ├── hook-pre-tool-use.ts     # PreToolUse shim → handler('pre')
│   ├── hook-post-tool-use.ts    # PostToolUse shim → handler('post')
│   └── hook-stop.ts             # Stop shim → handler('stop')
├── lib/
│   ├── types.ts                 # 全型定義 (LogRecord, TargetConfig, CompressionPlugin...)
│   ├── tokenizer.ts             # countTokens + approx fallback
│   ├── logger.ts                # JSONL append (daily rotation)
│   ├── config.ts                # state.json 読み書き + shouldMeasure
│   ├── targets.ts               # TARGETS const + classify(toolName, payload)
│   ├── plugins.ts               # COMPRESSION_PLUGINS + enable/disable/isEnabled
│   └── handler.ts               # 共通パイプライン (pre/post/stop)
├── scripts/
│   ├── hook-link.ts             # ~/.claude/settings.json 安全編集
│   ├── status.ts                # `make status` の中身
│   └── doctor.ts                # 健全性チェック
├── skills/
│   ├── token-measure/SKILL.md
│   ├── token-plugins/SKILL.md
│   ├── token-stats/SKILL.md
│   └── token-clear/SKILL.md
├── __tests__/
│   ├── unit/
│   │   ├── tokenizer.test.ts
│   │   ├── logger.test.ts
│   │   ├── config.test.ts
│   │   ├── targets.test.ts
│   │   ├── plugins.test.ts
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
└── CLAUDE.md
```

設計判断: `lib/handler.ts` が pre/post/stop の 3 hook 共通入口、shim は薄い。`config.ts` と `state.json` の責務分離（読み書き / 判定の純粋関数）。`scripts/` は実行時に呼ばれず、`make setup` 経由のみ。

---

## Task 1: Project scaffolding と types.ts

**Files:**
- Create: `apps/token-meter/package.json`
- Create: `apps/token-meter/tsconfig.json`
- Create: `apps/token-meter/.claude-plugin/plugin.json`
- Create: `apps/token-meter/lib/types.ts`
- Create: `apps/token-meter/__tests__/unit/types.test.ts`
- Create: `apps/token-meter/.gitignore`

**Interfaces:**
- Consumes: なし (新規)
- Produces:
  - `LogRecord` discriminated union: `kind: 'pre' | 'post.normal' | 'post.rtk' | 'post.compress' | 'stop'`
  - `State`: `{ enabled: boolean, tools: Record<string, boolean>, plugins: Record<string, boolean> }`
  - `TargetConfig`: scope / rtkWrappers / compressionTools / output / tokenizer
  - `CompressionPlugin`: name / description / install / isInstalled / enable / disable / isEnabled / detect
  - `HookEvent`: PreToolUseEvent / PostToolUseEvent / StopEvent
  - `SessionSummary`: tool_calls / output_tokens_total / by_tool / rtk / compression

- [ ] **Step 1: package.json を作成**

```json
{
  "name": "@tanaka-yui/token-meter",
  "version": "0.1.0",
  "description": "Claude Code の hook 経由で圧縮プラグインの効きを観測・記録する計測機構",
  "type": "module",
  "private": true,
  "scripts": {
    "check": "tsc --noEmit && biome check ./bin ./lib ./scripts ./__tests__",
    "check:fix": "biome check --write ./bin ./lib ./scripts ./__tests__",
    "format": "biome format ./bin ./lib ./scripts ./__tests__",
    "format:fix": "biome format --write ./bin ./lib ./scripts ./__tests__",
    "lint": "biome lint ./bin ./lib ./scripts ./__tests__",
    "lint:fix": "biome lint --write ./bin ./lib ./scripts ./__tests__",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/tokenizer": "^0.0.4",
    "zod": "^4.3.6"
  }
}
```

- [ ] **Step 2: tsconfig.json を作成 (cmux-team と統一)**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "types": ["bun"]
  },
  "include": ["bin/**/*.ts", "lib/**/*.ts", "scripts/**/*.ts", "__tests__/**/*.ts"]
}
```

- [ ] **Step 3: plugin manifest を作成**

`apps/token-meter/.claude-plugin/plugin.json`:

```json
{
  "name": "token-meter",
  "version": "0.1.0",
  "description": "Claude Code の hook 経由で圧縮プラグイン (rtk/caveman/headroom) の効きを観測・記録する計測機構",
  "author": {
    "name": "tanaka-yui",
    "url": "https://github.com/tanaka-yui"
  },
  "repository": "https://github.com/tanaka-yui/yui-cc-plugins/apps/token-meter",
  "license": "MIT",
  "keywords": ["claude-code", "hook", "token", "compression", "measurement"],
  "skills": "./skills/",
  "commands": "./commands/"
}
```

- [ ] **Step 4: .gitignore を作成**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 5: 失敗するテストを書く**

`apps/token-meter/__tests__/unit/types.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'
import type { LogRecord, State, TargetConfig } from '../../lib/types'

describe('types', () => {
  test('LogRecord discriminated union が kind で narrowing できる', () => {
    const rec: LogRecord = {
      kind: 'pre',
      ts: '2026-06-18T00:00:00.000Z',
      session: 's1',
      tool: 'Read',
      input_tokens: 10,
      input_bytes: 30,
    }
    if (rec.kind === 'pre') {
      expect(rec.input_tokens).toBe(10)
    }
  })

  test('State.tools と State.plugins は省略可能なフラグ辞書', () => {
    const s: State = { enabled: true, tools: {}, plugins: {} }
    expect(s.enabled).toBe(true)
  })

  test('TargetConfig.scope は include/exclude を持つ', () => {
    const t: TargetConfig = {
      scope: { include: ['*'], exclude: ['TodoWrite'] },
      rtkWrappers: [],
      compressionTools: [],
      output: { dir: '/tmp', rotation: 'daily', maxFileSizeMB: 100 },
      tokenizer: { mode: 'anthropic', fallbackToApprox: true },
    }
    expect(t.scope.exclude).toContain('TodoWrite')
  })
})
```

- [ ] **Step 6: 失敗を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/types.test.ts`
Expected: FAIL (module not found `../../lib/types`)

- [ ] **Step 7: lib/types.ts を実装**

```typescript
export type SessionSummary = {
  tool_calls: number
  output_tokens_total: number
  by_tool: Record<string, number>
  rtk: { calls: number; saved: number }
  compression: Record<string, { calls: number; saved: number }>
}

export type LogRecord =
  | {
      kind: 'pre'
      ts: string
      session: string
      tool: string
      input_tokens: number
      input_bytes: number
    }
  | {
      kind: 'post.normal'
      ts: string
      session: string
      tool: string
      input_tokens: number
      output_tokens: number
      output_bytes: number
      duration_ms: number
      degraded?: boolean
    }
  | {
      kind: 'post.rtk'
      ts: string
      session: string
      tool: 'Bash'
      raw_command: string
      wrapped_command: string
      output_tokens: number
      rtk_saved_tokens: number | null
    }
  | {
      kind: 'post.compress'
      ts: string
      session: string
      tool: string
      label: string
      input_tokens: number
      output_tokens: number
      ratio: number
    }
  | {
      kind: 'stop'
      ts: string
      session: string
      summary: SessionSummary
    }

export type State = {
  enabled: boolean
  tools: Record<string, boolean>
  plugins: Record<string, boolean>
}

export type RtkWrapper = {
  tool: string
  detectField: string
  pattern: RegExp
  savingsField: string
}

export type CompressionToolDef = {
  tool: string
  inputField: string
  outputField: string
  label: string
}

export type TargetConfig = {
  scope: { include: string[]; exclude: string[] }
  rtkWrappers: RtkWrapper[]
  compressionTools: CompressionToolDef[]
  output: { dir: string; rotation: 'daily' | 'never'; maxFileSizeMB: number }
  tokenizer: { mode: 'anthropic' | 'approx'; fallbackToApprox: boolean }
}

export type PluginInstallSpec =
  | { method: 'brew'; pkg: string }
  | { method: 'pip'; pkg: string }
  | { method: 'curl-sh'; url: string }

export type CompressionPlugin = {
  name: string
  description: string
  install: PluginInstallSpec
  isInstalled: () => boolean
  enable: () => Promise<void>
  disable: () => Promise<void>
  isEnabled: () => boolean
  detect:
    | { tool: string; pattern: RegExp }
    | { tool: string }
}

export type HookKind = 'pre' | 'post' | 'stop'

// hook stdin の JSON 構造は不定。`lib/schemas.ts` で zod スキーマを定義し
// 以下の型は `z.infer<typeof ...>` で生成する (このファイルで再宣言しない)。
// 期待される shape:
//   ToolPayload  = { session_id: string; tool_name: string;
//                    tool_input?: JsonValue; tool_response?: JsonValue;
//                    duration_ms?: number }
//   StopPayload  = { session_id: string; transcript_path?: string }
//   JsonValue    = string | number | boolean | null
//                | JsonValue[] | { [k: string]: JsonValue }

export type ToolClassification =
  | { kind: 'rtk'; raw_command: string; wrapped_command: string }
  | { kind: 'compression'; label: string; inputField: string; outputField: string }
  | { kind: 'normal' }
  | { kind: 'skip' }
```

- [ ] **Step 8: テストを実行して PASS を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/types.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: pnpm install を実行**

Run: `cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm install`
Expected: token-meter が workspace として登録され、`@anthropic-ai/tokenizer` がインストールされる

- [ ] **Step 10: コミット**

```bash
git add apps/token-meter/package.json apps/token-meter/tsconfig.json \
  apps/token-meter/.claude-plugin/plugin.json apps/token-meter/.gitignore \
  apps/token-meter/lib/types.ts apps/token-meter/__tests__/unit/types.test.ts \
  pnpm-lock.yaml
git commit -m "feat(token-meter): プロジェクトスキャフォルドと型定義を追加"
```

---

## Task 2: tokenizer.ts

**Files:**
- Create: `apps/token-meter/lib/tokenizer.ts`
- Create: `apps/token-meter/__tests__/unit/tokenizer.test.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/tokenizer` の `countTokens(text: string): number`
- Produces:
  - `tokenize(text: string, mode: 'anthropic' | 'approx'): { tokens: number; degraded: boolean }`
  - `approxTokens(text: string): number` — `Math.ceil(byteLength / 4)` の簡易近似
  - `truncateForTokenize(text: string, maxBytes = 262144): { text: string; truncated: boolean }` — 256KB 超は先頭/末尾サンプリング

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, test } from 'bun:test'
import { approxTokens, tokenize, truncateForTokenize } from '../../lib/tokenizer'

describe('tokenizer', () => {
  test('anthropic モードで hello world のトークン数を返す', () => {
    const result = tokenize('hello world', 'anthropic')
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.degraded).toBe(false)
  })

  test('approx モードはバイト数 / 4 を切り上げる', () => {
    expect(approxTokens('a'.repeat(8))).toBe(2)
    expect(approxTokens('a'.repeat(9))).toBe(3)
  })

  test('approx モードで degraded=true を返す', () => {
    const r = tokenize('abc', 'approx')
    expect(r.degraded).toBe(true)
  })

  test('256KB を超えるテキストは先頭/末尾サンプリングされる', () => {
    const big = 'a'.repeat(300_000)
    const r = truncateForTokenize(big, 262_144)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(262_144)
  })

  test('256KB 以下はそのまま返す', () => {
    const r = truncateForTokenize('short', 262_144)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('short')
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/tokenizer.test.ts`
Expected: FAIL (`Cannot find module '../../lib/tokenizer'`)

- [ ] **Step 3: lib/tokenizer.ts を実装**

```typescript
import { countTokens } from '@anthropic-ai/tokenizer'

export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

export function truncateForTokenize(
  text: string,
  maxBytes = 262_144,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false }
  }
  const half = Math.floor(maxBytes / 2)
  const head = text.slice(0, half)
  const tail = text.slice(-half)
  return { text: head + tail, truncated: true }
}

export function tokenize(
  text: string,
  mode: 'anthropic' | 'approx',
): { tokens: number; degraded: boolean } {
  if (mode === 'approx') {
    return { tokens: approxTokens(text), degraded: true }
  }
  try {
    const { text: t, truncated } = truncateForTokenize(text)
    const tokens = countTokens(t)
    return { tokens: truncated ? Math.ceil(tokens * (Buffer.byteLength(text, 'utf8') / Buffer.byteLength(t, 'utf8'))) : tokens, degraded: truncated }
  } catch {
    return { tokens: approxTokens(text), degraded: true }
  }
}
```

- [ ] **Step 4: テストを実行して PASS を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/tokenizer.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/token-meter/lib/tokenizer.ts apps/token-meter/__tests__/unit/tokenizer.test.ts
git commit -m "feat(token-meter): tokenizer ラッパと近似フォールバックを追加"
```

---

## Task 3: logger.ts

**Files:**
- Create: `apps/token-meter/lib/logger.ts`
- Create: `apps/token-meter/__tests__/unit/logger.test.ts`

**Interfaces:**
- Consumes: `LogRecord` (types.ts)
- Produces:
  - `appendLog(record: LogRecord, dir: string): void` — JSONL 1 行を `${dir}/YYYY-MM-DD.jsonl` に append (`O_APPEND` + 1 syscall)
  - `appendErrorLog(err: unknown, dir: string): void` — `${dir}/../error.log` に append
  - `readTodayRecords(dir: string, session: string): LogRecord[]` — 当日 JSONL からセッション一致レコードのみ抽出
  - `dailyPath(dir: string, now: Date): string` — `${dir}/YYYY-MM-DD.jsonl` を計算 (純粋関数)

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendErrorLog, appendLog, dailyPath, readTodayRecords } from '../../lib/logger'
import type { LogRecord } from '../../lib/types'

describe('logger', () => {
  test('dailyPath は dir/YYYY-MM-DD.jsonl を返す', () => {
    const d = new Date('2026-06-18T10:00:00Z')
    expect(dailyPath('/tmp/x', d)).toBe('/tmp/x/2026-06-18.jsonl')
  })

  test('appendLog は JSONL 1 行を追記する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-'))
    const rec: LogRecord = {
      kind: 'pre',
      ts: '2026-06-18T00:00:00.000Z',
      session: 's1',
      tool: 'Read',
      input_tokens: 5,
      input_bytes: 10,
    }
    appendLog(rec, dir)
    const path = dailyPath(dir, new Date())
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]!).kind).toBe('pre')
    rmSync(dir, { recursive: true })
  })

  test('appendLog は同日複数回呼ぶと append される', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-'))
    for (let i = 0; i < 3; i++) {
      appendLog(
        { kind: 'pre', ts: '2026-06-18T00:00:00.000Z', session: 's', tool: 'T', input_tokens: i, input_bytes: i },
        dir,
      )
    }
    const lines = readFileSync(dailyPath(dir, new Date()), 'utf8').trim().split('\n')
    expect(lines.length).toBe(3)
    rmSync(dir, { recursive: true })
  })

  test('readTodayRecords は session 一致のみ返す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-'))
    appendLog({ kind: 'pre', ts: '', session: 'A', tool: 'T', input_tokens: 1, input_bytes: 1 }, dir)
    appendLog({ kind: 'pre', ts: '', session: 'B', tool: 'T', input_tokens: 2, input_bytes: 2 }, dir)
    appendLog({ kind: 'pre', ts: '', session: 'A', tool: 'T', input_tokens: 3, input_bytes: 3 }, dir)
    const recs = readTodayRecords(dir, 'A')
    expect(recs.length).toBe(2)
    rmSync(dir, { recursive: true })
  })

  test('appendErrorLog は dir/../error.log に追記する', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-'))
    const logs = join(root, 'logs')
    appendErrorLog(new Error('boom'), logs)
    const errLog = readFileSync(join(root, 'error.log'), 'utf8')
    expect(errLog).toContain('boom')
    rmSync(root, { recursive: true })
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/logger.test.ts`
Expected: FAIL (`Cannot find module '../../lib/logger'`)

- [ ] **Step 3: lib/logger.ts を実装**

```typescript
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LogRecord } from './types'

export function dailyPath(dir: string, now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return join(dir, `${y}-${m}-${d}.jsonl`)
}

export function appendLog(record: LogRecord, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = dailyPath(dir, new Date())
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

export function appendErrorLog(err: unknown, logsDir: string): void {
  const parent = dirname(logsDir)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  const ts = new Date().toISOString()
  appendFileSync(join(parent, 'error.log'), `[${ts}] ${msg}\n`, { mode: 0o600 })
}

export function readTodayRecords(dir: string, session: string): LogRecord[] {
  const path = dailyPath(dir, new Date())
  try {
    const content = readFileSync(path, 'utf8')
    const out: LogRecord[] = []
    for (const line of content.split('\n')) {
      if (!line) continue
      const rec = JSON.parse(line) as LogRecord
      if (rec.session === session) out.push(rec)
    }
    return out
  } catch {
    return []
  }
}
```

- [ ] **Step 4: テスト実行して PASS 確認**

Run: `cd apps/token-meter && bun test __tests__/unit/logger.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/token-meter/lib/logger.ts apps/token-meter/__tests__/unit/logger.test.ts
git commit -m "feat(token-meter): JSONL ロガー (daily rotation + session フィルタ) を追加"
```

---

## Task 4: config.ts (state.json + shouldMeasure)

**Files:**
- Create: `apps/token-meter/lib/config.ts`
- Create: `apps/token-meter/__tests__/unit/config.test.ts`

**Interfaces:**
- Consumes: `State`, `TargetConfig` (types.ts)
- Produces:
  - `readState(path: string): State` — 未存在ならデフォルト `{ enabled: true, tools: {}, plugins: {} }` を返す
  - `writeState(path: string, state: State): void` — atomic write (tmpfile → rename)
  - `shouldMeasure(state: State, toolName: string, scope: TargetConfig['scope']): boolean` — 純粋関数
  - `matchesScope(toolName: string, scope: TargetConfig['scope']): boolean` — `*` ワイルドカード対応

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchesScope, readState, shouldMeasure, writeState } from '../../lib/config'
import type { State } from '../../lib/types'

const SCOPE = { include: ['*'], exclude: ['TodoWrite', 'TodoRead'] }

describe('config', () => {
  test('readState は未存在ならデフォルトを返す', () => {
    const s = readState(join(tmpdir(), 'nonexistent-tm-state.json'))
    expect(s.enabled).toBe(true)
    expect(s.tools).toEqual({})
    expect(s.plugins).toEqual({})
  })

  test('writeState → readState で round trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-'))
    const path = join(dir, 'state.json')
    const s: State = { enabled: false, tools: { Bash: true }, plugins: { rtk: true } }
    writeState(path, s)
    expect(existsSync(path)).toBe(true)
    expect(readState(path)).toEqual(s)
    rmSync(dir, { recursive: true })
  })

  test('matchesScope は include="*" + exclude を反映', () => {
    expect(matchesScope('Read', SCOPE)).toBe(true)
    expect(matchesScope('TodoWrite', SCOPE)).toBe(false)
  })

  test('shouldMeasure: state.enabled=false なら false', () => {
    const s: State = { enabled: false, tools: {}, plugins: {} }
    expect(shouldMeasure(s, 'Read', SCOPE)).toBe(false)
  })

  test('shouldMeasure: tool 別 override が最優先', () => {
    const s: State = { enabled: true, tools: { TodoWrite: true }, plugins: {} }
    expect(shouldMeasure(s, 'TodoWrite', SCOPE)).toBe(true)
  })

  test('shouldMeasure: tools.X=false で除外', () => {
    const s: State = { enabled: true, tools: { Read: false }, plugins: {} }
    expect(shouldMeasure(s, 'Read', SCOPE)).toBe(false)
  })

  test('shouldMeasure: override 無しなら scope で判定', () => {
    const s: State = { enabled: true, tools: {}, plugins: {} }
    expect(shouldMeasure(s, 'Read', SCOPE)).toBe(true)
    expect(shouldMeasure(s, 'TodoWrite', SCOPE)).toBe(false)
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/config.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: lib/config.ts を実装**

```typescript
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { State, TargetConfig } from './types'

const DEFAULT_STATE: State = { enabled: true, tools: {}, plugins: {} }

export function readState(path: string): State {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<State>
    return {
      enabled: parsed.enabled ?? true,
      tools: parsed.tools ?? {},
      plugins: parsed.plugins ?? {},
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function writeState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.state.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function matchesScope(toolName: string, scope: TargetConfig['scope']): boolean {
  for (const ex of scope.exclude) {
    if (ex === toolName) return false
  }
  for (const inc of scope.include) {
    if (inc === '*' || inc === toolName) return true
  }
  return false
}

export function shouldMeasure(state: State, toolName: string, scope: TargetConfig['scope']): boolean {
  if (!state.enabled) return false
  const override = state.tools[toolName]
  if (override !== undefined) return override
  return matchesScope(toolName, scope)
}
```

注: `writeState` の tmpfile 名に `Date.now()` を含むが、テスト時刻依存ではなく一意性のためのみ。テストは round-trip のみ検証する。

- [ ] **Step 4: テストを実行して PASS を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/config.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/token-meter/lib/config.ts apps/token-meter/__tests__/unit/config.test.ts
git commit -m "feat(token-meter): state.json 読み書きと shouldMeasure 判定ロジックを追加"
```

---

## Task 5: targets.ts (TARGETS + classify)

**Files:**
- Create: `apps/token-meter/lib/targets.ts`
- Create: `apps/token-meter/__tests__/unit/targets.test.ts`

**Interfaces:**
- Consumes: `TargetConfig`, `ToolPayload`, `ToolClassification` (types.ts)
- Produces:
  - `TARGETS: TargetConfig` — spec の §4.1 と同一
  - `classify(toolName: string, payload: ToolPayload, targets: TargetConfig): ToolClassification` — rtk → compression → normal の順で判定
  - `extractField(obj: unknown, path: string): unknown` — `'tool_input.command'` のようなドット記法アクセサ

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, test } from 'bun:test'
import { classify, extractField, TARGETS } from '../../lib/targets'

describe('targets', () => {
  test('extractField はドット記法でネストを取り出す', () => {
    expect(extractField({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1)
    expect(extractField({ a: 1 }, 'a.b')).toBeUndefined()
  })

  test('TARGETS.scope.exclude に TodoWrite/TodoRead を含む', () => {
    expect(TARGETS.scope.exclude).toEqual(['TodoWrite', 'TodoRead'])
  })

  test('classify: Bash + "rtk foo" は kind=rtk', () => {
    const r = classify('Bash', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'rtk ls' } }, TARGETS)
    expect(r.kind).toBe('rtk')
    if (r.kind === 'rtk') {
      expect(r.wrapped_command).toBe('rtk ls')
      expect(r.raw_command).toBe('ls')
    }
  })

  test('classify: Bash + 通常コマンドは kind=normal', () => {
    const r = classify('Bash', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls -l' } }, TARGETS)
    expect(r.kind).toBe('normal')
  })

  test('classify: mcp__headroom__compress は kind=compression label=headroom', () => {
    const r = classify(
      'mcp__headroom__compress',
      { session_id: 's', tool_name: 'mcp__headroom__compress', tool_input: { text: 'hi' } },
      TARGETS,
    )
    expect(r.kind).toBe('compression')
    if (r.kind === 'compression') {
      expect(r.label).toBe('headroom')
      expect(r.inputField).toBe('tool_input.text')
    }
  })

  test('classify: Read は kind=normal', () => {
    const r = classify('Read', { session_id: 's', tool_name: 'Read' }, TARGETS)
    expect(r.kind).toBe('normal')
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/targets.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: lib/targets.ts を実装**

```typescript
import type { TargetConfig, ToolClassification, ToolPayload } from './types'

export const TARGETS: TargetConfig = {
  scope: {
    include: ['*'],
    exclude: ['TodoWrite', 'TodoRead'],
  },
  rtkWrappers: [
    {
      tool: 'Bash',
      detectField: 'tool_input.command',
      pattern: /^\s*rtk\s+(.+)$/,
      savingsField: 'tool_response.metadata.rtk_saved_tokens',
    },
  ],
  compressionTools: [
    {
      tool: 'mcp__headroom__compress',
      inputField: 'tool_input.text',
      outputField: 'tool_response.compressed',
      label: 'headroom',
    },
    {
      tool: 'mcp__caveman-shrink__compress',
      inputField: 'tool_input.body',
      outputField: 'tool_response.body',
      label: 'caveman',
    },
  ],
  output: {
    dir: `${process.env.HOME ?? ''}/.claude/token-meter/logs`,
    rotation: 'daily',
    maxFileSizeMB: 100,
  },
  tokenizer: {
    mode: 'anthropic',
    fallbackToApprox: true,
  },
}

export function extractField(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

export function classify(
  toolName: string,
  payload: ToolPayload,
  targets: TargetConfig,
): ToolClassification {
  for (const w of targets.rtkWrappers) {
    if (w.tool !== toolName) continue
    const cmd = extractField(payload, w.detectField)
    if (typeof cmd !== 'string') continue
    const match = cmd.match(w.pattern)
    if (match) {
      return {
        kind: 'rtk',
        raw_command: match[1] ?? '',
        wrapped_command: cmd,
      }
    }
  }
  for (const c of targets.compressionTools) {
    if (c.tool === toolName) {
      return { kind: 'compression', label: c.label, inputField: c.inputField, outputField: c.outputField }
    }
  }
  return { kind: 'normal' }
}
```

- [ ] **Step 4: テスト実行して PASS 確認**

Run: `cd apps/token-meter && bun test __tests__/unit/targets.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/token-meter/lib/targets.ts apps/token-meter/__tests__/unit/targets.test.ts
git commit -m "feat(token-meter): 観測対象定義 (TARGETS) と tool 分類ロジックを追加"
```

---

## Task 6: plugins.ts (COMPRESSION_PLUGINS)

**Files:**
- Create: `apps/token-meter/lib/plugins.ts`
- Create: `apps/token-meter/__tests__/unit/plugins.test.ts`

**Interfaces:**
- Consumes: `CompressionPlugin` (types.ts)
- Produces:
  - `COMPRESSION_PLUGINS: CompressionPlugin[]` — rtk / caveman / headroom 3 件
  - `commandExists(cmd: string): boolean` — `which` 経由
  - `writeGate(name: string, on: boolean): Promise<void>` — `~/.claude/token-meter/gates/<name>.gate` を touch/rm
  - `readGate(name: string): boolean` — 同上 exists
  - `mcpToggle(name: string, on: boolean): Promise<void>` — `~/.claude.json` の `mcpServers.<name>.enabled` を atomic write 書換
  - `mcpStatus(name: string): boolean` — 同上読み出し

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandExists, COMPRESSION_PLUGINS, mcpStatus, mcpToggle, readGate, writeGate } from '../../lib/plugins'

describe('plugins', () => {
  test('COMPRESSION_PLUGINS は rtk/caveman/headroom 3 件', () => {
    const names = COMPRESSION_PLUGINS.map((p) => p.name)
    expect(names).toEqual(['rtk', 'caveman', 'headroom'])
  })

  test('commandExists は ls=true / __nope__=false', () => {
    expect(commandExists('ls')).toBe(true)
    expect(commandExists('__nope_xyz__')).toBe(false)
  })

  test('writeGate/readGate の round trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-gate-'))
    process.env.TOKEN_METER_GATE_DIR = dir
    await writeGate('test', true)
    expect(readGate('test')).toBe(true)
    await writeGate('test', false)
    expect(readGate('test')).toBe(false)
    rmSync(dir, { recursive: true })
    delete process.env.TOKEN_METER_GATE_DIR
  })

  test('mcpToggle は .claude.json の mcpServers.<name>.enabled を書換える', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-mcp-'))
    const claudeJson = join(dir, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { headroom: { command: 'headroom', enabled: true } } }))
    process.env.TOKEN_METER_CLAUDE_JSON = claudeJson
    await mcpToggle('headroom', false)
    expect(mcpStatus('headroom')).toBe(false)
    await mcpToggle('headroom', true)
    expect(mcpStatus('headroom')).toBe(true)
    rmSync(dir, { recursive: true })
    delete process.env.TOKEN_METER_CLAUDE_JSON
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/plugins.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: lib/plugins.ts を実装**

```typescript
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CompressionPlugin } from './types'

function gateDir(): string {
  return process.env.TOKEN_METER_GATE_DIR ?? join(homedir(), '.claude', 'token-meter', 'gates')
}

function gatePath(name: string): string {
  return join(gateDir(), `${name}.gate`)
}

function claudeJsonPath(): string {
  return process.env.TOKEN_METER_CLAUDE_JSON ?? join(homedir(), '.claude.json')
}

export function commandExists(cmd: string): boolean {
  const r = spawnSync('which', [cmd], { stdio: 'ignore' })
  return r.status === 0
}

export async function writeGate(name: string, on: boolean): Promise<void> {
  const path = gatePath(name)
  if (on) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, '', { mode: 0o600 })
  } else {
    rmSync(path, { force: true })
  }
}

export function readGate(name: string): boolean {
  return existsSync(gatePath(name))
}

type ClaudeConfig = {
  mcpServers?: Record<string, { enabled?: boolean } & Record<string, unknown>>
} & Record<string, unknown>

function readClaudeConfig(): ClaudeConfig {
  try {
    return JSON.parse(readFileSync(claudeJsonPath(), 'utf8')) as ClaudeConfig
  } catch {
    return {}
  }
}

function writeClaudeConfig(cfg: ClaudeConfig): void {
  const path = claudeJsonPath()
  const tmp = join(dirname(path), `.claude.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`)
  renameSync(tmp, path)
}

export async function mcpToggle(name: string, on: boolean): Promise<void> {
  const cfg = readClaudeConfig()
  const servers = cfg.mcpServers ?? {}
  const entry = servers[name] ?? {}
  servers[name] = { ...entry, enabled: on }
  cfg.mcpServers = servers
  writeClaudeConfig(cfg)
}

export function mcpStatus(name: string): boolean {
  const cfg = readClaudeConfig()
  const entry = cfg.mcpServers?.[name]
  return entry?.enabled === true
}

export const COMPRESSION_PLUGINS: CompressionPlugin[] = [
  {
    name: 'rtk',
    description: 'Rust Token Killer — Bash コマンド出力を圧縮',
    install: { method: 'brew', pkg: 'rtk-ai/tap/rtk' },
    isInstalled: () => commandExists('rtk'),
    enable: async () => writeGate('rtk', true),
    disable: async () => writeGate('rtk', false),
    isEnabled: () => readGate('rtk'),
    detect: { tool: 'Bash', pattern: /^\s*rtk\s+(.+)$/ },
  },
  {
    name: 'caveman',
    description: 'caveman talk 形式に出力を圧縮するスキル',
    install: {
      method: 'curl-sh',
      url: 'https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh',
    },
    isInstalled: () => existsSync(join(homedir(), '.claude', 'skills', 'caveman')),
    enable: async () => {
      const flag = join(homedir(), '.claude', 'caveman.session.flag')
      mkdirSync(dirname(flag), { recursive: true })
      writeFileSync(flag, '')
    },
    disable: async () => {
      rmSync(join(homedir(), '.claude', 'caveman.session.flag'), { force: true })
    },
    isEnabled: () => existsSync(join(homedir(), '.claude', 'caveman.session.flag')),
    detect: { tool: 'mcp__caveman-shrink__compress' },
  },
  {
    name: 'headroom',
    description: 'tool 出力・履歴を圧縮する MCP サーバ',
    install: { method: 'pip', pkg: 'headroom-ai[all]' },
    isInstalled: () => commandExists('headroom'),
    enable: async () => mcpToggle('headroom', true),
    disable: async () => mcpToggle('headroom', false),
    isEnabled: () => mcpStatus('headroom'),
    detect: { tool: 'mcp__headroom__compress' },
  },
]
```

注: `caveman.session.flag` のパスは実装時に caveman 仕様確認 (§15 オープン項目)。本実装は spec の §4.2 に従う。

- [ ] **Step 4: テスト実行して PASS 確認**

Run: `cd apps/token-meter && bun test __tests__/unit/plugins.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/token-meter/lib/plugins.ts apps/token-meter/__tests__/unit/plugins.test.ts
git commit -m "feat(token-meter): 圧縮 plugin 定義と enable/disable 抽象を追加"
```

---

## Task 7: handler.ts (共通パイプライン)

**Files:**
- Create: `apps/token-meter/lib/handler.ts`
- Create: `apps/token-meter/__tests__/unit/handler.test.ts`

**Interfaces:**
- Consumes: `tokenize` (tokenizer.ts), `appendLog`/`readTodayRecords` (logger.ts), `readState`/`shouldMeasure` (config.ts), `TARGETS`/`classify`/`extractField` (targets.ts)
- Produces:
  - `handlePre(payload: ToolPayload, opts: HandlerOpts): void`
  - `handlePost(payload: ToolPayload, opts: HandlerOpts): void`
  - `handleStop(payload: StopPayload, opts: HandlerOpts): void`
  - `HandlerOpts = { logsDir: string; statePath: string; now?: () => Date }`
  - `aggregate(records: LogRecord[]): SessionSummary` — 純粋関数

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregate, handlePost, handlePre, handleStop } from '../../lib/handler'
import { dailyPath } from '../../lib/logger'
import { writeState } from '../../lib/config'
import type { LogRecord } from '../../lib/types'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tm-h-'))
  const logsDir = join(root, 'logs')
  const statePath = join(root, 'state.json')
  writeState(statePath, { enabled: true, tools: {}, plugins: {} })
  return { root, logsDir, statePath }
}

describe('handler', () => {
  test('handlePre: 通常 tool の pre レコードを 1 行追記', () => {
    const { root, logsDir, statePath } = setup()
    handlePre({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x' } }, { logsDir, statePath })
    const lines = readFileSync(dailyPath(logsDir, new Date()), 'utf8').trim().split('\n')
    const rec = JSON.parse(lines[0]!) as LogRecord
    expect(rec.kind).toBe('pre')
    if (rec.kind === 'pre') expect(rec.tool).toBe('Read')
    rmSync(root, { recursive: true })
  })

  test('handlePre: enabled=false なら何も書かない', () => {
    const { root, logsDir, statePath } = setup()
    writeState(statePath, { enabled: false, tools: {}, plugins: {} })
    handlePre({ session_id: 's1', tool_name: 'Read' }, { logsDir, statePath })
    expect(() => readFileSync(dailyPath(logsDir, new Date()))).toThrow()
    rmSync(root, { recursive: true })
  })

  test('handlePost: rtk wrap を post.rtk として記録', () => {
    const { root, logsDir, statePath } = setup()
    handlePost(
      {
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'rtk git status' },
        tool_response: { stdout: 'M file\n', metadata: { rtk_saved_tokens: 100 } },
        duration_ms: 50,
      },
      { logsDir, statePath },
    )
    const lines = readFileSync(dailyPath(logsDir, new Date()), 'utf8').trim().split('\n')
    const rec = JSON.parse(lines[0]!) as LogRecord
    expect(rec.kind).toBe('post.rtk')
    if (rec.kind === 'post.rtk') {
      expect(rec.raw_command).toBe('git status')
      expect(rec.rtk_saved_tokens).toBe(100)
    }
    rmSync(root, { recursive: true })
  })

  test('handlePost: MCP 圧縮 tool を post.compress として ratio 付きで記録', () => {
    const { root, logsDir, statePath } = setup()
    handlePost(
      {
        session_id: 's1',
        tool_name: 'mcp__headroom__compress',
        tool_input: { text: 'a'.repeat(400) },
        tool_response: { compressed: 'a'.repeat(40) },
      },
      { logsDir, statePath },
    )
    const lines = readFileSync(dailyPath(logsDir, new Date()), 'utf8').trim().split('\n')
    const rec = JSON.parse(lines[0]!) as LogRecord
    expect(rec.kind).toBe('post.compress')
    if (rec.kind === 'post.compress') {
      expect(rec.label).toBe('headroom')
      expect(rec.ratio).toBeLessThan(1)
    }
    rmSync(root, { recursive: true })
  })

  test('aggregate: post.normal + post.rtk + post.compress を集計', () => {
    const recs: LogRecord[] = [
      { kind: 'post.normal', ts: '', session: 's', tool: 'Read', input_tokens: 1, output_tokens: 100, output_bytes: 400, duration_ms: 10 },
      { kind: 'post.rtk', ts: '', session: 's', tool: 'Bash', raw_command: 'ls', wrapped_command: 'rtk ls', output_tokens: 20, rtk_saved_tokens: 80 },
      { kind: 'post.compress', ts: '', session: 's', tool: 'mcp__headroom__compress', label: 'headroom', input_tokens: 1000, output_tokens: 100, ratio: 0.1 },
    ]
    const sum = aggregate(recs)
    expect(sum.tool_calls).toBe(3)
    expect(sum.output_tokens_total).toBe(220)
    expect(sum.by_tool.Read).toBe(100)
    expect(sum.rtk.calls).toBe(1)
    expect(sum.rtk.saved).toBe(80)
    expect(sum.compression.headroom?.saved).toBe(900)
  })

  test('handleStop: 集計 stop レコードを追記', () => {
    const { root, logsDir, statePath } = setup()
    handlePre({ session_id: 's1', tool_name: 'Read' }, { logsDir, statePath })
    handlePost(
      { session_id: 's1', tool_name: 'Read', tool_response: { content: 'hello' }, duration_ms: 5 },
      { logsDir, statePath },
    )
    handleStop({ session_id: 's1' }, { logsDir, statePath })
    const lines = readFileSync(dailyPath(logsDir, new Date()), 'utf8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]!) as LogRecord
    expect(last.kind).toBe('stop')
    if (last.kind === 'stop') {
      expect(last.summary.tool_calls).toBeGreaterThan(0)
    }
    rmSync(root, { recursive: true })
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/handler.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: lib/handler.ts を実装**

```typescript
import { readState, shouldMeasure } from './config'
import { appendLog, readTodayRecords } from './logger'
import { classify, extractField, TARGETS } from './targets'
import { tokenize } from './tokenizer'
import type { LogRecord, SessionSummary, StopPayload, ToolPayload } from './types'

export type HandlerOpts = {
  logsDir: string
  statePath: string
  now?: () => Date
}

function isoNow(opts: HandlerOpts): string {
  return (opts.now ? opts.now() : new Date()).toISOString()
}

function toText(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function tokensOf(text: string): number {
  return tokenize(text, TARGETS.tokenizer.mode).tokens
}

export function handlePre(payload: ToolPayload, opts: HandlerOpts): void {
  const state = readState(opts.statePath)
  if (!shouldMeasure(state, payload.tool_name, TARGETS.scope)) return
  const inputText = toText(payload.tool_input)
  const rec: LogRecord = {
    kind: 'pre',
    ts: isoNow(opts),
    session: payload.session_id,
    tool: payload.tool_name,
    input_tokens: tokensOf(inputText),
    input_bytes: Buffer.byteLength(inputText, 'utf8'),
  }
  appendLog(rec, opts.logsDir)
}

export function handlePost(payload: ToolPayload, opts: HandlerOpts): void {
  const state = readState(opts.statePath)
  if (!shouldMeasure(state, payload.tool_name, TARGETS.scope)) return
  const cls = classify(payload.tool_name, payload, TARGETS)
  const inputText = toText(payload.tool_input)
  const outputText = toText(payload.tool_response)
  const inputTokens = tokensOf(inputText)
  const outputTokens = tokensOf(outputText)
  const ts = isoNow(opts)

  if (cls.kind === 'rtk') {
    const wrapper = TARGETS.rtkWrappers.find((w) => w.tool === payload.tool_name)
    const savedRaw = wrapper ? extractField(payload, wrapper.savingsField) : undefined
    const saved = typeof savedRaw === 'number' ? savedRaw : null
    appendLog(
      {
        kind: 'post.rtk',
        ts,
        session: payload.session_id,
        tool: 'Bash',
        raw_command: cls.raw_command,
        wrapped_command: cls.wrapped_command,
        output_tokens: outputTokens,
        rtk_saved_tokens: saved,
      },
      opts.logsDir,
    )
    return
  }

  if (cls.kind === 'compression') {
    const inText = toText(extractField(payload, cls.inputField))
    const outText = toText(extractField(payload, cls.outputField))
    const inTok = tokensOf(inText)
    const outTok = tokensOf(outText)
    appendLog(
      {
        kind: 'post.compress',
        ts,
        session: payload.session_id,
        tool: payload.tool_name,
        label: cls.label,
        input_tokens: inTok,
        output_tokens: outTok,
        ratio: inTok === 0 ? 0 : outTok / inTok,
      },
      opts.logsDir,
    )
    return
  }

  appendLog(
    {
      kind: 'post.normal',
      ts,
      session: payload.session_id,
      tool: payload.tool_name,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      output_bytes: Buffer.byteLength(outputText, 'utf8'),
      duration_ms: payload.duration_ms ?? 0,
    },
    opts.logsDir,
  )
}

export function aggregate(records: LogRecord[]): SessionSummary {
  const summary: SessionSummary = {
    tool_calls: 0,
    output_tokens_total: 0,
    by_tool: {},
    rtk: { calls: 0, saved: 0 },
    compression: {},
  }
  for (const r of records) {
    if (r.kind === 'post.normal') {
      summary.tool_calls++
      summary.output_tokens_total += r.output_tokens
      summary.by_tool[r.tool] = (summary.by_tool[r.tool] ?? 0) + r.output_tokens
    } else if (r.kind === 'post.rtk') {
      summary.tool_calls++
      summary.output_tokens_total += r.output_tokens
      summary.by_tool[r.tool] = (summary.by_tool[r.tool] ?? 0) + r.output_tokens
      summary.rtk.calls++
      summary.rtk.saved += r.rtk_saved_tokens ?? 0
    } else if (r.kind === 'post.compress') {
      summary.tool_calls++
      summary.output_tokens_total += r.output_tokens
      summary.by_tool[r.tool] = (summary.by_tool[r.tool] ?? 0) + r.output_tokens
      const bucket = summary.compression[r.label] ?? { calls: 0, saved: 0 }
      bucket.calls++
      bucket.saved += Math.max(0, r.input_tokens - r.output_tokens)
      summary.compression[r.label] = bucket
    }
  }
  return summary
}

export function handleStop(payload: StopPayload, opts: HandlerOpts): void {
  const state = readState(opts.statePath)
  if (!state.enabled) return
  const recs = readTodayRecords(opts.logsDir, payload.session_id)
  const summary = aggregate(recs)
  appendLog(
    {
      kind: 'stop',
      ts: isoNow(opts),
      session: payload.session_id,
      summary,
    },
    opts.logsDir,
  )
}
```

- [ ] **Step 4: テスト実行して PASS 確認**

Run: `cd apps/token-meter && bun test __tests__/unit/handler.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/token-meter/lib/handler.ts apps/token-meter/__tests__/unit/handler.test.ts
git commit -m "feat(token-meter): pre/post/stop の共通パイプラインと集計関数を追加"
```

---

## Task 8: bin/ hook entries と統合テスト

**Files:**
- Create: `apps/token-meter/bin/hook-pre-tool-use.ts`
- Create: `apps/token-meter/bin/hook-post-tool-use.ts`
- Create: `apps/token-meter/bin/hook-stop.ts`
- Create: `apps/token-meter/__tests__/integration/hook-pre.test.ts`
- Create: `apps/token-meter/__tests__/integration/hook-post.test.ts`
- Create: `apps/token-meter/__tests__/integration/hook-stop.test.ts`
- Create: `apps/token-meter/__tests__/integration/e2e-flag.test.ts`

**Interfaces:**
- Consumes: `handlePre`/`handlePost`/`handleStop` (handler.ts), `appendErrorLog` (logger.ts)
- Produces: 3 つの executable shim (`#!/usr/bin/env bun`)
  - stdin から JSON を読んで対応 handler を呼び、例外時は error.log に出して `process.exit(0)`
  - `logsDir` / `statePath` は環境変数 `TOKEN_METER_HOME` (デフォルト `~/.claude/token-meter`) 配下

- [ ] **Step 1: 失敗するテストを書く (hook-pre)**

`apps/token-meter/__tests__/integration/hook-pre.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dailyPath } from '../../lib/logger'

function runHook(bin: string, payload: object, home: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, TOKEN_METER_HOME: home }
    const p = spawn('bun', ['run', bin], { env })
    let stderr = ''
    p.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    p.on('close', (code) => resolve({ code, stderr }))
    p.stdin.write(JSON.stringify(payload))
    p.stdin.end()
  })
}

describe('hook-pre-tool-use', () => {
  test('正常な payload を JSONL に記録し exit 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    const { code } = await runHook('apps/token-meter/bin/hook-pre-tool-use.ts', {
      session_id: 's1',
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
    }, home)
    expect(code).toBe(0)
    const lines = readFileSync(dailyPath(join(home, 'logs'), new Date()), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]!).tool).toBe('Read')
    rmSync(home, { recursive: true })
  })

  test('不正な JSON でも exit 0 で error.log に記録', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tm-i-'))
    const env = { ...process.env, TOKEN_METER_HOME: home }
    const p = spawn('bun', ['run', 'apps/token-meter/bin/hook-pre-tool-use.ts'], { env })
    const exit = new Promise<number | null>((r) => p.on('close', r))
    p.stdin.write('{not json')
    p.stdin.end()
    const code = await exit
    expect(code).toBe(0)
    const errLog = readFileSync(join(home, 'error.log'), 'utf8')
    expect(errLog.length).toBeGreaterThan(0)
    rmSync(home, { recursive: true })
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && bun test apps/token-meter/__tests__/integration/hook-pre.test.ts`
Expected: FAIL (bin script does not exist)

- [ ] **Step 3: bin/hook-pre-tool-use.ts を実装**

```typescript
#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { handlePre } from '../lib/handler'
import { appendErrorLog } from '../lib/logger'
import type { ToolPayload } from '../lib/types'

const HOME = process.env.TOKEN_METER_HOME ?? join(homedir(), '.claude', 'token-meter')
const LOGS = join(HOME, 'logs')
const STATE = join(HOME, 'state.json')

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const payload = JSON.parse(raw) as ToolPayload
  handlePre(payload, { logsDir: LOGS, statePath: STATE })
}

main()
  .catch((e) => appendErrorLog(e, LOGS))
  .finally(() => process.exit(0))
```

- [ ] **Step 4: bin/hook-post-tool-use.ts を実装**

```typescript
#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { handlePost } from '../lib/handler'
import { appendErrorLog } from '../lib/logger'
import type { ToolPayload } from '../lib/types'

const HOME = process.env.TOKEN_METER_HOME ?? join(homedir(), '.claude', 'token-meter')
const LOGS = join(HOME, 'logs')
const STATE = join(HOME, 'state.json')

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const payload = JSON.parse(raw) as ToolPayload
  handlePost(payload, { logsDir: LOGS, statePath: STATE })
}

main()
  .catch((e) => appendErrorLog(e, LOGS))
  .finally(() => process.exit(0))
```

- [ ] **Step 5: bin/hook-stop.ts を実装**

```typescript
#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { handleStop } from '../lib/handler'
import { appendErrorLog } from '../lib/logger'
import type { StopPayload } from '../lib/types'

const HOME = process.env.TOKEN_METER_HOME ?? join(homedir(), '.claude', 'token-meter')
const LOGS = join(HOME, 'logs')
const STATE = join(HOME, 'state.json')

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const payload = JSON.parse(raw) as StopPayload
  handleStop(payload, { logsDir: LOGS, statePath: STATE })
}

main()
  .catch((e) => appendErrorLog(e, LOGS))
  .finally(() => process.exit(0))
```

- [ ] **Step 6: shim に実行権限を付与**

Run: `chmod +x apps/token-meter/bin/hook-pre-tool-use.ts apps/token-meter/bin/hook-post-tool-use.ts apps/token-meter/bin/hook-stop.ts`

- [ ] **Step 7: hook-pre 統合テスト PASS 確認**

Run: `cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && bun test apps/token-meter/__tests__/integration/hook-pre.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: 残り 3 つの integration テストを追加**

`__tests__/integration/hook-post.test.ts` (同じ `runHook` ヘルパで Bash + rtk wrap / MCP 圧縮 / 通常 3 ケース)、
`__tests__/integration/hook-stop.test.ts` (pre/post を呼んだ後 stop で集計が追記される)、
`__tests__/integration/e2e-flag.test.ts` (state.enabled=false で何も書かないこと、tools.Read=false で除外されること) をそれぞれ Task 7 のユニットテストと同じ assertion を spawn 越しに行う形で実装。

- [ ] **Step 9: 全 integration テスト PASS 確認**

Run: `cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && bun test apps/token-meter/__tests__/integration/`
Expected: PASS (全テスト)

- [ ] **Step 10: 全テスト確認**

Run: `cd apps/token-meter && bun test`
Expected: PASS (unit + integration 全て)

- [ ] **Step 11: コミット**

```bash
git add apps/token-meter/bin/ apps/token-meter/__tests__/integration/
git commit -m "feat(token-meter): 3 hook shim と統合テストを追加"
```

---

## Task 9: scripts/hook-link.ts (settings.json 安全編集)

**Files:**
- Create: `apps/token-meter/scripts/hook-link.ts`
- Create: `apps/token-meter/__tests__/unit/hook-link.test.ts`

**Interfaces:**
- Consumes: なし (Node fs のみ)
- Produces:
  - CLI: `bun run scripts/hook-link.ts [--remove] [--settings <path>] [--bin <dir>]`
  - 内部関数 `addHooks(settings: SettingsJson, binDir: string): SettingsJson`
  - 内部関数 `removeHooks(settings: SettingsJson): SettingsJson`
  - 内部関数 `loadSettings(path: string): SettingsJson`
  - 内部関数 `saveSettings(path: string, s: SettingsJson, backupDir: string): void` — `<settings>.backup-YYYY-MM-DD-HHMM` を作成してから atomic write
  - `SettingsJson = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>`
  - `HookGroup = { matcher?: string; hooks: { type: 'command'; command: string }[] }`
  - 既存 hook 配列に append、重複検知 (command 文字列の完全一致) で skip

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, test } from 'bun:test'
import { addHooks, removeHooks, type SettingsJson } from '../../scripts/hook-link'

const BIN = '/u/h/.claude/token-meter/bin'

describe('hook-link', () => {
  test('addHooks: 空 settings に 3 hook を追加', () => {
    const out = addHooks({}, BIN)
    expect(out.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toContain('hook-pre-tool-use')
    expect(out.hooks?.PostToolUse?.[0]?.hooks[0]?.command).toContain('hook-post-tool-use')
    expect(out.hooks?.Stop?.[0]?.hooks[0]?.command).toContain('hook-stop')
  })

  test('addHooks: 既存 hook 配列に append', () => {
    const before: SettingsJson = {
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'rtk-hook' }] }] },
    }
    const out = addHooks(before, BIN)
    const preGroups = out.hooks?.PreToolUse ?? []
    const allCommands = preGroups.flatMap((g) => g.hooks.map((h) => h.command))
    expect(allCommands).toContain('rtk-hook')
    expect(allCommands.some((c) => c.includes('hook-pre-tool-use'))).toBe(true)
  })

  test('addHooks: 冪等 (2 回呼んでも重複しない)', () => {
    const a = addHooks({}, BIN)
    const b = addHooks(a, BIN)
    const count = (b.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes('hook-pre-tool-use')).length
    expect(count).toBe(1)
  })

  test('removeHooks: token-meter エントリのみ除去', () => {
    const a = addHooks({}, BIN)
    const withRtk: SettingsJson = {
      hooks: {
        ...a.hooks,
        PreToolUse: [...(a.hooks?.PreToolUse ?? []), { matcher: '', hooks: [{ type: 'command', command: 'rtk-hook' }] }],
      },
    }
    const b = removeHooks(withRtk)
    const remaining = (b.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks).map((h) => h.command)
    expect(remaining).toContain('rtk-hook')
    expect(remaining.some((c) => c.includes('hook-pre-tool-use'))).toBe(false)
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd apps/token-meter && bun test __tests__/unit/hook-link.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: scripts/hook-link.ts を実装**

```typescript
#!/usr/bin/env bun
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Hook = { type: 'command'; command: string }
export type HookGroup = { matcher?: string; hooks: Hook[] }
export type SettingsJson = {
  hooks?: Record<string, HookGroup[]>
} & Record<string, unknown>

const ENTRIES: Array<[string, string]> = [
  ['PreToolUse', 'hook-pre-tool-use'],
  ['PostToolUse', 'hook-post-tool-use'],
  ['Stop', 'hook-stop'],
]

function commandFor(binDir: string, name: string): string {
  return join(binDir, name)
}

export function addHooks(settings: SettingsJson, binDir: string): SettingsJson {
  const hooks = { ...(settings.hooks ?? {}) }
  for (const [event, name] of ENTRIES) {
    const cmd = commandFor(binDir, name)
    const groups = hooks[event] ?? []
    const exists = groups.some((g) => g.hooks.some((h) => h.command === cmd))
    if (exists) continue
    hooks[event] = [...groups, { matcher: '', hooks: [{ type: 'command', command: cmd }] }]
  }
  return { ...settings, hooks }
}

export function removeHooks(settings: SettingsJson): SettingsJson {
  if (!settings.hooks) return settings
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const filtered: HookGroup[] = []
    for (const g of groups) {
      const remaining = g.hooks.filter((h) => !h.command.includes('token-meter'))
      if (remaining.length > 0) filtered.push({ ...g, hooks: remaining })
    }
    if (filtered.length > 0) hooks[event] = filtered
  }
  return { ...settings, hooks }
}

export function loadSettings(path: string): SettingsJson {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as SettingsJson
}

export function saveSettings(path: string, s: SettingsJson): void {
  if (existsSync(path)) {
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    copyFileSync(path, `${path}.backup-${ts}`)
  }
  const tmp = join(dirname(path), `.settings.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`)
  renameSync(tmp, path)
}

function parseArgs(argv: string[]): { remove: boolean; settings: string; bin: string } {
  let remove = false
  let settings = join(homedir(), '.claude', 'settings.json')
  let bin = join(homedir(), '.claude', 'token-meter', 'bin')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--remove') remove = true
    else if (argv[i] === '--settings') settings = argv[++i] ?? settings
    else if (argv[i] === '--bin') bin = argv[++i] ?? bin
  }
  return { remove, settings, bin }
}

if (import.meta.main) {
  const { remove, settings, bin } = parseArgs(process.argv.slice(2))
  const current = loadSettings(settings)
  const next = remove ? removeHooks(current) : addHooks(current, bin)
  saveSettings(settings, next)
  console.log(remove ? `removed token-meter hooks from ${settings}` : `linked token-meter hooks into ${settings}`)
}
```

- [ ] **Step 4: テスト実行して PASS 確認**

Run: `cd apps/token-meter && bun test __tests__/unit/hook-link.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: コミット**

```bash
git add apps/token-meter/scripts/hook-link.ts apps/token-meter/__tests__/unit/hook-link.test.ts
git commit -m "feat(token-meter): settings.json 安全編集スクリプト (hook-link) を追加"
```

---

## Task 10: scripts/status.ts と scripts/doctor.ts

**Files:**
- Create: `apps/token-meter/scripts/status.ts`
- Create: `apps/token-meter/scripts/doctor.ts`

**Interfaces:**
- Consumes: `readState` (config.ts), `COMPRESSION_PLUGINS` (plugins.ts), `TARGETS` (targets.ts), `dailyPath`/`readTodayRecords` (logger.ts), `tokenize` (tokenizer.ts)
- Produces: 2 つの CLI shim (`#!/usr/bin/env bun`)
  - `status` — `state.json` と `~/.claude/settings.json` の hook 配線状況、当日 JSONL サイズを表示
  - `doctor` — `bun` / `rtk` / `caveman` / `headroom` インストール確認、`~/.claude/token-meter/` 権限確認、tokenizer 動作確認、hook 配線確認

これらは表示専用 (副作用なし) なので、シンプルな手動確認テストで十分。ユニットテストは省略 (writing-plans 指針の YAGNI)。

- [ ] **Step 1: scripts/status.ts を実装**

```typescript
#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readState } from '../lib/config'
import { dailyPath } from '../lib/logger'
import { COMPRESSION_PLUGINS } from '../lib/plugins'
import { loadSettings } from './hook-link'

const HOME = process.env.TOKEN_METER_HOME ?? join(homedir(), '.claude', 'token-meter')
const SETTINGS = join(homedir(), '.claude', 'settings.json')

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

function main(): void {
  const state = readState(join(HOME, 'state.json'))
  const settings = loadSettings(SETTINGS)
  const dailyLog = dailyPath(join(HOME, 'logs'), new Date())
  const size = existsSync(dailyLog) ? statSync(dailyLog).size : 0

  console.log('=== token-meter status ===')
  console.log(`enabled       : ${state.enabled}`)
  console.log(`logs dir      : ${join(HOME, 'logs')}`)
  console.log(`today log     : ${dailyLog} (${fmtBytes(size)})`)
  console.log(`state path    : ${join(HOME, 'state.json')}`)
  console.log('')
  console.log('--- tool overrides ---')
  for (const [t, v] of Object.entries(state.tools)) console.log(`  ${t.padEnd(30)} ${v}`)
  if (Object.keys(state.tools).length === 0) console.log('  (none)')
  console.log('')
  console.log('--- plugins ---')
  for (const p of COMPRESSION_PLUGINS) {
    console.log(
      `  ${p.name.padEnd(10)} installed=${p.isInstalled()} enabled=${p.isEnabled()}  — ${p.description}`,
    )
  }
  console.log('')
  console.log('--- hooks ---')
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop']) {
    const groups = settings.hooks?.[ev] ?? []
    const linked = groups.some((g) => g.hooks.some((h) => h.command.includes('token-meter')))
    console.log(`  ${ev.padEnd(15)} ${linked ? 'linked' : 'NOT LINKED'}`)
  }
}

main()
```

- [ ] **Step 2: scripts/doctor.ts を実装**

```typescript
#!/usr/bin/env bun
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { COMPRESSION_PLUGINS, commandExists } from '../lib/plugins'
import { tokenize } from '../lib/tokenizer'
import { loadSettings } from './hook-link'

const HOME = process.env.TOKEN_METER_HOME ?? join(homedir(), '.claude', 'token-meter')

type Check = { name: string; ok: boolean; detail: string }

function runChecks(): Check[] {
  const out: Check[] = []
  out.push({ name: 'bun installed', ok: commandExists('bun'), detail: 'bun --version で確認' })
  out.push({ name: 'token-meter home', ok: existsSync(HOME), detail: HOME })
  if (existsSync(HOME)) {
    const mode = (statSync(HOME).mode & 0o777).toString(8)
    out.push({ name: 'home permission 0700', ok: mode === '700', detail: `mode=${mode}` })
  }
  try {
    accessSync(join(HOME, 'logs'), constants.W_OK)
    out.push({ name: 'logs writable', ok: true, detail: '' })
  } catch {
    out.push({ name: 'logs writable', ok: false, detail: '権限不足、または未作成' })
  }
  const tk = tokenize('hello world', 'anthropic')
  out.push({ name: 'tokenizer works', ok: tk.tokens > 0 && !tk.degraded, detail: `tokens=${tk.tokens}` })
  const settings = loadSettings(join(homedir(), '.claude', 'settings.json'))
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop']) {
    const linked = (settings.hooks?.[ev] ?? []).some((g) => g.hooks.some((h) => h.command.includes('token-meter')))
    out.push({ name: `hook ${ev} linked`, ok: linked, detail: linked ? '' : 'make hook-link を実行' })
  }
  for (const p of COMPRESSION_PLUGINS) {
    out.push({ name: `plugin ${p.name} installed`, ok: p.isInstalled(), detail: '' })
  }
  return out
}

function main(): void {
  const checks = runChecks()
  let failed = 0
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
    if (!c.ok) failed++
  }
  console.log('')
  console.log(`${checks.length - failed}/${checks.length} passed`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
```

- [ ] **Step 3: 手動実行で出力を確認**

Run: `cd apps/token-meter && bun run scripts/status.ts`
Expected: status 出力 (一部 NOT LINKED があってよい — まだ hook-link していない)

Run: `cd apps/token-meter && bun run scripts/doctor.ts`
Expected: チェック一覧と最終 pass/total。一部 ✗ があってもクラッシュしないこと。

- [ ] **Step 4: コミット**

```bash
git add apps/token-meter/scripts/status.ts apps/token-meter/scripts/doctor.ts
git commit -m "feat(token-meter): status / doctor スクリプトを追加"
```

---

## Task 11: Makefile

**Files:**
- Create: `apps/token-meter/Makefile`

**Interfaces:**
- Consumes: `scripts/hook-link.ts`, `scripts/status.ts`, `scripts/doctor.ts`
- Produces:
  - `make setup` — deps + install-plugins + hook-link + state-init
  - `make hook-link` / `hook-unlink` / `state-init` / `status` / `doctor` / `test` / `uninstall` / `purge`

- [ ] **Step 1: Makefile を作成**

```makefile
SHELL := /bin/bash
REPO_ROOT := $(shell cd ../.. && pwd)
HOME_DIR := $(HOME)/.claude/token-meter

.DEFAULT_GOAL := help

.PHONY: help
help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

.PHONY: setup
setup: deps install-plugins hook-link state-init ## 1 コマンド完全セットアップ

.PHONY: deps
deps: ## 依存パッケージをインストール
	@cd $(REPO_ROOT) && pnpm install --filter=@tanaka-yui/token-meter

.PHONY: install-plugins
install-plugins: install-rtk install-caveman install-headroom ## 3 圧縮 plugin を全てインストール

.PHONY: install-rtk
install-rtk: ## rtk をインストール
	@command -v rtk >/dev/null || brew install rtk-ai/tap/rtk
	@rtk init -g --hook-only || true

.PHONY: install-caveman
install-caveman: ## caveman skill をインストール
	@test -d $(HOME)/.claude/skills/caveman || \
	  curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash

.PHONY: install-headroom
install-headroom: ## headroom MCP をインストール
	@command -v headroom >/dev/null || pipx install "headroom-ai[all]"
	@headroom mcp install --scope user --skip-existing || true

.PHONY: hook-link
hook-link: ## settings.json に hook を配線
	@bun run scripts/hook-link.ts --bin $(HOME_DIR)/bin

.PHONY: hook-unlink
hook-unlink: ## settings.json から hook を除去
	@bun run scripts/hook-link.ts --remove

.PHONY: state-init
state-init: ## ~/.claude/token-meter ディレクトリと state.json を初期化
	@mkdir -p $(HOME_DIR)/logs
	@chmod 700 $(HOME_DIR)
	@ln -sfn $(PWD)/bin $(HOME_DIR)/bin
	@ln -sfn $(PWD)/lib $(HOME_DIR)/lib
	@ln -sfn $(PWD)/node_modules $(HOME_DIR)/node_modules
	@test -f $(HOME_DIR)/state.json || \
	  echo '{"enabled":true,"tools":{},"plugins":{"rtk":true,"caveman":true,"headroom":true}}' \
	  > $(HOME_DIR)/state.json

.PHONY: status
status: ## 現在の状態を表示
	@bun run scripts/status.ts

.PHONY: doctor
doctor: ## 健全性チェック
	@bun run scripts/doctor.ts

.PHONY: test
test: ## bun test を実行
	@bun test

.PHONY: uninstall
uninstall: hook-unlink ## settings.json から token-meter hook を除去
	@echo "settings.json から token-meter hook を除去しました"

.PHONY: purge
purge: uninstall ## ~/.claude/token-meter を完全削除
	@rm -rf $(HOME_DIR)
```

- [ ] **Step 2: 手動確認**

Run: `cd apps/token-meter && make help`
Expected: ターゲット一覧が表示される

Run: `cd apps/token-meter && make state-init && make status`
Expected: `~/.claude/token-meter/` が作成され、`status` が enabled=true を表示。symlink で `bin` `lib` が貼られる。

- [ ] **Step 3: コミット**

```bash
git add apps/token-meter/Makefile
git commit -m "feat(token-meter): Makefile (setup/hook-link/status/doctor 等) を追加"
```

---

## Task 12: skills/token-measure/SKILL.md

**Files:**
- Create: `apps/token-meter/skills/token-measure/SKILL.md`

**Interfaces:**
- Consumes: `state.json` (Bash 経由で読み書き), JSONL ログ (Bash + jq)
- Produces: `/token-measure on|off|status|list|reset` の挙動を定義したスキル

- [ ] **Step 1: skills/token-measure/SKILL.md を作成**

````markdown
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
````

- [ ] **Step 2: コミット**

```bash
git add apps/token-meter/skills/token-measure/SKILL.md
git commit -m "feat(token-meter): /token-measure スキルを追加"
```

---

## Task 13: skills/token-plugins/SKILL.md

**Files:**
- Create: `apps/token-meter/skills/token-plugins/SKILL.md`

- [ ] **Step 1: skills/token-plugins/SKILL.md を作成**

````markdown
---
name: token-plugins
description: >
  Use when the user invokes `/token-plugins` or asks to list, install, enable,
  or disable a compression plugin (rtk / caveman / headroom). Wraps each
  plugin's enable/disable mechanism behind a unified interface.
---

# token-plugins: 圧縮 plugin の制御

`apps/token-meter/lib/plugins.ts` の `COMPRESSION_PLUGINS` を読み込み、
各 plugin の `enable()` / `disable()` / `isEnabled()` / `isInstalled()` を呼び分ける。

## 引数仕様

| サブコマンド | 動作 |
|---|---|
| `list` | plugin 一覧 + インストール済み / 有効 / 最近 7 日の効果 |
| `on <name>` | `COMPRESSION_PLUGINS.find(p => p.name === <name>).enable()` |
| `off <name>` | 同 `disable()` |
| `install <name>` | `make install-<name>` を呼ぶ |
| `status <name>` | 1 plugin の詳細 (インストール先 / 設定パス / 観測実績) |

## 実装手順

1. `bun -e "import { COMPRESSION_PLUGINS } from '$HOME/.claude/token-meter/lib/plugins.ts'; ..."` で plugin リストを取得。
2. `list` は JSONL から `kind === 'post.rtk'` と `kind === 'post.compress'` を集計して saved_tokens を計算。
3. `on` / `off` は async なので `await p.enable()` する。
4. `install` は `cd $HOME/.claude/token-meter && make install-<name>` を実行。

## 出力形式

spec §6.2 の表形式 (installed/enabled は ✓/✗)。

## 注意

- plugin によっては `enable()` が `.claude.json` を書換えるため Claude Code 再起動が必要 (headroom)。`on`/`off` 実行後はその旨を表示する。
- caveman の session flag パスは将来変わる可能性がある (spec §15)。
````

- [ ] **Step 2: コミット**

```bash
git add apps/token-meter/skills/token-plugins/SKILL.md
git commit -m "feat(token-meter): /token-plugins スキルを追加"
```

---

## Task 14: skills/token-stats/SKILL.md

**Files:**
- Create: `apps/token-meter/skills/token-stats/SKILL.md`

- [ ] **Step 1: skills/token-stats/SKILL.md を作成**

````markdown
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
````

- [ ] **Step 2: コミット**

```bash
git add apps/token-meter/skills/token-stats/SKILL.md
git commit -m "feat(token-meter): /token-stats スキルを追加"
```

---

## Task 15: skills/token-clear/SKILL.md

**Files:**
- Create: `apps/token-meter/skills/token-clear/SKILL.md`

- [ ] **Step 1: skills/token-clear/SKILL.md を作成**

````markdown
---
name: token-clear
description: >
  Use when the user invokes `/token-clear` or asks to delete old token-meter
  JSONL logs by retention period. Confirms before destructive deletion.
---

# token-clear: 履歴削除

`~/.claude/token-meter/logs/` 配下の JSONL を保持期間で削除する。

## 引数仕様

| 引数 | 動作 |
|---|---|
| `--before <N>d` | N 日以上前のファイルを削除 (例: `--before 30d`) |
| `--all` | 全 JSONL を削除 |
| `--dry-run` | 削除候補のみ表示 |

## 実装手順

1. 削除候補ファイル名から日付 (`YYYY-MM-DD.jsonl`) をパースし `--before` と比較。
2. `--dry-run` でない限り、削除前に candidate 一覧と合計サイズを表示しユーザーに確認を求める。
3. 確認後 `rm` で削除。

## 注意

- 削除は **不可逆**。必ず `--dry-run` で候補を確認してから本実行する。
- 同名ファイルが書込中の場合 (現在日付の jsonl) はスキップして警告を出す。
````

- [ ] **Step 2: コミット**

```bash
git add apps/token-meter/skills/token-clear/SKILL.md
git commit -m "feat(token-meter): /token-clear スキルを追加"
```

---

## Task 16: marketplace.json / install.sh / README / CLAUDE.md 統合

**Files:**
- Modify: `.claude-plugin/marketplace.json` (token-meter エントリを追加)
- Modify: `install.sh` (`claude plugin install token-meter@yui-cc-plugins` を追加)
- Create: `apps/token-meter/README.md`
- Create: `apps/token-meter/CLAUDE.md`

**Interfaces:**
- Consumes: 既存 marketplace.json 構造
- Produces: ユーザー向け README、Claude Code 向け CLAUDE.md、リポ全体のインストールフロー統合

- [ ] **Step 1: marketplace.json に token-meter エントリを追加**

`.claude-plugin/marketplace.json` の `plugins` 配列末尾 (e2e-test の次) に以下を追加:

```json
    {
      "name": "token-meter",
      "description": "Claude Code の hook 経由で圧縮プラグイン (rtk/caveman/headroom) の効きを観測・記録する計測機構",
      "source": "./apps/token-meter",
      "version": "0.1.0",
      "license": "MIT",
      "category": "observability",
      "tags": [
        "claude-code",
        "hook",
        "token",
        "compression",
        "measurement"
      ]
    }
```

- [ ] **Step 2: install.sh に 1 行追加**

`install.sh` の e2e-test の次に:

```bash
claude plugin install token-meter@yui-cc-plugins
```

- [ ] **Step 3: apps/token-meter/README.md を作成**

```markdown
# token-meter

Claude Code の hook 経由で 3 つの圧縮プラグイン (rtk / caveman / headroom) の効きを観測し、
JSONL に記録・集計するための計測機構プラグイン。

## できること

- 3 圧縮プラグインを **並行有効化** したまま、各プラグインの効きを定量的に観測
- tool 別 ON/OFF / plugin 別 ON/OFF を切り替えて A/B 比較
- 当日累計、tool 別 / plugin 別の token ボリュームと圧縮効果を表示
- 設定ファイル 1 つ追加で観測対象 plugin を拡張可能

## セットアップ

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins
git pull
cd apps/token-meter
make setup
# Claude Code を再起動
```

`make setup` は以下を行います:
- pnpm install (workspace 依存)
- rtk / caveman / headroom のインストール (未導入の場合のみ)
- `~/.claude/settings.json` に hook を安全に append (既存 hook と共存、バックアップあり)
- `~/.claude/token-meter/` の作成と state.json 初期化

## 使い方

| コマンド | 役割 |
|---|---|
| `/token-measure list` | tool 別観測実績一覧 |
| `/token-measure on\|off [tool]` | 計測機構全体 / tool 別 ON/OFF |
| `/token-plugins list` | 圧縮 plugin 一覧と効果 |
| `/token-plugins on\|off <name>` | plugin の ON/OFF |
| `/token-stats --since 7d` | 期間集計レポート |
| `/token-clear --before 30d` | 古いログを削除 |
| `make status` | 現在の状態 (CLI) |
| `make doctor` | 健全性チェック |

## アンインストール

```bash
make uninstall   # settings.json から hook を除去 (ログは残る)
make purge       # ~/.claude/token-meter/ を完全削除
```

## ログ形式

`~/.claude/token-meter/logs/YYYY-MM-DD.jsonl` に 1 イベント 1 行で追記。
スキーマは `lib/types.ts` の `LogRecord` を参照。

```jsonl
{"kind":"pre","ts":"...","session":"a1b2","tool":"Read","input_tokens":18,"input_bytes":54}
{"kind":"post.compress","ts":"...","session":"a1b2","tool":"mcp__headroom__compress","label":"headroom","input_tokens":4521,"output_tokens":612,"ratio":0.135}
```

## ライセンス

MIT
```

- [ ] **Step 4: apps/token-meter/CLAUDE.md を作成**

````markdown
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

- ドキュメント・コメント・コミットメッセージ・README: 日本語
- コード (変数名・関数名・CLI フラグ): 英語
- `any` / `unknown` 禁止 (narrowing 経由のみ)
- `class` 禁止 (Error 拡張除く)
- biome 2.4.9 (single quote, no semi, 120 col)
````

- [ ] **Step 5: check / test を実行**

Run: `cd /Users/yui/Documents/workspace/tanaka-yui/yui-cc-plugins && pnpm check`
Expected: token-meter を含む全 app で tsc + biome PASS

Run: `cd apps/token-meter && bun test`
Expected: 全テスト PASS

- [ ] **Step 6: コミット**

```bash
git add .claude-plugin/marketplace.json install.sh \
  apps/token-meter/README.md apps/token-meter/CLAUDE.md
git commit -m "feat(token-meter): marketplace 登録と README / CLAUDE.md を追加"
```

---

## Self-Review チェック結果

**Spec coverage:**
- §2 アーキテクチャ図 → Tasks 1-8 ですべて実装される
- §3 データフロー → Task 7 (handler) で網羅
- §4 設定駆動 (targets / plugins / state / shouldMeasure) → Tasks 4, 5, 6 でカバー
- §5 JSONL スキーマ → Task 1 (types.ts) + Task 7 (handler) でカバー
- §6 スキル一覧 → Tasks 12, 13, 14, 15
- §7 プロジェクト構造 → 全タスク合計で完成
- §8 Makefile → Task 11
- §9 エラー処理ポリシー → Task 8 (hook shim の `catch + exit 0`)
- §10 パフォーマンス目標 → `tokenize` の 256KB サンプリング (Task 2) と OFF 時即 return (Task 4)
- §11 セキュリティ → `mode 0o700/0o600` (Tasks 3, 4), 生コンテンツ非保存 (Task 7)
- §12 テスト戦略 → 各 Task のテスト + Task 8 の integration
- §13 リスク → backup + 冪等 (Task 9), atomic write (Tasks 4, 6, 9), fail open (Task 8)
- §14 将来拡張 → 設定ファイル駆動の構造で自然に拡張可能
- §15 オープン項目 → CLAUDE.md に明記、実装はデフォルト動作で妥協

**Type consistency:** Task 1 で定義した `LogRecord` の各 kind と Task 7 の `handlePost` 内で生成する record の field が一致。`CompressionPlugin.enable` の async 戻り値型 (Promise<void>) が Tasks 6, 13 で一貫。

**Placeholder scan:** "TBD" / "implement later" / "add appropriate error handling" など spec の薄い指示が残っていないか確認済み。全 step に code block または exact command を記載。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-18-token-meter.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 各 task を新規 subagent に渡し、between-task review で品質チェック。`subagent-driven-development` を呼ぶ。

**2. Inline Execution** - 本セッション内で `executing-plans` を使い、checkpoint で確認しながら順次実装。

どちらで進めますか？
