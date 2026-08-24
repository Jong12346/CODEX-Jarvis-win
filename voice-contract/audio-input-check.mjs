// 豆包 duplex 音频输入自检：读 WAV → 转 16k 单声道 s16le → 流式 input_audio_buffer.append → commit
// → 等 ASR 转写 + 模型回复（文本+音频）。默认输入 .tmp/reply.wav（上一轮模型回音，免录音）。
// 用法：双击 run-audio-input.bat（或 node voice-contract/audio-input-check.mjs [wav路径]）

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const logFile = fileURLToPath(new URL('../.tmp/audio-input-check.log', import.meta.url))
try { writeFileSync(logFile, '') } catch { /* 日志清空失败不阻塞 */ }
function log(msg) {
  console.log(msg)
  try {
    appendFileSync(logFile, String(msg) + '\n')
  } catch { /* ignore */ }
}

// 任何未捕获异常都写进日志，便于排查（窗口可能被关掉）
process.on('uncaughtException', (e) => {
  log('未捕获异常: ' + (e && e.stack ? e.stack : String(e)))
  process.exit(1)
})

const key = process.env.DOUBAO_API_KEY
if (!key) {
  log('缺少 DOUBAO_API_KEY 环境变量。')
  process.exit(2)
}

const inputPath = process.argv[2] || fileURLToPath(new URL('../.tmp/reply.wav', import.meta.url))
let wav
try {
  wav = readWav(readFileSync(inputPath))
} catch (e) {
  log('读取 WAV 失败: ' + e.message + '（路径: ' + inputPath + '）')
  process.exit(2)
}
log('输入音频: ' + inputPath + ' → ' + wav.sampleRate + 'Hz/' + wav.channels + 'ch/' + wav.bits + 'bit，转 16k 单声道...')
const pcm16 = toMono16kPcm16(wav)
log('转换后 PCM16 字节数: ' + pcm16.length + '（约 ' + Math.round((pcm16.length / 2 / 16000) * 1000) + 'ms @16k）')

// ---------- WAV 读取 ----------
function readWav(buffer) {
  if (buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46) {
    throw new Error('不是 WAV 文件')
  }
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let off = 12
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= buffer.length) {
    const id = String.fromCharCode(buffer[off], buffer[off + 1], buffer[off + 2], buffer[off + 3])
    const size = dv.getUint32(off + 4, true)
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true),
      }
    } else if (id === 'data') {
      dataOff = off + 8
      dataLen = size
      break
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || dataOff < 0) throw new Error('WAV 缺少 fmt/data 块')
  return { ...fmt, dataOff, dataLen, data: buffer }
}

function toMono16kPcm16(w) {
  const bytesPerSample = w.bits / 8
  const frames = Math.floor(w.dataLen / bytesPerSample / w.channels)
  const mono = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let c = 0; c < w.channels; c++) {
      const idx = w.dataOff + (f * w.channels + c) * bytesPerSample
      if (w.bits === 16) {
        sum += ((w.data[idx] | (w.data[idx + 1] << 8)) << 16) >> 16
      } else if (w.bits === 32) {
        const dv = new DataView(w.data.buffer, w.data.byteOffset, 4)
        sum += dv.getFloat32(idx, true) * 32767
      } else {
        sum += (w.data[idx] - 128) * 256
      }
    }
    mono[f] = sum / w.channels
  }
  const outRate = 16000
  const outLen = Math.max(1, Math.round((frames * outRate) / w.sampleRate))
  const out = new Uint8Array(outLen * 2)
  const ratio = w.sampleRate / outRate
  for (let o = 0; o < outLen; o++) {
    const src = o * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, frames - 1)
    const frac = src - i0
    const v = Math.round(mono[i0] + (mono[i1] - mono[i0]) * frac)
    const c = Math.max(-32768, Math.min(32767, v))
    out[o * 2] = c & 0xff
    out[o * 2 + 1] = (c >> 8) & 0xff
  }
  return out
}

// ---------- 连接与对话 ----------
const url = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
const ws = new WebSocket(url, { headers: { 'X-Api-Key': key } })

let asrText = ''
let replyText = ''
const replyAudio = []
let done = false

