import { notificationScript, notifyAwaitingUser, roleLabel } from '../../lib/notify.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('roleLabel は .dispatch/<slug>/roles/<role> から slug と役を取る', () => {
  assert.deepEqual(roleLabel('/repo/.dispatch/select-unify/roles/design'), { slug: 'select-unify', role: 'design' })
})

test('roleLabel は形が違えば最後の 2 つの名前を使う', () => {
  assert.deepEqual(roleLabel('/tmp/a/b'), { slug: 'a', role: 'b' })
})

test('notificationScript は " と \\ を逃がし、改行を空白にする', () => {
  assert.equal(
    notificationScript('Orca: "x"', 'a\\b\nc'),
    'display notification "a\\\\b c" with title "Orca: \\"x\\"" sound name "Glass"',
  )
})

test('notifyAwaitingUser は ORCA_DISPATCH_NOTIFY=0 なら出さない', () => {
  assert.equal(notifyAwaitingUser('/repo/.dispatch/s/roles/design', { ORCA_DISPATCH_NOTIFY: '0' }), false)
})
