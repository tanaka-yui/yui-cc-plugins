import {
  ERROR_DEADLINE,
  ERROR_GATE_REFUSED,
  ERROR_TIMEOUT,
  GATE_SCRIPT,
  GATE_SHELL,
  GATE_TOKEN,
  GH_TIMEOUT_MS,
  ISSUE_SCAN_PER_PAGE,
  LABEL_SPECS,
  SOURCE_LABEL,
} from './defaults.ts'
import { lastLineIsMarker } from './issue-body.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { identityOf } from './process.ts'
import { maskSecrets } from './secrets.ts'

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import type { ProcessIdentity } from './types.ts'
export type GhResult = { code: number; stdout: string; stderr: string }
export type GhGate = (child: ProcessIdentity) => boolean
export type Gh = (args: string[], deadline: number, gate?: GhGate) => Promise<GhResult>
export const createGh =
  (ghPath: string): Gh =>
  async (args, deadline, gate) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { code: -1, stdout: '', stderr: ERROR_DEADLINE }
    return new Promise((done) => {
      let stdout = ''
      let stderr = ''
      let forced = ''
      let settled = false
      const child = gate
        ? spawn(GATE_SHELL, ['-c', GATE_SCRIPT, ghPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(ghPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done({ code: forced ? -1 : code, stdout: maskSecrets(stdout), stderr: maskSecrets(forced || stderr).trim() })
      }
      const timer = setTimeout(
        () => {
          forced = ERROR_TIMEOUT
          child.kill('SIGKILL')
        },
        Math.min(GH_TIMEOUT_MS, remaining),
      )
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString()
      })
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString()
      })
      child.on('error', (error) => {
        stderr = error.message
        finish(-1)
      })
      child.on('close', (code) => finish(code ?? -1))
      child.stdin?.on('error', () => {
        /* 子の終了時に閉じた標準入力へ書けなくてもcloseで結果を返す */
      })
      if (gate) {
        let allowed = false
        try {
          const id = child.pid ? identityOf(child.pid) : null
          allowed = id !== null && gate(id)
        } catch {
          allowed = false
        }
        if (allowed) child.stdin?.end(`${GATE_TOKEN}\n`)
        else {
          forced = ERROR_GATE_REFUSED
          child.kill('SIGKILL')
        }
      }
    })
  }
export const findGhPath = (): string | null => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const file = resolve(join(dir, 'gh'))
    try {
      accessSync(file, constants.X_OK)
      if (isAbsolute(file)) return file
    } catch {
      /* 次のPATHを探す */
    }
  }
  return null
}
export const ghAuthOk = async (gh: Gh, deadline: number): Promise<boolean> =>
  (await gh(['auth', 'status'], deadline)).code === 0
export const viewerLogin = async (gh: Gh, deadline: number): Promise<string | null> => {
  const r = await gh(['api', 'user'], deadline)
  return r.code === 0 ? asString(get(parseJson(r.stdout) ?? undefined, 'login')) : null
}
export type RepoInfo = { visibility: string; viewerPermission: string; hasIssuesEnabled: boolean }
export const repoInfo = async (
  gh: Gh,
  repo: string,
  deadline: number,
): Promise<{ ok: true; info: RepoInfo } | { ok: false; error: string }> => {
  const r = await gh(['repo', 'view', repo, '--json', 'visibility,viewerPermission,hasIssuesEnabled'], deadline)
  if (r.code !== 0) return { ok: false, error: r.stderr }
  const o = asObject(parseJson(r.stdout))
  if (!o || !asString(o.visibility) || !asString(o.viewerPermission) || typeof o.hasIssuesEnabled !== 'boolean')
    return { ok: false, error: 'リポジトリの応答が不正です' }
  return {
    ok: true,
    info: {
      visibility: String(o.visibility),
      viewerPermission: String(o.viewerPermission),
      hasIssuesEnabled: o.hasIssuesEnabled,
    },
  }
}
export const ensureLabels = async (
  gh: Gh,
  repo: string,
  canWrite: boolean,
  deadline: number,
): Promise<{ ok: true; created: string[] } | { ok: false; error: string; missing: string[] }> => {
  const r = await gh(['label', 'list', '--repo', repo, '--limit', '500', '--json', 'name'], deadline)
  const existing = r.code === 0 ? asArray(parseJson(r.stdout)) : null
  if (!existing)
    return { ok: false, error: r.stderr || 'ラベルの応答が不正です', missing: LABEL_SPECS.map((l) => l.name) }
  const names = new Set(existing.map((v) => asString(get(v, 'name'))))
  const missing = LABEL_SPECS.filter((l) => !names.has(l.name))
  if (missing.length && !canWrite)
    return { ok: false, error: 'ラベルを作成する権限がありません', missing: missing.map((l) => l.name) }
  const created: string[] = []
  for (const label of missing) {
    const r = await gh(
      ['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description],
      deadline,
    )
    if (r.code !== 0)
      return {
        ok: false,
        error: r.stderr,
        missing: missing.filter((l) => !created.includes(l.name)).map((l) => l.name),
      }
    created.push(label.name)
  }
  return { ok: true, created }
}
export const createIssue = async (
  gh: Gh,
  repo: string,
  input: { title: string; bodyFile: string; labels: string[] },
  deadline: number,
  gate: GhGate,
): Promise<{ ok: true; url: string; number: number } | { ok: false; error: string }> => {
  const r = await gh(
    [
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      input.title,
      '--body-file',
      input.bodyFile,
      ...input.labels.flatMap((l) => ['--label', l]),
    ],
    deadline,
    gate,
  )
  if (r.code !== 0) return { ok: false, error: r.stderr }
  const url = r.stdout.trim().split(/\r?\n/).at(-1) ?? ''
  const number = url.match(/\/issues\/(\d+)$/)?.[1]
  return number && url.startsWith(`https://github.com/${repo}/issues/`)
    ? { ok: true, url, number: Number(number) }
    : { ok: false, error: 'Issue URL を読み取れません' }
}
export type IssueScan = { ok: true; issue: { url: string; number: number } | null } | { ok: false; error: string }
export const findIssueByMarker = async (
  gh: Gh,
  repo: string,
  marker: string,
  sinceIso: string,
  login: string,
  deadline: number,
): Promise<IssueScan> => {
  for (let page = 1; ; page++) {
    if (Date.now() >= deadline) return { ok: false, error: ERROR_DEADLINE }
    const r = await gh(
      [
        'api',
        `repos/${repo}/issues?labels=${SOURCE_LABEL}&state=all&sort=created&direction=desc&per_page=${ISSUE_SCAN_PER_PAGE}&page=${page}`,
      ],
      deadline,
    )
    if (r.code !== 0) return { ok: false, error: r.stderr }
    const items = asArray(parseJson(r.stdout))
    if (!items) return { ok: false, error: 'Issue 一覧の応答が不正です' }
    for (const value of items) {
      const o = asObject(value)
      if (!o || !asString(o.created_at)) return { ok: false, error: 'Issue 一覧の項目が不正です' }
      if (Date.parse(String(o.created_at)) < Date.parse(sinceIso)) return { ok: true, issue: null }
      if (o.pull_request) continue
      if (asString(get(o, 'user', 'login')) === login && lastLineIsMarker(asString(o.body) ?? '', marker)) {
        const url = asString(o.html_url)
        if (!url || typeof o.number !== 'number') return { ok: false, error: 'Issue のURLがありません' }
        return { ok: true, issue: { url, number: o.number } }
      }
    }
    if (items.length < ISSUE_SCAN_PER_PAGE) return { ok: true, issue: null }
  }
}