function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function streamAudio() {
  for (let off = 0; off < pcm16.length; off += 640) {
    const chunk = pcm16.subarray(off, Math.min(off + 640, pcm16.length))
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytesToBase64(chunk) }))
    await sleep(20)
  }
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  log('[sent] 音频已全部发送并 commit，等待 ASR 与回复...')
}

function finalize() {
  if (done) return
  done = true
  clearTimeout(timer)
  if (replyAudio.length > 0) {
    let total = 0
    for (const c of replyAudio) total += c.length
    const pcm = new Uint8Array(total)
    let off = 0
    for (const c of replyAudio) { pcm.set(c, off); off += c.length }
    const wavPath = fileURLToPath(new URL('../.tmp/reply2.wav', import.meta.url))
    const wav = new Uint8Array(44 + pcm.length)
    wav.set(wavHeader(pcm.length), 0)
    wav.set(pcm, 44)
    writeFileSync(wavPath, wav)
    log('已保存回复音频: .tmp/reply2.wav (' + pcm.length + ' 字节)')
  }
  log('音频输入自检完成，优雅关闭...')
  ws.send(JSON.stringify({ type: 'session.close' }))
}

function wavHeader(dataLength) {
  const buf = new Uint8Array(44)
  const dv = new DataView(buf.buffer)
  buf.set([0x52, 0x49, 0x46, 0x46], 0)
  dv.setUint32(4, 36 + dataLength, true)
  buf.set([0x57, 0x41, 0x56, 0x45], 8)
  buf.set([0x66, 0x6d, 0x74, 0x20], 12)
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, 24000, true)
  dv.setUint32(28, 48000, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  buf.set([0x64, 0x61, 0x74, 0x61], 36)
  dv.setUint32(40, dataLength, true)
  return buf
}

const timer = setTimeout(() => {
  log('超时：50 秒内未完成。')
  try { ws.close() } catch { /* noop */ }
  process.exit(1)
}, 50000)

ws.addEventListener('open', () => {
  log('[open] 已连接，发送 session.create (model=1.2.6.1) ...')
  ws.send(JSON.stringify({
    type: 'session.create',
    session: {
      model: '1.2.6.1',
      audio: {
        input: { format: { type: 'pcm', sample_rate: 16000 } },
        output: { format: { type: 'pcm_s16le', sample_rate: 24000 }, voice: 'zh_female_vv_jupiter_bigtts' },
      },
    },
  }))
})

ws.addEventListener('message', (ev) => {
  const data = typeof ev.data === 'string' ? ev.data : ''
  let obj
  try { obj = JSON.parse(data) } catch { return }
  const type = obj.type

  if (type === 'session.created') {
    log('SUCCESS session.id = ' + (obj.session && obj.session.id))
    log('[send] 开始流式发送输入音频 (' + Math.round((pcm16.length / 2 / 16000) * 1000) + 'ms)...')
    void streamAudio()
  } else if (type === 'conversation.item.input_audio_transcription.delta') {
    asrText += obj.delta || ''
    process.stdout.write(obj.delta || '')
  } else if (type === 'conversation.item.input_audio_transcription.completed') {
    log('')
    log('[ASR 转写] ' + (obj.transcript ?? asrText))
  } else if (type === 'response.output_text.delta') {
    replyText += obj.delta || ''
    process.stdout.write(obj.delta || '')
  } else if (type === 'response.output_text.done') {
    log('')
    log('[reply text] ' + (obj.text ?? replyText))
  } else if (type === 'response.output_audio.delta') {
    const b64 = obj.audio || obj.delta || ''
    if (b64) {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      replyAudio.push(bytes)
    }
  } else if (type === 'response.done') {
    log('[response.done] 一轮交互结束')
    finalize()
  } else if (type === 'session.closed') {
    log('会话已优雅关闭。')
    clearTimeout(timer)
    ws.close()
    process.exit(0)
  } else if (type === 'error') {
    log('FAIL 服务端错误: ' + JSON.stringify(obj))
    clearTimeout(timer)
    ws.close()
    process.exit(1)
  }
})

ws.addEventListener('error', (ev) => {
  log('WebSocket 连接错误: ' + ((ev && ev.message) || 'unknown'))
  clearTimeout(timer)
  process.exit(1)
})
