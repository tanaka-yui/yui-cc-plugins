import { parseFlags } from '../cli.ts'
import { renderGuide } from '../guide.ts'
import { intakeHome } from '../paths.ts'
import { hintName } from '../workspace.ts'
export const run = (argv: string[]): void => {
  parseFlags('guide', { args: argv, options: {} })
  console.log(renderGuide(hintName(intakeHome())))
}
