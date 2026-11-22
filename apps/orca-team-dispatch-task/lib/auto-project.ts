import { AUTO_GITHUB_PAGE_SIZE, github, labelNames } from './auto-github.ts'
import { autoReadUncounted, canAutoCall } from './auto-paths.ts'
import { asArray, asObject, asString, get, type Json, parseJson } from './json.ts'
import { MANAGED_LABELS, STATUS_LABELS } from './status.ts'

import type { AutoConfig, ProjectRef } from './auto-config.ts'
import type { AutoState, ProjectPair } from './auto-state.ts'

export const AUTO_PROJECT_MAX_PAGES = 10
export const AUTO_PROJECT_LABEL_LIMIT = 20
export type ProjectItem = {
  itemId: string
  key: string
  repo: string
  number: number
  labels: string[]
  label: string
  labelAt: string
  status: string
  statusAt: string
}
export type ProjectRead = {
  projectId: string
  fieldId: string
  options: Record<string, string>
  items: ProjectItem[]
}
export type ProjectReadError = { error: string; outOfBudget: boolean }
export type SyncDecision =
  | { action: 'skip' }
  | { action: 'record'; pair: ProjectPair }
  | { action: 'setLabel'; pair: ProjectPair }
  | { action: 'setStatus'; pair: ProjectPair }
export type ProjectSyncContext = {
  sources: AutoConfig['sources']
  state: AutoState
  save: () => void
  log: (line: string) => void
  // 管理の印が無い Issue も同期するリポジトリ（intake の existing が active）。名前の大文字小文字は無視する
  active: ReadonlySet<string>
  // その tick で読めた Project の項目の `owner/repo#N` → Status。ステータス名でなければ ''。読めなかった Project の項目は入らない
  statuses: Map<string, string>
  failed: Set<string>
  touched: Set<string>
}
const seconds = (time: string): number => {
  const parsed = Date.parse(time)
  return Number.isNaN(parsed) ? -Infinity : Math.floor(parsed / 1000)
}
export const decideProjectSync = (prev: ProjectPair | undefined, item: ProjectItem): SyncDecision => {
  const { status, label } = item
  // Todo など、ステータス名でない Status。ラベルが前回から動いたときだけ Status をラベルに揃える
  if (!status)
    return prev && label && prev.label !== label
      ? { action: 'setStatus', pair: { status: label, label } }
      : { action: 'record', pair: { status: '', label } }
  if (label === status) return { action: 'record', pair: { status, label } }
  const statusChanged = !prev || prev.status !== status
  const labelChanged = !prev || prev.label !== label
  if (!label)
    return statusChanged
      ? { action: 'setLabel', pair: { status, label: status } }
      : { action: 'record', pair: { status, label } }
  if (statusChanged && !labelChanged) return { action: 'setLabel', pair: { status, label: status } }
  if (labelChanged && !statusChanged) return { action: 'setStatus', pair: { status: label, label } }
  if (statusChanged && labelChanged)
    return seconds(item.labelAt) >= seconds(item.statusAt)
      ? { action: 'setStatus', pair: { status: label, label } }
      : { action: 'setLabel', pair: { status, label: status } }
  return { action: 'skip' }
}

const READ_QUERY = `query($owner:String!,$number:Int!,$after:String){ repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectV2(number:$number){ id field(name:"Status"){ __typename ... on ProjectV2SingleSelectField { id options { id name } } } items(first:${AUTO_GITHUB_PAGE_SIZE}, after:$after){ pageInfo{hasNextPage endCursor} nodes{ id isArchived content{ __typename ... on Issue{ number repository{nameWithOwner} labels(first:${AUTO_PROJECT_LABEL_LIMIT}){nodes{name}} timelineItems(last:${AUTO_PROJECT_LABEL_LIMIT}, itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){ nodes{ __typename ... on LabeledEvent{createdAt label{name}} ... on UnlabeledEvent{createdAt label{name}} } } } } status: fieldValueByName(name:"Status"){ __typename ... on ProjectV2ItemFieldSingleSelectValue{ name optionId updatedAt } } } } } } } }`
const statusName = (name: string): string =>
  STATUS_LABELS.find((s) => s.name.toLowerCase() === name.toLowerCase())?.name ?? ''
