/**
 * 音频格式转换（浏览器麦克风 → 豆包）。
 * 浏览器 AudioWorklet 产出 Float32（设备采样率，通常 44100/48000），
 * 豆包 S2S 要求 PCM16 s16le @ 24000。这里提供 float32→int16 与线性重采样两段纯函数。
 */

/** Float32 [-1,1] → PCM16 小端字节（s16le）。越界裁剪。 */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]
    if (s > 1) s = 1
    if (s < -1) s = -1
    const scaled = s < 0 ? s * 0x8000 : s * 0x7fff
    const v = Math.round(scaled)
    out[i * 2] = v & 0xff
    out[i * 2 + 1] = (v >> 8) & 0xff
  }
  return out
}

function readSample(bytes: Uint8Array, i: number): number {
  const idx = i * 2
  const u16 = bytes[idx] | (bytes[idx + 1] << 8)
  return (u16 << 16) >> 16
}

function writeSample(out: Uint8Array, i: number, v: number): void {
  const idx = i * 2
  out[idx] = v & 0xff
  out[idx + 1] = (v >> 8) & 0xff
}

/** PCM16 小端字节流的线性重采样（fromRate → toRate）。同率返回拷贝。 */
export function resamplePcm16(bytes: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) return new Uint8Array(bytes)
  const inSamples = bytes.length / 2
  const ratio = fromRate / toRate
  const outSamples = Math.max(1, Math.round(inSamples / ratio))
  const out = new Uint8Array(outSamples * 2)
  for (let o = 0; o < outSamples; o++) {
    const src = o * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, inSamples - 1)
    const frac = src - i0
    const s0 = readSample(bytes, i0)
    const s1 = readSample(bytes, i1)
    writeSample(out, o, Math.round(s0 + (s1 - s0) * frac))
  }
  return out
}
