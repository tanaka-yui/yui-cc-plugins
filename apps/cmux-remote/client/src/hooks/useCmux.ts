import { useCallback, useRef, useState } from 'react'

import { type CmuxNotification, createRpcRequest, type Pane, parseRpcResponse, type Workspace } from '../lib/cmux-rpc'
import { type ConnectionStatus, useWebSocket } from './useWebSocket'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RPC_TIMEOUT = 10_000

export function useCmux() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [currentWorkspace, setCurrentWorkspace] = useState<string | null>(null)
  const [panes, setPanes] = useState<Pane[]>([])
  const [currentPane, setCurrentPane] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<CmuxNotification[]>([])
  const pendingRef = useRef(new Map<string, PendingRequest>())

  const handleMessage = useCallback((data: string) => {
    try {
      const resp = parseRpcResponse(data)
      const pending = pendingRef.current.get(resp.id)
      if (pending) {
        clearTimeout(pending.timer)
        pendingRef.current.delete(resp.id)
        if (resp.error) {
          pending.reject(new Error(resp.error.message))
        } else {
          pending.resolve(resp.result)
        }
      }
    } catch (err) {
      console.error('[cmux] Failed to parse message:', err)
    }
  }, [])

  const wsUrl =
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
      : 'ws://localhost:3456/ws'

  const { status, send } = useWebSocket({
    url: wsUrl,
    onMessage: handleMessage,
  })

  const rpc = useCallback(
    (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      return new Promise((resolve, reject) => {
        const req = createRpcRequest(method, params)
        const timer = setTimeout(() => {
          pendingRef.current.delete(req.id)
          reject(new Error(`RPC timeout: ${method}`))
        }, RPC_TIMEOUT)

        pendingRef.current.set(req.id, { resolve, reject, timer })
        send(JSON.stringify(req))
      })
    },
    [send],
  )

  const listWorkspaces = useCallback(async () => {
    const result = (await rpc('workspace.list')) as { workspaces: Workspace[] }
    const wsList = result.workspaces ?? []
    setWorkspaces(wsList)
    const active = wsList.find((w) => w.selected)
    if (active) setCurrentWorkspace(active.ref)
    return wsList
  }, [rpc])

  const selectWorkspace = useCallback(async (ref: string) => {
    // PWA側の表示切替のみ。ローカルcmuxのフォーカスは変更しない。
    setCurrentWorkspace(ref)
  }, [])

  const listPanes = useCallback(
    async (workspaceRef?: string) => {
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      const result = (await rpc('pane.list', params)) as { panes: Pane[] }
      const paneList = result.panes ?? []
      setPanes(paneList)
      const active = paneList.find((p) => p.focused)
      if (active) setCurrentPane(active.selected_surface_ref)
      return paneList
    },
    [rpc],
  )

  const focusSurface = useCallback(
    async (surfaceRef: string) => {
      await rpc('surface.focus', { surface_ref: surfaceRef })
      setCurrentPane(surfaceRef)
    },
    [rpc],
  )

  const readText = useCallback(
    async (workspaceRef?: string): Promise<string> => {
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      const result = (await rpc('surface.read_text', params)) as { text: string }
      return result.text ?? ''
    },
    [rpc],
  )

  const sendText = useCallback(
    async (surfaceRef: string, text: string) => {
      await rpc('surface.send_text', { surface_ref: surfaceRef, text })
    },
    [rpc],
  )

  const getTree = useCallback(async () => {
    return await rpc('system.tree')
  }, [rpc])

  const listNotifications = useCallback(async () => {
    const result = (await rpc('notification.list')) as { notifications: CmuxNotification[] }
    const list = result.notifications ?? []
    setNotifications(list)
    return list
  }, [rpc])

  const navigateWorkspace = useCallback(
    async (direction: 'next' | 'prev') => {
      if (workspaces.length === 0) return
      const idx = workspaces.findIndex((w) => w.ref === currentWorkspace)
      const nextIdx =
        direction === 'next' ? (idx + 1) % workspaces.length : (idx - 1 + workspaces.length) % workspaces.length
      const target = workspaces[nextIdx]
      if (target) await selectWorkspace(target.ref)
    },
    [workspaces, currentWorkspace, selectWorkspace],
  )

  const navigatePane = useCallback(
    async (direction: 'next' | 'prev') => {
      if (panes.length === 0) return
      const idx = panes.findIndex((p) => p.selected_surface_ref === currentPane)
      const nextIdx = direction === 'next' ? (idx + 1) % panes.length : (idx - 1 + panes.length) % panes.length
      const target = panes[nextIdx]
      if (target) await focusSurface(target.selected_surface_ref)
    },
    [panes, currentPane, focusSurface],
  )

  return {
    status: status as ConnectionStatus,
    workspaces,
    currentWorkspace,
    panes,
    currentPane,
    notifications,
    listWorkspaces,
    selectWorkspace,
    listPanes,
    focusSurface,
    readText,
    sendText,
    getTree,
    listNotifications,
    navigateWorkspace,
    navigatePane,
  }
}
