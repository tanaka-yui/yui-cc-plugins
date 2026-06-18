#!/usr/bin/env bun

import { COMPRESSION_PLUGINS, commandExists } from '../lib/plugins'
import { tokenize } from '../lib/tokenizer'
import { loadSettings } from './hook-link'

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
