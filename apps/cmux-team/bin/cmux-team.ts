#!/usr/bin/env bun

// cmux-team CLI ラッパー
// bun で src/main.ts を実行する

const mainTs = `${import.meta.dir}/../src/main.ts`

// bun の存在確認
const bunCheck = Bun.spawnSync(['which', 'bun'], { stderr: 'ignore' })
if (bunCheck.exitCode !== 0) {
  console.error('エラー: bun がインストールされていません。')
  console.error('インストール: https://bun.sh/docs/installation')
  process.exit(1)
}

// 引数を透過して bun run で実行
const args = process.argv.slice(2)

if (args[0] === 'start') {
  // start コマンド: exit code 42 で自動再起動
  let restarts = 0
  const MAX_RESTARTS = 10
  while (restarts < MAX_RESTARTS) {
    const result = Bun.spawnSync(['bun', 'run', mainTs, ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
    })
    if (result.exitCode === 42) {
      restarts++
      console.log(`♻ daemon auto-restart (${restarts}/${MAX_RESTARTS})`)
      Bun.spawnSync(['sleep', '1'])
      continue
    }
    if (result.exitCode !== 0) {
      process.exit(result.exitCode ?? 1)
    }
    break // 正常終了
  }
  if (restarts >= MAX_RESTARTS) {
    console.error('Error: daemon restart limit reached')
    process.exit(1)
  }
} else {
  const result = Bun.spawnSync(['bun', 'run', mainTs, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(result.exitCode ?? 0)
}
