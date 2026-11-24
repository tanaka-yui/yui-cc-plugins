import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_ORCA_LOG ?? '', `${JSON.stringify(args)}\n`)
const fail = (s: string): never => {
  console.error(s)
  process.exit(1)
}
let result: object = {}
if (args[0] === 'repo') result = args[1] === 'add' ? { repo: { id: 'folder-1' } } : { repos: [] }
else if (args[0] === 'automations') {
  if (args[1] === 'create') {
    if (process.env.FAKE_ORCA_CREATE === 'fail') fail('作成失敗')
    result = { automation: { id: 'auto-1' } }
  } else if (args[1] === 'edit') {
    if (process.env.FAKE_ORCA_EDIT) fail('編集失敗')
    // 本物の Orca は --json の失敗を stdout の JSON で返し、stderr には書かない
    if (args[2] !== 'auto-1') {
      console.log(JSON.stringify({ ok: false, error: { code: 'runtime_error', message: 'Automation not found.' } }))
      process.exit(1)
    }
    result = { automation: { id: args[2] } }
  } else if (args[1] === 'list')
    result = { automations: process.env.FAKE_ORCA_EDIT === 'gone' ? [] : [{ id: 'auto-1' }] }
  else if (args[1] === 'runs') {
    if (process.env.FAKE_ORCA_RUNS === 'fail') fail('履歴失敗')
    result = { runs: JSON.parse(process.env.FAKE_ORCA_RUNS ?? '[]') }
  } else fail('未対応の操作')
} else if (args[0] === 'terminal') {
  if (args[1] === 'list') result = { terminals: JSON.parse(process.env.FAKE_ORCA_TERMINALS ?? '[]') }
  else if (args[1] === 'close') {
    if (process.env.FAKE_ORCA_CLOSE === 'fail') fail('閉じられない')
    result = { closed: true }
  } else fail('未対応の操作')
} else fail('未対応の操作')
console.log(JSON.stringify({ ok: true, result }))
