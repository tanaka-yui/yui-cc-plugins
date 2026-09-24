// GitHub issue 自動ループの issue 取得・claim・状態管理。
// Usage: node issue-fetch.ts --state-file <path> <subcommand> [options]
// ★ cmux 版からの変更: CMUX 変数の削除、workers.json による痕跡確認、記録された
//   worktree_path の実在確認、Orca 用ラベルの説明、単件指定の fetch、TypeScript 移植。
import { readJson, writeAtomic } from '../../../lib/fs.ts'
import { asArray, asObject, asString, get, type Json, type JsonObject, parseJson } from '../../../lib/json.ts'
import { nowIso, nowSeconds, run, which } from '../../../lib/sys.ts'

import { existsSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

// 移植元の理由（skills/orca-team-dispatch-task/scripts/issue-fetch.sh）:
// ★ **移植元: `apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/scripts/issue-fetch.sh`**
//   上流から変えたのは次の 6 点である。元のロック・claim・fetch の失敗処理は保っている
//   （lock の in-flight grace / takeover mutex / claim の補償 / fetch の窓拡張と
//   exhaustion 判定は、失敗様式ごと持ち込む価値があるのでそのまま）。
//
//     1. 死んだ `CMUX` 変数を削除した
//     2. reconcile の痕跡が `prewarm.json` → `workers.json`
//     3. reconcile の worktree 痕跡が `<repo>/.worktrees/<slug>` の固定パス →
//        `workers.json` の `roles[].worktree_path` の実在（Orca の worktree は repo の外）
//     4. `gh label create` の説明文
//     5. `fetch --issue <N>` を足した（単件指定。検索を通さず、claim と補償は共通経路へ
//        合流させる）。`--issue` の flag 自体は上流にもある（mark-dispatched などが使う）
//     6. TypeScript へ移した（2026-09 の P2）
//
//   **上流が動いたらこの一覧との差分を人が見て判断する。**自動追従はしない。
// ★ **単件指定 (`--issue <N>`) は検索を通さない。**ラベルや assignee で絞る意味が
//   無いうえ、検索から漏れた issue を指定できなくなる。**claim とその補償
//   （state を書けなければラベルを戻す）は下の共通経路に合流させる** — 2 か所に
//   書くと必ず片方だけ直されてドリフトする。
//
// ★ cmux 版の `prewarm.json` は Orca では `workers.json` である。
//
// ★ **Orca の worktree は repo の外に作られる**ので、`<repo>/.worktrees/<slug>` の
//   固定パスでは探せない（実測: `~/workspace/<repo>/<slug>`）。記録された
//   `worktree_path` が実在するかを見る。**列挙できないことを「不在」と読まない** —
//   workers.json が読めなければ上の行が既に痕跡として立っている。
const MAX_WINDOW = 1000
const LOCK_INFLIGHT_GRACE_SEC = 60
const TAKEOVER_MUTEX_GRACE_SEC = 120
let ownerGeneration = ''

const fatal = (message: string): never => {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}
const note = (tag: string, message: string): void => {
  process.stderr.write(`[${tag}] ${message}\n`)
}
type Options = {
  stateFile: string
  sub: string
  leaseMin: number
  limit: number
  batch: number
  labels: string
  assignee: string
  state: string
  issue: string
  status: string
  prUrl: string
  message: string
  configJson: string
  filterJson: string
  dryRun: boolean
}
type Paths = {
  stateFile: string
  loopDir: string
  lockDir: string
  ownerFile: string
  takeoverMutex: string
  dispatchDir: string
  session: string
  host: string
}
const object = (value: Json | undefined): JsonObject => asObject(value) ?? {}
const array = (value: Json | undefined): Json[] => asArray(value) ?? []
const string = (value: Json | undefined): string => asString(value) ?? ''
const pretty = (value: Json): string => `${JSON.stringify(value, null, 2)}\n`
const makeSlug = (issue: string, title: string): string => {
  const body = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
  return `issue-${issue}-${body}`.slice(0, 30).replace(/-$/, '')
}
const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
const mtime = (path: string): number => {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000)
  } catch {
    return 0
  }
}
const isoEpoch = (value: string): number => {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0
}
const lockIsLive = (paths: Paths, leaseMin: number): boolean => {
  if (!isDir(paths.lockDir)) return false
  const heartbeat = string(get(readJson(paths.ownerFile), 'heartbeat'))
  if (heartbeat === '') return nowSeconds() - mtime(paths.lockDir) <= LOCK_INFLIGHT_GRACE_SEC
  return nowSeconds() - isoEpoch(heartbeat) <= leaseMin * 60
}
const requireSession = (paths: Paths): void => {
  if (paths.session === '') fatal('stable session id not found; set LOOP_SESSION_ID (or CLAUDE_CODE_SESSION_ID)')
}
const writeOwner = (paths: Paths): string => {
  const timestamp = nowIso()
  const generation = `${timestamp}-${paths.session}-${Math.floor(Math.random() * 32768)}`
  const content = {
    session_id: paths.session,
    host: paths.host,
    started_at: timestamp,
    heartbeat: timestamp,
    generation,
  }
  if (!writeAtomic(paths.ownerFile, pretty(content))) fatal('failed to write owner.json')
  ownerGeneration = generation
  return generation
}
const acquireTakeoverMutex = (paths: Paths): boolean => {
  try {
    mkdirSync(paths.takeoverMutex)
    return true
  } catch {
    /* 既存の mutex を調べる */
  }
  if (nowSeconds() - mtime(paths.takeoverMutex) <= TAKEOVER_MUTEX_GRACE_SEC) return false
  const stamp = nowIso().replace(/[-:]/g, '').replace('.000', '')
  const quarantine = join(paths.loopDir, `loop.lock.takeover.stale.${stamp}.${process.pid}`)
  try {
    renameSync(paths.takeoverMutex, quarantine)
    try {
      rmdirSync(quarantine)
    } catch {
      rmSync(quarantine, { recursive: true, force: true })
    }
    mkdirSync(paths.takeoverMutex)
    return true
  } catch {
    return false
  }
}
const releaseTakeoverOnExit = (paths: Paths): void => {
  process.on('exit', () => {
    try {
      rmdirSync(paths.takeoverMutex)
    } catch {
      /* 別の owner が片付ける */
    }
  })
}
const verifyOwnerGeneration = (paths: Paths): JsonObject => {
  if (!isFile(paths.ownerFile)) fatal(`no active loop lock at ${paths.lockDir}`)
  const owner = object(readJson(paths.ownerFile))
  const session = string(owner.session_id)
  const generation = string(owner.generation)
  if (session !== paths.session) fatal(`loop lock is owned by '${session}', not '${paths.session}'`)
  if (ownerGeneration !== '' && generation !== ownerGeneration) fatal('loop lock generation changed')
  ownerGeneration = generation
  return owner
}
const requireOwner = (paths: Paths): void => {
  requireSession(paths)
  const owner = verifyOwnerGeneration(paths)
  if (!writeAtomic(paths.ownerFile, pretty({ ...owner, heartbeat: nowIso() }))) fatal('heartbeat update failed')
}
const stateWriteSoft = (paths: Paths, mutate: (state: JsonObject) => boolean): boolean => {
  if (!isFile(paths.stateFile)) return false
  const state = asObject(readJson(paths.stateFile))
  if (state === null || !mutate(state)) return false
  return writeAtomic(paths.stateFile, pretty(state))
}
const stateWrite = (paths: Paths, mutate: (state: JsonObject) => boolean): void => {
  verifyOwnerGeneration(paths)
  if (!isFile(paths.stateFile)) {
    if (!writeAtomic(paths.stateFile, pretty({ issues: {}, batches: [], leaked: [] })))
      fatal(`failed to update ${paths.stateFile}`)
  }
  if (!stateWriteSoft(paths, mutate)) fatal(`failed to update ${paths.stateFile}`)
}
const gh = (...args: string[]) => run('gh', args)
const issueNumber = (value: Json | undefined): string => (value === undefined || value === null ? '' : String(value))
const stateIssues = (state: Json | null): JsonObject => object(get(state, 'issues'))

