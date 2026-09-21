import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DoubaoDuplexVoiceClient, type DuplexSocketFactory, type DuplexSocketHandlers } from './doubao-duplex-client.ts'
import type { TextSocket } from './doubao-duplex.ts'
import type { AudioSink, AudioSource, Clock } from './voice-client.ts'
import type { UnifiedVoiceEvent } from './voice-events.ts'

class FakeSocket implements TextSocket {
  sent: string[] = []
  closed = false
  handlers: DuplexSocketHandlers | null = null
  send(text: string): void { this.sent.push(text) }
  close(): void { this.closed = true }
  open(): void { this.handlers?.onOpen() }
  message(event: Record<string, unknown>): void { this.handlers?.onMessage(JSON.stringify(event)) }
  drop(): void { this.handlers?.onClose() }
}

class FakeMic implements AudioSource {
  starts = 0
  stops = 0
  onPcm: ((chunk: Uint8Array) => void) | null = null
  start(onPcm: (chunk: Uint8Array) => void): void { this.starts += 1; this.onPcm = onPcm }
  stop(): void { this.stops += 1; this.onPcm = null }
}

class FakeSpeaker implements AudioSink {
  played: Uint8Array[] = []
  stops = 0
  play(chunk: Uint8Array): void { this.played.push(chunk) }
  stop(): void { this.stops += 1 }
}

function setup() {
  const socket = new FakeSocket()
  const factory: DuplexSocketFactory = { open: (handlers) => { socket.handlers = handlers; return socket } }
  const mic = new FakeMic()
  const speaker = new FakeSpeaker()
  const states: string[] = []
  const events: UnifiedVoiceEvent[] = []
  const timers: Array<() => void> = []
  const clock: Clock = { setTimeout: (fn) => { timers.push(fn); return () => {} } }
  const client = new DoubaoDuplexVoiceClient(factory, mic, speaker, {}, {
    onState: (state) => states.push(state),
    onEvent: (batch) => events.push(...batch),
  }, clock)
  return { client, socket, mic, speaker, states, events, timers }
}

test('connect creates a duplex session and starts the mic only after session.created', () => {
  const s = setup()
  s.client.connect()
  assert.deepEqual(s.states, ['connecting'])
  s.socket.open()
  assert.equal(JSON.parse(s.socket.sent[0]).type, 'session.create')
  assert.equal(s.mic.starts, 0)

  s.socket.message({ type: 'session.created', session: { id: 'session-1' } })
  assert.deepEqual(s.states, ['connecting', 'ready'])
  assert.equal(s.mic.starts, 1)
})

test('microphone PCM is sent through the active duplex session', () => {
  const s = setup()
  s.client.connect()
  s.socket.open()
  s.socket.message({ type: 'session.created', session: { id: 'session-1' } })
  s.mic.onPcm?.(new Uint8Array([0, 16]))
  const message = JSON.parse(s.socket.sent[1])
  assert.equal(message.type, 'input_audio_buffer.append')
  assert.equal(message.audio, Buffer.from([0, 16]).toString('base64'))
})

test('server audio is decoded and routed to the speaker', () => {
  const s = setup()
  s.client.connect()
  s.socket.open()
  s.socket.message({ type: 'session.created', session: { id: 'session-1' } })
  s.socket.message({ type: 'response.output_audio.delta', audio: Buffer.from([1, 2, 3, 4]).toString('base64') })
  assert.deepEqual([...s.speaker.played[0]], [1, 2, 3, 4])
})

test('mute and unmute stop and restart capture while keeping the session alive', () => {
  const s = setup()
  s.client.connect()
  s.socket.open()
  s.socket.message({ type: 'session.created', session: { id: 'session-1' } })
  s.client.mute()
  s.client.unmute()
  assert.equal(s.mic.stops, 1)
  assert.equal(s.mic.starts, 2)
  assert.deepEqual(s.socket.sent.slice(1).map((text) => JSON.parse(text).type), [
    'input_audio_mute.commit',
    'input_audio_unmute.commit',
  ])
})

test('stop waits for session.closed before reporting closed', () => {
  const s = setup()
  s.client.connect()
  s.socket.open()
  s.socket.message({ type: 'session.created', session: { id: 'session-1' } })
  s.client.stop()
  assert.equal(s.states.at(-1), 'closing')
  assert.equal(s.socket.closed, false)
  assert.equal(JSON.parse(s.socket.sent.at(-1)!).type, 'session.close')

  s.socket.message({ type: 'session.closed' })
  assert.equal(s.states.at(-1), 'closed')
  assert.equal(s.socket.closed, true)
})

test('unexpected socket close emits a recoverable network error', () => {
  const s = setup()
  s.client.connect()
  s.socket.open()
  s.socket.drop()
  assert.equal(s.states.at(-1), 'error')
  const event = s.events.at(-1)
  assert.equal(event?.type, 'error')
  if (event?.type === 'error') {
    assert.equal(event.error.category, 'network')
    assert.equal(event.error.recoverable, true)
  }
})

test('a protocol error is forwarded exactly once', () => {
  const s = setup()
  s.client.connect()
  s.socket.open()
  s.socket.message({ type: 'session.created', session: { id: 'session-1' } })
  s.socket.message({ type: 'error', message: 'bad request' })
  assert.equal(s.events.filter((event) => event.type === 'error').length, 1)
  assert.equal(s.states.at(-1), 'error')
})

test('a synchronous WebSocket construction failure becomes a recoverable event', () => {
  const mic = new FakeMic()
  const speaker = new FakeSpeaker()
  const states: string[] = []
  const events: UnifiedVoiceEvent[] = []
  const client = new DoubaoDuplexVoiceClient(
    { open: () => { throw new Error('invalid relay URL') } },
    mic,
    speaker,
    {},
    { onState: (state) => states.push(state), onEvent: (batch) => events.push(...batch) },
  )
  client.connect()
  assert.deepEqual(states, ['connecting', 'error'])
  const event = events[0]
  assert.equal(event?.type, 'error')
  if (event?.type === 'error') assert.equal(event.error.recoverable, true)
})
