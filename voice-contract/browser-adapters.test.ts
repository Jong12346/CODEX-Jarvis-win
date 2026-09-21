import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserSocketFactory, browserDuplexSocketFactory, browserMicSource, browserAudioSink } from './browser-adapters.ts'
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
  sent: Array<ArrayBuffer | string> = []
  closed = false
  url: string
  constructor(url: string) {
    this.url = url
    FakeWS.last = this
  }
  send(data: ArrayBuffer | string): void { this.sent.push(data) }
  close(): void { this.closed = true }
}

test('browser adapters module exports the three factories', () => {
  assert.equal(typeof browserSocketFactory, 'function')
  assert.equal(typeof browserDuplexSocketFactory, 'function')
  assert.equal(typeof browserMicSource, 'function')
  assert.equal(typeof browserAudioSink, 'function')
})

test('browser duplex socket factory preserves JSON text frames', () => {
  const factory = browserDuplexSocketFactory('ws://127.0.0.1:8787/ws', () => FakeWS)
  let received = ''
  const socket = factory.open({
    onOpen: () => {},
    onMessage: (text) => { received = text },
    onClose: () => {},
    onError: () => {},
  })
  const ws = FakeWS.last!
  ws.onmessage!({ data: '{"type":"session.created"}' })
  assert.equal(received, '{"type":"session.created"}')
  socket.send('{"type":"session.create"}')
  assert.equal(ws.sent[0], '{"type":"session.create"}')
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
  assert.ok(ws.sent[0] instanceof ArrayBuffer)
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

test('mic source emits exact 20ms PCM16 frames and keeps the remainder', async () => {
  let processor: { onaudioprocess: ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null } | null = null
  const audioContext = {
    sampleRate: 16000,
    destination: {},
    createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
    createScriptProcessor: () => {
      const created = { onaudioprocess: null, connect: () => {}, disconnect: () => {} }
      processor = created
      return created
    },
    close: async () => {},
  }
  const frames: Uint8Array[] = []
  const mic = browserMicSource(
    async () => ({ getAudioTracks: () => [{ stop: () => {} }] }),
    () => audioContext,
  )
  await mic.start((frame) => frames.push(frame))

  const process = (samples: number) => {
    const active = processor as unknown as { onaudioprocess: (event: { inputBuffer: { getChannelData(): Float32Array } }) => void }
    active.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(samples).fill(0.25) } })
  }
  process(400)
  assert.deepEqual(frames.map((frame) => frame.length), [640])
  process(240)
  assert.deepEqual(frames.map((frame) => frame.length), [640, 640])
  await mic.stop()
})

test('stopping while microphone permission is pending cancels the late stream', async () => {
  let resolveStream: ((stream: unknown) => void) | null = null
  let trackStops = 0
  let contexts = 0
  const streamPromise = new Promise<unknown>((resolve) => { resolveStream = resolve })
  const mic = browserMicSource(
    () => streamPromise,
    () => { contexts += 1; return {} },
  )
  const starting = Promise.resolve(mic.start(() => {}))
  await mic.stop()
  const release = resolveStream as unknown as (stream: unknown) => void
  release({ getAudioTracks: () => [{ stop: () => { trackStops += 1 } }] })
  await starting
  assert.equal(trackStops, 1)
  assert.equal(contexts, 0)
})

test('audio sink keeps 24kHz timing and queues chunks without overlap', async () => {
  const starts: number[] = []
  const sampleRates: number[] = []
  const stopped: boolean[] = []
  const audioContext = {
    currentTime: 10,
    destination: {},
    resume: async () => {},
    createBuffer: (_channels: number, length: number, sampleRate: number) => {
      sampleRates.push(sampleRate)
      const channel = new Float32Array(length)
      return { getChannelData: () => channel }
    },
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect: () => {},
      disconnect: () => {},
      start: (when = 0) => starts.push(when),
      stop: () => stopped.push(true),
    }),
  }
  const sink = browserAudioSink(() => audioContext, 24000)
  await sink.play(new Uint8Array(4800)) // 100ms
  await sink.play(new Uint8Array(4800))
  assert.deepEqual(sampleRates, [24000, 24000])
  assert.deepEqual(starts, [10, 10.1])
  sink.stop()
  assert.equal(stopped.length, 2)
})