const projectItem = (node: Json, repos: string[], active: ReadonlySet<string>): ProjectItem | null => {
  if (get(node, 'isArchived') === true) return null
  const content = get(node, 'content')
  const number = get(content, 'number')
  const name = asString(get(content, 'repository', 'nameWithOwner'))
  const repo = repos.find((r) => r.toLowerCase() === name?.toLowerCase())
  const itemId = asString(get(node, 'id'))
  const labels = labelNames(get(content, 'labels', 'nodes'))
  if (!repo || !itemId || typeof number !== 'number') return null
  const managed = MANAGED_LABELS.some((l) => labels.includes(l))
  if (!managed && ![...active].some((a) => a.toLowerCase() === repo.toLowerCase())) return null
  const label = STATUS_LABELS.find((s) => labels.includes(s.name))?.name ?? ''
  let labelAt = ''
  for (const event of asArray(get(content, 'timelineItems', 'nodes')) ?? []) {
    const name = asString(get(event, 'label', 'name'))
    const at = asString(get(event, 'createdAt')) ?? ''
    if (STATUS_LABELS.some((s) => s.name === name) && seconds(at) > seconds(labelAt)) labelAt = at
  }
  return {
    itemId,
    key: `${repo}#${number}`,
    repo,
    number,
    labels,
    label,
    labelAt,
    status: statusName(asString(get(node, 'status', 'name')) ?? ''),
    statusAt: asString(get(node, 'status', 'updatedAt')) ?? '',
  }
}
export const readProject = (
  ref: ProjectRef,
  repos: string[],
  active: ReadonlySet<string> = new Set(),
): ProjectRead | ProjectReadError => {
  const result: ProjectRead = { projectId: '', fieldId: '', options: {}, items: [] }
  let after: string | null = null
  const failure = (error: string): ProjectReadError => ({ error, outOfBudget: false })
  const scopeError = 'gh に project の権限がありません。gh auth refresh -s project を実行してください'
  for (let index = 0; index < AUTO_PROJECT_MAX_PAGES; index++) {
    if (!canAutoCall('Project 同期')) return { error: '予算を使い切りました', outOfBudget: true }
    const args = [
      'api',
      'graphql',
      '--raw-field',
      `query=${READ_QUERY}`,
      '--raw-field',
      `owner=${ref.owner}`,
      '--field',
      `number=${ref.number}`,
    ]
    if (after !== null) args.push('--raw-field', `after=${after}`)
    const call = autoReadUncounted('gh', args)
    if (call.rc !== 0) {
      if ((call.stdout + call.stderr).includes('INSUFFICIENT_SCOPES')) return failure(scopeError)
      if (call.stderr.includes('timed out')) return failure('期限までに読めませんでした')
      return failure(
        call.stderr
          .split('\n')
          .map((s) => s.trim())
          .find(Boolean)
          ?.replace(/^gh: /, '') ?? `gh が終了コード ${call.rc} で終わりました`,
      )
    }
    const value = parseJson(call.stdout)
    if (value === null) return failure('応答を読めません')
    const errors = asArray(get(value, 'errors'))
    if (errors?.length)
      return failure(
        JSON.stringify(errors).includes('INSUFFICIENT_SCOPES')
          ? scopeError
          : (asString(get(errors[0], 'message')) ?? 'GraphQL のエラー'),
      )
    const project = asObject(get(value, 'data', 'repositoryOwner', 'projectV2'))
    if (!project) return failure('Project が見つかりません')
    const projectId = asString(project.id)
    const fieldId = asString(get(project, 'field', 'id'))
    if (projectId === null || fieldId === null) return failure('単一選択の Status 欄がありません')
    result.projectId = projectId
    result.fieldId = fieldId
    for (const option of asArray(get(project, 'field', 'options')) ?? []) {
      const name = statusName(asString(get(option, 'name')) ?? '')
      const id = asString(get(option, 'id'))
      if (name && id !== null && result.options[name] === undefined) result.options[name] = id
    }
    for (const node of asArray(get(project, 'items', 'nodes')) ?? []) {
      const parsed = projectItem(node, repos, active)
      if (parsed) result.items.push(parsed)
    }
    if (get(project, 'items', 'pageInfo', 'hasNextPage') !== true) return result
    after = asString(get(project, 'items', 'pageInfo', 'endCursor'))
    if (after === null) return failure('ページの続きを読めません')
  }
  return failure(`項目が ${AUTO_PROJECT_MAX_PAGES * AUTO_GITHUB_PAGE_SIZE} 件を超えています`)
}

