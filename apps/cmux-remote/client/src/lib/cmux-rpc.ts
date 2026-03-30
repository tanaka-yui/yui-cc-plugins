export interface RpcRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

export interface RpcResponse {
  id: string
  ok?: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export interface Workspace {
  id: string
  ref: string
  title: string
  selected?: boolean
  pinned?: boolean
  index: number
  current_directory?: string
  custom_color?: string | null
}

export interface CmuxNotification {
  id: string
  title: string
  subtitle: string
  body: string
  workspace_id: string
  surface_id: string
  is_read: boolean
}

export interface Pane {
  id: string
  ref: string
  focused?: boolean
  index: number
  selected_surface_ref: string
  surface_refs: string[]
  surface_count: number
}

export interface TreeNode {
  type: string
  id: string
  name?: string
  children?: TreeNode[]
}

let rpcId = 0

export function createRpcRequest(method: string, params: Record<string, unknown> = {}): RpcRequest {
  return {
    id: String(++rpcId),
    method,
    params,
  }
}

export function parseRpcResponse(data: string): RpcResponse {
  return JSON.parse(data) as RpcResponse
}
