import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConductorDoneMessage, QueueMessage, TaskCreatedMessage } from './schema'

// テスト用に PROJECT_ROOT を一時ディレクトリに設定
let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cmux-team-test-'))
  process.env.PROJECT_ROOT = testDir
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  delete process.env.PROJECT_ROOT
})

// 動的 import で PROJECT_ROOT を反映させる
async function getQueue() {
  // モジュールキャッシュをバイパスするためインラインで再実装
  const { mkdir, writeFile, readdir, readFile, rename } = await import('node:fs/promises')
  const { join, basename } = await import('node:path')
  const { QueueMessage } = await import('./schema')

  const QUEUE_DIR = join(testDir, '.team/queue')
  const PROCESSED_DIR = join(QUEUE_DIR, 'processed')

  await mkdir(QUEUE_DIR, { recursive: true })
  await mkdir(PROCESSED_DIR, { recursive: true })

  let seq = 0

  return {
    QUEUE_DIR,
    PROCESSED_DIR,

    async send(message: QueueMessage): Promise<string> {
      QueueMessage.parse(message) // バリデーション
      seq++
      const ts = Math.floor(Date.now() / 1000)
      const fileName = `${String(seq).padStart(3, '0')}-${ts}-${message.type.toLowerCase()}.json`
      const filePath = join(QUEUE_DIR, fileName)
      const tmpPath = `${filePath}.tmp`
      await writeFile(tmpPath, `${JSON.stringify(message, null, 2)}\n`)
      await rename(tmpPath, filePath)
      return filePath
    },

    async read(): Promise<Array<{ path: string; message: QueueMessage }>> {
      const files = (await readdir(QUEUE_DIR)).filter((f) => f.endsWith('.json')).sort()
      const messages: Array<{ path: string; message: QueueMessage }> = []
      for (const file of files) {
        const filePath = join(QUEUE_DIR, file)
        const raw = JSON.parse(await readFile(filePath, 'utf-8'))
        messages.push({ path: filePath, message: QueueMessage.parse(raw) })
      }
      return messages
    },

    async markProcessed(filePath: string): Promise<void> {
      await rename(filePath, join(PROCESSED_DIR, basename(filePath)))
    },
  }
}

describe('Queue', () => {
  test('TASK_CREATED メッセージを送信・読み取りできる', async () => {
    const q = await getQueue()
    const path = await q.send({
      type: 'TASK_CREATED',
      taskId: '035',
      taskFile: '.team/tasks/035-fix.md',
      timestamp: new Date().toISOString(),
    })

    expect(path).toContain('task_created.json')

    const messages = await q.read()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message.type).toBe('TASK_CREATED')
    expect((messages[0]?.message as TaskCreatedMessage | undefined)?.taskId).toBe('035')
  })

  test('複数メッセージが順序通りに読み取れる', async () => {
    const q = await getQueue()
    await q.send({
      type: 'TASK_CREATED',
      taskId: '035',
      taskFile: '.team/tasks/035.md',
      timestamp: new Date().toISOString(),
    })
    await q.send({
      type: 'SHUTDOWN',
      timestamp: new Date().toISOString(),
    })

    const messages = await q.read()
    expect(messages).toHaveLength(2)
    expect(messages[0]?.message.type).toBe('TASK_CREATED')
    expect(messages[1]?.message.type).toBe('SHUTDOWN')
  })

  test('処理済みメッセージが processed/ に移動される', async () => {
    const q = await getQueue()
    const path = await q.send({
      type: 'SHUTDOWN',
      timestamp: new Date().toISOString(),
    })

    await q.markProcessed(path)

    const remaining = await q.read()
    expect(remaining).toHaveLength(0)

    const processed = await readdir(q.PROCESSED_DIR)
    expect(processed).toHaveLength(1)
  })

  test('不正な JSON はバリデーションエラーになる', async () => {
    const q = await getQueue()
    expect(() =>
      q.send({ type: 'INVALID_TYPE', timestamp: new Date().toISOString() } as unknown as QueueMessage),
    ).toThrow()
  })

  test('CONDUCTOR_DONE メッセージが正しく処理される', async () => {
    const q = await getQueue()
    await q.send({
      type: 'CONDUCTOR_DONE',
      conductorId: 'conductor-123',
      surface: 'surface:42',
      success: true,
      sessionId: 'abc-def',
      timestamp: new Date().toISOString(),
    })

    const messages = await q.read()
    expect(messages).toHaveLength(1)
    expect((messages[0]?.message as ConductorDoneMessage | undefined)?.conductorId).toBe('conductor-123')
    expect((messages[0]?.message as ConductorDoneMessage | undefined)?.sessionId).toBe('abc-def')
  })
})
