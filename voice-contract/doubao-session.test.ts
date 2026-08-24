import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DoubaoSession, buildSessionPayload, type VoiceSocket } from './doubao-session.ts'
import { ClientEvent, ServerEvent, MsgType, Serialization, FLAG_EVENT, parseServerFrame } from './doubao-codec.ts'
import type { UnifiedVoiceEvent } from './voice-events.ts'

class FakeSocket implements VoiceSocket {
  sent: Uint8Array[] = []
  closed = false
  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
}

// 手工构造服务端帧（FULL_SERVER_RESPONSE + FLAG_EVENT + JSON）
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

function sentEventId(frame: Uint8Array): number {
  const parsed = parseServerFrame(frame)
  return parsed.eventId ?? -1
}

test('handshake walks connecting -> starting -> active', () => {
  const events: UnifiedVoiceEvent[][] = []
  const session = new DoubaoSession({ model: '1.2.1.1' }, (e) => events.push(e))
  const sock = new FakeSocket()

  session.onSocketOpen(sock)
  assert.equal(session.state, 'connecting')
  assert.equal(sentEventId(sock.sent[0]), ClientEvent.START_CONNECTION)

  session.onServerBytes(serverFrame(ServerEvent.CONNECTION_STARTED))
  assert.equal(session.state, 'starting')
  assert.equal(sentEventId(sock.sent[1]), ClientEvent.START_SESSION)

  session.onServerBytes(serverFrame(ServerEvent.SESSION_STARTED))
  assert.equal(session.state, 'active')
  assert.deepEqual(events, [])
})

test('session payload carries model, tts and system role', () => {
  const p = buildSessionPayload({ model: '2.2.0.0', speaker: 'zh_f', systemRole: '你是助手', botName: 'Jarvis' })
  assert.equal((p.tts as Record<string, unknown>).speaker, 'zh_f')
  assert.deepEqual((p.tts as Record<string, unknown>).audio_config, { channel: 1, format: 'pcm_s16le', sample_rate: 24000 })
  assert.equal(((p.dialog as Record<string, unknown>).extra as Record<string, unknown>).model, '2.2.0.0')
  assert.equal((p.dialog as Record<string, unknown>).system_role, '你是助手')
  assert.equal((p.dialog as Record<string, unknown>).bot_name, 'Jarvis')
})

test('audio and text are gated on active state', () => {
  const session = new DoubaoSession({ model: '1.2.1.1' }, () => {})
  const sock = new FakeSocket()
  session.onSocketOpen(sock)
  session.sendAudio(new Uint8Array([0x00, 0x10]))
  session.sendText('你好')
  assert.equal(sock.sent.length, 1, 'no audio/text before active')

  session.onServerBytes(serverFrame(ServerEvent.CONNECTION_STARTED))
  session.onServerBytes(serverFrame(ServerEvent.SESSION_STARTED))
  session.sendAudio(new Uint8Array([0x00, 0x10]))
  session.sendText('你好')

  const audioFrame = parseServerFrame(sock.sent[2])
  assert.equal(audioFrame.eventId, ClientEvent.TASK_REQUEST)
  assert.equal(audioFrame.sessionId, session.sessionId)
  assert.equal(audioFrame.payload.length, 2)

  const textFrame = parseServerFrame(sock.sent[3])
  assert.equal(textFrame.eventId, ClientEvent.CHAT_TEXT_QUERY)
  assert.deepEqual(textFrame.payloadJson, { content: '你好' })
})

test('incoming ASR response is emitted as transcript events', () => {
  const emitted: UnifiedVoiceEvent[] = []
  const session = new DoubaoSession({ model: '1.2.1.1' }, (e) => emitted.push(...e))
  const sock = new FakeSocket()
  session.onSocketOpen(sock)
  session.onServerBytes(serverFrame(ServerEvent.CONNECTION_STARTED))
  session.onServerBytes(serverFrame(ServerEvent.SESSION_STARTED))

  session.onServerBytes(serverFrame(ServerEvent.ASR_RESPONSE, { results: [{ text: '嗨', is_interim: false }] }))
  assert.deepEqual(emitted, [{ type: 'transcriptFinal', role: 'user', text: '嗨' }])
})

test('connection failed emits a recoverable network error and closes', () => {
  const emitted: UnifiedVoiceEvent[] = []
  const session = new DoubaoSession({ model: '1.2.1.1' }, (e) => emitted.push(...e))
  const sock = new FakeSocket()
  session.onSocketOpen(sock)
  session.onServerBytes(serverFrame(ServerEvent.CONNECTION_FAILED, { error: 'tls' }))
  assert.equal(session.state, 'closed')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'error')
})

test('stop sends finish session + finish connection and closes the socket', () => {
  const session = new DoubaoSession({ model: '1.2.1.1' }, () => {})
  const sock = new FakeSocket()
  session.onSocketOpen(sock)
  session.onServerBytes(serverFrame(ServerEvent.CONNECTION_STARTED))
  session.onServerBytes(serverFrame(ServerEvent.SESSION_STARTED))

  session.stop()
  assert.equal(session.state, 'closed')
  assert.equal(sock.closed, true)
  assert.equal(sentEventId(sock.sent[2]), ClientEvent.FINISH_SESSION)
  assert.equal(sentEventId(sock.sent[3]), ClientEvent.FINISH_CONNECTION)
})
