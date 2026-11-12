import { MSG_HOOK_NO_TOKEN, SLACK_HOOK_TOKEN_ENV } from '../defaults.ts'
import { renderFormManifest } from '../form.ts'
import { homePaths, intakeHome } from '../paths.ts'
import { isBotToken, maskToken, saveToken } from '../secrets.ts'
import { hooksInterface, manifestHash, saveDeployedHash, slackProject } from '../slack-cli.ts'

// Slack CLI が呼ぶフック。get-hooks / get-manifest は標準出力に JSON を返し、deploy は今のアプリのボットトークンを保存する
export const run = (argv: string[]): void => {
  const [hook] = argv
  if (hook === 'get-hooks') {
    console.log(JSON.stringify(hooksInterface()))
  } else if (hook === 'get-manifest') {
    console.log(renderFormManifest())
  } else if (hook === 'deploy') {
    // Slack CLI はアプリをマニフェストどおりに作ってインストールしたあとでこのフックを呼ぶ。
    // トークンを受け取れなくても、ここまで来ればアプリは今の版になっているので指紋を残す（set-token のあと deploy し直さない）
    saveDeployedHash(slackProject(intakeHome()), manifestHash())
    const token = process.env[SLACK_HOOK_TOKEN_ENV]
    if (token && isBotToken(token)) {
      saveToken(homePaths(intakeHome()).secrets, token)
      console.log(`saved token=${maskToken(token)}`)
    } else {
      console.error(MSG_HOOK_NO_TOKEN)
      process.exitCode = 1
    }
  } else {
    console.error('使用法: slack-hook <get-hooks|get-manifest|deploy>')
    process.exitCode = 2
  }
}
