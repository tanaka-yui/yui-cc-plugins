import { addHooks, loadSettings, removeHooks, type SettingsJson } from '../../scripts/hook-link'

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    const count = (b.hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .filter((h) => h.command.includes('hook-pre-tool-use')).length
    expect(count).toBe(1)
  })

  test('loadSettings: 不正 JSON のファイルでは {} を返す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-hl-'))
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{not json')
    expect(loadSettings(path)).toEqual({})
    rmSync(dir, { recursive: true })
  })

  test('removeHooks: token-meter エントリのみ除去', () => {
    const a = addHooks({}, BIN)
    const withRtk: SettingsJson = {
      hooks: {
        ...a.hooks,
        PreToolUse: [
          ...(a.hooks?.PreToolUse ?? []),
          { matcher: '', hooks: [{ type: 'command', command: 'rtk-hook' }] },
        ],
      },
    }
    const b = removeHooks(withRtk)
    const remaining = (b.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks).map((h) => h.command)
    expect(remaining).toContain('rtk-hook')
    expect(remaining.some((c) => c.includes('hook-pre-tool-use'))).toBe(false)
  })
})
