import { parseFlags } from '../cli.ts'
import {
  DECISIONS_FILE,
  DETAILS_MAX_CHARS,
  MAX_QUESTIONS_PER_ROUND,
  QUESTION_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  UNRESOLVED_ITEM_MAX_CHARS,
  UNRESOLVED_MAX_ITEMS,
  WORK_FILE,
} from '../defaults.ts'
import { homePaths, intakeHome, pluginRoot } from '../paths.ts'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
export const run = (argv: string[]): void => {
  parseFlags('procedure', { args: argv, options: {} })
  const paths = homePaths(intakeHome())
  const values: Record<string, string | number> = {
    LAUNCHER: paths.launcher,
    RUN_DIR: paths.runDir,
    WORK_FILE,
    DECISIONS_FILE,
    MAX_QUESTIONS: MAX_QUESTIONS_PER_ROUND,
    QUESTION_MAX_CHARS,
    SUMMARY_MAX_CHARS,
    DETAILS_MAX_CHARS,
    UNRESOLVED_MAX_ITEMS,
    UNRESOLVED_ITEM_MAX_CHARS,
  }
  const template = readFileSync(join(pluginRoot(), 'skills/slack-issue-intake/references/procedure.md'), 'utf8')
  console.log(template.replace(/{{([A-Z_]+)}}/g, (match, key: string) => String(values[key] ?? match)))
}
