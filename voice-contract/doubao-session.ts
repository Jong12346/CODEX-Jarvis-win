/**
 * 豆包 S2S 会话驱动（transport 无关的状态机）。
 * 浏览器侧胶水只负责：建立真实 WebSocket + getUserMedia 采集 + AudioContext 播放，
 * 然后把「socket 打开」「收到字节」「要送音频」转交给本类；超时由胶水层拥有。
 *
 * 状态：idle → connecting → starting → active → closed
 */
import {
  ClientEvent,
  ServerEvent,
  buildAudioFrame,
  buildEventFrame,
  parseServerFrame,
  type ParsedFrame,
} from './doubao-codec.ts'
import { mapDoubaoFrame } from './doubao-map.ts'
import type { UnifiedVoiceEvent } from './voice-events.ts'

export interface VoiceSocket {
  send(data: Uint8Array): void
  close(): void
}

export interface DoubaoSessionConfig {
  model: string
  speaker?: string
  systemRole?: string
  botName?: string
}

let idSeq = 0
function newId(prefix: string): string {
  idSeq += 1
  return prefix + '-' + idSeq + '-' + Date.now().toString(36)
}

/** START_SESSION 载荷（对齐 demo _build_session_payload）。speaker 具体 ID 以豆包控制台为准。 */
export function buildSessionPayload(config: DoubaoSessionConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tts: {
      speaker: config.speaker ?? '',
      audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 },
    },
    dialog: { extra: { model: config.model } },
  }
  const dialog = payload.dialog as Record<string, unknown>
  if (config.systemRole) dialog.system_role = config.systemRole
  if (config.botName) dialog.bot_name = config.botName
  return payload
}

export type SessionState = 'idle' | 'connecting' | 'starting' | 'active' | 'closed'

export class DoubaoSession {
  state: SessionState = 'idle'
  readonly connectId = newId('conn')
  readonly sessionId = newId('session')
  private socket: VoiceSocket | null = null
  private readonly config: DoubaoSessionConfig
  private readonly emit: (events: UnifiedVoiceEvent[]) => void

  constructor(config: DoubaoSessionConfig, emit: (events: UnifiedVoiceEvent[]) => void) {
    this.config = config
    this.emit = emit
  }

  onSocketOpen(socket: VoiceSocket): void {
    this.socket = socket
    this.state = 'connecting'
    socket.send(buildEventFrame(ClientEvent.START_CONNECTION, {}, undefined, this.connectId))
  }

  onServerBytes(data: Uint8Array): void {
    let frame: ParsedFrame
    try {
      frame = parseServerFrame(data)
    } catch {
      return
    }

    switch (frame.eventId) {
      case ServerEvent.CONNECTION_STARTED:
        if (this.state === 'connecting' && this.socket) {
          this.state = 'starting'
          this.socket.send(
            buildEventFrame(ClientEvent.START_SESSION, buildSessionPayload(this.config), this.sessionId),
          )
        }
        return
      case ServerEvent.CONNECTION_FAILED:
        this.state = 'closed'
        this.emit(mapDoubaoFrame(frame))
        return
      case ServerEvent.SESSION_STARTED:
        this.state = 'active'
        return
      default:
        this.emit(mapDoubaoFrame(frame))
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.state === 'active' && this.socket) {
      this.socket.send(buildAudioFrame(pcm, this.sessionId))
    }
  }

  sendText(text: string): void {
    if (this.state === 'active' && this.socket) {
      this.socket.send(buildEventFrame(ClientEvent.CHAT_TEXT_QUERY, { content: text }, this.sessionId))
    }
  }

  stop(): void {
    if (this.socket) {
      if (this.state === 'active') {
        this.socket.send(buildEventFrame(ClientEvent.FINISH_SESSION, {}, this.sessionId))
      }
      this.socket.send(buildEventFrame(ClientEvent.FINISH_CONNECTION, {}))
      this.socket.close()
    }
    this.state = 'closed'
  }
}