const parseOptions = (argv: string[]): Options => {
  const options: Options = {
    stateFile: '',
    sub: '',
    leaseMin: 30,
    limit: 0,
    batch: 0,
    labels: '',
    assignee: '',
    state: 'open',
    issue: '',
    status: '',
    prUrl: '',
    message: '',
    configJson: '',
    filterJson: '',
    dryRun: false,
  }
  const fields: { [key: string]: keyof Options } = {
    '--state-file': 'stateFile',
    '--lease-min': 'leaseMin',
    '--limit': 'limit',
    '--batch': 'batch',
    '--labels': 'labels',
    '--assignee': 'assignee',
    '--state': 'state',
    '--issue': 'issue',
    '--status': 'status',
    '--pr-url': 'prUrl',
    '--message': 'message',
    '--config-json': 'configJson',
    '--filter-json': 'filterJson',
  }
  const required: { [key: string]: string } = {
    '--state-file': 'a path',
    '--lease-min': 'a number',
    '--limit': 'a number',
    '--batch': 'a number',
    '--labels': 'a value',
    '--assignee': 'a value',
    '--state': 'a value',
    '--issue': 'a number',
    '--status': 'a value',
    '--pr-url': 'a value',
    '--message': 'a value',
    '--config-json': 'JSON',
    '--filter-json': 'JSON',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    const field = fields[arg]
    if (field !== undefined) {
      if (i + 1 >= argv.length) fatal(`${arg} requires ${required[arg]}`)
      const value = argv[++i] ?? ''
      if (field === 'leaseMin' || field === 'limit' || field === 'batch') {
        if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) fatal(`${arg} requires a number`)
        options[field] = Number(value)
      } else if (field !== 'dryRun') {
        options[field] = value
      }
    } else if (arg.startsWith('-')) {
      fatal(`unknown option: ${arg}`)
    } else if (options.sub !== '') {
      fatal(`unexpected argument: ${arg}`)
    } else {
      options.sub = arg
    }
  }
  if (options.stateFile === '') fatal('--state-file is required')
  if (options.sub === '') fatal('a subcommand is required')
  return options
}
const makePaths = (stateFile: string): Paths => {
  const directory = dirname(stateFile)
  const loopDir = isAbsolute(directory) ? directory : `${process.cwd()}/${directory}`
  const lockDir = join(loopDir, 'loop.lock.d')
  return {
    stateFile,
    loopDir,
    lockDir,
    ownerFile: join(lockDir, 'owner.json'),
    takeoverMutex: join(loopDir, 'loop.lock.takeover.d'),
    dispatchDir: process.env.DISPATCH_DIR || join(dirname(loopDir), '.dispatch'),
    session: process.env.LOOP_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '',
    host: hostname().split('.')[0] || 'unknown',
  }
}

