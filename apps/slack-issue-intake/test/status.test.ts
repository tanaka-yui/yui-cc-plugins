import { getMeta, getSubmission, listByStates, openDb } from '../lib/db.ts'
import { writeJson } from '../lib/fs.ts'
import { readLease } from '../lib/lease.ts'
import { homePaths } from '../lib/paths.ts'
import { NOW, richTextMessage, templateText, textMessage, tsAt } from './fixtures/slack-messages.ts'
import { fakeGh, runCliAsync, seedSubmission, setupHome, startSlack, tempHome } from './helpers.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const setup = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const home = tempHome()
  const gh = fakeGh(tempHome())
  const server = await startSlack(() => ({
    json: {
      ok: true,
      messages: [
        richTextMessage(
          tsAt(1000),
          [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: templateText().split('<@U012AB3CD>')[0] ?? '' },
                { type: 'user', user_id: 'U012AB3CD' },
                { type: 'text', text: templateText().split('<@U012AB3CD>')[1] ?? '' },
              ],
            },
          ],
          { files: [{ id: 'F1' }, { id: 'F2' }] },
        ),
        textMessage(tsAt(900), templateText({ category: 'その他' })),
        textMessage(tsAt(800), '雑談'),
      ],
    },
  }))
  t.after(() => server.close())
  const env = { ...gh.env, ...(await setupHome(home, { apiBase: server.url, ghPath: gh.ghPath, ghState: gh.state })) }
  return { home, env, server, cli: (args: string[]) => runCliAsync(args, env) }
}
test('SS1 状態・権限・リース・pollの結果を秘密なしで表示', async (t) => {
  const f = await setup(t)
  await seedSubmission(f.home, { ts: tsAt(1000), state: 'waiting', rounds: 1, askedAt: NOW })
  await seedSubmission(f.home, {
    ts: tsAt(900),
    state: 'creating',
    inflight: { owner: { pid: 123, start: 's' }, child: null, at: NOW, deadConfirmedAt: null },
    lastError: 'create in flight',
  })
  await seedSubmission(f.home, {
    ts: tsAt(800),
    state: 'failed',
    failedFrom: 'creating',
    lastError: 'error xoxb-123-secret',
  })
  writeJson(homePaths(f.home).pollStatus, { at: NOW, result: 'work', agentWork: 1, partial: true, errors: ['err'] })
  const r = await f.cli(['status'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /permissions=accepted/)
  assert.match(r.stdout, /creating id=2 inflight=123 error=create in flight/)
  assert.match(r.stdout, /last_poll=.*result=work agent_work=1 partial=true errors=1/)
  assert.ok(!r.stdout.includes('secret'))
  writeJson(homePaths(f.home).projectLocalSettings, {})
  assert.match((await f.cli(['status'])).stdout, /permissions=unsafe/)
})
test('SS2 retryは作成記録と印を保持して直前の状態へ戻す', async (t) => {
  const f = await setup(t)
  const record = { owner: { pid: 123, start: 's' }, child: null, at: NOW, deadConfirmedAt: null }
  const id = await seedSubmission(f.home, {
    ts: tsAt(1000),
    state: 'failed',
    failedFrom: 'creating',
    attempts: 10,
    createStartedAt: NOW,
    createLogin: 'intake-bot',
    inflight: record,
  })
  assert.equal((await f.cli(['retry', '--id', String(id), '--now', NOW])).code, 0)
  const db = openDb(homePaths(f.home).db)
  const s = getSubmission(db, id)
  assert.equal(s?.state, 'creating')
  assert.equal(s?.attempts, 0)
  assert.equal(s?.createStartedAt, NOW)
  assert.equal(s?.createLogin, 'intake-bot')
  assert.deepEqual(s?.inflight, record)
  db.close()
  assert.equal((await f.cli(['retry', '--id', String(id), '--now', NOW])).code, 1)
})
test('IS1 inspectはblocks・text・不備を見せ、DB・cursor・リースを変更しない', async (t) => {
  const f = await setup(t)
  const db = openDb(homePaths(f.home).db)
  const before = getMeta(db, 'cursor_ts')
  db.close()
  const r = await f.cli(['inspect', '--raw'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /marker=yes source=blocks .*files=2 .*parse=ok .*reporter=U012AB3CD/)
  assert.match(r.stdout, /parse=invalid .*problems=カテゴリが/)
  assert.match(r.stdout, /marker=no .*parse=-/)
  const after = openDb(homePaths(f.home).db)
  assert.equal(getMeta(after, 'cursor_ts'), before)
  assert.equal(readLease(after), null)
  assert.equal(listByStates(after, ['new']).length, 0)
  after.close()
})
