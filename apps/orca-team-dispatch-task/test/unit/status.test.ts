import { ISSUE_EXCLUDED_LABELS, STATUS_LABELS, searchExclusion } from '../../lib/status.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('STATUS_LABELS の名前と並び（2 つ付いたときの優先順）', () => {
  assert.deepEqual(
    STATUS_LABELS.map((l) => l.name),
    ['Done', 'Testing', 'Failed', 'In review', 'Ready_Eng', 'In progress', 'Pending', 'Ready', 'Backlog'],
  )
})
test('ISSUE_EXCLUDED_LABELS は Ready 以外の 8 つと古い dispatch の 3 つ', () => {
  assert.equal(ISSUE_EXCLUDED_LABELS.length, 11)
  assert.ok(ISSUE_EXCLUDED_LABELS.includes('Testing'))
  assert.ok(!ISSUE_EXCLUDED_LABELS.includes('Ready'))
  assert.ok(ISSUE_EXCLUDED_LABELS.includes('dispatch/failed'))
  assert.ok(ISSUE_EXCLUDED_LABELS.includes('In progress'))
})
test('searchExclusion は空白を含む名前を引用符で囲む', () => {
  assert.equal(searchExclusion(['In progress', 'dispatch/done']), '-label:"In progress" -label:"dispatch/done"')
})
