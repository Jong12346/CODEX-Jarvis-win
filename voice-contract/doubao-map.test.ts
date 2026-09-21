import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapDoubaoFrame } from './doubao-map.ts'
import { ServerEvent, MsgType, Serialization, FLAG_EVENT, parseServerFrame, type ParsedFrame } from './doubao-codec.ts'
import { ProviderError, validateAudioFrame } from './voice-events.ts'

function jsonFrame(eventId: number, payloadJson: unknown, msgType = MsgType.FULL_SERVER_RESPONSE): ParsedFrame {
  return {
    msgType,
    flags: FLAG_EVENT,
    serialization: Serialization.JSON,
    compression: 0,
    eventId,
    payload: new Uint8Array(0),
    payloadJson,
  }
}

test('ASR response maps interim to delta and final to transcriptFinal', () => {
  const events = mapDoubaoFrame(jsonFrame(ServerEvent.ASR_RESPONSE, {
    results: [
      { text: '你好', is_interim: true },
      { text: '你好 Jarvis', is_interim: false },
    ],
  }))
  assert.deepEqual(events, [
    { type: 'transcriptDelta', role: 'user', text: '你好' },
    { type: 'transcriptFinal', role: 'user', text: '你好 Jarvis' },
  ])
})

test('TTS response maps raw pcm to an aligned audio frame', () => {
  const pcm = new Uint8Array(640)
  const events = mapDoubaoFrame({
    msgType: MsgType.FULL_SERVER_RESPONSE,
    flags: FLAG_EVENT,
    serialization: Serialization.RAW,
    compression: 0,
    eventId: ServerEvent.TTS_RESPONSE,
    payload: pcm,
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'audioFrame')
  const samples = (events[0] as { samples: number[] }).samples
  assert.equal(validateAudioFrame(samples), true)
  assert.equal(samples.length, 640)
})

test('TTS sentence start/end map to turn started/completed', () => {
  assert.deepEqual(mapDoubaoFrame(jsonFrame(ServerEvent.TTS_SENTENCE_START, {})), [{ type: 'turnStarted' }])
  assert.deepEqual(mapDoubaoFrame(jsonFrame(ServerEvent.TTS_ENDED, {})), [{ type: 'turnCompleted' }])
  assert.deepEqual(mapDoubaoFrame(jsonFrame(ServerEvent.CHAT_ENDED, {})), [{ type: 'turnCompleted' }])
})

test('chat response maps content to assistant transcriptFinal', () => {
  const events = mapDoubaoFrame(jsonFrame(ServerEvent.CHAT_RESPONSE, { content: '已运行测试' }))
  assert.deepEqual(events, [{ type: 'transcriptFinal', role: 'assistant', text: '已运行测试' }])
  assert.deepEqual(mapDoubaoFrame(jsonFrame(ServerEvent.CHAT_RESPONSE, { content: '' })), [])
})

test('dialog common error maps to protocol error', () => {
  const events = mapDoubaoFrame(jsonFrame(ServerEvent.DIALOG_COMMON_ERROR, { message: 'bad request' }))
  assert.equal(events.length, 1)
  const e = events[0] as { type: 'error'; error: ProviderError }
  assert.equal(e.type, 'error')
  assert.equal(e.error.category, 'protocol')
  assert.equal(e.error.code, 'doubao.dialogError')
  assert.equal(e.error.adviceZh, 'bad request')
})

test('connection failed maps to recoverable network error', () => {
  const events = mapDoubaoFrame(jsonFrame(ServerEvent.CONNECTION_FAILED, { error: 'tls' }))
  const e = events[0] as { type: 'error'; error: ProviderError }
  assert.equal(e.error.category, 'network')
  assert.equal(e.error.recoverable, true)
})

test('frame-level ERROR maps error code and message', () => {
  const events = mapDoubaoFrame({
    msgType: MsgType.ERROR,
    flags: 0,
    serialization: Serialization.JSON,
    compression: 0,
    errorCode: 0x1005,
    payload: new Uint8Array(0),
    payloadJson: { error: 'bad appid' },
  })
  const e = events[0] as { type: 'error'; error: ProviderError }
  assert.equal(e.type, 'error')
  assert.equal(e.error.category, 'protocol')
  assert.equal(e.error.adviceZh, 'bad appid')
})

test('internal bookkeeping events produce no unified events', () => {
  for (const eid of [ServerEvent.SESSION_STARTED, ServerEvent.ASR_INFO, ServerEvent.ASR_ENDED, ServerEvent.TTS_SENTENCE_END, ServerEvent.USAGE_RESPONSE, ServerEvent.CHAT_TEXT_QUERY_CONFIRMED]) {
    assert.deepEqual(mapDoubaoFrame(jsonFrame(eid, {})), [], 'event ' + eid)
  }
})

test('full round-trip: server TTS frame bytes -> parse -> map', () => {
  // 手工拼服务端 TTS_RESPONSE(352) 帧：FULL_SERVER_RESPONSE + FLAG_EVENT + RAW，裸 PCM
  const pcm = new Uint8Array([0x00, 0x10, 0xff, 0x00])
  const sid = new TextEncoder().encode('session-abc')
  const out: number[] = [0x11, (MsgType.FULL_SERVER_RESPONSE << 4) | FLAG_EVENT, (Serialization.RAW << 4) | 0, 0x00]
  const u32 = (n: number) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  u32(ServerEvent.TTS_RESPONSE)
  u32(sid.length)
  for (const b of sid) out.push(b)
  u32(pcm.length)
  for (const b of pcm) out.push(b)

  const parsed = parseServerFrame(new Uint8Array(out))
  const events = mapDoubaoFrame(parsed)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { type: 'audioFrame', samples: [0x00, 0x10, 0xff, 0x00] })
})
