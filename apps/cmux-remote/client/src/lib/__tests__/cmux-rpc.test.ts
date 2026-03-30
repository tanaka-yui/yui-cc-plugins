import { describe, expect, it } from 'vitest'

import { createRpcRequest, parseRpcResponse } from '../cmux-rpc'

describe('cmux-rpc', () => {
  describe('createRpcRequest', () => {
    it('メソッド名とパラメータを含むリクエストを生成する', () => {
      const req = createRpcRequest('workspace.list', { foo: 'bar' })
      expect(req.method).toBe('workspace.list')
      expect(req.params).toEqual({ foo: 'bar' })
      expect(req.id).toBeDefined()
    })

    it('パラメータ省略時は空オブジェクトを設定する', () => {
      const req = createRpcRequest('system.tree')
      expect(req.params).toEqual({})
    })

    it('呼び出しごとにユニークなIDを生成する', () => {
      const req1 = createRpcRequest('method1')
      const req2 = createRpcRequest('method2')
      expect(req1.id).not.toBe(req2.id)
    })
  })

  describe('parseRpcResponse', () => {
    it('正常なレスポンスをパースする', () => {
      const json = JSON.stringify({
        id: '1',
        result: [{ id: 'ws1', name: 'default' }],
      })
      const resp = parseRpcResponse(json)
      expect(resp.id).toBe('1')
      expect(resp.result).toEqual([{ id: 'ws1', name: 'default' }])
      expect(resp.error).toBeUndefined()
    })

    it('エラーレスポンスをパースする', () => {
      const json = JSON.stringify({
        id: '2',
        error: { code: -1, message: 'not found' },
      })
      const resp = parseRpcResponse(json)
      expect(resp.id).toBe('2')
      expect(resp.error).toEqual({ code: -1, message: 'not found' })
    })

    it('不正なJSONでエラーを投げる', () => {
      expect(() => parseRpcResponse('invalid')).toThrow()
    })
  })
})
