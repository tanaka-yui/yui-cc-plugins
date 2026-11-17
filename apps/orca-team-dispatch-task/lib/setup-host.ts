import { envArgs, LOCAL_HOST, parseHosts } from './auto-hosts.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { receiptArray, receiptOk, runOrca } from './orca.ts'
import { availableMemoryMb, envCount, run, sleepSeconds } from './sys.ts'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync } from 'node:fs'
import { availableParallelism, homedir, hostname, tmpdir, totalmem } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type { HostSpec } from './auto-hosts.ts'

const MIB = 1024 * 1024
const realPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
export type HostChoice = { id: string; name: string; kind: 'local' | 'environment' }
export const listHostChoices = (): HostChoice[] | null => {
  const rows = receiptArray(runOrca(['host', 'list', '--json']), 'hosts')
  return (
    rows?.flatMap((row): HostChoice[] => {
      const id = asString(get(row, 'id')),
        kind = get(row, 'kind')
      const name = kind === 'local' ? asString(get(row, 'machineName')) || hostname() : asString(get(row, 'name'))
      return id && name && (kind === 'local' || kind === 'environment') ? [{ id, name, kind }] : []
    }) ?? null
  )
}
export const hostReachable = (id: string): boolean => {
  const result = runOrca(['status', ...envArgs(id), '--json'])
  return receiptOk(result) && get(result.json, 'result', 'runtime', 'reachable') === true
}
export const measureLocal = (now: string): HostSpec => {
  const fs = statfsSync(homedir())
  let swapTotalMb = 0
  if (process.platform === 'darwin')
    swapTotalMb = Math.floor(
      Number(/total\s*=\s*([\d.]+)M/.exec(run('sysctl', ['-n', 'vm.swapusage']).stdout)?.[1] ?? 0),
    )
  else if (process.platform === 'linux') {
    try {
      swapTotalMb = Math.floor(
        Number(/SwapTotal:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024,
      )
    } catch {
      /* 読めなければ 0。 */
    }
  }
  return {
    cpus: availableParallelism(),
    memoryTotalMb: Math.floor(totalmem() / MIB),
    memoryFreeMb: Math.floor(availableMemoryMb()),
    swapTotalMb,
    diskFreeMb: Math.floor((fs.bavail * fs.bsize) / MIB),
    measuredAt: now,
  }
}
export const swapWarning = (spec: HostSpec, platform: string): boolean =>
  platform !== 'darwin' && spec.swapTotalMb === 0
export type RemoteProbe = {
  spec: HostSpec | null
  orcaBin: string | null
  ghAuthOk: boolean | null
  platform: string | null
}
const PROBE_BEGIN = '@@orca-auto-probe:begin@@'
const PROBE_END = '@@orca-auto-probe:end@@'
const PROBE_SCRIPT = String.raw`
const os=require('node:os'),fs=require('node:fs'),cp=require('node:child_process');
const run=(c,a)=>{try{return cp.spawnSync(c,a,{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:15000,killSignal:'SIGKILL'})}catch{return {status:null,stdout:''}}};
const platform=os.platform(),m=1024*1024;let memoryFreeMb=Math.floor(os.freemem()/m),swapTotalMb=0;
if(platform==='darwin'){const t=run('vm_stat',[]).stdout||'',p=Number((t.match(/page size of (\d+) bytes/)||[])[1]);const n=k=>Number((t.match(new RegExp('Pages '+k+':\\s+(\\d+)\\.'))||[])[1]);const f=(n('free')+n('speculative')+n('inactive'))*p/m;if(Number.isFinite(f))memoryFreeMb=Math.floor(f);swapTotalMb=Math.floor(Number(((run('sysctl',['-n','vm.swapusage']).stdout||'').match(/total\s*=\s*([\d.]+)M/)||[])[1]||0))}
if(platform==='linux'){try{const t=fs.readFileSync('/proc/meminfo','utf8');memoryFreeMb=Math.floor(Number((t.match(/MemAvailable:\s+(\d+)/)||[])[1])/1024);swapTotalMb=Math.floor(Number((t.match(/SwapTotal:\s+(\d+)/)||[])[1]||0)/1024)}catch{}}
let diskFreeMb=null;try{const s=fs.statfsSync(os.homedir());diskFreeMb=Math.floor(s.bavail*s.bsize/m)}catch{}
const fallback='/Applications/Orca.app/Contents/Resources/bin/orca';const orcaBin=process.env.ORCA_CLI_COMMAND||(run('/bin/sh',['-c','command -v orca']).stdout||'').trim()||(fs.existsSync(fallback)?fallback:null);const gh=run('gh',['auth','status','--active','--hostname','github.com']);
console.log('@@orca-auto-probe:begin@@'+JSON.stringify({platform,cpus:os.availableParallelism(),memoryTotalMb:Math.floor(os.totalmem()/m),memoryFreeMb,swapTotalMb,diskFreeMb,orcaBin,ghAuthOk:gh.status===null?null:gh.status===0})+'@@orca-auto-probe:end@@');
`.replaceAll('\n', '')
export const probeCommand = (): string =>
  `node -e "eval(Buffer.from('${Buffer.from(PROBE_SCRIPT).toString('base64')}','base64').toString('utf8'))"`
export const PROBE_READ_ATTEMPTS = 30
export const probeRemote = (id: string, worktreeSelector: string, now: string): RemoteProbe => {
  const empty: RemoteProbe = { spec: null, orcaBin: null, ghAuthOk: null, platform: null }
  const created = runOrca([
    'terminal',
    'create',
    '--environment',
    id,
    '--worktree',
    worktreeSelector,
    '--title',
    'orca-auto-setup',
    '--command',
    probeCommand(),
    '--json',
  ])
  const handle = receiptOk(created) ? asString(get(created.json, 'result', 'terminal', 'handle')) : null
  if (!handle) return empty
  try {
    for (let attempt = 0; attempt < PROBE_READ_ATTEMPTS; attempt++) {
      const result = runOrca([
        'terminal',
        'read',
        '--environment',
        id,
        '--terminal',
        handle,
        '--limit',
        '400',
        '--json',
      ])
      const tail = receiptOk(result) ? asArray(get(result.json, 'result', 'terminal', 'tail')) : null
      const text = tail?.filter((line): line is string => typeof line === 'string').join('') ?? ''
      const start = text.indexOf(PROBE_BEGIN),
        end = text.indexOf(PROBE_END, start + PROBE_BEGIN.length)
      const value = start >= 0 && end >= 0 ? asObject(parseJson(text.slice(start + PROBE_BEGIN.length, end))) : null
      if (value) {
        const spec = {
          cpus: value.cpus ?? null,
          memoryTotalMb: value.memoryTotalMb ?? null,
          memoryFreeMb: value.memoryFreeMb ?? null,
          swapTotalMb: value.swapTotalMb ?? null,
          diskFreeMb: value.diskFreeMb ?? null,
          measuredAt: now,
        }
        const parsed = parseHosts([{ id, name: id, lanes: 1, orcaBin: 'orca', repos: {}, spec }], {})
        return {
          spec: parsed.ok ? (parsed.hosts?.[0]?.spec ?? null) : null,
          orcaBin: asString(value.orcaBin) || null,
          ghAuthOk: typeof value.ghAuthOk === 'boolean' ? value.ghAuthOk : null,
          platform: asString(value.platform) || null,
        }
      }
      if (attempt + 1 < PROBE_READ_ATTEMPTS) sleepSeconds(envCount('ORCA_AUTO_PROBE_INTERVAL_MS', 1000) / 1000)
    }
    return empty
  } finally {
    runOrca(['terminal', 'close', '--environment', id, '--terminal', handle, '--json'])
  }
}
export const listRemoteRepos = (id: string): Array<{ id: string; path: string; repo: string | null }> | null => {
  const rows = receiptArray(runOrca(['repo', 'list', ...envArgs(id), '--json']), 'repos')
  return (
    rows?.flatMap((row) => {
      const id = asString(get(row, 'id')),
        path = asString(get(row, 'path'))
      const key = asString(get(row, 'gitRemoteIdentity', 'canonicalKey'))
      return id && path ? [{ id, path, repo: key?.match(/^github\.com\/([^/\s]+\/[^/\s]+)$/)?.[1] ?? null }] : []
    }) ?? null
  )
}
export const addRepo = (id: string, path: string): string | null => {
  if (id === LOCAL_HOST && listRemoteRepos(id)?.some((r) => realPath(r.path) === realPath(path))) return `path:${path}`
  const result = runOrca(['repo', 'add', ...envArgs(id), '--path', path, '--json'])
  if (receiptOk(result)) {
    if (id === LOCAL_HOST) return `path:${path}`
    const added = asString(get(result.json, 'result', 'repo', 'id'))
    if (added) return `id:${added}`
  }
  const found = listRemoteRepos(id)?.find((r) =>
    id === LOCAL_HOST ? realPath(r.path) === realPath(path) : r.path === path,
  )
  return found ? (id === LOCAL_HOST ? `path:${path}` : `id:${found.id}`) : null
}
export const checkRemoteRepo = (id: string, selector: string, repo: string): 'match' | 'mismatch' | 'unknown' => {
  const entry = listRemoteRepos(id)?.find((r) => `id:${r.id}` === selector)
  return !entry?.repo ? 'unknown' : entry.repo.toLowerCase() === repo.toLowerCase() ? 'match' : 'mismatch'
}
export const checkoutProblem = (repo: string, path: string): string | null => {
  if (!isAbsolute(path)) return 'checkout は絶対パスで入力してください'
  const git = (...args: string[]) => run('git', ['-C', path, ...args])
  const top = git('rev-parse', '--show-toplevel')
  if (top.rc !== 0) return 'git の checkout ではありません'
  if (realPath(top.stdout.trim()) !== realPath(path)) return 'checkout の一番上を入力してください'
  const origin = git('remote', 'get-url', 'origin').stdout.trim()
  let identity = origin.match(/^[^@]+@[^:]+:(.+)$/)?.[1] ?? ''
  if (origin.includes('://')) {
    try {
      identity = new URL(origin).pathname.replace(/^\//, '')
    } catch {
      identity = ''
    }
  }
  identity = identity.replace(/\/$/, '').replace(/\.git$/, '')
  if (identity.toLowerCase() !== repo.toLowerCase()) return `origin が ${repo} ではありません: ${origin}`
  const status = git('status', '--porcelain')
  if (status.rc !== 0 || status.stdout.trim()) return '未コミットの変更があります'
  return null
}
export const repoDefaults = (checkout: string): { infra: boolean; ci: boolean } => {
  const infra = run('git', ['-C', checkout, 'ls-files', '--', '*.tf']).stdout.trim().length > 0
  const workflows = join(checkout, '.github/workflows')
  return { infra, ci: existsSync(workflows) && readdirSync(workflows).some((name) => /\.ya?ml$/.test(name)) }
}
export const runVerifyLocal = (checkout: string, commands: string[]): { ok: boolean; failed: string | null } => {
  const git = (...args: string[]) => run('git', ['-C', checkout, ...args])
  git('worktree', 'prune')
  const temporary = mkdtempSync(join(tmpdir(), 'orca-auto-verify-'))
  const ignore = () => {}
  process.on('SIGINT', ignore)
  try {
    if (git('worktree', 'add', '--detach', temporary, 'HEAD').rc !== 0) return { ok: false, failed: 'git worktree add' }
    for (const command of commands) {
      const result = spawnSync('/bin/sh', ['-c', command], { cwd: temporary, stdio: ['ignore', 'inherit', 'inherit'] })
      if (result.status !== 0) return { ok: false, failed: command }
    }
    return { ok: true, failed: null }
  } finally {
    git('worktree', 'remove', '--force', temporary)
    rmSync(temporary, { recursive: true, force: true })
    git('worktree', 'prune')
    process.removeListener('SIGINT', ignore)
  }
}
