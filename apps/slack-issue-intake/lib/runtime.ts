import { loadConfig } from './config.ts'
import { openDb } from './db.ts'
import { createGh } from './github.ts'
import { homePaths } from './paths.ts'
import { loadToken } from './secrets.ts'
import { createSlackClient } from './slack-api.ts'
import { noConfigReason, noTokenReason } from './workspace.ts'

import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { Gh } from './github.ts'
import type { HomePaths } from './paths.ts'
import type { SlackClient } from './slack-api.ts'
export type Runtime = {
  home: string
  paths: HomePaths
  config: Config
  token: string
  db: Db
  slack: SlackClient
  gh: Gh
}
export const openRuntime = (home: string): { ok: true; runtime: Runtime } | { ok: false; reason: string } => {
  const paths = homePaths(home)
  const config = loadConfig(home)
  if (!config) return { ok: false, reason: noConfigReason(home) }
  const token = loadToken(paths.secrets)
  if (!token) return { ok: false, reason: noTokenReason(home) }
  return {
    ok: true,
    runtime: {
      home,
      paths,
      config,
      token,
      db: openDb(paths.db),
      slack: createSlackClient(token),
      gh: createGh(config.ghPath),
    },
  }
}
