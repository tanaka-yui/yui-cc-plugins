import { PS_ARGS } from './agent-process.ts'
import { DEFAULT_ORCA_USER_DATA, PS_MAX_BUFFER, STATUS_BAR_ITEM_ID, TRANSCRIPT_TAIL_BYTES } from './config.ts'
import { asArray, asString, isObject, parseJson } from './json.ts'

import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, open, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { OrcaWorkerApi } from 'orca/worker'
import type { Deps } from './failover.ts'

// 失敗しても stdout を返す（lsof は対象が一部読めないと exit 1 になる）
const run = (file: string, args: string[]): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: PS_MAX_BUFFER }, (error, stdout) => resolve({ ok: !error, stdout }))
  })

const orcaCli = async (args: string[]): Promise<string> => {
  const result = await run('orca', [...args, '--json'])
  if (!result.ok) throw new Error(`orca ${args.slice(0, 2).join(' ')} failed: ${result.stdout.slice(0, 200)}`)
  return result.stdout
}

export function createSystemDeps(orca: OrcaWorkerApi): Deps {
  const home = homedir()
  return {
    // プラグインの terminal.read は TUI の画面を読めないので、CLI の --screen を使う
    readTerminal: async (terminalId) => {
      const result = await run('orca', ['terminal', 'read', '--terminal', terminalId, '--screen', '--json'])
      const root = parseJson(result.stdout)
      const res = isObject(root) ? root.result : undefined
      const terminal = isObject(res) ? res.terminal : undefined
      if (!result.ok || !isObject(terminal)) {
        orca.log(`${terminalId}: terminal read failed`)
        return []
      }
      return asArray(terminal.tail).flatMap((line) => {
        const text = asString(line)
        return text === null ? [] : [text]
      })
    },
    sendText: async (terminalId, text) =>
      (await orca.host.call('terminal.sendText', { terminalId, text, enter: true })).accepted,
    listProcesses: async () => (await run('/bin/ps', PS_ARGS)).stdout,
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    readFileTail: async (path) => {
      const file = await open(path, 'r').catch(() => null)
      if (!file) return null
      try {
        const { size } = await file.stat()
        const length = Math.min(size, TRANSCRIPT_TAIL_BYTES)
        const buffer = Buffer.alloc(length)
        await file.read(buffer, 0, length, size - length)
        return buffer.toString('utf8')
      } finally {
        await file.close()
      }
    },
    globTranscripts: async (configHome, sessionId) => {
      const projects = join(configHome, 'projects')
      const dirs = await readdir(projects).catch(() => [])
      const found = await Promise.all(
        dirs.map(async (dir) => {
          const path = join(projects, dir, `${sessionId}.jsonl`)
          return (await access(path).then(
            () => true,
            () => false,
          ))
            ? [path]
            : []
        }),
      )
      return found.flat()
    },
    lsof: async (pid) => (await run('/usr/sbin/lsof', ['-p', String(pid), '-Fn'])).stdout,
    copyFile: async (from, to) => {
      await mkdir(dirname(to), { recursive: true })
      if (
        await access(to).then(
          () => true,
          () => false,
        )
      )
        return
      await copyFile(from, to)
    },
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig)
      } catch {
        // すでに終了している
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM'
      }
    },
    accountListJson: () => orcaCli(['account', 'list']),
    selectAccount: async (agent, accountId) => {
      await orcaCli(['account', 'select', '--agent', agent, '--account', accountId])
    },
    notify: async (title, body) => {
      await orca.host.call('notifications.show', { title, body })
    },
    status: async (text) => {
      await orca.host.call('statusBar.update', { id: STATUS_BAR_ITEM_ID, text })
    },
    log: (message) => orca.log(message),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule: (ms, fn) => {
      setTimeout(fn, Math.max(0, ms))
    },
    homeDir: home,
    orcaUserData: process.env.ORCA_USER_DATA_PATH ?? join(home, DEFAULT_ORCA_USER_DATA),
  }
}
