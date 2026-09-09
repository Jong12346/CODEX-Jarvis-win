import { createServer } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket, WebSocketServer } from 'ws'
import { isAllowedBrowserOrigin, startDoubaoRelayServer } from './relay-server.mjs'

function openSocket(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data, isBinary) => resolve({ data, isBinary }))
    socket.once('error', reject)
  })
}

function closeWsServer(server) {
  return new Promise((resolve, reject) => {
    for (const socket of server.clients) socket.terminate()
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function createEchoUpstream() {
  const httpServer = createServer()
  const wsServer = new WebSocketServer({ server: httpServer })
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')
  return {
    httpServer,
    wsServer,
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      await closeWsServer(wsServer)
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
    },
  }
}

test('origin policy accepts local browser origins and rejects remote pages', () => {
  assert.equal(isAllowedBrowserOrigin(undefined), true)
  assert.equal(isAllowedBrowserOrigin('http://localhost:5173'), true)
  assert.equal(isAllowedBrowserOrigin('https://tauri.localhost'), true)
  assert.equal(isAllowedBrowserOrigin('tauri://localhost'), true)
  assert.equal(isAllowedBrowserOrigin('https://example.com'), false)
  assert.equal(isAllowedBrowserOrigin('null'), false)
})

test('live relay adds the API header and preserves text and binary frames', async () => {
  const upstream = await createEchoUpstream()
  let seenApiKey
  upstream.wsServer.on('connection', (socket, request) => {
    seenApiKey = request.headers['x-api-key']
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
  })

  const relay = await startDoubaoRelayServer({
    apiKey: 'test-key-never-log',
    port: 0,
    upstreamUrl: upstream.url,
    log: () => {},
  })

  try {
    const browser = await openSocket(relay.url, { origin: 'http://localhost:5173' })
    try {
      const textPromise = nextMessage(browser)
      browser.send('{"type":"session.create"}')
      const textFrame = await textPromise
      assert.equal(textFrame.isBinary, false)
      assert.equal(textFrame.data.toString(), '{"type":"session.create"}')
      assert.equal(seenApiKey, 'test-key-never-log')

      const binaryPromise = nextMessage(browser)
      browser.send(new Uint8Array([0, 1, 255]))
      const binaryFrame = await binaryPromise
      assert.equal(binaryFrame.isBinary, true)
      assert.deepEqual([...binaryFrame.data], [0, 1, 255])
    } finally {
      browser.terminate()
    }
  } finally {
    await relay.close()
    await upstream.close()
  }
})

test('live relay rejects a non-local browser origin', async () => {
  const upstream = await createEchoUpstream()
  const relay = await startDoubaoRelayServer({
    apiKey: 'test-key-never-log',
    port: 0,
    upstreamUrl: upstream.url,
    log: () => {},
  })

  try {
    const statusCode = await new Promise((resolve, reject) => {
      const browser = new WebSocket(relay.url, { origin: 'https://example.com' })
      browser.once('open', () => reject(new Error('remote origin unexpectedly connected')))
      browser.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode)
      })
      browser.once('error', () => {})
    })
    assert.equal(statusCode, 403)
  } finally {
    await relay.close()
    await upstream.close()
  }
})
