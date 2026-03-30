import { Socket } from 'net'
import { homedir } from 'os'
import { join } from 'path'

const DEFAULT_SOCKET_PATH = join(homedir(), 'Library/Application Support/cmux/cmux.sock')

export class CmuxClient {
  private socket: Socket | null = null
  private buffer = ''
  private onMessage: ((msg: string) => void) | null = null
  private socketPath: string

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? process.env.CMUX_SOCKET ?? DEFAULT_SOCKET_PATH
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.socket = new Socket()

        const timeout = setTimeout(() => {
          this.socket?.destroy()
          reject(new Error('Connection to cmux socket timed out (30s)'))
        }, 30_000)

        this.socket.on('error', (err) => {
          clearTimeout(timeout)
          console.error(`[cmux-client] Socket error:`, err.message)
          this.socket?.destroy()
          this.socket = null
          reject(err)
        })

        this.socket.on('close', () => {
          console.log('[cmux-client] Socket closed')
          this.socket = null
        })

        this.socket.on('data', (data) => {
          this.buffer += data.toString()
          const lines = this.buffer.split('\n')
          this.buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim()) {
              this.onMessage?.(line)
            }
          }
        })

        this.socket.connect(this.socketPath, () => {
          clearTimeout(timeout)
          console.log(`[cmux-client] Connected to ${this.socketPath}`)
          resolve()
        })
      } catch (err) {
        this.socket?.destroy()
        this.socket = null
        reject(err)
      }
    })
  }

  send(message: string): void {
    if (!this.socket) {
      throw new Error('Not connected to cmux socket')
    }
    this.socket.write(message + '\n')
  }

  setMessageHandler(handler: (msg: string) => void): void {
    this.onMessage = handler
  }

  disconnect(): void {
    this.socket?.destroy()
    this.socket = null
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  async checkConnection(): Promise<boolean> {
    try {
      if (this.isConnected) return true
      await this.connect()
      this.disconnect()
      return true
    } catch {
      return false
    }
  }
}
