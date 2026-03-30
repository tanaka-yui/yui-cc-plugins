import { useCallback, useEffect, useRef, useState } from 'react'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

interface UseWebSocketOptions {
  url: string
  onMessage: (data: string) => void
  maxRetries?: number
}

const DEFAULT_MAX_RETRIES = 10

export function useWebSocket({ url, onMessage, maxRetries = DEFAULT_MAX_RETRIES }: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMessageRef = useRef(onMessage)
  const unmountedRef = useRef(false)
  onMessageRef.current = onMessage

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const connect = useCallback(() => {
    if (unmountedRef.current) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    clearRetryTimer()
    setStatus('connecting')
    const ws = new WebSocket(url)

    ws.onopen = () => {
      setStatus('connected')
      retryRef.current = 0
      console.log('[ws] Connected')
    }

    ws.onmessage = (event) => {
      onMessageRef.current(event.data as string)
    }

    ws.onclose = () => {
      setStatus('disconnected')
      wsRef.current = null

      if (unmountedRef.current) return

      if (retryRef.current >= maxRetries) {
        console.log(`[ws] Max retries (${maxRetries}) reached, giving up`)
        return
      }

      // Exponential backoff: 1s, 2s, 4s, ... max 30s
      const delay = Math.min(1000 * 2 ** retryRef.current, 30_000)
      retryRef.current++
      console.log(`[ws] Reconnecting in ${delay}ms (attempt ${retryRef.current}/${maxRetries})...`)
      retryTimerRef.current = setTimeout(connect, delay)
    }

    ws.onerror = (err) => {
      console.error('[ws] Error:', err)
      ws.close()
    }

    wsRef.current = ws
  }, [url, maxRetries, clearRetryTimer])

  const send = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])

  useEffect(() => {
    unmountedRef.current = false
    connect()
    return () => {
      unmountedRef.current = true
      clearRetryTimer()
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [connect, clearRetryTimer])

  return { status, send }
}
