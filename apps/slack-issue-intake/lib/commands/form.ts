import { parseFlags } from '../cli.ts'
import { deleteMeta, getMeta, setMeta } from '../db.ts'
import {
  ADMIN_LEASE_MS,
  COMMAND_DEADLINE_MS,
  ERROR_RESTRICTED_ACTION,
  FORM_FEATURED_MANUAL,
  FORM_KINDS,
  FORM_META_FEATURED,
  FORM_META_TRIGGER_ID,
  FORM_META_URL,
  formMetaKey,
  MSG_FORM_FEATURE_BY_HAND,
  MSG_FORM_FEATURE_FAILED,
  MSG_FORM_LEGACY_DELETE_FAILED,
  MSG_FORM_LEGACY_KEPT,
  MSG_FORM_NO_APP,
  MSG_FORM_NO_CLI,
  MSG_FORM_REFUSED,
  MSG_FORM_STALE_MANIFEST,
  TRIGGER_NOT_FOUND_PATTERN,
} from '../defaults.ts'
import { featuredParams, featureSteps, renderFormManifest } from '../form.ts'
import { acquireLease, releaseLease, renewLease } from '../lease.ts'
import { intakeHome } from '../paths.ts'
import { openRuntime } from '../runtime.ts'
import { maskSecrets } from '../secrets.ts'
import { authTest } from '../slack-api.ts'
import {
  createTrigger,
  deleteTrigger,
  deployedApp,
  findSlackCli,
  grantTriggerAccess,
  manifestHash,
  readDeployedHash,
  slackProject,
  writeProject,
  writeTriggerDef,
} from '../slack-cli.ts'

import type { SlackFailure } from '../slack-api.ts'
import type { FormKind } from '../types.ts'

const reason = (f: SlackFailure): string => (f.detail ? `${f.error} ${f.detail}` : f.error)

// --manifest: フォーム付きのマニフェストを表示する。引数なし: init のあと、対象チャンネルにフォームのボタンを置く。
// ボタンはチャンネルのおすすめワークフローにする（メンバーには入力欄の代わりにボタンが出る）。
// 作ったリンクとおすすめにしたトリガーの ID は DB に残し、再実行しても重ねて作らない
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
  const bin = findSlackCli()
  const project = slackProject(rt.home)
  const app = deployedApp(project)
  if (!bin || !app) {
    console.error(!app ? MSG_FORM_NO_APP : MSG_FORM_NO_CLI)
    rt.db.close()
    process.exitCode = 2
    return
  }
  // プラグインを更新するとフックのパスが古くなるので、Slack CLI を呼ぶ前に書き直す
  writeProject(project)
  // deploy 済みのアプリに今のワークフローが無いと、ボタンを作れない。Workflow Builder ではなく make setup へ案内する
  if (readDeployedHash(project) !== manifestHash()) {
    console.error(MSG_FORM_STALE_MANIFEST)
    rt.db.close()
    process.exitCode = 2
    return
  }
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
    if (auth.info.teamId !== rt.config.slack.teamId || app.teamId !== rt.config.slack.teamId)
      throw new Error('トークンのワークスペースが設定と違います')
    const triggers: { kind: FormKind; triggerId: string; url: string }[] = []
    for (const kind of FORM_KINDS) {
      const idKey = formMetaKey(FORM_META_TRIGGER_ID, kind)
      const urlKey = formMetaKey(FORM_META_URL, kind)
      let triggerId = getMeta(rt.db, idKey)
      let url = getMeta(rt.db, urlKey)
      if (!triggerId || !url) {
        guard()
        const defPath = writeTriggerDef(project, channel, kind)
        const created = createTrigger(bin, project, app.teamId, defPath)
        if (!created.ok) throw new Error(MSG_FORM_REFUSED.replace('{error}', created.error))
        triggerId = created.triggerId
        url = created.url
        // 作ったものは、リースを確かめる前にすぐ記録する（ほかの処理とは別のキーなので競合しない）。再実行で重ねないため
        setMeta(rt.db, idKey, triggerId)
        setMeta(rt.db, urlKey, url)
      }
      triggers.push({ kind, triggerId, url })
    }
    for (const t of triggers) {
      guard()
      const permitted = grantTriggerAccess(bin, project, app.teamId, t.triggerId, channel)
      if (!permitted.ok) throw new Error(`ボタンを使える人を設定できません（${permitted.error}）`)
    }
    const ids = triggers.map((t) => t.triggerId)
    const wanted = ids.join(',')
    let featuredState = getMeta(rt.db, FORM_META_FEATURED)
    if (featuredState !== wanted) {
      guard()
      const featured = await rt.slack.call('workflows.featured.add', featuredParams(channel, ids), deadline)
      if (featured.ok) featuredState = wanted
      else if (featured.error === ERROR_RESTRICTED_ACTION) {
        // 権限の問題なので再実行しても通らない。画面での手順を示し、setup が先へ進めるよう印を残す
        console.error(MSG_FORM_FEATURE_BY_HAND.replace('{steps}', featureSteps()))
        featuredState = FORM_FEATURED_MANUAL
      } else
        throw new Error(MSG_FORM_FEATURE_FAILED.replace('{error}', reason(featured)).replace('{steps}', featureSteps()))
      setMeta(rt.db, FORM_META_FEATURED, featuredState)
    }
    // 0.2 の 1 つのボタンは、新しい 3 つを出したあとで外して消す。チャンネルからボタンが消える時間を作らない
    const legacy = getMeta(rt.db, FORM_META_TRIGGER_ID)
    // 新しい 3 つを画面で注目にしてもらうまでは、古いボタンを残す（チャンネルからボタンが消えないように）
    if (legacy && featuredState === FORM_FEATURED_MANUAL) console.error(MSG_FORM_LEGACY_KEPT)
    else if (legacy) {
      guard()
      // すでに外れていることがあるので、失敗しても先へ進む
      await rt.slack.call('workflows.featured.remove', featuredParams(channel, [legacy]), deadline)
      guard()
      const deleted = deleteTrigger(bin, project, app.teamId, legacy)
      if (deleted.ok || TRIGGER_NOT_FOUND_PATTERN.test(deleted.error)) {
        deleteMeta(rt.db, FORM_META_TRIGGER_ID)
        deleteMeta(rt.db, FORM_META_URL)
      } else console.error(MSG_FORM_LEGACY_DELETE_FAILED.replace('{trigger}', legacy).replace('{error}', deleted.error))
    }
    console.log(
      [
        ...triggers.flatMap((t) => [`trigger.${t.kind.key}=${t.triggerId}`, `url.${t.kind.key}=${t.url}`]),
        `channel=${channel}`,
        `featured=${featuredState}`,
      ].join('\n'),
    )
  } catch (error) {
    console.error(maskSecrets(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    releaseLease(rt.db, lease.token)
    rt.db.close()
  }
}
