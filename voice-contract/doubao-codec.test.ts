import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MsgType,
  Serialization,
  FLAG_EVENT,
  ClientEvent,
  ServerEvent,
  buildEventFrame,
  buildAudioFrame,
  parseServerFrame,
} from './doubao-codec.ts'

test('header layout is version|header_size, msg_type|flags, serialization|compression', () => {
  // FULL_CLIENT_REQUEST(1) + FLAG_EVENT(0b0100) + JSON(1) -> [0x11, 0x14, 0x10, 0x00]
  const frame = buildEventFrame(ClientEvent.START_SESSION, {}, 'sid-1')
  assert.equal(frame[0], 0x11)
  assert.equal(frame[1], (MsgType.FULL_CLIENT_REQUEST << 4) | FLAG_EVENT)
  assert.equal(frame[2], (Serialization.JSON << 4) | 0)
  assert.equal(frame[3], 0x00)
})

test('event frame round-trips session-level payload', () => {
  const frame = buildEventFrame(
    ClientEvent.START_SESSION,
    { app: { appid: 'test' }, user: { uid: 'u1' } },
    'session-abc',
  )
  const parsed = parseServerFrame(frame)
  assert.equal(parsed.msgType, MsgType.FULL_CLIENT_REQUEST)
  assert.equal(parsed.eventId, ClientEvent.START_SESSION)
  assert.equal(parsed.sessionId, 'session-abc')
  assert.deepEqual(parsed.payloadJson, { app: { appid: 'test' }, user: { uid: 'u1' } })
})

test('connect-level event carries connect id instead of session id', () => {
  const frame = buildEventFrame(ClientEvent.START_CONNECTION, {}, undefined, 'conn-xyz')
  const parsed = parseServerFrame(frame)
  assert.equal(parsed.eventId, ClientEvent.START_CONNECTION)
  assert.equal(parsed.sessionId, undefined, 'connect-level events carry connect_id, not session_id')
})

test('audio frame round-trips raw pcm payload', () => {
  const pcm = new Uint8Array([0x00, 0x10, 0xff, 0x00, 0x80, 0x80])
  const frame = buildAudioFrame(pcm, 'session-abc')
  const parsed = parseServerFrame(frame)
  assert.equal(parsed.msgType, MsgType.AUDIO_ONLY_REQUEST)
  assert.equal(parsed.eventId, ClientEvent.TASK_REQUEST)
  assert.equal(parsed.sessionId, 'session-abc')
  assert.deepEqual([...parsed.payload], [...pcm])
})

test('server TTS response frame parses payload json', () => {
  // 手工拼一个服务端 TTS_RESPONSE(352) 帧：FULL_SERVER_RESPONSE + FLAG_EVENT + JSON
  const header = [0x11, (MsgType.FULL_SERVER_RESPONSE << 4) | FLAG_EVENT, (Serialization.JSON << 4) | 0, 0x00]
  const payload = JSON.stringify({ text: '你好', sentence_index: 0 })
  const payloadBytes = new TextEncoder().encode(payload)
  const sid = new TextEncoder().encode('session-abc')
  const out: number[] = [...header]
  const u32 = (n: number) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  u32(ServerEvent.TTS_RESPONSE)
  u32(sid.length)
  for (const b of sid) out.push(b)
  u32(payloadBytes.length)
  for (const b of payloadBytes) out.push(b)
  const parsed = parseServerFrame(new Uint8Array(out))
  assert.equal(parsed.msgType, MsgType.FULL_SERVER_RESPONSE)
  assert.equal(parsed.eventId, ServerEvent.TTS_RESPONSE)
  assert.equal(parsed.sessionId, 'session-abc')
  assert.deepEqual(parsed.payloadJson, { text: '你好', sentence_index: 0 })
})

test('error frame parses error code', () => {
  // ERROR(0b1111) 帧：带 error_code 可选字段
  const header = [0x11, (MsgType.ERROR << 4) | 0, (Serialization.JSON << 4) | 0, 0x00]
  const payload = JSON.stringify({ message: 'bad appid' })
  const payloadBytes = new TextEncoder().encode(payload)
  const out: number[] = [...header]
  const u32 = (n: number) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  u32(0x1005)
  u32(payloadBytes.length)
  for (const b of payloadBytes) out.push(b)
  const parsed = parseServerFrame(new Uint8Array(out))
  assert.equal(parsed.msgType, MsgType.ERROR)
  assert.equal(parsed.errorCode, 0x1005)
  assert.deepEqual(parsed.payloadJson, { message: 'bad appid' })
})

test('short frames are rejected', () => {
  assert.throws(() => parseServerFrame(new Uint8Array([0x11])), /too short/)
})
