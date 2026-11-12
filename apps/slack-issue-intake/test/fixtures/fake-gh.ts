import { asArray, asObject, asString, get, parseJson } from '../../lib/json.ts'

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

import type { JsonObject } from '../../lib/json.ts'

const args = process.argv.slice(2)
const value = (flag: string): string => args[args.indexOf(flag) + 1] ?? ''
const cmd = args.slice(0, 2).join(' ')
const log = process.env.FAKE_GH_LOG ?? ''
const state = process.env.FAKE_GH_STATE ?? ''
const body = args.includes('--body-file') ? readFileSync(value('--body-file'), 'utf8') : null
appendFileSync(log, `${JSON.stringify({ argv: args, body, pid: process.pid })}\n`)
if (
  process.env.FAKE_GH_SLEEP_MS &&
  (!process.env.FAKE_GH_SLEEP_ON || args.join(' ').startsWith(process.env.FAKE_GH_SLEEP_ON))
)
  await setTimeout(Number(process.env.FAKE_GH_SLEEP_MS))
const login = process.env.FAKE_GH_LOGIN ?? 'intake-bot'
const fail = (): never => {
  console.error('失敗 xoxb-123-secret')
  process.exit(1)
}
const output = (value: object): void => console.log(JSON.stringify(value))
const issues = (): JsonObject[] => {
  try {
    return (asArray(parseJson(readFileSync(state, 'utf8'))) ?? []).flatMap((v) => {
      const o = asObject(v)
      return o ? [o] : []
    })
  } catch {
    return []
  }
}
if (cmd === 'auth status') {
  if (process.env.FAKE_GH_AUTH === 'fail') fail()
} else if (args[0] === 'api' && args[1] === 'user') output({ login })
else if (cmd === 'repo view') {
  if (process.env.FAKE_GH_REPO === 'missing') fail()
  output({
    visibility: process.env.FAKE_GH_VISIBILITY ?? 'PRIVATE',
    viewerPermission: process.env.FAKE_GH_PERMISSION ?? 'WRITE',
    hasIssuesEnabled: process.env.FAKE_GH_HAS_ISSUES !== 'false',
  })
} else if (cmd === 'label list')
  output(
    (process.env.FAKE_GH_LABELS ?? '')
      .split(',')
      .filter(Boolean)
      .map((name) => ({ name })),
  )
else if (cmd === 'label create') {
  if (process.env.FAKE_GH_LABEL_CREATE === 'fail') fail()
} else if (cmd === 'issue create') {
  if (process.env.FAKE_GH_CREATE === 'fail') fail()
  // 本物の gh は、リポジトリに無いラベルを付けると作成に失敗する（名前は大文字小文字を区別しない）
  const known = process.env.FAKE_GH_KNOWN_LABELS?.split(',').map((l) => l.toLowerCase())
  if (known && args.some((a, i) => a === '--label' && !known.includes((args[i + 1] ?? '').toLowerCase()))) fail()
  const all = issues()
  const number = all.length
    ? Math.max(...all.map((i) => Number(i.number))) + 1
    : Number(process.env.FAKE_GH_ISSUE_NUMBER ?? 42)
  const html_url = `https://github.com/${value('--repo')}/issues/${number}`
  all.push({
    number,
    html_url,
    body,
    created_at: new Date().toISOString(),
    user: { login },
    labels: args.flatMap((a, i) => (a === '--label' ? [{ name: args[i + 1] ?? '' }] : [])),
  })
  writeFileSync(state, JSON.stringify(all))
  if (process.env.FAKE_GH_CREATE === 'lost') fail()
  console.log(html_url)
} else if (args[0] === 'api' && args[1]?.startsWith('repos/')) {
  if (process.env.FAKE_GH_API_FAIL_PATH && args[1].includes(process.env.FAKE_GH_API_FAIL_PATH)) fail()
  const [path = '', query] = args[1].split('?')
  const params = new URLSearchParams(query)
  const page = Number(params.get('page'))
  if (page === Number(process.env.FAKE_GH_API_FAIL_PAGE)) fail()
  const per = Number(params.get('per_page'))
  const since = params.get('since')
  const after = (iso: string): boolean => !since || Date.parse(iso) >= Date.parse(since)
  // Issue のコメント（GitHub は id の昇順で返し、since は更新日時で絞る）
  const comments = path.match(/\/issues\/(\d+)\/comments$/)
  if (comments) {
    const issue = issues().find((i) => i.number === Number(comments[1]))
    const list = (asArray(issue?.comments) ?? [])
      .flatMap((c) => {
        const o = asObject(c)
        return o ? [o] : []
      })
      .filter((c) => after(String(c.updated_at ?? c.created_at)))
      .sort((a, b) => Number(a.id) - Number(b.id))
    output(list.slice((page - 1) * per, page * per))
  } else {
    const label = params.get('labels')
    const byUpdated = params.get('sort') === 'updated'
    const key = byUpdated ? 'updated_at' : 'created_at'
    const all = issues()
      .filter((i) => (asArray(i.labels) ?? []).some((l) => asString(get(l, 'name')) === label))
      .filter((i) => !byUpdated || after(String(i.updated_at)))
      .sort((a, b) => String(b[key]).localeCompare(String(a[key])))
    if (params.get('direction') === 'asc') all.reverse()
    output(all.slice((page - 1) * per, page * per))
  }
} else fail()
