import { intakeHome } from '../../lib/paths.ts'
import { findSlackCli, runDeploy, slackProject, writeProject } from '../../lib/slack-cli.ts'

// process.env を変えたまま呼ぶための小さな実行器。テストが子プロセスとして起動する
const [mode] = process.argv.slice(2)
if (mode === 'find') {
  console.log(findSlackCli() ?? 'null')
} else if (mode === 'deploy') {
  const project = slackProject(intakeHome())
  writeProject(project)
  process.exitCode = runDeploy(findSlackCli() ?? '', project, null)
}