const WRITE_QUERY =
  'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){ updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){ projectV2Item{ id } } }'
export const syncProjects = (ctx: ProjectSyncContext): void => {
  const projects = new Map<string, { ref: ProjectRef; repos: string[] }>()
  for (const source of ctx.sources) {
    if (!source.project) continue
    const key = `${source.project.owner}/${source.project.number}`
    const group = projects.get(key)
    if (group) group.repos.push(source.repo)
    else projects.set(key, { ref: source.project, repos: [source.repo] })
  }
  for (const [key, group] of projects) {
    if (ctx.failed.has(key)) continue
    if (!canAutoCall('Project 同期')) return
    const project = readProject(group.ref, group.repos, ctx.active)
    if ('error' in project) {
      if (project.outOfBudget) return
      ctx.log(`Project を読めません: ${key}: ${project.error}`)
      ctx.failed.add(key)
      continue
    }
    for (const item of project.items) ctx.statuses.set(item.key, item.status)
    for (const item of project.items) {
      if (ctx.touched.has(item.key) || ctx.state.issues[item.key]?.pendingLabel) continue
      const decision = decideProjectSync(ctx.state.projectSync[item.key], item)
      if (decision.action === 'skip') continue
      const { pair } = decision
      if (decision.action === 'record') {
        const prev = ctx.state.projectSync[item.key]
        if (prev?.status !== pair.status || prev?.label !== pair.label) {
          ctx.state.projectSync[item.key] = pair
          ctx.save()
        }
        continue
      }
      const option = project.options[pair.status]
      if (decision.action === 'setStatus' && !option) {
        ctx.touched.add(item.key)
        ctx.log(`Project の Status に「${pair.status}」の選択肢がありません: ${item.key}`)
        continue
      }
      if (!canAutoCall('Project 同期')) return
      ctx.touched.add(item.key)
      let success: boolean
      if (decision.action === 'setLabel') {
        const remove = item.labels.filter((name) => name !== pair.label && STATUS_LABELS.some((s) => s.name === name))
        success =
          github([
            'issue',
            'edit',
            String(item.number),
            '--repo',
            item.repo,
            '--add-label',
            pair.label,
            ...remove.flatMap((name) => ['--remove-label', name]),
          ]).rc === 0
      } else {
        const call = github([
          'api',
          'graphql',
          '--raw-field',
          `query=${WRITE_QUERY}`,
          '--raw-field',
          `project=${project.projectId}`,
          '--raw-field',
          `item=${item.itemId}`,
          '--raw-field',
          `field=${project.fieldId}`,
          '--raw-field',
          `option=${option}`,
        ])
        success =
          call.rc === 0 &&
          !!asString(
            get(parseJson(call.stdout) ?? undefined, 'data', 'updateProjectV2ItemFieldValue', 'projectV2Item', 'id'),
          )
      }
      if (success) {
        ctx.state.projectSync[item.key] = pair
        ctx.save()
      } else
        ctx.log(
          `Project の同期で ${decision.action === 'setLabel' ? 'ラベルを付け替えられません' : 'Status を書けません'}: ${item.key} → ${decision.action === 'setLabel' ? pair.label : pair.status}`,
        )
    }
  }
}
