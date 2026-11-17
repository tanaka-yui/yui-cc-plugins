import { github } from './auto-github.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { STATUS_LABELS } from './status.ts'

import type { ProjectRef } from './auto-config.ts'

export type StatusOptions = {
  fieldId: string
  options: Array<{ id: string; name: string; color: string; description: string }>
}
export const PROJECT_STATUS_COLORS: Readonly<Record<string, string>> = {
  Done: 'GREEN',
  Failed: 'RED',
  'In review': 'YELLOW',
  Ready_Eng: 'PURPLE',
  'In progress': 'BLUE',
  Pending: 'GRAY',
  Ready: 'GREEN',
  Backlog: 'GRAY',
}
const PROJECT_COLORS = ['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE']
const STATUS_FIELD_QUERY =
  'query($owner:String!,$number:Int!){ repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectV2(number:$number){ field(name:"Status"){ __typename ... on ProjectV2SingleSelectField { id options { id name color description } } } } } } }'
export const ghHasProjectScope = (): boolean | null => {
  const result = github(['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'])
  if (result.rc !== 0) return null
  const rows = asArray(get(parseJson(result.stdout), 'hosts', 'github.com'))
  const active = rows?.find((row) => get(row, 'active') === true)
  const scopes = asString(get(active, 'scopes'))
  return get(active, 'state') === 'success' && scopes !== null
    ? scopes
        .split(',')
        .map((s) => s.trim())
        .includes('project')
    : null
}
export const readStatusOptions = (ref: ProjectRef): StatusOptions | { error: string } => {
  const result = github([
    'api',
    'graphql',
    '--raw-field',
    `query=${STATUS_FIELD_QUERY}`,
    '--raw-field',
    `owner=${ref.owner}`,
    '--field',
    `number=${ref.number}`,
  ])
  if (result.rc !== 0)
    return {
      error: `${result.stdout}\n${result.stderr}`.includes('INSUFFICIENT_SCOPES')
        ? 'gh auth refresh -h github.com -s project を実行してください'
        : (result.stderr.split('\n').find((line) => line.trim()) ?? 'Project を読めません'),
    }
  const owner = get(parseJson(result.stdout), 'data', 'repositoryOwner')
  if (!asObject(owner)) return { error: 'owner が見つかりません' }
  const project = get(owner, 'projectV2')
  if (!asObject(project)) return { error: 'Project が見つかりません' }
  const field = get(project, 'field')
  const id = asString(get(field, 'id'))
  const options = asArray(get(field, 'options'))
  if (get(field, '__typename') !== 'ProjectV2SingleSelectField' || !id || !options)
    return { error: '単一選択の Status 欄がありません' }
  const parsed: StatusOptions['options'] = []
  for (const option of options) {
    const id = asString(get(option, 'id')),
      name = asString(get(option, 'name')),
      color = asString(get(option, 'color')),
      description = asString(get(option, 'description'))
    if (!id || !name || !color || description === null) return { error: 'Status の選択肢を読めません' }
    parsed.push({ id, name, color, description })
  }
  return { fieldId: id, options: parsed }
}
export const missingStatusOptions = (current: StatusOptions): string[] =>
  STATUS_LABELS.filter(
    (label) => !current.options.some((option) => option.name.toLowerCase() === label.name.toLowerCase()),
  ).map((label) => label.name)
export const addStatusOptions = (current: StatusOptions, missing: string[]): boolean => {
  if (
    current.options.some((o) => !PROJECT_COLORS.includes(o.color)) ||
    missing.some((name) => !STATUS_LABELS.some((l) => l.name === name))
  )
    return false
  const quote = JSON.stringify
  const options = [
    ...current.options.map(
      (o) => `{id:${quote(o.id)},name:${quote(o.name)},color:${o.color},description:${quote(o.description)}}`,
    ),
    ...missing.map(
      (name) =>
        `{name:${quote(name)},color:${PROJECT_STATUS_COLORS[name]},description:${quote(STATUS_LABELS.find((label) => label.name === name)?.description ?? '')}}`,
    ),
  ]
  const mutation = `mutation($fieldId:ID!){ updateProjectV2Field(input:{fieldId:$fieldId,singleSelectOptions:[${options.join(',')}]}){ projectV2Field{ ... on ProjectV2SingleSelectField { options { id name } } } } }`
  const result = github([
    'api',
    'graphql',
    '--raw-field',
    `query=${mutation}`,
    '--raw-field',
    `fieldId=${current.fieldId}`,
  ])
  const rows = asArray(get(parseJson(result.stdout), 'data', 'updateProjectV2Field', 'projectV2Field', 'options'))
  return (
    result.rc === 0 &&
    rows !== null &&
    [...current.options.map((o) => o.name), ...missing].every((name) =>
      rows.some((o) => asString(get(o, 'name'))?.toLowerCase() === name.toLowerCase()),
    )
  )
}
