import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DoubaoRelay, type RelayData, type RelayEnd, type RelayHandlers, type UpstreamFactory } from './relay.ts'

class FakeEnd implements RelayEnd {
  sent: RelayData[] = []
  closed = false
  private handlers: RelayHandlers | null = null
  send(data: RelayData): void { this.sent.push(data) }
  close(): void { this.closed = true; this.handlers?.onClose() }
  setHandlers(handlers: RelayHandlers): void { this.handlers = handlers }
  emit(data: RelayData): void { this.handlers?.onMessage(data) }
  emitClose(): void { this.handlers?.onClose() }
}

test('attach opens upstream with the auth headers and target url', () => {
  let seenUrl = ''
  let seenHeaders: Record<string, string> = {}
  const upstream = new FakeEnd()
  const factory: UpstreamFactory = (url, headers) => {
    seenUrl = url
    seenHeaders = headers
    return upstream
  }
  const relay = new DoubaoRelay(factory, 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue', {
    'X-Api-App-ID': 'app-123',
    'X-Api-Access-Key': 'ak-secret',
    'X-Api-Resource-Id': 'volc.speech.dialog',
  })

  const browser = new FakeEnd()
  relay.attach(browser)
  assert.equal(seenUrl, 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue')
  assert.equal(seenHeaders['X-Api-App-ID'], 'app-123')
  assert.equal(seenHeaders['X-Api-Access-Key'], 'ak-secret')
  assert.equal(seenHeaders['X-Api-Resource-Id'], 'volc.speech.dialog')
})

test('bytes flow both ways between browser and upstream', () => {
  const upstream = new FakeEnd()
  const relay = new DoubaoRelay(() => upstream, 'wss://example', {})
  const browser = new FakeEnd()
  relay.attach(browser)

  const audio = new Uint8Array([0x00, 0x10])
  browser.emit(audio)
  assert.ok(upstream.sent[0] instanceof Uint8Array)
  assert.deepEqual([...upstream.sent[0]], [...audio])

  const tts = new Uint8Array([0xff, 0xee])
  upstream.emit(tts)
  assert.ok(browser.sent[0] instanceof Uint8Array)
  assert.deepEqual([...browser.sent[0]], [...tts])
})

test('text frames keep their type in both directions', () => {
  const upstream = new FakeEnd()
  const relay = new DoubaoRelay(() => upstream, 'wss://example', {})
  const browser = new FakeEnd()
  relay.attach(browser)

  browser.emit('{"type":"session.create"}')
  assert.equal(upstream.sent[0], '{"type":"session.create"}')

  upstream.emit('{"type":"session.created"}')
  assert.equal(browser.sent[0], '{"type":"session.created"}')
})

test('browser close tears down upstream', () => {
  const upstream = new FakeEnd()
  const relay = new DoubaoRelay(() => upstream, 'wss://example', {})
  const browser = new FakeEnd()
  relay.attach(browser)
  browser.emitClose()
  assert.equal(upstream.closed, true)
})

test('upstream close tears down browser', () => {
  const upstream = new FakeEnd()
  const relay = new DoubaoRelay(() => upstream, 'wss://example', {})
  const browser = new FakeEnd()
  relay.attach(browser)
  upstream.emitClose()
  assert.equal(browser.closed, true)
})
