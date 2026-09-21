// 豆包 duplex 指定文本播报自检：session.create → 打招呼 TTS → 收 PCM 音频 → 优雅关闭。
// 从环境变量读 DOUBAO_API_KEY，绝不硬编码、绝不回显。回复音频存 .tmp/reply.wav 可直接听。
// 用法：双击 run-conversation.bat（或 $env:DOUBAO_API_KEY=...; node voice-contract/conversation-check.mjs）

import { appendFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDuplexSession } from './doubao-duplex.ts'
import { measurePcm16, writePcm16Wav } from './wav-audio.mjs'

const logFile = fileURLToPath(new URL('../.tmp/conversation-check.log', import.meta.url))
try { writeFileSync(logFile, '') } catch { /* 日志清空失败不阻塞 */ }
function log(msg) {
  console.log(msg)
  try { appendFileSync(logFile, String(msg) + '\n') } catch { /* 日志写失败不影响自检 */ }
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
let validationFailed = false
let gracefulClosed = false
let closeTimer

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function finalize() {
  if (done) return
  done = true
  clearTimeout(responseTimer)

  if (audioChunks.length === 0) {
    validationFailed = true
    log('FAIL：服务端未返回回复音频。')
  } else {
    const pcm = concat(audioChunks)
    try {
      const metrics = measurePcm16(pcm, 24000)
      const wavPath = fileURLToPath(new URL('../.tmp/reply.wav', import.meta.url))
      writeFileSync(wavPath, writePcm16Wav(pcm, 24000))
      log(`已保存回复音频: .tmp/reply.wav (${pcm.length} 字节，${metrics.durationMs}ms)`)
      log(`音量检查: peak=${metrics.peak}, rms=${metrics.rms}, rmsDbfs=${metrics.rmsDbfs ?? '-inf'}, clipped=${metrics.clippedSamples}`)
      if (metrics.signal !== 'present') {
        validationFailed = true
        log(`FAIL：回复音频信号为 ${metrics.signal}，未达到自动响度检查阈值。`)
      } else {
        log('PASS：回复音频含有效幅度；内容和听感仍需人工试听。')
      }
    } catch (error) {
      validationFailed = true
      log('FAIL：回复音频不是有效 PCM16：' + error.message)
    }
  }

  if (!replyText.trim()) log('INFO：指定文本播报不要求模型回复文本事件。')
  log('播报自检完成，优雅关闭...')
  ws.send(JSON.stringify({ type: 'session.close' }))
  closeTimer = setTimeout(() => {
    log('FAIL：5 秒内未收到 session.closed。')
    try { ws.close() } catch { /* noop */ }
    process.exit(1)
  }, 5000)
}

const responseTimer = setTimeout(() => {
  log('超时：40 秒内未完成一轮对话。')
  try { ws.close() } catch { /* noop */ }
  process.exit(1)
}, 40000)

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
    log('[send] 指定播报: 你好，请介绍一下你自己。')
    ws.send(JSON.stringify({ type: 'speech_text_buffer.commit', text: '你好，请介绍一下你自己。' }))
  } else if (type === 'response.output_text.delta') {
    const delta = obj.delta || ''
    replyText += delta
    process.stdout.write(delta)
  } else if (type === 'response.output_text.done') {
    const completed = obj.text ?? replyText
    if (typeof completed === 'string' && completed) replyText = completed
    log('')
    log('[reply text] ' + replyText)
  } else if (type === 'response.output_audio.delta') {
    const b64 = obj.audio || obj.delta || ''
    if (b64) audioChunks.push(Buffer.from(b64, 'base64'))
  } else if (type === 'response.done') {
    log('[response.done] 一轮交互结束')
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
