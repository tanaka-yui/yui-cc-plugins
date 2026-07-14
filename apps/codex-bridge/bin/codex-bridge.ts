#!/usr/bin/env bun

import { main } from '../src/generate.ts'

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  home: process.env.HOME ?? '',
})
process.exit(code)
