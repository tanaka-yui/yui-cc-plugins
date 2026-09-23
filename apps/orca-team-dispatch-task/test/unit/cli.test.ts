import { parseFlags } from '../../lib/cli.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const CLI_TS = new URL('../../lib/cli.ts', import.meta.url).href

// die は process.exit するので、別の node で走らせて終了コードと stderr を見る
const evaluate = (code: string) => {
  const script = `import { die, log, parseFlags } from '${CLI_TS}'; ${code}`
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
}

test('parseFlags は繰り返しのフラグを配列で返す', () => {
  const { values } = parseFlags('t', {
    args: ['--status-dir', 'a', '--status-dir', 'b'],
    options: { 'status-dir': { type: 'string', multiple: true } },
    strict: true,
  })
  assert.deepEqual(values['status-dir'], ['a', 'b'])
})

test('解析できない引数は exit 2 で、名前つきの 1 行を stderr に出す', () => {
  const child = evaluate(`parseFlags('orca-cleanup', { args: ['--bogus'], options: {}, strict: true })`)
  assert.equal(child.status, 2)
  assert.match(child.stderr, /^orca-cleanup: .*--bogus/m)
  assert.equal(child.stdout, '')
})

test('log は <name>: <message> を stderr に出し、die は exit 2', () => {
  const child = evaluate(`log('orca-cleanup', 'hello'); die('orca-cleanup', 'bye')`)
  assert.equal(child.status, 2)
  assert.match(child.stderr, /^orca-cleanup: hello\norca-cleanup: bye\n$/m)
})
