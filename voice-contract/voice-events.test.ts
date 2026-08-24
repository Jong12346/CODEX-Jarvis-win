import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ProviderError,
  controlSurfaceFor,
  mapVendorEvent,
  providerSwitchPrelude,
  validateAudioFrame,
  voiceSessionConfig,
  type ProviderCapabilities,
  type UnifiedVoiceEvent,
  type VoiceProvider,
  type VoiceSessionConfig,
} from './voice-events.ts'

// 收集整棵 JSON 树的键名，用于 D4/BYOK 边界断言
function collectKeys(value: unknown, out: string[]): void {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item, out)
    } else {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out.push(k)
        collectKeys(v, out)
      }
    }
  }
}

test('audio frames must be non-empty and byte-aligned pcm16', () => {
  assert.equal(validateAudioFrame(new Array(640).fill(0)), true, '320 samples x 2 bytes')
  assert.equal(validateAudioFrame(new Array(639).fill(0)), false, 'odd length invalid')
  assert.equal(validateAudioFrame([]), false, 'empty frame invalid')
})

test('errors always carry stable code, category and advice', () => {
  const err = new ProviderError('network.tls', 'network', true, '请检查系统代理或 VPN 后重试')
  assert.equal(err.code, 'network.tls')
  assert.equal(err.category, 'network')
  assert.equal(err.recoverable, true)
  assert.ok(err.adviceZh.length > 0)
  const v = JSON.parse(JSON.stringify(err))
  assert.equal(v.code, 'network.tls')
  assert.equal(v.category, 'network')
  assert.equal(v.recoverable, true)
  assert.ok('adviceZh' in v)
})

test('provider error categories cover all planned fault domains', () => {
  const cases: Array<[string, ProviderError['category']]> = [
    ['network.timeout', 'network'],
    ['auth.expired', 'auth'],
    ['mic.denied', 'mic'],
    ['codec.decode', 'codec'],
    ['protocol.unknownEvent', 'protocol'],
    ['rate.limited', 'rate'],
  ]
  for (const [code, category] of cases) {
    const err = new ProviderError(code, category, false, '建议')
    assert.equal(err.category, category)
    assert.ok(err.code.length > 0)
    assert.ok(err.adviceZh.length > 0)
  }
})

test('control surface is a pure function of capabilities', () => {
  const full: ProviderCapabilities = { realtime: true, toolEvents: true, interruptable: true, audioFormat: 'pcm16' }
  const s = controlSurfaceFor(full)
  assert.equal(s.showInterrupt, true)
  assert.equal(s.showTaskTools, true)
  assert.equal(s.showRealtimeBadge, true)
  assert.equal(s.pipelineOnly, false)

  const voiceOnly: ProviderCapabilities = { realtime: true, toolEvents: false, interruptable: false, audioFormat: 'pcm16' }
  const s2 = controlSurfaceFor(voiceOnly)
  assert.equal(s2.showInterrupt, false)
  assert.equal(s2.showTaskTools, false)
  assert.equal(s2.showRealtimeBadge, true)
  assert.equal(s2.pipelineOnly, false)

  const pipeline: ProviderCapabilities = { realtime: false, toolEvents: false, interruptable: false, audioFormat: 'none' }
  const s3 = controlSurfaceFor(pipeline)
  assert.equal(s3.showRealtimeBadge, false)
  assert.equal(s3.pipelineOnly, true)
  assert.ok(s3.degradedCopyHint.length > 0)
})

test('control surface serializes for the frontend', () => {
  const caps: ProviderCapabilities = { realtime: true, toolEvents: false, interruptable: true, audioFormat: 'opus' }
  const v = controlSurfaceFor(caps)
  assert.equal(v.showInterrupt, true)
  assert.equal(v.showTaskTools, false)
  assert.equal(v.showRealtimeBadge, true)
  assert.equal(v.pipelineOnly, false)
})

