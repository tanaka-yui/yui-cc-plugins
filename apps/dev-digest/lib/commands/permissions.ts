import { die, log, parseFlags } from '../cli.ts'
import { digestHome } from '../paths.ts'
import { applyRules, proposedRules, replaceRules } from '../permissions.ts'

const NAME = 'dev-digest permissions'
const EXIT_FAILED = 1

// --show は書き込み先と書き方とルールを出すだけ（ルールにはパスしか入らず、秘密は含まない）。
// project（作業フォルダ）の allow はこの一覧で置き換えてモードを決め、user の deny には無いものだけ足す
export const run = (argv: string[]): void => {
  const { values } = parseFlags(NAME, {
    args: argv,
    options: { show: { type: 'boolean' }, apply: { type: 'boolean' } },
  })
  if (values.show === values.apply) die(NAME, '--show か --apply のどちらか一方を指定してください')
  const rules = proposedRules(digestHome())
  if (values.show) {
    const lines = [
      `project=${rules.project.file} mode=replace`,
      `  defaultMode ${rules.project.defaultMode}`,
      ...rules.project.allow.map((rule) => `  allow ${rule}`),
      `user=${rules.user.file} mode=add`,
      ...rules.user.deny.map((rule) => `  deny ${rule}`),
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    return
  }
  try {
    const project = replaceRules(rules.project.file, 'allow', rules.project.allow, rules.project.defaultMode)
    const user = applyRules(rules.user.file, 'deny', rules.user.deny)
    process.stdout.write(`replaced project=${project} added user=${user}\n`)
  } catch (error) {
    log(NAME, error instanceof Error ? error.message : String(error))
    process.exitCode = EXIT_FAILED
  }
}
