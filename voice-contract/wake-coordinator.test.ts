import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WakeVoiceCoordinator,
  type WakeCoordinatorState,
  type WakeTrigger,
  type WakeWordEngine,
} from './wake-coordinator.ts'

class FakeWakeEngine implements WakeWordEngine {
  starts = 0
  stops = 0
  disposes = 0
  detector: ((keyword: string) => void) | null = null
  startGate: Promise<void> | null = null
  stopGate: Promise<void> | null = null
  startError: Error | null = null

  async start(onDetected: (keyword: string) => void): Promise<void> {
    this.starts += 1
    this.detector = onDetected
    if (this.startError) throw this.startError
    if (this.startGate) await this.startGate
  }

  async stop(): Promise<void> {
    this.stops += 1
    if (this.stopGate) await this.stopGate
  }

  dispose(): void { this.disposes += 1 }
  detect(keyword = '嗨 Jarvis'): void { this.detector?.(keyword) }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function setup() {
  const engine = new FakeWakeEngine()
  const states: WakeCoordinatorState[] = []
  const requests: WakeTrigger[] = []
  const coordinator = new WakeVoiceCoordinator(engine, {
    onState: (state) => states.push(state),
    onVoiceRequested: (trigger) => { requests.push(trigger) },
  })
  return { coordinator, engine, states, requests }
}

test('arm starts the engine before reporting armed', async () => {
  const s = setup()
  const gate = deferred()
  s.engine.startGate = gate.promise
  const arming = s.coordinator.arm()
  assert.deepEqual(s.states, ['loading'])
  gate.resolve()
  await arming
  assert.deepEqual(s.states, ['loading', 'armed'])
  assert.equal(s.engine.starts, 1)
})

test('keyword detection releases wake before requesting voice', async () => {
  const s = setup()
  await s.coordinator.arm()
  const gate = deferred()
  s.engine.stopGate = gate.promise
  s.engine.detect('贾维斯')
  await Promise.resolve()
  assert.equal(s.coordinator.currentState, 'releasing')
  assert.deepEqual(s.requests, [])
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(s.coordinator.currentState, 'suspended')
  assert.deepEqual(s.requests, [{ source: 'keyword', keyword: '贾维斯' }])
})

test('duplicate keyword hits cannot open two voice sessions', async () => {
  const s = setup()
  await s.coordinator.arm()
  s.engine.detect()
  s.engine.detect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(s.requests.length, 1)
})

test('disabling auto wake during microphone release keeps the current voice request', async () => {
  const s = setup()
  await s.coordinator.arm()
  const gate = deferred()
  s.engine.stopGate = gate.promise
  s.engine.detect()
  await Promise.resolve()
  await s.coordinator.disarm()
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(s.requests, [{ source: 'keyword', keyword: '嗨 Jarvis' }])
  await s.coordinator.voiceStopped()
  assert.equal(s.coordinator.currentState, 'idle')
  assert.equal(s.engine.starts, 1)
})

test('voice stop re-arms wake when it is still enabled', async () => {
  const s = setup()
  await s.coordinator.arm()
  await s.coordinator.requestVoice({ source: 'manual' })
  await s.coordinator.voiceStopped()
  assert.equal(s.coordinator.currentState, 'armed')
  assert.equal(s.engine.starts, 2)
})

test('disarm during a pending start prevents a late armed state', async () => {
  const s = setup()
  const gate = deferred()
  s.engine.startGate = gate.promise
  const arming = s.coordinator.arm()
  await s.coordinator.disarm()
  gate.resolve()
  await arming
  assert.equal(s.coordinator.currentState, 'idle')
  assert.equal(s.coordinator.wakeEnabled, false)
})

test('manual voice remains available without enabling wake', async () => {
  const s = setup()
  await s.coordinator.requestVoice({ source: 'manual' })
  assert.equal(s.coordinator.currentState, 'suspended')
  assert.deepEqual(s.requests, [{ source: 'manual' }])
  await s.coordinator.voiceStopped()
  assert.equal(s.coordinator.currentState, 'idle')
})

test('engine load failure is reported and disables automatic re-arm', async () => {
  const s = setup()
  s.engine.startError = new Error('missing model')
  await s.coordinator.arm()
  assert.equal(s.coordinator.currentState, 'error')
  assert.equal(s.coordinator.wakeEnabled, false)
  assert.equal(s.engine.stops, 1)
})

test('dispose tears down the engine and ignores future arm calls', async () => {
  const s = setup()
  await s.coordinator.arm()
  await s.coordinator.dispose()
  await s.coordinator.arm()
  assert.equal(s.coordinator.currentState, 'disposed')
  assert.equal(s.engine.disposes, 1)
  assert.equal(s.engine.starts, 1)
})
