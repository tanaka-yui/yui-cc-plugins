import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { join } from 'path'

import { health } from './health'
import { createWebSocketHandler } from './ws'

const app = new Hono()
const port = parseInt(process.env.PORT ?? '3456', 10)
const clientDistPath = join(import.meta.dir, '../../client/dist')

// Health check
app.route('/', health)

// Static files (PWA)
app.use('/*', serveStatic({ root: clientDistPath }))

const wsHandler = createWebSocketHandler()

const server = Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req, { data: {} as any })
      if (upgraded) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    // Hono handles the rest
    return app.fetch(req, server)
  },
  websocket: wsHandler,
})

console.log(`[server] cmux-remote bridge running on http://localhost:${server.port}`)
