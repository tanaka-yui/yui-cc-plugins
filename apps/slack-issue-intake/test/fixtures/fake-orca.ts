import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_ORCA_LOG ?? '', JSON.stringify(args) + '\n')
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
    result = { automation: { id: args[2] } }
  } else if (args[1] === 'list')
    result = { automations: process.env.FAKE_ORCA_EDIT === 'gone' ? [] : [{ id: 'auto-1' }] }
  else fail('未対応の操作')
} else fail('未対応の操作')
console.log(JSON.stringify({ ok: true, result }))
