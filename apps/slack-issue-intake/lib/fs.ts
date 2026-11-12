import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './defaults.ts'
import { parseJson } from './json.ts'

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Json } from './json.ts'
export const ensurePrivateDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE })
  chmodSync(dir, SECRET_DIR_MODE)
}
export const readJson = (file: string): Json | null => {
  try {
    return parseJson(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
export const writeAtomic = (file: string, value: string, mode = SECRET_FILE_MODE): void => {
  ensurePrivateDir(dirname(file))
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, value, { mode, flag: 'wx' })
    renameSync(temp, file)
    chmodSync(file, mode)
  } finally {
    rmSync(temp, { force: true })
  }
}
export const writeJson = (file: string, value: object, mode = SECRET_FILE_MODE): void =>
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
