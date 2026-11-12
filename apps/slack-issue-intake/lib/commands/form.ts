import { parseFlags } from '../cli.ts'
import { getMeta, setMeta } from '../db.ts'
import {
  ADMIN_LEASE_MS,
  COMMAND_DEADLINE_MS,
  FORM_META_BOOKMARK_ID,
  FORM_META_TRIGGER_ID,
  FORM_META_URL,
  MSG_FORM_REFUSED,
} from '../defaults.ts'
import { bookmarkParams, permissionParams, renderFormManifest, triggerParams } from '../form.ts'
import { asString, get } from '../json.ts'
import { acquireLease, releaseLease, renewLease } from '../lease.ts'
import { intakeHome } from '../paths.ts'
import { openRuntime } from '../runtime.ts'
import { maskSecrets } from '../secrets.ts'
import { authTest } from '../slack-api.ts'

import type { SlackFailure } from '../slack-api.ts'

const reason = (f: SlackFailure): string => (f.detail ? `${f.error} ${f.detail}` : f.error)

// --manifest: フォーム付きのマニフェストを表示する。引数なし: init のあと、対象チャンネルにフォームのボタンを置く。
// 作ったボタンとブックマークの ID は DB に残し、再実行しても重ねて作らない
export const run = async (argv: string[]): Promise<void> => {
  const { values } = parseFlags('form', { args: argv, options: { manifest: { type: 'boolean' } } })
  if (values.manifest) {
    console.log(renderFormManifest())
    return
  }
  const opened = openRuntime(intakeHome())
  if (!opened.ok) {
    console.error(opened.reason)
    process.exitCode = 2
    return
  }
  const rt = opened.runtime
  const deadline = Date.now() + COMMAND_DEADLINE_MS
  const lease = acquireLease(rt.db, 'admin', null, new Date(), ADMIN_LEASE_MS)
  if (!lease.ok) {
    console.error('処理中です。少し待ってから再実行してください')
    rt.db.close()
    process.exitCode = 1
    return
  }
  const guard = (): void => {
    if (!renewLease(rt.db, lease.token, new Date(), ADMIN_LEASE_MS)) throw new Error('lease lost')
  }
  const { channel } = rt.config
  try {
    const auth = await authTest(rt.slack, deadline)
    if (!auth.ok) throw new Error(auth.error)
    if (auth.info.teamId !== rt.config.slack.teamId) throw new Error('トークンのワークスペースが設定と違います')
    let triggerId = getMeta(rt.db, FORM_META_TRIGGER_ID)
    let url = getMeta(rt.db, FORM_META_URL)
    if (!triggerId || !url) {
      guard()
      const created = await rt.slack.call('workflows.triggers.create', triggerParams(channel), deadline)
      if (!created.ok) throw new Error(MSG_FORM_REFUSED.replace('{error}', reason(created)))
      triggerId = asString(get(created.body, 'trigger', 'id'))
      url = asString(get(created.body, 'trigger', 'shortcut_url'))
      if (!triggerId || !url) throw new Error('ボタンを作った応答に ID か URL がありません')
      // 作ったものは、リースを確かめる前にすぐ記録する（ほかの処理とは別のキーなので競合しない）。再実行で重ねないため
      setMeta(rt.db, FORM_META_TRIGGER_ID, triggerId)
      setMeta(rt.db, FORM_META_URL, url)
    }
    guard()
    const permitted = await rt.slack.call(
      'workflows.triggers.permissions.set',
      permissionParams(triggerId, channel),
      deadline,
    )
    if (!permitted.ok) throw new Error(`ボタンを使える人を設定できません（${reason(permitted)}）`)
    let bookmarkId = getMeta(rt.db, FORM_META_BOOKMARK_ID)
    if (!bookmarkId) {
      guard()
      const added = await rt.slack.call('bookmarks.add', bookmarkParams(channel, url), deadline)
      if (!added.ok)
        throw new Error(
          `ブックマークを追加できません（${reason(added)}）。次の URL を手でブックマークに追加してください: ${url}`,
        )
      // 応答に ID が無くても追加はされているので、空でない値を残して再実行で重ねない
      bookmarkId = asString(get(added.body, 'bookmark', 'id')) ?? '-'
      setMeta(rt.db, FORM_META_BOOKMARK_ID, bookmarkId)
    }
    console.log(`trigger=${triggerId}\nurl=${url}\nchannel=${channel}\nbookmark=${bookmarkId}`)
  } catch (error) {
    console.error(maskSecrets(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    releaseLease(rt.db, lease.token)
    rt.db.close()
  }
}
