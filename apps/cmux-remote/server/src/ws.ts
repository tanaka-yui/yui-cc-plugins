import type { ServerWebSocket } from 'bun'

const CMUX_BIN = process.env.CMUX_BIN_PATH ?? '/Applications/cmux.app/Contents/Resources/bin/cmux'

// Methods that need CLI execution due to socket API fallback bug
const CLI_METHODS: Record<string, (params: Record<string, unknown>) => string[]> = {
  'surface.send_text': (p) => {
    const args = ['send']
    if (p.workspace_ref) args.push('--workspace', String(p.workspace_ref))
    else if (p.surface_ref) args.push('--surface', String(p.surface_ref))
    return [...args, String(p.text ?? '')]
  },
  'surface.read_text': (p) => {
    const args = ['read-screen', '--scrollback']
    if (p.workspace_ref) args.push('--workspace', String(p.workspace_ref))
    else if (p.surface_ref) args.push('--surface', String(p.surface_ref))
    return args
  },
  'surface.send_key': (p) => {
    const args = ['send-key']
    if (p.workspace_ref) args.push('--workspace', String(p.workspace_ref))
    else if (p.surface_ref) args.push('--surface', String(p.surface_ref))
    return [...args, String(p.key ?? 'return')]
  },
}

async function execCmuxCli(method: string, params: Record<string, unknown>, id: string): Promise<string> {
  const buildArgs = CLI_METHODS[method]
  if (!buildArgs) return ''

  const args = buildArgs(params)
  try {
    const proc = Bun.spawn([CMUX_BIN, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      return JSON.stringify({
        id,
        ok: false,
        error: { code: 'cli_error', message: stderr.trim() || `exit ${exitCode}` },
      })
    }

    if (method === 'surface.read_text') {
      return JSON.stringify({ id, ok: true, result: { text: stdout } })
    }
    return JSON.stringify({ id, ok: true, result: { output: stdout.trim() } })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return JSON.stringify({ id, ok: false, error: { code: 'cli_error', message: msg } })
  }
}

interface WSData {
  socket: WebSocket | null
  ready: boolean
  messageBuffer: string[]
}

function connectCmuxSocket(ws: ServerWebSocket<WSData>) {
  const socketPath = process.env.CMUX_SOCKET_PATH ?? `${Bun.env.HOME}/Library/Application Support/cmux/cmux.sock`
  const { Socket } = require('net')
  const sock = new Socket()

  let buffer = ''

  sock.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) {
        try {
          ws.send(line)
        } catch {}
      }
    }
  })

  sock.on('error', (err: Error) => {
    console.error('[cmux-socket] Error:', err.message)
  })

  sock.on('close', () => {
    console.log('[cmux-socket] Closed')
  })

  sock.connect(socketPath, () => {
    console.log('[cmux-socket] Connected')
    ws.data.ready = true
    for (const msg of ws.data.messageBuffer) {
      sock.write(msg + '\n')
    }
    ws.data.messageBuffer = []
  })

  return {
    send(msg: string) {
      sock.write(msg + '\n')
    },
    close() {
      sock.destroy()
    },
  }
}

export function createWebSocketHandler() {
  const sockets = new WeakMap<ServerWebSocket<WSData>, ReturnType<typeof connectCmuxSocket>>()

  return {
    open(ws: ServerWebSocket<WSData>) {
      console.log('[ws] Client connected')
      ws.data = { socket: null, ready: false, messageBuffer: [] }
      const cmux = connectCmuxSocket(ws)
      sockets.set(ws, cmux)
    },

    async message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
      const msg = typeof message === 'string' ? message : message.toString()

      let parsed: { id?: string; method?: string; params?: Record<string, unknown> }
      try {
        parsed = JSON.parse(msg)
      } catch {
        return
      }

      // Route CLI-required methods through cmux binary
      if (parsed.method && CLI_METHODS[parsed.method]) {
        const result = await execCmuxCli(parsed.method, parsed.params ?? {}, parsed.id ?? '0')
        ws.send(result)
        return
      }

      // All other methods go through socket
      const cmux = sockets.get(ws)
      if (!cmux) return

      if (!ws.data.ready) {
        ws.data.messageBuffer.push(msg)
        return
      }

      cmux.send(msg)
    },

    close(ws: ServerWebSocket<WSData>, code: number, reason: string) {
      console.log(`[ws] Client disconnected: ${code} ${reason}`)
      sockets.get(ws)?.close()
    },
  }
}
