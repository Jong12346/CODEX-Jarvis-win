// 豆包 duplex（Seeduplex 3.0）真实握手自检。
// 从环境变量读 DOUBAO_API_KEY，绝不硬编码、绝不回显。
// 用法（PowerShell）:
//   $env:DOUBAO_API_KEY="你的key"; node voice-contract/handshake-check.mjs
// 输出 session.created 即链路全通；输出 error 会带错误码与提示。

const key = process.env.DOUBAO_API_KEY
if (!key) {
  console.error('缺少 DOUBAO_API_KEY 环境变量。请先设置后再运行。')
  process.exit(2)
}

const url = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'

const ws = new WebSocket(url, { headers: { 'X-Api-Key': key } })
const timer = setTimeout(() => {
  console.error('超时：10 秒内未收到 session.created 或 error，请检查网络/Key/是否开通实时语音对话。')
  try { ws.close() } catch { /* noop */ }
  process.exit(1)
}, 10000)

ws.addEventListener('open', () => {
  console.log('[open] WebSocket 已连接，发送 session.create (model=1.2.6.1) ...')
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
  console.log('[event]', data.slice(0, 500))
  let obj
  try { obj = JSON.parse(data) } catch { return }
  if (obj.type === 'session.created') {
    console.log('SUCCESS session.id =', obj.session && obj.session.id)
    clearTimeout(timer)
    ws.send(JSON.stringify({ type: 'session.close' }))
  } else if (obj.type === 'session.closed') {
    console.log('会话已优雅关闭，自检通过。')
    clearTimeout(timer)
    ws.close()
    process.exit(0)
  } else if (obj.type === 'error') {
    console.error('FAIL 服务端错误:', JSON.stringify(obj))
    clearTimeout(timer)
    ws.close()
    process.exit(1)
  }
})

ws.addEventListener('error', (ev) => {
  console.error('WebSocket 连接错误:', (ev && ev.message) || 'unknown')
  clearTimeout(timer)
  process.exit(1)
})
