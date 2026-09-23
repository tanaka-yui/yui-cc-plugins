import { type Json, parseJson } from './json.ts'

import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

// 読めない・壊れているファイルは null。どちらも「その記録は無い」として扱う
export const readJson = (file: string): Json | null => {
  try {
    return parseJson(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// 同じディレクトリの一時ファイルに書いてから rename で置き換える。途中で落ちても半端なファイルを残さない。
// 書けなかったときは必ず false を返す（例外を外へ出さない）
export const writeAtomic = (file: string, content: string): boolean => {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx' })
    renameSync(temporary, file)
    return true
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // ★ 片付けは best effort。ここで投げると「書けなかった」という結果ごと失われる
    }
    return false
  }
}
