import { createGh } from '../../lib/github.ts'

import { writeFileSync } from 'node:fs'

const [path = '', record = ''] = process.argv.slice(2)
await createGh(path)(['issue', 'create'], Date.now() + 5000, (child) => {
  writeFileSync(record, JSON.stringify(child))
  process.exit(1)
})
