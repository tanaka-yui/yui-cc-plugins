import { Hono } from 'hono'

import { CmuxClient } from './cmux-client'

const health = new Hono()

health.get('/health', async (c) => {
  const client = new CmuxClient()
  const cmuxAvailable = await client.checkConnection()

  return c.json({
    status: 'ok',
    cmux: cmuxAvailable ? 'connected' : 'disconnected',
    uptime: process.uptime(),
  })
})

export { health }
