import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME_ENV = 'DEV_DIGEST_HOME'
const HOME_DIRNAME = '.dev-digest'

// 設定・DB・秘密情報を置く場所。環境変数で差し替えられる（テスト用）
export const digestHome = (): string => process.env[HOME_ENV] || join(homedir(), HOME_DIRNAME)

export type HomePaths = {
  config: string
  reposDir: string
  secrets: string
  db: string
  binDir: string
  launcher: string
  launcherScript: string
  runDir: string
}

export const homePaths = (home: string): HomePaths => {
  const binDir = join(home, 'bin')
  return {
    config: join(home, 'config.json'),
    reposDir: join(home, 'repos'),
    secrets: join(home, 'secrets.json'),
    db: join(home, 'digest.db'),
    binDir,
    launcher: join(binDir, 'dev-digest'),
    launcherScript: join(binDir, 'launch.ts'),
    runDir: join(home, 'run'),
  }
}
