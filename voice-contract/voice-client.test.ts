import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DoubaoVoiceClient, type SocketFactory, type SocketHandlers, type AudioSource, type AudioSink, type Clock, type VoiceSocket, type ClientState } from './voice-client.ts'
import { ClientEvent, ServerEvent, MsgType, Serialization, FLAG_EVENT, parseServerFrame } from './doubao-codec.ts'
import type { UnifiedVoiceEvent } from './voice-events.ts'

class FakeSocket implements VoiceSocket {
  sent: Uint8Array[] = []
  closed = false
  send(data: Uint8Array): void { this.sent.push(data) }
  close(): void { this.closed = true }
}

class FakeSocketFactory implements SocketFactory {
  handlers: SocketHandlers | null = null
  socket = new FakeSocket()
  open(handlers: SocketHandlers): VoiceSocket {
    this.handlers = handlers
    return this.socket
  }
}

class FakeMic implements AudioSource {
  started = false
  stopped = false
  private onPcm: ((chunk: Uint8Array) => void) | null = null
  start(onPcm: (chunk: Uint8Array) => void): void { this.started = true; this.onPcm = onPcm }
  stop(): void { this.stopped = true; this.onPcm = null }
  emit(chunk: Uint8Array): void { this.onPcm?.(chunk) }
}

class FakeSpeaker implements AudioSink {
  played: Uint8Array[] = []
  stopped = false
  play(chunk: Uint8Array): void { this.played.push(chunk) }
  stop(): void { this.stopped = true }
}

class FakeClock implements Clock {
  private timers: Array<{ fn: () => void; ms: number }> = []
  setTimeout(fn: () => void, ms: number): () => void {
    this.timers.push({ fn, ms })
    return () => { this.timers = this.timers.filter((t) => t.fn !== fn) }
  }
  fireAll(): void {
    const copy = [...this.timers]
    this.timers = []
    for (const t of copy) t.fn()
  }
}

function serverFrame(eventId: number, payloadJson?: unknown): Uint8Array {
  const payload = payloadJson === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(payloadJson))
  const sid = new TextEncoder().encode('server-sid')
  const out: number[] = [0x11, (MsgType.FULL_SERVER_RESPONSE << 4) | FLAG_EVENT, (Serialization.JSON << 4) | 0, 0x00]
  const u32 = (n: number) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  u32(eventId)
  u32(sid.length)
  for (const b of sid) out.push(b)
  u32(payload.length)
  for (const b of payload) out.push(b)
  return new Uint8Array(out)
}

function setup() {
  const sockFactory = new FakeSocketFactory()
  const mic = new FakeMic()
  const speaker = new FakeSpeaker()
  const clock = new FakeClock()
  const states: ClientState[] = []
  const events: UnifiedVoiceEvent[][] = []
  const client = new DoubaoVoiceClient(
    sockFactory, mic, speaker, { model: '2.2.0.0' },
    { onState: (s) => states.push(s), onEvent: (e) => events.push(e) },
    clock, 10000,
  )
  return { client, sockFactory, mic, speaker, clock, states, events }
}

function driveToActive(s: ReturnType<typeof setup>): void {
  s.client.connect()
  s.sockFactory.handlers!.onOpen()
  s.sockFactory.handlers!.onMessage(serverFrame(ServerEvent.CONNECTION_STARTED))
  s.sockFactory.handlers!.onMessage(serverFrame(ServerEvent.SESSION_STARTED))
}

test('connect walks to ready and starts the mic after session start', () => {
  const s = setup()
  s.client.connect()
  s.sockFactory.handlers!.onOpen()
  assert.deepEqual(s.states, ['connecting'])
  assert.equal(parseServerFrame(s.sockFactory.socket.sent[0]).eventId, ClientEvent.START_CONNECTION)

  s.sockFactory.handlers!.onMessage(serverFrame(ServerEvent.CONNECTION_STARTED))
  s.sockFactory.handlers!.onMessage(serverFrame(ServerEvent.SESSION_STARTED))
  assert.deepEqual(s.states, ['connecting', 'ready'])
  assert.equal(s.mic.started, true)
})

test('mic pcm is forwarded as an audio frame once active', () => {
  const s = setup()
  driveToActive(s)
  s.mic.emit(new Uint8Array([0x00, 0x10, 0xff, 0x00]))
  // sent: [0]=START_CONNECTION [1]=START_SESSION [2]=audio
  const audio = parseServerFrame(s.sockFactory.socket.sent[2])
  assert.equal(audio.eventId, ClientEvent.TASK_REQUEST)
  assert.equal(audio.payload.length, 4)
})

test('server ASR and TTS route to callback events and speaker', () => {
  const s = setup()
  driveToActive(s)
  s.sockFactory.handlers!.onMessage(serverFrame(ServerEvent.ASR_RESPONSE, { results: [{ text: '嗨', is_interim: false }] }))
  assert.deepEqual(s.events.at(-1), [{ type: 'transcriptFinal', role: 'user', text: '嗨' }])

  // TTS_RESPONSE 用裸 PCM 帧
  const pcm = new Uint8Array([0x00, 0x10])
  const sid = new TextEncoder().encode('server-sid')
  const out: number[] = [0x11, (MsgType.FULL_SERVER_RESPONSE << 4) | FLAG_EVENT, (Serialization.RAW << 4) | 0, 0x00]
  const u32 = (n: number) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  u32(ServerEvent.TTS_RESPONSE); u32(sid.length); for (const b of sid) out.push(b); u32(pcm.length); for (const b of pcm) out.push(b)
  s.sockFactory.handlers!.onMessage(new Uint8Array(out))
  assert.equal(s.speaker.played.length, 1)
  assert.deepEqual([...s.speaker.played[0]], [0x00, 0x10])
})

test('handshake timeout emits a recoverable network error', () => {
  const s = setup()
  s.client.connect()
  s.sockFactory.handlers!.onOpen()
  s.clock.fireAll()
  assert.deepEqual(s.states, ['connecting', 'error'])
  const last = s.events.at(-1)!
  assert.equal(last[0].type, 'error')
  assert.equal((last[0] as { error: { code: string } }).error.code, 'voice.handshakeTimeout')
})

test('stop tears down mic, speaker, socket and session', () => {
  const s = setup()
  driveToActive(s)
  s.client.stop()
  assert.equal(s.mic.stopped, true)
  assert.equal(s.speaker.stopped, true)
  assert.equal(s.sockFactory.socket.closed, true)
  assert.deepEqual(s.states.at(-1), 'closed')
  // sent: [0]=START_CONNECTION [1]=START_SESSION [2]=FINISH_SESSION [3]=FINISH_CONNECTION
  assert.equal(parseServerFrame(s.sockFactory.socket.sent[2]).eventId, ClientEvent.FINISH_SESSION)
  assert.equal(parseServerFrame(s.sockFactory.socket.sent[3]).eventId, ClientEvent.FINISH_CONNECTION)
})

test('socket error surfaces as a network error event', () => {
  const s = setup()
  s.client.connect()
  s.sockFactory.handlers!.onOpen()
  s.sockFactory.handlers!.onError(new Error('boom'))
  assert.deepEqual(s.states, ['connecting', 'error'])
  const last = s.events.at(-1)!
  assert.equal(last[0].type, 'error')
  assert.equal((last[0] as { error: { category: string } }).error.category, 'network')
})
