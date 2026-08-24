// 豆包 duplex 一轮真实对话自检：session.create → 文字打招呼 → 收回复(文本+音频) → 优雅关闭。
// 从环境变量读 DOUBAO_API_KEY，绝不硬编码、绝不回显。回复音频存 .tmp/reply.wav 可直接听。
// 用法：双击 run-conversation.bat（或 $env:DOUBAO_API_KEY=...; node voice-contract/conversation-check.mjs）

import { appendFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const logFile = fileURLToPath(new URL('../.tmp/conversation-check.log', import.meta.url))
function log(msg) {
  console.log(msg)
  try {
    appendFileSync(logFile, String(msg) + '\n')
  } catch {
    /* ignore */
  }
}

const key = process.env.DOUBAO_API_KEY
if (!key) {
  log('缺少 DOUBAO_API_KEY 环境变量。')
  process.exit(2)
}

const url = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
const ws = new WebSocket(url, { headers: { 'X-Api-Key': key } })

let replyText = ''
const audioChunks = []
let done = false

function concat(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function wavHeader(dataLength) {
  const buf = new Uint8Array(44)
  const dv = new DataView(buf.buffer)
  buf.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  dv.setUint32(4, 36 + dataLength, true)
  buf.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  buf.set([0x66, 0x6d, 0x74, 0x20], 12) // fmt
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, 24000, true)
  dv.setUint32(28, 24000 * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  buf.set([0x64, 0x61, 0x74, 0x61], 36) // data
  dv.setUint32(40, dataLength, true)
  return buf
}

function finalize() {
  if (done) return
  done = true
  clearTimeout(timer)
  if (audioChunks.length > 0) {
    const pcm = concat(audioChunks)
    const wavPath = fileURLToPath(new URL('../.tmp/reply.wav', import.meta.url))
    const wav = new Uint8Array(44 + pcm.length)
    wav.set(wavHeader(pcm.length), 0)
    wav.set(pcm, 44)
    writeFileSync(wavPath, wav)
    log('已保存回复音频: .tmp/reply.wav (' + pcm.length + ' 字节 PCM16@24kHz)')
  }
  log('对话自检完成，优雅关闭...')
  ws.send(JSON.stringify({ type: 'session.close' }))
}

const timer = setTimeout(() => {
  log('超时：40 秒内未完成一轮对话。')
  try { ws.close() } catch { /* noop */ }
  process.exit(1)
}, 40000)

ws.addEventListener('open', () => {
  log('[open] 已连接，发送 session.create (model=1.2.6.1) ...')
  ws.send(JSON.stringify({
    type: 'session.create',
    session: {
      model: '1.2.6.1',
      audio: {
        input: { format: { type: 'pcm', sample_rate: 16000 } },
        output: { format: { type: 'pcm_s16le', sample_rate: 24000 }, voice: process.env.DOUBAO_VOICE || 'saturn_zh_female_keainvsheng_tob' },
      },
      // 官方：输出 PCM 需在 extension.tts.audio_config 配置；speaker 与旧版 StartSessionPayload 一致
      extension: {
        tts: {
          audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 },
          speaker: process.env.DOUBAO_VOICE || 'saturn_zh_female_keainvsheng_tob',
        },
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
    log('[send] 打招呼: 你好，请介绍一下你自己。')
    ws.send(JSON.stringify({ type: 'speech_text_buffer.commit', text: '你好，请介绍一下你自己。' }))
  } else if (type === 'response.output_text.delta') {
    const delta = obj.delta || ''
    replyText += delta
    process.stdout.write(delta)
  } else if (type === 'response.output_text.done') {
    log('')
    log('[reply text] ' + (obj.text ?? replyText))
  } else if (type === 'response.output_audio.delta') {
    const b64 = obj.audio || obj.delta || ''
    if (b64) {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      audioChunks.push(bytes)
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
