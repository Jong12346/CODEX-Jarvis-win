import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DoubaoDuplexSession, type TextSocket } from './doubao-duplex.ts'
import type { UnifiedVoiceEvent } from './voice-events.ts'

class FakeTextSocket implements TextSocket {
  sent: string[] = []
  closed = false
  send(text: string): void { this.sent.push(text) }
  close(): void { this.closed = true }
}

function setup() {
  const events: UnifiedVoiceEvent[] = []
  const session = new DoubaoDuplexSession({ voice: 'zh_female_vv_jupiter_bigtts' }, (e) => events.push(...e))
  const sock = new FakeTextSocket()
  return { session, sock, events }
}

function serverEvent(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra })
}

test('session create carries model, audio config and voice', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  assert.equal(s.session.state, 'creating')
  const msg = JSON.parse(s.sock.sent[0])
  assert.equal(msg.type, 'session.create')
  assert.equal(msg.session.model, '1.2.6.1')
  assert.deepEqual(msg.session.audio.input.format, { type: 'pcm', sample_rate: 16000 })
  assert.deepEqual(msg.session.audio.output.format, { type: 'pcm_s16le', sample_rate: 24000 })
  assert.equal(msg.session.audio.output.voice, 'zh_female_vv_jupiter_bigtts')
  // 官方：输出 PCM 需在 extension.tts.audio_config 配置
  assert.deepEqual(msg.session.extension.tts.audio_config, { channel: 1, format: 'pcm_s16le', sample_rate: 24000 })
  assert.equal(msg.session.extension.tts.speaker, 'zh_female_vv_jupiter_bigtts')
})

test('session.created activates and records session id', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'dialog-9' } }))
  assert.equal(s.session.state, 'active')
  assert.equal(s.session.sessionId, 'dialog-9')
})

test('ASR events map to user transcripts', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.onMessage(serverEvent('conversation.item.input_audio_transcription.delta', { delta: '嗨', transcript: '嗨' }))
  s.session.onMessage(serverEvent('conversation.item.input_audio_transcription.completed', { transcript: '嗨 Jarvis' }))
  assert.deepEqual(s.events, [
    { type: 'transcriptDelta', role: 'user', text: '嗨' },
    { type: 'transcriptFinal', role: 'user', text: '嗨 Jarvis' },
  ])
})

test('output text and audio map to assistant events', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.onMessage(serverEvent('response.output_audio.started'))
  s.session.onMessage(serverEvent('response.output_text.delta', { delta: '收到' }))
  // 音频 delta：base64 内联，验证解码回 PCM16
  const pcm = new Uint8Array([0x00, 0x10, 0xff, 0x00])
  s.session.onMessage(serverEvent('response.output_audio.delta', { audio: Buffer.from(pcm).toString('base64') }))
  s.session.onMessage(serverEvent('response.output_audio.done'))

  assert.deepEqual(s.events[0], { type: 'turnStarted' })
  assert.deepEqual(s.events[1], { type: 'transcriptDelta', role: 'assistant', text: '收到' })
  const audioEv = s.events[2] as { type: 'audioFrame'; samples: number[] }
  assert.equal(audioEv.type, 'audioFrame')
  assert.deepEqual(audioEv.samples, [0x00, 0x10, 0xff, 0x00])
  assert.deepEqual(s.events[3], { type: 'turnCompleted' })
})

test('function call arguments map to tool events', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.onMessage(serverEvent('response.function_call_arguments.done', {
    items: [{ call_id: 'call-1', name: 'lookup_weather', arguments: '{"city":"Beijing"}' }],
  }))
  assert.deepEqual(s.events, [{ type: 'toolEvent', kind: 'lookup_weather', summary: '{"city":"Beijing"}' }])
})

test('error event maps to a protocol error', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.onMessage(serverEvent('error', { message: 'bad key' }))
  const e = s.events[0] as { type: 'error'; error: { category: string; code: string } }
  assert.equal(e.type, 'error')
  assert.equal(e.error.category, 'protocol')
  assert.equal(e.error.code, 'doubao.duplexError')
})

test('sendAudio base64-encodes into input_audio_buffer.append', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.sendAudio(new Uint8Array([0x00, 0x10]))
  const msg = JSON.parse(s.sock.sent[1])
  assert.equal(msg.type, 'input_audio_buffer.append')
  assert.equal(msg.audio, Buffer.from([0x00, 0x10]).toString('base64'))
})

test('sendText uses the documented specified-speech event', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.sendText('开始执行任务')
  const msg = JSON.parse(s.sock.sent[1])
  assert.equal(msg.type, 'speech_text_buffer.commit')
  assert.equal(msg.text, '开始执行任务')
})

test('function call output is returned via conversation.item.create role=tool', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.sendFunctionCallOutput('call-1', '{"temperature":26}')
  const msg = JSON.parse(s.sock.sent[1])
  assert.equal(msg.type, 'conversation.item.create')
  assert.equal(msg.items[0].call_id, 'call-1')
  assert.equal(msg.items[0].role, 'tool')
  assert.equal(msg.items[0].content[0].type, 'input_text')
  assert.equal(msg.items[0].content[0].text, '{"temperature":26}')
})

test('stop is graceful: session.close first, socket closes on session.closed ack', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.stop()
  assert.equal(s.session.state, 'closing')
  assert.equal(s.sock.closed, false, 'socket must not close before session.closed ack')
  assert.equal(JSON.parse(s.sock.sent[1]).type, 'session.close')
  s.session.onMessage(serverEvent('session.closed'))
  assert.equal(s.session.state, 'closed')
  assert.equal(s.sock.closed, true)
})

test('mute and unmute keep the full-duplex uplink alive', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.mute()
  s.session.unmute()
  assert.equal(JSON.parse(s.sock.sent[1]).type, 'input_audio_mute.commit')
  assert.equal(JSON.parse(s.sock.sent[2]).type, 'input_audio_unmute.commit')
})

test('finished file input ends ASR before entering the muted keepalive state', () => {
  const s = setup()
  s.session.onSocketOpen(s.sock)
  s.session.onMessage(serverEvent('session.created', { session: { id: 'x' } }))
  s.session.commitAudio()
  s.session.mute()
  assert.deepEqual(s.sock.sent.slice(1).map((text) => JSON.parse(text).type), [
    'input_audio_buffer.commit',
    'input_audio_mute.commit',
  ])
})
