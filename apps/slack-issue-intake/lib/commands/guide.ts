import { parseFlags } from '../cli.ts'
import { renderGuide } from '../guide.ts'
export const run = (argv: string[]): void => {
  parseFlags('guide', { args: argv, options: {} })
  console.log(renderGuide())
}
