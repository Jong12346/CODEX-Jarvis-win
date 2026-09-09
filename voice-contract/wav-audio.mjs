// Offline WAV validation, conversion and signal measurements. No device or network access.
import { resamplePcm16 } from './pcm.ts'

export function readWav(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('需要 RIFF/WAVE 音频文件')
  }
  const end = buffer.readUInt32LE(4) + 8
  if (end > buffer.length || end < 12) throw new Error('WAV 文件被截断')
  let format
  let data
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) throw new Error('WAV 块头被截断')
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > end) throw new Error('WAV 数据块被截断')
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV fmt 块不完整')
      format = {
        format: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bits: buffer.readUInt16LE(start + 14),
      }
    } else if (id === 'data') {
      if (data) throw new Error('暂不支持多个 WAV data 块')
      data = buffer.subarray(start, start + size)
    }
    offset = start + size + (size % 2)
    if (offset > end) throw new Error('WAV 块缺少填充字节')
  }
  if (!format || !data || data.length === 0) throw new Error('WAV 缺少 fmt/data 或音频为空')
  const { channels, sampleRate, bits, blockAlign, byteRate } = format
  if (channels < 1 || channels > 32 || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error('WAV 声道数或采样率不支持')
  }
  if (!(format.format === 1 && [8, 16, 24, 32].includes(bits)) && !(format.format === 3 && bits === 32)) {
    throw new Error('仅支持 PCM 8/16/24/32 位或 IEEE float32 WAV')
  }
  if (blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign || data.length % blockAlign !== 0) {
    throw new Error('WAV 帧对齐或速率字段无效')
  }
  return { ...format, data }
}

export function toMonoPcm16(wav, targetRate = 16000) {
  if (!Number.isInteger(targetRate) || targetRate < 8000 || targetRate > 192000) throw new Error('目标采样率无效')
  const frames = wav.data.length / wav.blockAlign
  const mono = Buffer.alloc(frames * 2)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < wav.channels; channel++) {
      const offset = frame * wav.blockAlign + channel * wav.bits / 8
      let sample
      if (wav.format === 3) {
        sample = wav.data.readFloatLE(offset)
        if (!Number.isFinite(sample)) throw new Error('WAV 包含无效浮点采样')
        sample *= 32768
      } else if (wav.bits === 8) sample = (wav.data[offset] - 128) * 256
      else if (wav.bits === 16) sample = wav.data.readInt16LE(offset)
      else if (wav.bits === 24) sample = wav.data.readIntLE(offset, 3) / 256
      else sample = wav.data.readInt32LE(offset) / 65536
      sum += sample
    }
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / wav.channels))), frame * 2)
  }
  return resamplePcm16(mono, wav.sampleRate, targetRate)
}

export function measurePcm16(bytes, sampleRate = 24000) {
  if (bytes.length === 0 || bytes.length % 2 !== 0) throw new Error('PCM16 必须非空且按 2 字节对齐')
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let peak = 0
  let squares = 0
  let clippedSamples = 0
  for (let offset = 0; offset < data.length; offset += 2) {
    const sample = data.readInt16LE(offset)
    peak = Math.max(peak, Math.abs(sample))
    squares += sample * sample
    if (sample === -32768 || sample === 32767) clippedSamples++
  }
  const samples = data.length / 2
  const rms = Math.sqrt(squares / samples)
  return {
    samples, sampleRate, durationMs: Math.round(samples / sampleRate * 1000), peak,
    rms: Math.round(rms * 1000) / 1000,
    rmsDbfs: rms === 0 ? null : Math.round(20 * Math.log10(rms / 32768) * 100) / 100,
    clippedSamples,
    // A signal-level check is not speech recognition or a listening test.
    signal: peak === 0 ? 'silent' : rms < 100 ? 'quiet' : 'present',
  }
}

export function writePcm16Wav(bytes, sampleRate = 24000) {
  measurePcm16(bytes, sampleRate)
  const wav = Buffer.alloc(44 + bytes.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + bytes.length, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(bytes.length, 40)
  wav.set(bytes, 44)
  return wav
}
