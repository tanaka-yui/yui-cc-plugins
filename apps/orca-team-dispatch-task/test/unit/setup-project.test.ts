import { ensureStatusLabels } from '../../lib/auto-github.ts'
import {
  addStatusOptions,
  ghHasProjectScope,
  missingStatusOptions,
  PROJECT_STATUS_COLORS,
  readStatusOptions,
} from '../../lib/setup-project.ts'
import { STATUS_LABELS } from '../../lib/status.ts'
import { fixture } from '../lib/auto-fixture.ts'

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const current = {
  fieldId: 'F',
  options: [
    { id: 'opt-todo', name: 'Todo', color: 'GRAY', description: '未着手' },
    { id: 'p', name: 'in progress', color: 'BLUE', description: '' },
    { id: 'd', name: 'Done', color: 'GREEN', description: '' },
  ],
}
test('SU10 project scope belongs to the active successful account', () => {
  const f = fixture()
  try {
    for (const [scopes, state, want] of [
      ['gist, project, repo', 'success', true],
      ['gist, repo', 'success', false],
      ['project', 'error', null],
    ] as const) {
      f.respond('auth_status', {
        hosts: {
          'github.com': [
            { active: false, state: 'success', scopes: 'project' },
            { active: true, state, scopes },
          ],
        },
      })
      assert.equal(ghHasProjectScope(), want)
    }
    writeFileSync(join(f.gh, 'auth_status.rc'), '1')
    assert.equal(ghHasProjectScope(), null)
  } finally {
    f.cleanup()
  }
})
test('SU11 Status field parsing and errors', () => {
  const f = fixture()
  try {
    const ref = { owner: 'acme', number: 3 }
    f.respond('api_graphql', {
      data: {
        repositoryOwner: {
          projectV2: {
            field: { __typename: 'ProjectV2SingleSelectField', id: current.fieldId, options: current.options },
          },
        },
      },
    })
    assert.deepEqual(readStatusOptions(ref), current)
    for (const repositoryOwner of [
      null,
      { projectV2: null },
      { projectV2: { field: { __typename: 'ProjectV2TextField' } } },
    ]) {
      f.respond('api_graphql', { data: { repositoryOwner } })
      assert.ok('error' in readStatusOptions(ref))
    }
    f.hook('api_graphql', 'echo INSUFFICIENT_SCOPES >&2')
    writeFileSync(join(f.gh, 'api_graphql.rc'), '1')
    const result = readStatusOptions(ref)
    assert.ok('error' in result)
    assert.match(result.error, /gh auth refresh -h github.com -s project/)
  } finally {
    f.cleanup()
  }
})
test('SU12 missing Status options compare case insensitively', () => {
  assert.deepEqual(missingStatusOptions(current), [
    'Testing',
    'Failed',
    'In review',
    'Ready_Eng',
    'Pending',
    'Ready',
    'Backlog',
  ])
})
test('SU13 preserves existing options and verifies the mutation response', () => {
  const f = fixture()
  try {
    const missing = missingStatusOptions(current)
    f.hook('api_graphql', `printf '%s\\037' "$@" > "$GH_STUB_DIR/graphql.args"`)
    f.respond('api_graphql', {
      data: {
        updateProjectV2Field: {
          projectV2Field: { options: [...current.options, ...missing.map((name) => ({ name }))] },
        },
      },
    })
    assert.equal(addStatusOptions(current, missing), true)
    const args = readFileSync(join(f.gh, 'graphql.args'), 'utf8')
    assert.ok(
      args.indexOf('{id:"opt-todo",name:"Todo",color:GRAY,description:"未着手"}') < args.indexOf('{name:"Failed"'),
    )
    assert.ok(args.includes('{name:"Failed",color:RED,description:"AI が失敗した"}'))
    f.respond('api_graphql', { data: { updateProjectV2Field: { projectV2Field: { options: current.options } } } })
    assert.equal(addStatusOptions(current, missing), false)
    writeFileSync(join(f.gh, 'api_graphql.rc'), '1')
    assert.equal(addStatusOptions(current, missing), false)
    assert.equal(
      addStatusOptions(
        { ...current, options: [{ ...current.options[0], id: 'x', name: 'Todo', color: 'INVALID', description: '' }] },
        missing,
      ),
      false,
    )
  } finally {
    f.cleanup()
  }
})
test('SU13b colors cover all statuses with valid Project enums', () => {
  for (const label of STATUS_LABELS)
    assert.ok(
      ['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE'].includes(
        PROJECT_STATUS_COLORS[label.name] ?? '',
      ),
    )
})
test('SU14 labels create only missing names and surface failures', () => {
  const f = fixture()
  try {
    f.respond('label_list', [{ name: 'ready' }, { name: 'done' }])
    assert.equal(ensureStatusLabels('acme/app'), true)
    const creates = f
      .calls()
      .split('\n')
      .filter((line) => line.startsWith('label create'))
    assert.equal(creates.length, 7)
    assert.ok(creates.every((line) => line.includes('--repo acme/app')))
    assert.ok(creates.every((line) => !/^label create (Ready|Done) /.test(line)))
    writeFileSync(join(f.gh, 'label_create_Failed.rc'), '1')
    assert.equal(ensureStatusLabels('acme/app'), false)
    writeFileSync(join(f.gh, 'label_list.rc'), '1')
    assert.equal(ensureStatusLabels('acme/app'), false)
  } finally {
    f.cleanup()
  }
})
