import { die, log, parseFlags } from '../cli.ts'
import { digestHome } from '../paths.ts'
import { applyRules, proposedRules } from '../permissions.ts'

const NAME = 'dev-digest permissions'
const EXIT_FAILED = 1

// --show は書き込み先と足すルールを出すだけ（ルールにはパスしか入らず、秘密は含まない）
export const run = (argv: string[]): void => {
  const { values } = parseFlags(NAME, {
    args: argv,
    options: { show: { type: 'boolean' }, apply: { type: 'boolean' } },
  })
  if (values.show === values.apply) die(NAME, '--show か --apply のどちらか一方を指定してください')
  const rules = proposedRules(digestHome())
  if (values.show) {
    const lines = [
      `project=${rules.project.file}`,
      ...rules.project.allow.map((rule) => `  allow ${rule}`),
      `user=${rules.user.file}`,
      ...rules.user.deny.map((rule) => `  deny ${rule}`),
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    return
  }
  try {
    const project = applyRules(rules.project.file, 'allow', rules.project.allow)
    const user = applyRules(rules.user.file, 'deny', rules.user.deny)
    process.stdout.write(`added project=${project} user=${user}\n`)
  } catch (error) {
    log(NAME, error instanceof Error ? error.message : String(error))
    process.exitCode = EXIT_FAILED
  }
}
