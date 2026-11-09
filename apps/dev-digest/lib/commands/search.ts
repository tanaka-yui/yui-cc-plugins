import { die, parseFlags } from '../cli.ts'
import { loadConfig, loadRepos, SECTIONS, type Section } from '../config.ts'
import { openDb, type SearchQuery, search } from '../db.ts'
import { digestHome, homePaths } from '../paths.ts'
import { sectionByStoreAs } from '../pending.ts'
import { parseSeverity } from '../severity.ts'

import { existsSync } from 'node:fs'

const NAME = 'dev-digest search'
const DEFAULT_LIMIT = 50
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

// timezone における utcMs の UTC からの差（ms）
const offsetMs = (utcMs: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs))
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return local - Math.floor(utcMs / 1000) * 1000
}

// timezone の現地 00:00 に当たる UTC の時刻（夏時間の切り替えでも 2 回の補正で収まる）
const localMidnightMs = (year: number, month: number, day: number, timeZone: string): number => {
  const guess = Date.UTC(year, month - 1, day)
  const first = guess - offsetMs(guess, timeZone)
  return guess - offsetMs(first, timeZone)
}

// since は現地の 00:00、until は翌日の現地 00:00 の 1 ms 前
const parseDay = (flag: string, value: string, timeZone: string, end: boolean): string => {
  const match = DATE_PATTERN.exec(value)
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (match === null || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day)
    return die(NAME, `${flag} は YYYY-MM-DD で指定してください: ${value}`)
  if (!end) return new Date(localMidnightMs(year, month, day, timeZone)).toISOString()
  // Date.UTC は日の繰り上がりを正規化する
  return new Date(localMidnightMs(year, month, day + 1, timeZone) - 1).toISOString()
}

export const run = (argv: string[]): void => {
  const { values } = parseFlags(NAME, {
    args: argv,
    options: {
      q: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      section: { type: 'string' },
      repo: { type: 'string' },
      'min-severity': { type: 'string' },
      limit: { type: 'string' },
    },
  })
  const home = digestHome()
  const config = loadConfig(home) ?? die(NAME, '設定がありません。init を先に実行してください')
  const timeZone = config.schedule.timezone

  const sections: Section[] = []
  for (const name of (values.section ?? '').split(',').filter((s) => s !== '')) {
    const section = SECTIONS.find((s) => s === name.trim())
    if (section === undefined) die(NAME, `--section は ${SECTIONS.join('|')} の csv にしてください: ${name}`)
    else sections.push(section)
  }
  const minSeverity = values['min-severity'] === undefined ? null : parseSeverity(values['min-severity'])
  if (values['min-severity'] !== undefined && minSeverity === null)
    die(NAME, '--min-severity は low|medium|high|critical にしてください')
  const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit)
  if (!Number.isInteger(limit) || limit < 1) die(NAME, '--limit は 1 以上の整数にしてください')

  let since: string | null = null
  let until: string | null = null
  try {
    since = values.since === undefined ? null : parseDay('--since', values.since, timeZone, false)
    until = values.until === undefined ? null : parseDay('--until', values.until, timeZone, true)
  } catch (error) {
    die(NAME, `timezone を解釈できません: ${error instanceof Error ? error.message : String(error)}`)
  }

  const query: SearchQuery = {
    text: values.q ?? null,
    since,
    until,
    sections,
    repo: values.repo ?? null,
    minSeverity,
    limit,
  }
  const paths = homePaths(home)
  // DB が無ければ空の履歴として扱い、検索のために作らない
  if (!existsSync(paths.db)) {
    process.stdout.write('[]\n')
    return
  }
  const db = openDb(paths.db)
  try {
    const hits = search(db, query, sectionByStoreAs(config, loadRepos(home)))
    process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`)
  } finally {
    db.close()
  }
}
