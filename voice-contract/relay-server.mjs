import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { DoubaoRelay } from './relay.ts'

export const DEFAULT_RELAY_HOST = '127.0.0.1'
export const DEFAULT_RELAY_PORT = 8787
export const DEFAULT_RELAY_PATH = '/ws'
export const DEFAULT_DOUBAO_UPSTREAM_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'

const MAX_PENDING_BYTES = 4 * 1024 * 1024

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function isAllowedBrowserOrigin(origin) {
  if (origin === undefined) return true
  if (origin === 'tauri://localhost') return true

  try {
    const url = new URL(origin)
    const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'tauri.localhost'
    return localHost && (url.protocol === 'http:' || url.protocol === 'https:')
  } catch {
    return false
  }
}

function rejectUpgrade(socket, statusCode, reason) {
  socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function frameSize(data) {
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
}

function normalizeMessage(data, isBinary) {
  if (!isBinary) return data.toString('utf8')
  const bytes = Array.isArray(data) ? Buffer.concat(data) : data
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

class WsRelayEnd {
  #socket
  #handlers = null
  #incoming = []
  #outgoing = []
  #pendingBytes = 0
  #closed = false

  constructor(socket) {
    this.#socket = socket
    socket.on('open', () => this.#flush())
    socket.on('message', (data, isBinary) => {
      const message = normalizeMessage(data, isBinary)
      if (this.#handlers) this.#handlers.onMessage(message)
      else this.#incoming.push(message)
    })
    socket.on('close', () => this.#notifyClosed())
    socket.on('error', () => this.#notifyClosed())
  }

  send(data) {
    if (this.#closed) return
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(data, { binary: typeof data !== 'string' })
      return
    }
    if (this.#socket.readyState !== WebSocket.CONNECTING) {
      this.#notifyClosed()
      return
    }

    const size = frameSize(data)
    if (this.#pendingBytes + size > MAX_PENDING_BYTES) {
      this.#socket.close(1009, 'pending relay data exceeded limit')
      this.#notifyClosed()
      return
    }
    this.#pendingBytes += size
    this.#outgoing.push(data)
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#outgoing = []
    this.#incoming = []
    this.#pendingBytes = 0
    if (this.#socket.readyState === WebSocket.CONNECTING || this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close()
    }
  }

  setHandlers(handlers) {
    this.#handlers = handlers
    for (const message of this.#incoming.splice(0)) handlers.onMessage(message)
    if (this.#closed) handlers.onClose()
  }

  #flush() {
    if (this.#closed) return
    for (const data of this.#outgoing.splice(0)) {
      this.#socket.send(data, { binary: typeof data !== 'string' })
    }
    this.#pendingBytes = 0
  }

  #notifyClosed() {
    if (this.#closed) return
    this.#closed = true
    this.#outgoing = []
    this.#incoming = []
    this.#pendingBytes = 0
    this.#handlers?.onClose()
  }
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

/** Start a localhost-only browser → Doubao duplex WebSocket relay. */
export async function startDoubaoRelayServer({
  apiKey,
  host = DEFAULT_RELAY_HOST,
  port = DEFAULT_RELAY_PORT,
  path = DEFAULT_RELAY_PATH,
  upstreamUrl = DEFAULT_DOUBAO_UPSTREAM_URL,
  log = console.log,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new Error('DOUBAO_API_KEY is required')
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('relay host must be a loopback address')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('relay port must be an integer from 0 to 65535')
  if (!path.startsWith('/')) throw new Error('relay path must start with /')
  const normalizedApiKey = apiKey.trim()

  const httpServer = createServer((_request, response) => {
    response.writeHead(404).end()
  })
  const wsServer = new WebSocketServer({ noServer: true })
  const cleanups = new Set()

  httpServer.on('upgrade', (request, socket, head) => {
    const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname
    if (requestPath !== path) return rejectUpgrade(socket, 404, 'Not Found')
    if (!isLoopback(request.socket.remoteAddress)) return rejectUpgrade(socket, 403, 'Forbidden')
    if (!isAllowedBrowserOrigin(request.headers.origin)) return rejectUpgrade(socket, 403, 'Forbidden')

    wsServer.handleUpgrade(request, socket, head, (browserSocket) => {
      wsServer.emit('connection', browserSocket, request)
    })
  })

  wsServer.on('connection', (browserSocket) => {
    const relay = new DoubaoRelay(
      (url, headers) => new WsRelayEnd(new WebSocket(url, { headers })),
      upstreamUrl,
      { 'X-Api-Key': normalizedApiKey },
    )
    const cleanup = relay.attach(new WsRelayEnd(browserSocket))
    cleanups.add(cleanup)
    browserSocket.once('close', () => cleanups.delete(cleanup))
  })

  await listen(httpServer, host, port)
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('relay did not bind a TCP port')
  const url = `ws://${host.includes(':') ? `[${host}]` : host}:${address.port}${path}`
  log(`Doubao relay listening at ${url}`)

  let stopped = false
  return {
    host,
    port: address.port,
    path,
    url,
    async close() {
      if (stopped) return
      stopped = true
      for (const cleanup of [...cleanups]) cleanup()
      for (const socket of wsServer.clients) socket.terminate()
      await Promise.all([closeServer(wsServer), closeServer(httpServer)])
    },
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const service = await startDoubaoRelayServer({
    apiKey: process.env.DOUBAO_API_KEY,
    host: process.env.DOUBAO_RELAY_HOST || DEFAULT_RELAY_HOST,
    port: Number(process.env.DOUBAO_RELAY_PORT || DEFAULT_RELAY_PORT),
    path: process.env.DOUBAO_RELAY_PATH || DEFAULT_RELAY_PATH,
  })

  const stop = async () => {
    await service.close()
    process.exitCode = 0
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
