import { health } from '../health'

import { describe, expect, it } from 'bun:test'

describe('Health endpoint', () => {
  it('/health にGETリクエストでステータスを返す', async () => {
    const req = new Request('http://localhost/health')
    const res = await health.fetch(req)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      status: string
      cmux: string
      uptime: number
    }
    expect(body.status).toBe('ok')
    expect(['connected', 'disconnected']).toContain(body.cmux)
    expect(typeof body.uptime).toBe('number')
  })
})
