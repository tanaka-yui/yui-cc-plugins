/**
 * Master surface の作成・管理
 */

import * as cmux from './cmux'
import { log } from './logger'
import { generateMasterPrompt } from './template'
import { errorMessage } from './utils'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface MasterState {
  surface: string
}

export async function spawnMaster(projectRoot: string, daemonSurface?: string): Promise<MasterState | null> {
  try {
    // プロンプト生成
    await generateMasterPrompt(projectRoot)

    // ペイン作成（daemon surface を右に split）
    const surface = await cmux.newSplit('right', daemonSurface ? { surface: daemonSurface } : undefined)

    if (!(await cmux.validateSurface(surface))) {
      await log('error', `Master surface ${surface} validation failed`)
      return null
    }

    // proxy-port 読み取り
    let proxyPort: string | undefined
    try {
      proxyPort = (await readFile(join(projectRoot, '.team/proxy-port'), 'utf-8')).trim()
    } catch {}

    // Claude Code 起動
    const envExports = proxyPort ? `export ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort} && ` : ''
    await cmux.send(
      surface,
      `${envExports}claude --dangerously-skip-permissions --append-system-prompt-file .team/prompts/master.md 'ユーザーからのタスクを待ってください。'\n`,
    )

    // Trust 承認
    await cmux.waitForTrust(surface)

    // タブ名設定
    const num = surface.replace('surface:', '')
    await cmux.renameTab(surface, `[${num}] Master`)

    await log('master_spawned', `surface=${surface}`)
    return { surface }
  } catch (e: unknown) {
    await log('error', `Master spawn failed: ${errorMessage(e)}`)
    return null
  }
}

export async function isMasterAlive(surface: string): Promise<boolean> {
  return cmux.validateSurface(surface)
}