test('vendor event mapping is total and typed', () => {
  const cases: Array<[string, unknown, UnifiedVoiceEvent]> = [
    ['transcript.delta', { role: 'user', text: '你好' }, { type: 'transcriptDelta', role: 'user', text: '你好' }],
    ['transcript.final', { role: 'assistant', text: '收到' }, { type: 'transcriptFinal', role: 'assistant', text: '收到' }],
    ['turn.started', {}, { type: 'turnStarted' }],
    ['turn.completed', {}, { type: 'turnCompleted' }],
    ['session.ended', { reason: 'stop' }, { type: 'sessionEnded', reason: 'stop' }],
    ['tool.event', { kind: 'command', summary: '运行测试' }, { type: 'toolEvent', kind: 'command', summary: '运行测试' }],
  ]
  for (const [kind, payload, expected] of cases) {
    assert.deepEqual(mapVendorEvent(kind, payload), expected, 'kind=' + kind)
  }
})

test('unknown vendor events classify as protocol errors', () => {
  assert.throws(
    () => mapVendorEvent('vendor.private', {}),
    (e: unknown) => e instanceof ProviderError && e.category === 'protocol' && !e.recoverable && e.adviceZh.length > 0 && e.code === 'protocol.unknownEvent',
  )
})

test('malformed vendor events classify as protocol errors', () => {
  const bad = (fn: () => void) => assert.throws(fn, (e: unknown) => e instanceof ProviderError && e.category === 'protocol')
  bad(() => mapVendorEvent('transcript.delta', { role: 'user' }))
  bad(() => mapVendorEvent('transcript.delta', { role: 'robot', text: 'x' }))
  bad(() => mapVendorEvent('transcript.delta', null))
  bad(() => mapVendorEvent('transcript.delta', { role: 'user', text: 42 }))
})

test('audio frames never travel the json event path', () => {
  assert.throws(
    () => mapVendorEvent('audio.frame', { samples: 'AAAA' }),
    (e: unknown) => e instanceof ProviderError && e.code === 'protocol.audioOnJsonPath',
  )
})

test('session end events require a reason', () => {
  assert.throws(() => mapVendorEvent('session.ended', {}), (e: unknown) => e instanceof ProviderError && e.category === 'protocol')
  assert.throws(() => mapVendorEvent('session.ended', { reason: 7 }), (e: unknown) => e instanceof ProviderError && e.category === 'protocol')
})

test('tool events require kind and summary', () => {
  assert.throws(() => mapVendorEvent('tool.event', { summary: 'x' }), (e: unknown) => e instanceof ProviderError && e.category === 'protocol')
  assert.throws(() => mapVendorEvent('tool.event', { kind: 'command' }), (e: unknown) => e instanceof ProviderError && e.category === 'protocol')
})

test('unified events serialize with type tag and camelCase', () => {
  const delta = mapVendorEvent('transcript.delta', { role: 'user', text: '你好' })
  assert.deepEqual(delta, { type: 'transcriptDelta', role: 'user', text: '你好' })
  assert.equal(JSON.parse(JSON.stringify(mapVendorEvent('turn.started', {}))).type, 'turnStarted')
  assert.deepEqual(JSON.parse(JSON.stringify(mapVendorEvent('session.ended', { reason: 'stop' }))), { type: 'sessionEnded', reason: 'stop' })
})

test('provider switch uses the ordered shutdown prefix', () => {
  const active: VoiceStateInput[] = ['voiceConnecting', 'voiceListening', 'voiceSpeaking', 'working']
  for (const state of active) {
    assert.deepEqual(providerSwitchPrelude(state).steps, ['requestVoiceStop', 'awaitVoiceStopped', 'instantiate'], state)
  }
  for (const state of ['wakeReady', 'degraded'] as VoiceStateInput[]) {
    assert.deepEqual(providerSwitchPrelude(state).steps, ['instantiate'], state)
  }
  const mid: VoiceStateInput[] = ['booting', 'wakeArming', 'wakeDetected', 'wakeReleasingMicrophone', 'voiceAcquiringMicrophone', 'voiceStopping', 'wakeRearming', 'stopping']
  for (const state of mid) {
    assert.deepEqual(providerSwitchPrelude(state).steps, ['reject'], state)
  }
})

