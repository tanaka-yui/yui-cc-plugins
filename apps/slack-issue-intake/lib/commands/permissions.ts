import { parseFlags } from '../cli.ts'
import { PERMISSION_ASSUMPTIONS } from '../defaults.ts'
import { intakeHome } from '../paths.ts'
import { applyProject, applyUserDeny, inheritedGrants, proposedRules } from '../permissions.ts'
import { maskSecrets } from '../secrets.ts'
export const run = (argv: string[]): void => {
  const { values } = parseFlags('permissions', {
    args: argv,
    options: { show: { type: 'boolean' }, apply: { type: 'boolean' } },
  })
  if (Boolean(values.show) === Boolean(values.apply)) {
    console.error('--show または --apply を1つ指定してください')
    process.exitCode = 2
    return
  }
  const rules = proposedRules(intakeHome())
  if (values.apply) {
    applyProject(rules)
    const added = applyUserDeny(rules)
    console.log(`project=${rules.project.file}\nuser=${rules.user.file} deny_added=${added}`)
    return
  }
  console.log(
    `project=${rules.project.file}\ndefaultMode=${rules.project.defaultMode}\ndisableBypassPermissionsMode=${rules.project.disableBypassPermissionsMode}`,
  )
  for (const r of rules.project.allow) console.log(`allow ${r}`)
  for (const r of rules.project.deny) console.log(`deny ${r}`)
  console.log(`user=${rules.user.file}`)
  for (const r of rules.user.deny) console.log(`deny ${r}`)
  const inherited = inheritedGrants()
  if (inherited) {
    for (const rule of inherited.allow) console.log(maskSecrets(`inherited-allow ${rule}`))
    for (const dir of inherited.dirs) console.log(maskSecrets(`inherited-dir ${dir}`))
  } else console.log('受け継ぐ許可を読めません')
  console.log(PERMISSION_ASSUMPTIONS)
}
