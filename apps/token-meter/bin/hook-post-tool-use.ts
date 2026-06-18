#!/usr/bin/env bun

import { handlePost } from '../lib/handler'
import { appendErrorLog } from '../lib/logger'
import { ToolPayloadSchema } from '../lib/schemas'

import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.TOKEN_METER_HOME ?? join(homedir(), '.claude', 'token-meter')
const LOGS = join(HOME, 'logs')
const STATE = join(HOME, 'state.json')

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  const json = JSON.parse(raw)
  const payload = ToolPayloadSchema.parse(json)
  handlePost(payload, { logsDir: LOGS, statePath: STATE })
}

main()
  .catch((e) => appendErrorLog(e, LOGS))
  .finally(() => process.exit(0))
