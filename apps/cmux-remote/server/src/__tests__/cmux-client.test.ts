import { CmuxClient } from '../cmux-client'

import { describe, expect, it } from 'bun:test'

describe('CmuxClient', () => {
  it('デフォルトで未接続状態である', () => {
    const client = new CmuxClient('/tmp/nonexistent.sock')
    expect(client.isConnected).toBe(false)
  })

  it('存在しないソケットへの接続でエラーを返す', async () => {
    const client = new CmuxClient('/tmp/nonexistent-cmux-test.sock')
    await expect(client.connect()).rejects.toThrow()
  })

  it('未接続状態でsendするとエラーを投げる', () => {
    const client = new CmuxClient('/tmp/nonexistent.sock')
    expect(() => client.send('test')).toThrow('Not connected to cmux socket')
  })

  it('disconnectを安全に呼べる（未接続時）', () => {
    const client = new CmuxClient('/tmp/nonexistent.sock')
    expect(() => client.disconnect()).not.toThrow()
  })

  it('存在しないソケットのcheckConnectionはfalseを返す', async () => {
    const client = new CmuxClient('/tmp/nonexistent-cmux-test.sock')
    const result = await client.checkConnection()
    expect(result).toBe(false)
  })
})
