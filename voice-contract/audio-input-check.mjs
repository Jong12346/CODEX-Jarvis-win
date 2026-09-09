// 豆包 duplex 音频输入自检：读 WAV → 转 16k 单声道 s16le → 流式发送 → 等 ASR 与回复。
// 默认输入 .tmp/reply.wav；也可把自己的语音 WAV 路径作为第一个参数传入。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDuplexSession } from './doubao-duplex.ts'
import { measurePcm16, readWav, toMonoPcm16, writePcm16Wav } from './wav-audio.mjs'

const logFile = fileURLToPath(new URL('../.tmp/audio-input-check.log', import.meta.url))
try { writeFileSync(logFile, '') } catch { /* 日志清空失败不阻塞 */ }
function log(msg) {
  console.log(msg)
  try { appendFileSync(logFile, String(msg) + '\n') } catch { /* 日志写失败不影响自检 */ }
}

process.on('uncaughtException', (error) => {
  log('未捕获异常: ' + (error && error.message ? error.message : String(error)))
  process.exit(1)
})

const inputPath = process.argv[2] || fileURLToPath(new URL('../.tmp/reply.wav', import.meta.url))
let inputWav
let pcm16
try {
  inputWav = readWav(readFileSync(inputPath))
  pcm16 = toMonoPcm16(inputWav, 16000)
  const metrics = measurePcm16(pcm16, 16000)
  log(`输入音频: ${inputPath} → ${inputWav.sampleRate}Hz/${inputWav.channels}ch/${inputWav.bits}bit`)
  log(`转换结果: ${pcm16.length} 字节 PCM16@16kHz，${metrics.durationMs}ms，peak=${metrics.peak}，rms=${metrics.rms}`)
  if (metrics.signal !== 'present') throw new Error(`输入音频信号为 ${metrics.signal}，不会提交给 ASR`)
} catch (error) {
  log('读取或转换 WAV 失败: ' + error.message)
  process.exit(2)
}

const key = process.env.DOUBAO_API_KEY
if (!key) {
  log('缺少 DOUBAO_API_KEY 环境变量。')
  process.exit(2)
}

const url = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
const ws = new WebSocket(url, { headers: { 'X-Api-Key': key } })

let asrText = ''
let replyText = ''
const replyAudio = []
let done = false
let validationFailed = false
let gracefulClosed = false
let closeTimer

function bytesToBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function streamAudio() {
  for (let offset = 0; offset < pcm16.length; offset += 640) {
    const chunk = pcm16.subarray(offset, Math.min(offset + 640, pcm16.length))
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytesToBase64(chunk) }))
    await sleep(20)
  }
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  // 文件发送完毕等同于关闭麦克风；全双工模型要求显式进入静音态以保持会话存活。
  ws.send(JSON.stringify({ type: 'input_audio_mute.commit' }))
  log('[sent] 音频已全部发送并 commit，已发送 mute 保活，等待 ASR 与回复...')
}

function finalize() {
  if (done) return
  done = true
  clearTimeout(responseTimer)

  if (!asrText.trim()) {
    validationFailed = true
    log('FAIL：服务端未返回有效 ASR 转写。')
  }
  if (!replyText.trim()) {
    validationFailed = true
    log('FAIL：服务端未返回回复文本。')
  }
  if (replyAudio.length === 0) {
    validationFailed = true
    log('FAIL：服务端未返回回复音频。')
  } else {
    const pcm = Buffer.concat(replyAudio.map((chunk) => Buffer.from(chunk)))
    try {
      const metrics = measurePcm16(pcm, 24000)
      const wavPath = fileURLToPath(new URL('../.tmp/reply2.wav', import.meta.url))
      writeFileSync(wavPath, writePcm16Wav(pcm, 24000))
      log(`已保存回复音频: .tmp/reply2.wav (${pcm.length} 字节，peak=${metrics.peak}，rms=${metrics.rms})`)
      if (metrics.signal !== 'present') {
        validationFailed = true
        log(`FAIL：回复音频信号为 ${metrics.signal}。`)
      }
    } catch (error) {
      validationFailed = true
      log('FAIL：回复音频不是有效 PCM16：' + error.message)
    }
  }

  log('音频输入自检完成，优雅关闭...')
  ws.send(JSON.stringify({ type: 'session.close' }))
  closeTimer = setTimeout(() => {
    log('FAIL：5 秒内未收到 session.closed。')
    try { ws.close() } catch { /* noop */ }
    process.exit(1)
  }, 5000)
}

