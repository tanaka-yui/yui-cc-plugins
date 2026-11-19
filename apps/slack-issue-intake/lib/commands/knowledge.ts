import { parseFlags } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { KNOWLEDGE_ERRORS } from '../defaults.ts'
import { buildRepos } from '../knowledge.ts'
import { intakeHome } from '../paths.ts'
import { maskSecrets } from '../secrets.ts'
import { noConfigReason } from '../workspace.ts'

// 仕様の索引（knowledge）を作り直す（make knowledge）。--repo が無ければ設定のリポジトリすべて
export const run = (argv: string[]): void => {
  const { values } = parseFlags('knowledge', { args: argv, options: { repo: { type: 'string' } } })
  const home = intakeHome()
  const config = loadConfig(home)
  if (!config) {
    console.error(noConfigReason(home))
    process.exitCode = 2
    return
  }
  const names = config.repos.map((r) => r.name)
  const repos = values.repo ? names.filter((name) => name.toLowerCase() === values.repo?.toLowerCase()) : names
  if (!repos.length) {
    console.error(`${KNOWLEDGE_ERRORS.unknownRepo}: ${maskSecrets(values.repo ?? '')}`)
    process.exitCode = 2
    return
  }
  const ok = buildRepos(
    home,
    repos,
    config.ghPath,
    (line) => console.log(maskSecrets(line)),
    (line) => console.error(maskSecrets(line)),
  )
  process.exitCode = ok ? 0 : 1
}
