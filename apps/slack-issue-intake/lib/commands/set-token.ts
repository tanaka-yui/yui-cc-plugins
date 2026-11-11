import { parseFlags } from '../cli.ts'
import { TOKEN_PROMPT } from '../defaults.ts'
import { readSecret } from '../input.ts'
import { homePaths, intakeHome } from '../paths.ts'
import { isBotToken, maskToken, saveToken } from '../secrets.ts'
export const run = (argv: string[]): void => {
  const { values } = parseFlags('set-token', {
    args: argv,
    options: { 'from-stdin': { type: 'boolean' }, 'from-clipboard': { type: 'boolean' } },
  })
  if (values['from-stdin'] && values['from-clipboard']) {
    process.exitCode = 2
    return
  }
  const mode = values['from-stdin']
    ? 'stdin'
    : values['from-clipboard'] || process.platform !== 'darwin'
      ? 'clipboard'
      : 'dialog'
  const input = readSecret(mode, TOKEN_PROMPT)
  if (input.kind !== 'value') {
    if (input.kind === 'unavailable' && mode === 'dialog') console.log('fallback=clipboard')
    process.exitCode = input.kind === 'cancelled' ? 1 : 4
    return
  }
  if (!isBotToken(input.value)) {
    console.error('Bot User OAuth Token（xoxb-）ではありません。何も保存していません')
    process.exitCode = 1
    return
  }
  saveToken(homePaths(intakeHome()).secrets, input.value)
  console.log(`saved token=${maskToken(input.value)}`)
}
