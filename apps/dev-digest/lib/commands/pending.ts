import { die, parseFlags, parseNow } from '../cli.ts'
import { loadConfig, loadRepos } from '../config.ts'
import { latestRun, openDb } from '../db.ts'
import { digestHome, homePaths } from '../paths.ts'
import { buildPending } from '../pending.ts'

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'dev-digest pending'
const DIR_MODE = 0o700

export const run = (argv: string[]): void => {
  const { values } = parseFlags(NAME, { args: argv, options: { now: { type: 'string' } } })
  const now = parseNow(NAME, values.now)
  const home = digestHome()
  const config = loadConfig(home) ?? die(NAME, '設定がありません。init を先に実行してください')
  const repos = loadRepos(home)
  const paths = homePaths(home)
  mkdirSync(home, { recursive: true, mode: DIR_MODE })
  const db = openDb(paths.db)
  try {
    const latest = latestRun(db) ?? die(NAME, '実行記録がありません。collect を先に実行してください')
    const pending = buildPending(db, config, repos, latest.runId, now)
    mkdirSync(paths.runDir, { recursive: true, mode: DIR_MODE })
    const file = join(paths.runDir, 'pending.json')
    // 一時ファイルに書いてから rename する（途中で切れた pending.json を残さない）
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(pending, null, 2)}\n`)
    renameSync(temp, file)
    process.stdout.write(`file=${file}\nitems=${pending.items.length}\nrepos=${pending.repos.length}\n`)
  } finally {
    db.close()
  }
}