test('switch plan never touches the agent backend', () => {
  for (const state of ['voiceListening', 'wakeReady', 'stopping']) {
    const plan = providerSwitchPrelude(state as VoiceStateInput)
    const keys: string[] = []
    collectKeys(plan, keys)
    assert.ok(!keys.some((k) => k.toLowerCase().includes('thread')), 'switch plan must not reference threads')
  }
})

test('voice session config never carries thread identity', () => {
  const cfg = voiceSessionConfig('E:/project', { model: 'doubao-realtime', apiKeyRef: 'cred.volcengine' })
  const keys: string[] = []
  collectKeys(cfg, keys)
  assert.ok(!keys.some((k) => k.toLowerCase().includes('thread')), 'voice config must not carry thread (D4)')
  for (const k of keys) {
    if (k.toLowerCase().includes('key')) {
      assert.ok(k.endsWith('Ref'), 'only key references allowed, no plaintext key: ' + k)
    }
  }
})

// ---------- provider 实现义务：假件驱动的生命周期契约 ----------

class FakeProvider implements VoiceProvider {
  events: UnifiedVoiceEvent[]
  connected = false
  calls: string[] = []

  constructor(events: UnifiedVoiceEvent[]) {
    this.events = events
  }

  async connect(_config: VoiceSessionConfig): Promise<void> {
    this.connected = true
    this.calls.push('connect')
  }

  async interrupt(): Promise<void> {
    if (!this.connected) throw new ProviderError('voice.notConnected', 'protocol', false, '请先建立语音会话')
    this.calls.push('interrupt')
  }

  async sendText(_text: string): Promise<void> {
    if (!this.connected) throw new ProviderError('voice.notConnected', 'protocol', false, '请先建立语音会话')
    this.calls.push('sendText')
  }

  async stop(): Promise<void> {
    this.connected = false
    this.calls.push('stop')
  }

  capabilities(): ProviderCapabilities {
    return { realtime: true, toolEvents: false, interruptable: true, audioFormat: 'pcm16' }
  }

  async nextEvent(): Promise<UnifiedVoiceEvent | undefined> {
    if (!this.connected) return undefined
    return this.events.shift()
  }
}

test('providers must reject use before connect', async () => {
  const fake = new FakeProvider([])
  await assert.rejects(fake.sendText('你好'), (e: unknown) => e instanceof ProviderError && e.category === 'protocol')
  await assert.rejects(fake.interrupt(), (e: unknown) => e instanceof ProviderError && e.category === 'protocol')
})

test('providers emit events in order and stop is idempotent', async () => {
  const fake = new FakeProvider([
    { type: 'transcriptDelta', role: 'user', text: '嗨' },
    { type: 'transcriptFinal', role: 'user', text: '嗨 Jarvis' },
    { type: 'turnStarted' },
    { type: 'turnCompleted' },
  ])
  await fake.connect(voiceSessionConfig('E:/project', { model: 'test' }))
  assert.deepEqual(await fake.nextEvent(), { type: 'transcriptDelta', role: 'user', text: '嗨' })
  await fake.interrupt()
  assert.deepEqual(await fake.nextEvent(), { type: 'transcriptFinal', role: 'user', text: '嗨 Jarvis' })
  assert.deepEqual(await fake.nextEvent(), { type: 'turnStarted' })
  assert.deepEqual(await fake.nextEvent(), { type: 'turnCompleted' })
  await fake.stop()
  await fake.stop()
  assert.equal(await fake.nextEvent(), undefined)
  assert.deepEqual(fake.calls, ['connect', 'interrupt', 'stop', 'stop'])
})

type VoiceStateInput = Parameters<typeof providerSwitchPrelude>[0]