const responseTimer = setTimeout(() => {
  log('超时：50 秒内未完成。')
  try { ws.close() } catch { /* noop */ }
  process.exit(1)
}, 50000)

ws.addEventListener('open', () => {
  log('[open] 已连接，发送 session.create (model=1.2.6.1) ...')
  ws.send(JSON.stringify({
    type: 'session.create',
    session: buildDuplexSession({ voice: process.env.DOUBAO_VOICE }),
  }))
})

ws.addEventListener('message', (ev) => {
  const data = typeof ev.data === 'string' ? ev.data : ''
  let obj
  try { obj = JSON.parse(data) } catch { return }
  const type = obj.type

  if (type === 'session.created') {
    log('SUCCESS session.id = ' + (obj.session && obj.session.id))
    log(`[send] 开始流式发送输入音频 (${Math.round(pcm16.length / 2 / 16000 * 1000)}ms)...`)
    void streamAudio()
  } else if (type === 'conversation.item.input_audio_transcription.delta') {
    // 豆包 delta 是当前完整的阶段性识别结果，不是可直接拼接的 token。
    if (typeof obj.delta === 'string' && obj.delta) asrText = obj.delta
  } else if (type === 'conversation.item.input_audio_transcription.completed') {
    const completed = obj.transcript ?? asrText
    if (typeof completed === 'string' && completed) asrText = completed
    log('')
    log('[ASR 转写] ' + asrText)
  } else if (type === 'response.output_text.delta') {
    replyText += obj.delta || ''
    process.stdout.write(obj.delta || '')
  } else if (type === 'response.output_text.done') {
    const completed = obj.text ?? replyText
    if (typeof completed === 'string' && completed) replyText = completed
    log('')
    log('[reply text] ' + replyText)
  } else if (type === 'response.output_audio.delta') {
    const b64 = obj.audio || obj.delta || ''
    if (b64) replyAudio.push(Buffer.from(b64, 'base64'))
  } else if (type === 'response.done') {
    log('[response.done] 一轮交互结束')
    finalize()
  } else if (type === 'input_audio_buffer.committed') {
    log('[ack] 服务端已确认结束 ASR 输入。')
  } else if (type === 'conversation.item.input_audio_transcription.failed') {
    validationFailed = true
    log('FAIL：服务端 ASR 识别失败。')
    finalize()
  } else if (type === 'session.closed') {
    gracefulClosed = true
    log(validationFailed ? '会话已优雅关闭，但自检失败。' : '会话已优雅关闭，自检通过。')
    clearTimeout(responseTimer)
    clearTimeout(closeTimer)
    ws.close()
    process.exit(validationFailed ? 1 : 0)
  } else if (type === 'error') {
    log(`FAIL 服务端错误: code=${obj.code || 'unknown'}, message=${obj.message || 'unknown'}`)
    clearTimeout(responseTimer)
    clearTimeout(closeTimer)
    ws.close()
    process.exit(1)
  }
})

ws.addEventListener('error', (ev) => {
  log('WebSocket 连接错误: ' + ((ev && ev.message) || 'unknown'))
  clearTimeout(responseTimer)
  clearTimeout(closeTimer)
  process.exit(1)
})

ws.addEventListener('close', () => {
  if (!gracefulClosed) {
    clearTimeout(responseTimer)
    clearTimeout(closeTimer)
    log('FAIL：连接在收到 session.closed 前关闭。')
    process.exitCode = 1
  }
})
