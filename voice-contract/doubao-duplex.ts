/**
 * 豆包新版实时语音对话 3.0（Seeduplex，官方文档 6561/2549778）会话 + 事件映射。
 * WebSocket 文本 JSON、单 X-Api-Key 鉴权（relay 侧）、支持函数调用。
 *
 * 官方要点（已按权威文档修正，第三方 SDK 文档有出入）：
 * - session.model 固定 1.2.6.1（全双工版）
 * - 输出默认 OGG-Opus；要 PCM 需在 extension.tts.audio_config 配置（24000Hz 单声道 16bit 小端）
 * - 全双工靠上行音频保活：关麦发 input_audio_mute.commit，恢复发 input_audio_unmute.commit
 * - 优雅关闭：先 session.close 并收到 session.closed 再断 WS，否则触发 ContextCanceled(55000001)
 * - function calling：call_id 配对回传，并行调用聚合一并回传
 */
import { ProviderError, type UnifiedVoiceEvent } from './voice-events.ts'

export interface TextSocket {
  send(text: string): void
  close(): void
}

export interface DuplexConfig {
  model?: string
  instructions?: string
  voice?: string
  inputSampleRate?: number
  outputSampleRate?: number
  tools?: unknown[]
}

/** Shared by the adapter and the live check scripts to avoid payload drift. */
export function buildDuplexSession(config: DuplexConfig = {}): Record<string, unknown> {
  const voice = config.voice ?? 'saturn_zh_female_keainvsheng_tob'
  const session: Record<string, unknown> = {
    model: config.model ?? '1.2.6.1',
    audio: {
      input: { format: { type: 'pcm', sample_rate: config.inputSampleRate ?? 16000 } },
      output: {
        format: { type: 'pcm_s16le', sample_rate: config.outputSampleRate ?? 24000 },
        voice,
      },
    },
    extension: {
      tts: {
        audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: config.outputSampleRate ?? 24000 },
        speaker: voice,
      },
    },
  }
  if (config.instructions) session.instructions = config.instructions
  if (config.tools) session.tools = config.tools
  return session
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export type DuplexState = 'idle' | 'creating' | 'active' | 'closing' | 'closed'

export class DoubaoDuplexSession {
  state: DuplexState = 'idle'
  sessionId: string | undefined
  private socket: TextSocket | null = null
  private readonly config: DuplexConfig
  private readonly emit: (events: UnifiedVoiceEvent[]) => void
  private eventSeq = 0

  constructor(config: DuplexConfig, emit: (events: UnifiedVoiceEvent[]) => void) {
    this.config = config
    this.emit = emit
  }

  onSocketOpen(socket: TextSocket): void {
    this.socket = socket
    this.state = 'creating'
    this.send({ type: 'session.create', session: buildDuplexSession(this.config) })
  }

  private send(obj: Record<string, unknown>): void {
    this.eventSeq += 1
    this.socket?.send(JSON.stringify({ event_id: 'ev-' + this.eventSeq, ...obj }))
  }

  onMessage(text: string): void {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    const type = typeof ev.type === 'string' ? ev.type : ''

    switch (type) {
      case 'session.created': {
        const session = ev.session as Record<string, unknown> | undefined
        if (session && typeof session.id === 'string') this.sessionId = session.id
        this.state = 'active'
        return
      }
      case 'session.closed':
        this.socket?.close()
        this.state = 'closed'
        return
      case 'conversation.item.input_audio_transcription.delta':
        this.emit([{ type: 'transcriptDelta', role: 'user', text: str(ev.delta) }])
        return
      case 'conversation.item.input_audio_transcription.completed':
        this.emit([{ type: 'transcriptFinal', role: 'user', text: str(ev.transcript ?? ev.delta) }])
        return
      case 'response.output_text.delta':
        this.emit([{ type: 'transcriptDelta', role: 'assistant', text: str(ev.delta) }])
        return
      case 'response.output_text.done':
        this.emit([{ type: 'transcriptFinal', role: 'assistant', text: str(ev.text ?? ev.delta) }])
        return
      case 'response.output_audio.started':
        this.emit([{ type: 'turnStarted' }])
        return
      case 'response.output_audio.delta': {
        const audio = str(ev.audio ?? ev.delta)
        if (audio) this.emit([{ type: 'audioFrame', samples: Array.from(base64ToBytes(audio)) }])
        return
      }
      case 'response.output_audio.done':
        this.emit([{ type: 'turnCompleted' }])
        return
      case 'response.function_call_arguments.done': {
        const items = Array.isArray(ev.items) ? (ev.items as Array<Record<string, unknown>>) : []
        for (const item of items) {
          this.emit([{ type: 'toolEvent', kind: str(item.name), summary: str(item.arguments) }])
        }
        return
      }
      case 'error': {
        const message = str(ev.message ?? ev.error)
        const code = str(ev.code)
        const advice =
          code === '55000001' || message.includes('ContextCanceled')
            ? '未正常发送 session.close 即断开，请先发 session.close 再关闭连接'
            : message
        this.emit([{ type: 'error', error: new ProviderError('doubao.duplexError', 'protocol', false, advice) }])
        return
      }
      default:
        // session.updated / input_audio_buffer.committed / conversation.item.* / response.done / usage 内部簿记
        return
    }
  }

  sendAudio(pcm16: Uint8Array): void {
    if (this.state !== 'active') return
    this.send({ type: 'input_audio_buffer.append', audio: bytesToBase64(pcm16) })
  }

  commitAudio(): void {
    if (this.state !== 'active') return
    this.send({ type: 'input_audio_buffer.commit' })
  }

  /** 关闭麦克风后发送，避免全双工因收不到上行音频超时。 */
  mute(): void {
    if (this.state !== 'active') return
    this.send({ type: 'input_audio_mute.commit' })
  }

  /** 恢复麦克风后发送。 */
  unmute(): void {
    if (this.state !== 'active') return
    this.send({ type: 'input_audio_unmute.commit' })
  }

  sendText(text: string): void {
    if (this.state !== 'active') return
    // 豆包将该事件定义为打招呼/指定文本播报；它直接产出 TTS，不保证 Chat 文本事件。
    this.send({ type: 'speech_text_buffer.commit', text })
  }

  cancel(): void {
    if (this.state !== 'active') return
    this.send({ type: 'response.cancel' })
  }

  sendFunctionCallOutput(callId: string, output: string): void {
    if (this.state !== 'active') return
    this.send({
      type: 'conversation.item.create',
      items: [{ call_id: callId, role: 'tool', content: [{ type: 'input_text', text: output }] }],
    })
  }

  /** 优雅关闭：先发 session.close，收到 session.closed 后由 onMessage 关闭 socket。 */
  stop(): void {
    if (this.socket && (this.state === 'active' || this.state === 'creating')) {
      this.state = 'closing'
      this.send({ type: 'session.close' })
    } else {
      this.socket?.close()
      this.state = 'closed'
    }
  }
}
