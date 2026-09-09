import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  keywordFromSherpaResult,
  probeSherpaKwsAssets,
  resampleFloat32,
  validateSherpaKwsManifest,
} from './sherpa-kws-browser.ts'

const validManifest = {
  schemaVersion: 1,
  wrapperScript: 'sherpa-onnx-kws.js',
  runtimeScript: 'sherpa-onnx-wasm-kws-main.js',
  sampleRate: 16000,
  recognizerConfig: { keywords: 'jarvis' },
}

test('validates a local sherpa KWS asset manifest', () => {
  assert.deepEqual(validateSherpaKwsManifest(validManifest), validManifest)
})

test('rejects remote or parent-relative runtime paths', () => {
  assert.throws(() => validateSherpaKwsManifest({ ...validManifest, runtimeScript: 'https://example.com/kws.js' }))
  assert.throws(() => validateSherpaKwsManifest({ ...validManifest, wrapperScript: '../kws.js' }))
})

test('extracts only non-empty keyword results', () => {
  assert.equal(keywordFromSherpaResult({ keyword: ' 贾维斯 ' }), '贾维斯')
  assert.equal(keywordFromSherpaResult({ keyword: '' }), '')
  assert.equal(keywordFromSherpaResult({ text: '贾维斯' }), '')
})

test('resamples float audio to the requested rate', () => {
  const output = resampleFloat32(new Float32Array([0, 0.5, 1, 0.5]), 4, 2)
  assert.deepEqual([...output], [0, 1])
})

test('asset probe reports an absent manifest without throwing', async () => {
  const result = await probeSherpaKwsAssets('/wake/', async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  }))
  assert.deepEqual(result, { available: false, reason: '离线唤醒模型未安装' })
})

test('asset probe returns a validated manifest', async () => {
  const result = await probeSherpaKwsAssets('/wake/', async () => ({
    ok: true,
    status: 200,
    json: async () => validManifest,
  }))
  assert.equal(result.available, true)
  if (result.available) assert.equal(result.manifest.sampleRate, 16000)
})
