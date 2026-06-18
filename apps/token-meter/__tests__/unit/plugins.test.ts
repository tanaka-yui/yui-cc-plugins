import { COMPRESSION_PLUGINS, commandExists, mcpStatus, mcpToggle, readGate, writeGate } from '../../lib/plugins'

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
