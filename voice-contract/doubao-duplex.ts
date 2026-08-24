/**
 * 豆包新版实时语音对话（Seeduplex / 2549778）会话 + 事件映射。
 * WebSocket 文本 JSON，单 X-Api-Key 鉴权（relay 侧），支持函数调用。
 *
 * 对比旧版二进制：端点 /api/v3/duplex/realtime/dialogue、事件用字符串 type、
 * 音频 base64 内联、session.tools 支持 function calling → 可走一体化模式。
 * 本模块映射到统一事件（voice-events.ts），上层编排/契约/relay 全复用。
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

export class DoubaoDuplexSession {
  state: 'idle' | 'creating' | 'active' | 'closed' = 'idle'
  sessionId: string | undefined
  private socket: TextSocket | null = null
  private readonly config: DuplexConfig
  private readonly emit: (events: UnifiedVoiceEvent[]) => void

  constructor(config: DuplexConfig, emit: (events: UnifiedVoiceEvent[]) => void) {
    this.config = config
    this.emit = emit
  }

  onSocketOpen(socket: TextSocket): void {
    this.socket = socket
    this.state = 'creating'
    this.send({ type: 'session.create', session: this.buildSession() })
  }

  private buildSession(): Record<string, unknown> {
    const session: Record<string, unknown> = {
      model: this.config.model ?? '1.2.6.0',
      audio: {
        input: { format: { type: 'pcm', sample_rate: this.config.inputSampleRate ?? 16000 } },
        output: {
          format: { type: 'pcm_s16le', sample_rate: this.config.outputSampleRate ?? 24000 },
          voice: this.config.voice ?? '',
        },
      },
    }
    if (this.config.instructions) session.instructions = this.config.instructions
    if (this.config.tools) session.tools = this.config.tools
    return session
  }

  private send(obj: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(obj))
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
        const audio = str(ev.audio)
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
      case 'error':
        this.emit([
          {
            type: 'error',
            error: new ProviderError('doubao.duplexError', 'protocol', false, str(ev.message ?? ev.error)),
          },
        ])
        return
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

  sendText(text: string): void {
    if (this.state !== 'active') return
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

  stop(): void {
    if (this.socket) {
      if (this.state === 'active') this.send({ type: 'session.close' })
      this.socket.close()
    }
    this.state = 'closed'
  }
}
