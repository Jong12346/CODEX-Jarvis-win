import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measurePcm16, readWav, toMonoPcm16, writePcm16Wav } from './wav-audio.mjs'

function wavWithFormat({ format = 1, channels, sampleRate, bits, data }) {
  const blockAlign = channels * bits / 8
  const wav = Buffer.alloc(44 + data.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + data.length, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(format, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * blockAlign, 28)
  wav.writeUInt16LE(blockAlign, 32)
  wav.writeUInt16LE(bits, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(data.length, 40)
  data.copy(wav, 44)
  return wav
}

test('PCM16 WAV round-trips and reports signed signal levels', () => {
  const pcm = Buffer.alloc(6)
  pcm.writeInt16LE(-32768, 0)
  pcm.writeInt16LE(0, 2)
  pcm.writeInt16LE(32767, 4)
  const parsed = readWav(writePcm16Wav(pcm, 24000))
  assert.equal(parsed.format, 1)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.sampleRate, 24000)
  assert.deepEqual(Buffer.from(parsed.data), pcm)
  const metrics = measurePcm16(parsed.data, 24000)
  assert.equal(metrics.samples, 3)
  assert.equal(metrics.sampleRate, 24000)
  assert.equal(metrics.durationMs, 0)
  assert.equal(metrics.peak, 32768)
  assert.ok(Math.abs(metrics.rms - 26754.552) < 0.001)
  assert.equal(metrics.rmsDbfs, -1.76)
  assert.equal(metrics.clippedSamples, 2)
  assert.equal(metrics.signal, 'present')
})

test('IEEE float32 stereo is downmixed without rereading the first sample', () => {
  const samples = Buffer.alloc(16)
  for (const [index, value] of [0.5, 0.5, -0.5, -0.5].entries()) samples.writeFloatLE(value, index * 4)
  const parsed = readWav(wavWithFormat({ format: 3, channels: 2, sampleRate: 16000, bits: 32, data: samples }))
  const mono = Buffer.from(toMonoPcm16(parsed, 16000))
  assert.deepEqual([mono.readInt16LE(0), mono.readInt16LE(2)], [16384, -16384])
})

test('odd-sized ancillary chunks are skipped with their padding byte', () => {
  const original = writePcm16Wav(Buffer.from([1, 0, 2, 0]), 16000)
  const junkSize = Buffer.alloc(4)
  junkSize.writeUInt32LE(3)
  const withJunk = Buffer.concat([
    original.subarray(0, 36),
    Buffer.from('JUNK'), junkSize, Buffer.from([7, 8, 9, 0]),
    original.subarray(36),
  ])
  withJunk.writeUInt32LE(withJunk.length - 8, 4)
  assert.deepEqual(Buffer.from(readWav(withJunk).data), Buffer.from([1, 0, 2, 0]))
})

test('truncated and misaligned WAV data are rejected', () => {
  const truncated = writePcm16Wav(Buffer.from([1, 0]), 16000).subarray(0, 45)
  assert.throws(() => readWav(truncated), /截断/)
  const misaligned = wavWithFormat({ channels: 2, sampleRate: 16000, bits: 16, data: Buffer.from([1, 0]) })
  assert.throws(() => readWav(misaligned), /对齐/)
})
