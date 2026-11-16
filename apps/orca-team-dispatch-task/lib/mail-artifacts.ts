import { writeAtomic } from './fs.ts'
import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { MAIL_ENVELOPE_MAX_BYTES } from './mail-spec.ts'

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type EnvelopeHead = { repo: string; branch: string; head: string }
export type Envelope = { nonce: string; version: 1 | 2; heads: EnvelopeHead[]; files: Record<string, string> }
export const parseEnvelope = (body: string): Envelope | { error: string } => {
  if (Buffer.byteLength(body, 'utf8') > MAIL_ENVELOPE_MAX_BYTES)
    return { error: `envelope is larger than ${MAIL_ENVELOPE_MAX_BYTES} bytes` }
  const value = asObject(parseJson(body))
  if (!value || (value.version !== 1 && value.version !== 2))
    return { error: 'envelope must be a version 1 or 2 object' }
  const nonce = asString(value.nonce)
  const files = asObject(value.files)
  if (!nonce || !/^[0-9a-f]{16,64}$/.test(nonce)) return { error: 'envelope nonce is invalid' }
  const heads: EnvelopeHead[] = []
  if (value.version === 1) {
    const branch = asString(value.branch)
    const head = asString(value.head)
    if (!branch) return { error: 'envelope branch is empty' }
    if (!head || !/^[0-9a-f]{40,64}$/.test(head)) return { error: 'envelope head is invalid' }
    heads.push({ repo: '', branch, head })
  } else {
    const values = asArray(value.heads)
    const error = 'envelope heads must name each repository once with its branch and head'
    if (!values?.length) return { error }
    for (const entry of values) {
      const repo = asString(get(entry, 'repo'))
      const branch = asString(get(entry, 'branch'))
      const head = asString(get(entry, 'head'))
      if (!repo || !branch || !head || !/^[0-9a-f]{40,64}$/.test(head) || heads.some((h) => h.repo === repo))
        return { error }
      heads.push({ repo, branch, head })
    }
  }
  if (!files || Object.values(files).some((v) => typeof v !== 'string'))
    return { error: 'envelope files must contain strings' }
  return { nonce, version: value.version, heads, files: files as Record<string, string> }
}
export const allowedTarget = (role: string, name: string, integration: boolean, planOnly: boolean): string | null => {
  if (!['design', 'design_review', 'exec', 'exec_review'].includes(role)) return null
  if (name === 'result.md') return `roles/${role}/result.md`
  if (role === 'design' && planOnly && (name === 'plan.md' || name === 'plan-result.json')) return name
  if (integration && name === 'auto-result.json') return name
  const prefix = role.startsWith('exec') ? 'code' : 'plan'
  const suffix = role.endsWith('_review') ? 'findings' : 'request'
  return new RegExp(`^review/${prefix}-round-[1-9][0-9]?-${suffix}\\.md$`).test(name) ? name : null
}
export const materialize = (
  statusDir: string,
  role: string,
  envelope: Envelope,
  integration: boolean,
  planOnly: boolean,
): string => {
  const targets: Array<{ target: string; body: string }> = []
  for (const [name, body] of Object.entries(envelope.files)) {
    const target = allowedTarget(role, name, integration, planOnly)
    if (!target) return `the envelope file ${name} is not allowed for ${role}`
    targets.push({ target, body })
  }
  for (const { target, body } of targets) {
    try {
      mkdirSync(dirname(join(statusDir, target)), { recursive: true })
    } catch {
      return `cannot create the directory for ${target}`
    }
    if (!writeAtomic(join(statusDir, target), body)) return `cannot write ${target}`
  }
  return ''
}
