import {
  downloadFiles,
  fileRefsFromMessage,
  permalinkFileIds,
  resolveFiles,
  safeFileName,
} from '../../lib/attachments.ts'
import { createSlackClient } from '../../lib/slack-api.ts'
import { startSlack, tempHome } from '../helpers.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { FileRef } from '../../lib/types.ts'

test('AT1 files配列の削除済み・非表示ファイルを除く', () =>
  assert.deepEqual(
    fileRefsFromMessage({
      files: [
        { id: 'F1', name: 'a', url_private_download: 'https://files.slack.com/a' },
        { id: 'F2', mode: 'tombstone' },
        { id: 'F3', mode: 'hidden_by_limit' },
      ],
    }).map((f) => [f.id, f.downloadUrl]),
    [['F1', 'https://files.slack.com/a']],
  ))
test('AT2 本文のpermalinkからファイルIDを抽出', () =>
  assert.deepEqual(
    permalinkFileIds({ text: '見て <https://acme.slack.com/files/U012AB3CD/F0ABCDEF1/shot.png|shot.png>' }),
    ['F0ABCDEF1'],
  ))
test('AT3 files.infoと合流して重複を除き10件まで', async (t) => {
  const server = await startSlack((r) => ({
    json: { ok: true, file: { id: r.params.file ?? '', name: 'a', size: 2 } },
  }))
  t.after(() => server.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = server.url
  const c = createSlackClient('xoxb-t')
  const refs = await resolveFiles(
    c,
    {
      files: [{ id: 'F1' }, { id: 'F2' }],
      text: 'https://acme.slack.com/files/U1/F1/a https://acme.slack.com/files/U1/F3/a',
    },
    Date.now() + 5000,
  )
  assert.ok(refs.ok)
  assert.deepEqual(
    refs.files.map((f) => f.id),
    ['F1', 'F2', 'F3'],
  )
  assert.equal(server.requests.length, 1)
  const limited = await resolveFiles(
    c,
    { files: Array.from({ length: 12 }, (_, i) => ({ id: `F${i}` })) },
    Date.now() + 5000,
  )
  assert.ok(limited.ok)
  assert.equal(limited.files.length, 10)
})
test('AT4 保存名はパストラバーサルと隠しファイルを防ぐ', () => {
  assert.equal(safeFileName(1, '../../etc/passwd'), '1-passwd')
  assert.equal(safeFileName(2, '.hidden'), '2-hidden')
  assert.equal(safeFileName(3, 'スクショ.png'), '3-____.png')
})
test('AT5 許された形式とサイズだけ保存し、失敗理由を残す', async (t) => {
  const server = await startSlack((r) =>
    r.path.endsWith('missing') ? { status: 404 } : { bytes: new Uint8Array([1, 2, 3]) },
  )
  t.after(() => server.close())
  process.env.SLACK_ISSUE_INTAKE_API_BASE = server.url
  const base: FileRef = {
    id: 'F1',
    name: 'a.png',
    mimetype: 'image/png',
    size: 3,
    permalink: 'https://acme.slack.com/f',
    downloadUrl: `${server.url}/f`,
  }
  const dir = tempHome()
  const r = await downloadFiles(
    createSlackClient('xoxb-t'),
    [
      base,
      { ...base, mimetype: 'video/mp4' },
      { ...base, size: 6000000 },
      { ...base, downloadUrl: `${server.url}/missing` },
    ],
    dir,
    1,
    Date.now() + 5000,
  )
  assert.equal(r[0]?.localPath, `${dir}/1-a.png`)
  assert.deepEqual([...readFileSync(r[0]?.localPath ?? '')], [1, 2, 3])
  assert.deepEqual(
    r.map((f) => f.note),
    [null, 'not downloaded: type', 'not downloaded: too large', 'not downloaded: error'],
  )
  assert.equal(server.requests.length, 2)
})
