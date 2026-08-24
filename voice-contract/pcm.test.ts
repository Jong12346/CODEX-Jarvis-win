import { test } from 'node:test'
import assert from 'node:assert/strict'
import { float32ToPcm16, resamplePcm16 } from './pcm.ts'

test('float32 silence maps to zero bytes', () => {
  const out = float32ToPcm16(new Float32Array([0, 0, 0]))
  assert.deepEqual([...out], [0, 0, 0, 0, 0, 0])
})

test('float32 extremes map to int16 bounds', () => {
  assert.deepEqual([...float32ToPcm16(new Float32Array([1.0]))], [0xff, 0x7f])
  assert.deepEqual([...float32ToPcm16(new Float32Array([-1.0]))], [0x00, 0x80])
})

test('float32 half-scale maps to ~16384', () => {
  const out = float32ToPcm16(new Float32Array([0.5]))
  assert.deepEqual([...out], [0x00, 0x40])
})

test('float32 clamps out-of-range values', () => {
  assert.deepEqual([...float32ToPcm16(new Float32Array([1.5]))], [0xff, 0x7f])
  assert.deepEqual([...float32ToPcm16(new Float32Array([-2]))], [0x00, 0x80])
})

test('resample is identity at the same rate', () => {
  const bytes = new Uint8Array([0x64, 0x00, 0xc8, 0x00]) // 100, 200
  const out = resamplePcm16(bytes, 48000, 48000)
  assert.deepEqual([...out], [...bytes])
})

test('resample 48000 -> 24000 halves the sample count', () => {
  const bytes = float32ToPcm16(new Float32Array([0.1, 0.2, 0.3, 0.4]))
  const out = resamplePcm16(bytes, 48000, 24000)
  assert.equal(out.length, bytes.length / 2)
  // 线性重采样：取源位置 0 与 2
  const s0 = (out[0] | (out[1] << 8)) << 16 >> 16
  const s1 = (out[2] | (out[3] << 8)) << 16 >> 16
  assert.ok(Math.abs(s0 - Math.round(0.1 * 0x7fff)) <= 1)
  assert.ok(Math.abs(s1 - Math.round(0.3 * 0x7fff)) <= 1)
})

test('resample 24000 -> 48000 doubles and interpolates', () => {
  const bytes = new Uint8Array([100 & 0xff, 100 >> 8, 200 & 0xff, 200 >> 8]) // 100, 200
  const out = resamplePcm16(bytes, 24000, 48000)
  assert.equal(out.length, bytes.length * 2)
  const read = (o: number) => (out[o * 2] | (out[o * 2 + 1] << 8)) << 16 >> 16
  assert.equal(read(0), 100)
  assert.equal(read(1), 150)
  assert.equal(read(2), 200)
  assert.equal(read(3), 200)
})