const fetchIssues = (paths: Paths, options: Options): number => {
  requireOwner(paths)
  if (which('gh') === null) fatal('gh is not installed')
  if (!(options.limit > 0 && options.batch > 0)) fatal('fetch requires positive --limit and --batch')
  if (!isFile(paths.stateFile)) fatal(`${paths.stateFile} not found; run init first`)
  const existing = stateIssues(readJson(paths.stateFile))
  let candidates: Json[] = []
  let limit = options.limit
  // ★ 単件指定は検索を通さず、claim と state 書き込みの補償は共通経路に合流させる。
  if (options.issue !== '') {
    const viewed = gh('issue', 'view', options.issue, '--json', 'number,title,body,url,labels')
    if (viewed.rc !== 0) fatal(`gh issue view #${options.issue} failed`)
    const issue = parseJson(viewed.stdout)
    if (issue !== null && !Object.hasOwn(existing, issueNumber(get(issue, 'number')))) candidates = [issue]
    if (candidates.length === 0) {
      note('warn', `issue #${options.issue} は既に state に載っています`)
      process.stdout.write('[]\n')
      return 0
    }
    limit = 1
  } else {
    let search = '-label:dispatch/in-progress -label:dispatch/done -label:dispatch/failed'
    const assigneeFlags: string[] = []
    if (options.assignee === 'none') search += ' no:assignee'
    else if (options.assignee !== '') assigneeFlags.push('--assignee', options.assignee)
    const labelFlags = options.labels === '' ? [] : ['--label', options.labels]
    let window = Math.min(limit * 2, MAX_WINDOW)
    let exhaustionKnown = false
    while (true) {
      const listed = gh(
        'issue',
        'list',
        '--state',
        options.state,
        ...labelFlags,
        ...assigneeFlags,
        '--search',
        search,
        '--limit',
        String(window),
        '--json',
        'number,title,body,url,labels',
      )
      if (listed.rc !== 0) fatal('gh issue list failed')
      const returned = array(parseJson(listed.stdout))
      candidates = returned.filter((entry) => !Object.hasOwn(existing, issueNumber(get(entry, 'number'))))
      if (returned.length < window || candidates.length > 0) {
        exhaustionKnown = true
        break
      }
      if (window >= MAX_WINDOW) break
      window = Math.min(window * 2, MAX_WINDOW)
      note('fetch', `window全除外につき拡張: --limit ${window}`)
    }
    if (!exhaustionKnown) {
      note('warn', `取得窓を上限 ${MAX_WINDOW} まで広げても候補が尽きたと確認できませんでした`)
      return 4
    }
  }
  if (candidates.length === 0) {
    process.stdout.write('[]\n')
    return 0
  }
  if (options.dryRun) {
    process.stdout.write(pretty(candidates.slice(0, limit)))
    return 0
  }
  const tasks: Json[] = []
  for (const candidate of candidates) {
    if (tasks.length >= limit) break
    const number = issueNumber(get(candidate, 'number'))
    const title = string(get(candidate, 'title'))
    if (gh('issue', 'edit', number, '--add-label', 'dispatch/in-progress').rc !== 0) {
      note('warn', `issue #${number} の claim に失敗したため除外します`)
      continue
    }
    const slug = makeSlug(number, title)
    const recorded = stateWriteSoft(paths, (state) => {
      state.issues = {
        ...stateIssues(state),
        [number]: { slug, status: 'claimed', batch: options.batch, claimed_at: nowIso() },
      }
      return true
    })
    if (!recorded) {
      if (gh('issue', 'edit', number, '--remove-label', 'dispatch/in-progress').rc !== 0) {
        fatal(`issue #${number}: state 記録と claim 補償の両方に失敗しました`)
      }
      note('warn', `issue #${number} の state 記録に失敗したため claim を取り消しました`)
      continue
    }
    tasks.push({ ...object(candidate), slug })
    note('claim', `issue #${number} -> ${slug}`)
  }
  if (tasks.length === 0) {
    note('warn', '候補はありましたが claim が 1 件も成立しませんでした')
    return 3
  }
  stateWrite(paths, (state) => {
    state.batches = [
      ...array(state.batches),
      { n: options.batch, issues: tasks.map((item) => get(item, 'number') ?? null), started_at: nowIso() },
    ]
    return true
  })
  process.stdout.write(pretty(tasks))
  return 0
}

