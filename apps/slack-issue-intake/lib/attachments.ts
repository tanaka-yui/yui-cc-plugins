import {
  EXTRA_TEXT_MIMETYPES,
  IMAGE_MIMETYPES,
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  TEXT_MIMETYPE_PREFIX,
} from './defaults.ts'
import { ensurePrivateDir, writeAtomic } from './fs.ts'
import { asArray, asObject, asString } from './json.ts'
import { maskSecrets } from './secrets.ts'
import { fileInfo } from './slack-api.ts'
import { messageText } from './slack-text.ts'

import { basename, join } from 'node:path'

import type { JsonObject } from './json.ts'
import type { SlackClient } from './slack-api.ts'
import type { FileRef } from './types.ts'
export type WorkAttachment = {
  name: string
  mimetype: string
  permalink: string
  localPath: string | null
  note: string | null
}
const fileRef = (file: JsonObject): FileRef | null => {
  const id = asString(file.id)
  if (!id || file.mode === 'tombstone' || file.mode === 'hidden_by_limit') return null
  return {
    id,
    name: maskSecrets(asString(file.name) ?? asString(file.title) ?? id),
    mimetype: asString(file.mimetype) ?? '',
    size: typeof file.size === 'number' ? file.size : 0,
    permalink: asString(file.permalink) ?? '',
    downloadUrl: asString(file.url_private_download) ?? asString(file.url_private),
  }
}
export const fileRefsFromMessage = (message: JsonObject): FileRef[] =>
  (asArray(message.files) ?? []).flatMap((v) => {
    const o = asObject(v)
    const ref = o ? fileRef(o) : null
    return ref ? [ref] : []
  })
export const permalinkFileIds = (message: JsonObject): string[] => [
  ...new Set(
    [
      ...messageText(message).text.matchAll(
        /https:\/\/[A-Za-z0-9-]+\.slack\.com\/files\/U[A-Z0-9]+\/(F[A-Z0-9]+)(?:\/|\b)/g,
      ),
    ]
      .map((m) => m[1] ?? '')
      .filter(Boolean),
  ),
]
export const resolveFiles = async (c: SlackClient, message: JsonObject, deadline: number): Promise<FileRef[]> => {
  const refs = new Map(fileRefsFromMessage(message).map((f) => [f.id, f]))
  for (const id of permalinkFileIds(message)) {
    if (refs.size >= MAX_FILES_PER_MESSAGE) break
    if (refs.has(id)) continue
    const file = await fileInfo(c, id, deadline)
    const ref = file ? fileRef(file) : null
    if (ref) refs.set(ref.id, ref)
  }
  return [...refs.values()].slice(0, MAX_FILES_PER_MESSAGE)
}
export const safeFileName = (index: number, name: string): string =>
  `${index}-${
    basename(name)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 100) || 'file'
  }`
export const downloadFiles = async (
  c: SlackClient,
  refs: FileRef[],
  dir: string,
  startIndex: number,
  deadline: number,
): Promise<WorkAttachment[]> => {
  const output: WorkAttachment[] = []
  for (const [i, f] of refs.entries()) {
    const image = IMAGE_MIMETYPES.includes(f.mimetype)
    const text = f.mimetype.startsWith(TEXT_MIMETYPE_PREFIX) || EXTRA_TEXT_MIMETYPES.includes(f.mimetype)
    const max = image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
    let localPath: string | null = null
    let note: string | null = null
    if (!image && !text) note = 'not downloaded: type'
    else if (f.size > max) note = 'not downloaded: too large'
    else if (!f.downloadUrl) note = 'not downloaded: error'
    else {
      const r = await c.download(f.downloadUrl, max, deadline)
      if (!r.ok) note = r.error === 'too_large' ? 'not downloaded: too large' : 'not downloaded: error'
      else {
        ensurePrivateDir(dir)
        localPath = join(dir, safeFileName(startIndex + i, f.name))
        if (text) writeAtomic(localPath, maskSecrets(new TextDecoder().decode(r.bytes)))
        else {
          const { writeFileSync } = await import('node:fs')
          writeFileSync(localPath, r.bytes, { mode: 0o600 })
        }
      }
    }
    output.push({ name: f.name, mimetype: f.mimetype, permalink: f.permalink, localPath, note })
  }
  return output
}
