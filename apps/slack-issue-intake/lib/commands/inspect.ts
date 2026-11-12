import { fileRefsFromMessage, permalinkFileIds } from '../attachments.ts'
import { parseFlags } from '../cli.ts'
import { loadConfig } from '../config.ts'
import { COMMAND_DEADLINE_MS, HISTORY_PAGE_LIMIT } from '../defaults.ts'
import { asString } from '../json.ts'
import { parseSubmission } from '../parse.ts'
import { homePaths, intakeHome } from '../paths.ts'
import { loadToken, maskSecrets } from '../secrets.ts'
import { createSlackClient, fetchLatest } from '../slack-api.ts'
import { messageText } from '../slack-text.ts'
export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags('inspect', {
    args: argv,
    options: { limit: { type: 'string' }, raw: { type: 'boolean' } },
  })
  const limit = Number(values.limit ?? 5)
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_LIMIT) {
    process.exitCode = 2
    return
  }
  const home = intakeHome()
  const config = loadConfig(home)
  const token = loadToken(homePaths(home).secrets)
  if (!config || !token) {
    console.error('init と set-token を先に実行してください')
    process.exitCode = 2
    return
  }
  const latest = await fetchLatest(createSlackClient(token), config.channel, limit, Date.now() + COMMAND_DEADLINE_MS)
  if (!latest.ok) {
    console.error(maskSecrets(latest.error))
    process.exitCode = 1
    return
  }
  const line = (text: string): string => maskSecrets(text.replace(/[\r\n]/g, ' '))
  for (const m of latest.messages) {
    const { text, source } = messageText(m)
    const own = m.user === config.slack.botUserId || m.bot_id === config.slack.botId
    const parsed = parseSubmission(text, own ? null : asString(m.user))
    const f = parsed.kind === 'ok' ? parsed.fields : null
    const reporter =
      parsed.kind === 'ok' ? parsed.fields.reporterId : parsed.kind === 'invalid' ? parsed.reporterId : null
    console.log(
      line(
        `ts=${m.ts} marker=${parsed.kind === 'not-submission' ? 'no' : 'yes'} source=${source} user=${asString(m.user) ?? '-'} bot=${m.bot_id || m.user === config.slack.botUserId ? 'yes' : 'no'} files=${fileRefsFromMessage(m).length} file_links=${permalinkFileIds(m).length} parse=${parsed.kind === 'not-submission' ? '-' : parsed.kind} title=${f?.title ?? '-'} category=${f?.category ?? '-'} priority=${f?.priority ?? '-'} reporter=${reporter ?? '-'} problems=${parsed.kind === 'invalid' ? parsed.problems.join('、') : '-'}`,
      ),
    )
    if (values.raw) console.log(maskSecrets(JSON.stringify(m, null, 2)))
  }
}