const reconcile = (paths: Paths): number => {
  requireOwner(paths)
  if (!isFile(paths.stateFile)) {
    process.stdout.write(pretty({ action: 'ok', reasons: [] }))
    return 0
  }
  const issues = stateIssues(readJson(paths.stateFile))
  let action = 'ok'
  const reasons: string[] = []
  for (const [number, issue] of Object.entries(issues)) {
    if (get(issue, 'status') === 'dispatched') {
      action = 'abort'
      reasons.push(`issue #${number} は dispatched のままです`)
    }
  }
  for (const [number, issue] of Object.entries(issues)) {
    if (get(issue, 'status') !== 'claimed') continue
    const slug = string(get(issue, 'slug'))
    const recordDir = join(paths.dispatchDir, slug)
    const evidence: string[] = []
    if (isFile(join(recordDir, 'status.json'))) evidence.push('status.json')
    const workersFile = join(recordDir, 'workers.json')
    if (isFile(workersFile)) {
      evidence.push('workers.json')
      const workers = readJson(workersFile)
      for (const role of Object.values(object(get(workers, 'roles')))) {
        const worktreePath = string(get(role, 'worktree_path'))
        if (worktreePath !== '' && isDir(worktreePath)) {
          evidence.push('worktree')
          break
        }
      }
    }
    if (evidence.length > 0) {
      action = 'abort'
      reasons.push(`issue #${number} (${slug}) は生存の痕跡があります (${evidence.join(', ')})`)
    } else if (which('gh') === null || gh('issue', 'edit', number, '--remove-label', 'dispatch/in-progress').rc !== 0) {
      action = 'abort'
      reasons.push(`issue #${number} (${slug}) のラベル除去に失敗しました`)
    } else {
      stateWrite(paths, (state) => {
        const next = { ...stateIssues(state) }
        delete next[number]
        state.issues = next
        return true
      })
      reasons.push(`issue #${number} (${slug}) を release しました`)
    }
  }
  process.stdout.write(pretty({ action, reasons }))
  return 0
}

