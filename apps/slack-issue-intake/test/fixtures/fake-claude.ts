// claude -p の代わり。引数と cwd を記録し、FAKE_CLAUDE_RESULT（無ければ空の索引）を --output-format json の形で返す
import { appendFileSync } from 'node:fs'

const log = process.env.FAKE_CLAUDE_LOG ?? ''
if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`)
if (process.env.FAKE_CLAUDE_FAIL) process.exit(1)
const result = process.env.FAKE_CLAUDE_RESULT ?? JSON.stringify({ overview: '', topics: [], glossary: [], docs: [] })
console.log(JSON.stringify({ type: 'result', is_error: false, result: `索引です\n${result}` }))
