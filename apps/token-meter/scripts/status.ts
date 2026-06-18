#!/usr/bin/env bun

import { readState } from '../lib/config'
import { dailyPath } from '../lib/logger'
import { COMPRESSION_PLUGINS } from '../lib/plugins'
import { loadSettings } from './hook-link'

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
    console.log(`  ${p.name.padEnd(10)} installed=${p.isInstalled()} enabled=${p.isEnabled()}  — ${p.description}`)
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
