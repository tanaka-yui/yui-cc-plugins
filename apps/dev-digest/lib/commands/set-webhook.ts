import { die, log, parseFlags } from '../cli.ts'
import { loadRepos } from '../config.ts'
import { GLOBAL_TARGET, WEBHOOK_PROMPT_TEMPLATE } from '../defaults.ts'
import { type InputMode, readSecret } from '../input.ts'
import { digestHome, homePaths } from '../paths.ts'
import { isWebhookUrl, maskWebhook, saveWebhook } from '../secrets.ts'

const NAME = 'dev-digest set-webhook'
const EXIT_REJECTED = 1
const EXIT_UNAVAILABLE = 4

// 値は stdout / stderr / 子プロセスの argv のどこにも出さない。出すのは固定の文言と伏せた URL だけ
export const run = (argv: string[]): void => {
  const { values } = parseFlags(NAME, {
    args: argv,
    options: {
      target: { type: 'string' },
      'from-clipboard': { type: 'boolean' },
      'from-stdin': { type: 'boolean' },
    },
  })
  const target = values.target ?? die(NAME, '--target <global|owner/repo> を指定してください')
  if (values['from-clipboard'] && values['from-stdin'])
    die(NAME, '--from-clipboard と --from-stdin は同時に指定できません')

  const home = digestHome()
  if (target !== GLOBAL_TARGET && !loadRepos(home).some((repo) => repo.slug === target))
    die(NAME, '--target は global か登録済みのリポジトリの slug を指定してください')

  const mode: InputMode = values['from-stdin']
    ? 'stdin'
    : values['from-clipboard'] || process.platform !== 'darwin'
      ? 'clipboard'
      : 'dialog'
  const result = readSecret(mode, WEBHOOK_PROMPT_TEMPLATE.replace('{target}', target))

  if (result.kind === 'cancelled') {
    log(NAME, '入力がキャンセルされました。何も保存していません')
    process.exitCode = EXIT_REJECTED
    return
  }
  if (result.kind === 'unavailable') {
    log(NAME, `${mode} から値を読めませんでした`)
    if (mode === 'dialog') process.stdout.write('fallback=clipboard\n')
    process.exitCode = EXIT_UNAVAILABLE
    return
  }
  if (!isWebhookUrl(result.value)) {
    log(NAME, 'Slack の Incoming Webhook URL ではありません。何も保存していません')
    process.exitCode = EXIT_REJECTED
    return
  }
  saveWebhook(homePaths(home).secrets, target, result.value)
  process.stdout.write(`saved target=${target} url=${maskWebhook(result.value)}\n`)
}