const main = (argv: string[]): number => {
  const options = parseOptions(argv)
  const paths = makePaths(options.stateFile)
  switch (options.sub) {
    case 'lock-check':
      if (lockIsLive(paths, options.leaseMin)) {
        note('lock', 'an issue loop is already running')
        return 1
      }
      return 0
    case 'lock-acquire': {
      requireSession(paths)
      if (options.leaseMin < 10) fatal('--lease-min must be at least 10')
      mkdirSync(paths.loopDir, { recursive: true })
      try {
        mkdirSync(paths.lockDir)
        writeOwner(paths)
        note('lock', `acquired (${paths.session})`)
        return 0
      } catch {
        /* 既存の lock を調べる */
      }
      if (string(get(readJson(paths.ownerFile), 'session_id')) === paths.session && isFile(paths.ownerFile)) return 0
      if (lockIsLive(paths, options.leaseMin)) {
        note('lock', 'another loop is running')
        return 1
      }
      if (!acquireTakeoverMutex(paths)) {
        note('lock', 'another process is taking over')
        return 1
      }
      releaseTakeoverOnExit(paths)
      if (lockIsLive(paths, options.leaseMin)) return 1
      if (isDir(paths.lockDir)) {
        const stamp = nowIso().replace(/[-:]/g, '')
        try {
          renameSync(paths.lockDir, join(paths.loopDir, `loop.lock.stale.${stamp}.${paths.session}`))
        } catch {
          fatal('failed to quarantine stale lock')
        }
      }
      try {
        mkdirSync(paths.lockDir)
      } catch {
        fatal('failed to create lock after takeover')
      }
      writeOwner(paths)
      return 0
    }
    case 'lock-release':
      requireSession(paths)
      if (!isDir(paths.lockDir)) return 0
      if (!acquireTakeoverMutex(paths)) fatal('a takeover is in progress; not releasing')
      releaseTakeoverOnExit(paths)
      if (!isFile(paths.ownerFile)) fatal('lock has no owner.json; not releasing')
      if (string(get(readJson(paths.ownerFile), 'session_id')) !== paths.session)
        fatal('lock belongs to another owner; not releasing')
      rmSync(paths.lockDir, { recursive: true, force: true })
      return 0
    case 'heartbeat':
      requireOwner(paths)
      return 0
    case 'init': {
      requireOwner(paths)
      if (options.configJson === '' || options.filterJson === '') fatal('init requires --config-json and --filter-json')
      const config = parseJson(options.configJson)
      const filter = parseJson(options.filterJson)
      if (config === null || config === false) fatal('--config-json is not valid JSON')
      if (filter === null || filter === false) fatal('--filter-json is not valid JSON')
      const prior = asObject(readJson(paths.stateFile))
      if (existsSync(paths.stateFile) && prior === null) fatal('failed to update state')
      const state: JsonObject =
        prior === null
          ? { started_at: nowIso(), filter, config, issues: {}, batches: [], leaked: [] }
          : {
              ...prior,
              config,
              filter,
              issues: prior.issues ?? {},
              batches: prior.batches ?? [],
              leaked: prior.leaked ?? [],
              started_at: prior.started_at ?? nowIso(),
            }
      if (!writeAtomic(paths.stateFile, pretty(state))) fatal('failed to update state')
      return 0
    }
    case 'fetch':
      return fetchIssues(paths, options)
    case 'mark-dispatched':
      requireOwner(paths)
      if (options.issue === '') fatal('--issue is required')
      stateWrite(paths, (state) => {
        state.issues = {
          ...stateIssues(state),
          [options.issue]: {
            ...object(get(state, 'issues', options.issue)),
            status: 'dispatched',
            dispatched_at: nowIso(),
          },
        }
        return true
      })
      return 0
    case 'release':
      requireOwner(paths)
      if (options.issue === '') fatal('--issue is required')
      if (which('gh') === null) fatal('gh is not installed; state is preserved')
      if (gh('issue', 'edit', options.issue, '--remove-label', 'dispatch/in-progress').rc !== 0) {
        fatal(`issue #${options.issue} のラベル除去に失敗したため state は保持します`)
      }
      stateWrite(paths, (state) => {
        const next = { ...stateIssues(state) }
        delete next[options.issue]
        state.issues = next
        return true
      })
      return 0
    case 'reconcile':
      return reconcile(paths)
    case 'ensure-labels': {
      requireOwner(paths)
      if (which('gh') === null) fatal('gh is not installed')
      const listed = gh('label', 'list', '--limit', '200', '--json', 'name')
      if (listed.rc !== 0) fatal('gh label list failed')
      const existing = array(parseJson(listed.stdout))
      for (const label of ['dispatch/in-progress', 'dispatch/done', 'dispatch/failed']) {
        if (!existing.some((entry) => get(entry, 'name') === label)) {
          if (gh('label', 'create', label, '--description', 'orca-team-dispatch-task issue mode').rc !== 0)
            fatal(`ラベル '${label}' の作成に失敗しました`)
        }
      }
      return 0
    }
    case 'finalize':
      requireOwner(paths)
      if (options.issue === '' || options.status === '') fatal('finalize requires --issue and --status')
      stateWrite(paths, (state) => {
        const entry: JsonObject = { ...object(get(state, 'issues', options.issue)), status: options.status }
        if (options.prUrl !== '') entry.pr_url = options.prUrl
        if (options.message !== '') entry.message = options.message
        state.issues = { ...stateIssues(state), [options.issue]: entry }
        return true
      })
      return 0
    default:
      return fatal(`unknown subcommand: ${options.sub}`)
  }
}

process.exitCode = main(process.argv.slice(2))
