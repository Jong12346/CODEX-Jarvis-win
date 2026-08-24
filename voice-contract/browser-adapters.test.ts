import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserSocketFactory, browserMicSource, browserAudioSink } from './browser-adapters.ts'
import type { SocketFactory, AudioSource, AudioSink } from './voice-client.ts'

// 本测试只验证浏览器适配器模块可加载、导出形状正确、以及工厂接线逻辑；
// 真实浏览器行为（getUserMedia/AudioContext/WebSocket）留实机联调。

class FakeWS {
  static last: FakeWS | null = null
  binaryType = ''
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  sent: ArrayBuffer[] = []
  closed = false
  url: string
  constructor(url: string) {
    this.url = url
    FakeWS.last = this
  }
  send(data: ArrayBuffer): void { this.sent.push(data) }
  close(): void { this.closed = true }
}

test('browser adapters module exports the three factories', () => {
  assert.equal(typeof browserSocketFactory, 'function')
  assert.equal(typeof browserMicSource, 'function')
  assert.equal(typeof browserAudioSink, 'function')
})

test('browser socket factory wires a fake WebSocket to the SocketFactory shape', () => {
  const factory = browserSocketFactory('ws://127.0.0.1:8787/ws', () => FakeWS) as SocketFactory
  let opened = false
  let received: Uint8Array | null = null

  const socket = factory.open({
    onOpen: () => { opened = true },
    onMessage: (d) => { received = d },
    onClose: () => {},
    onError: () => {},
  })

  const ws = FakeWS.last!
  assert.equal(ws.url, 'ws://127.0.0.1:8787/ws')

  ws.onopen!()
  assert.equal(opened, true)

  ws.onmessage!({ data: new Uint8Array([1, 2, 3]).buffer })
  assert.ok(received instanceof Uint8Array)
  assert.deepEqual([...received!], [1, 2, 3])

  socket.send(new Uint8Array([9, 9]))
  assert.equal(ws.sent.length, 1)
  assert.deepEqual([...new Uint8Array(ws.sent[0])], [9, 9])

  socket.close()
  assert.equal(ws.closed, true)
})

test('mic source and audio sink factories exist with expected shape', () => {
  const mic = browserMicSource(async () => ({}), () => ({})) as AudioSource
  assert.equal(typeof mic.start, 'function')
  assert.equal(typeof mic.stop, 'function')
  const sink = browserAudioSink(() => ({})) as AudioSink
  assert.equal(typeof sink.play, 'function')
  assert.equal(typeof sink.stop, 'function')
})
