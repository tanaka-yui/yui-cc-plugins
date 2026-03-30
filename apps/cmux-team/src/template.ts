/**
 * テンプレート検索・変数展開
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function findTemplateDir(): string | null {
  // 1. daemon 自身からの相対パス（src/ の兄弟 templates/）
  //    src/template.ts → ../templates/
  const fromSelf = join(dirname(import.meta.path), '../templates')
  if (existsSync(join(fromSelf, 'master.md'))) return fromSelf

  // 2. プロジェクトローカル
  const projectRoot = process.env.PROJECT_ROOT || process.cwd()
  const local = join(projectRoot, 'templates')
  if (existsSync(join(local, 'master.md'))) return local

  return null
}

export async function generateMasterPrompt(projectRoot: string): Promise<void> {
  const promptsDir = join(projectRoot, '.team/prompts')
  await mkdir(promptsDir, { recursive: true })
  const dst = join(promptsDir, 'master.md')

  const templateDir = findTemplateDir()
  if (!templateDir) {
    throw new Error('Template directory not found. npm install -g cmux-team を実行してください')
  }

  await cp(join(templateDir, 'master.md'), dst)
}

export async function generateConductorRolePrompt(projectRoot: string): Promise<string> {
  const templateDir = findTemplateDir()
  if (!templateDir || !existsSync(join(templateDir, 'conductor-role.md'))) {
    throw new Error('Conductor role template not found. npm install -g cmux-team を実行してください')
  }

  const promptsDir = join(projectRoot, '.team/prompts')
  await mkdir(promptsDir, { recursive: true })

  const promptFile = join(promptsDir, 'conductor-role.md')

  let content = await readFile(join(templateDir, 'conductor-role.md'), 'utf-8')
  content = content.replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)

  await writeFile(promptFile, content)
  return promptFile
}

export async function generateConductorTaskPrompt(
  projectRoot: string,
  conductorId: string,
  _taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string,
): Promise<string> {
  const templateDir = findTemplateDir()
  if (!templateDir || !existsSync(join(templateDir, 'conductor-task.md'))) {
    throw new Error('Conductor task template not found. npm install -g cmux-team を実行してください')
  }

  const promptsDir = join(projectRoot, '.team/prompts')
  await mkdir(promptsDir, { recursive: true })

  const promptFile = join(promptsDir, `${conductorId}.md`)

  let content = await readFile(join(templateDir, 'conductor-task.md'), 'utf-8')

  content = content
    .replace(/\{\{TASK_CONTENT\}\}/g, taskContent)
    .replace(/\{\{WORKTREE_PATH\}\}/g, worktreePath)
    .replace(/\{\{OUTPUT_DIR\}\}/g, join(projectRoot, outputDir))
    .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
    .replace(/\{\{CONDUCTOR_ID\}\}/g, conductorId)

  await writeFile(promptFile, content)
  return promptFile
}
