/**
 * Browser/runtime orchestration for the JSON-based Doubao Duplex session.
 * Transport, microphone, speaker, and timers are injected so lifecycle behavior stays testable.
 */
import { DoubaoDuplexSession, type DuplexConfig, type TextSocket } from './doubao-duplex.ts'
import { ProviderError, type UnifiedVoiceEvent } from './voice-events.ts'
import type { AudioSink, AudioSource, Clock } from './voice-client.ts'

export interface DuplexSocketHandlers {
  onOpen(): void
  onMessage(text: string): void
  onClose(): void
  onError(error: unknown): void
}

export interface DuplexSocketFactory {
  open(handlers: DuplexSocketHandlers): TextSocket
}

export type DuplexClientState = 'idle' | 'connecting' | 'ready' | 'closing' | 'error' | 'closed'

export interface DuplexClientCallbacks {
  onEvent(events: UnifiedVoiceEvent[]): void
  onState(state: DuplexClientState): void
}

const DEFAULT_CLOCK: Clock = {
  setTimeout: (fn, ms) => {
    const timer = globalThis.setTimeout(fn, ms)
    return () => globalThis.clearTimeout(timer)
  },
}

export class DoubaoDuplexVoiceClient {
  private session: DoubaoDuplexSession | null = null
  private socket: TextSocket | null = null
  private state: DuplexClientState = 'idle'
  private micRunning = false
  private cancelHandshake: (() => void) | null = null
  private cancelCloseTimeout: (() => void) | null = null
  private readonly socketFactory: DuplexSocketFactory
  private readonly mic: AudioSource
  private readonly speaker: AudioSink
  private readonly config: DuplexConfig
  private readonly callbacks: DuplexClientCallbacks
  private readonly clock: Clock
  private readonly handshakeTimeoutMs: number
  private readonly closeTimeoutMs: number

  constructor(
    socketFactory: DuplexSocketFactory,
    mic: AudioSource,
    speaker: AudioSink,
    config: DuplexConfig,
    callbacks: DuplexClientCallbacks,
    clock: Clock = DEFAULT_CLOCK,
    handshakeTimeoutMs = 10000,
    closeTimeoutMs = 5000,
  ) {
    this.socketFactory = socketFactory
    this.mic = mic
    this.speaker = speaker
    this.config = config
    this.callbacks = callbacks
    this.clock = clock
    this.handshakeTimeoutMs = handshakeTimeoutMs
    this.closeTimeoutMs = closeTimeoutMs
  }

  connect(): void {
    if (this.state === 'connecting' || this.state === 'ready' || this.state === 'closing') return
    this.setState('connecting')
    try {
      this.socket = this.socketFactory.open({
        onOpen: () => {
          this.session = new DoubaoDuplexSession(this.config, (events) => this.handleEvents(events))
          this.session.onSocketOpen(this.socket as TextSocket)
          this.cancelHandshake = this.clock.setTimeout(() => {
            if (this.state === 'connecting') {
              this.fail(new ProviderError('voice.handshakeTimeout', 'network', true, '握手超时，请检查 relay、网络或 Key'))
            }
          }, this.handshakeTimeoutMs)
        },
        onMessage: (text) => {
          this.session?.onMessage(text)
          this.syncSessionState()
        },
        onClose: () => {
          if (this.state === 'closed' || this.state === 'error') return
          if (this.state === 'closing' || this.session?.state === 'closed') this.finishClosed()
          else this.fail(new ProviderError('voice.wsClosed', 'network', true, 'WebSocket 意外断开'))
        },
        onError: (error) => {
          this.fail(new ProviderError('voice.wsError', 'network', true, 'WebSocket 错误：' + String(error)))
        },
      })
    } catch (error) {
      this.fail(new ProviderError('voice.wsOpen', 'network', true, '无法打开 relay WebSocket：' + String(error)))
    }
  }

  sendText(text: string): void {
    this.session?.sendText(text)
  }

  cancelResponse(): void {
    this.session?.cancel()
  }

  sendFunctionCallOutput(callId: string, output: string): void {
    this.session?.sendFunctionCallOutput(callId, output)
  }

  mute(): void {
    if (this.state !== 'ready') return
    this.stopMic()
    this.session?.mute()
  }

  unmute(): void {
    if (this.state !== 'ready' || this.micRunning) return
    this.session?.unmute()
    this.startMic()
  }

  stop(): void {
    if (this.state === 'closed' || this.state === 'idle') {
      this.finishClosed()
      return
    }
    if (this.state === 'closing') return

    this.setState('closing')
    this.stopMic()
    this.session?.stop()
    if (this.session?.state === 'closed') {
      this.finishClosed()
      return
    }
    this.cancelCloseTimeout = this.clock.setTimeout(() => this.finishClosed(), this.closeTimeoutMs)
  }

  private syncSessionState(): void {
    if (this.state === 'connecting' && this.session?.state === 'active') {
      this.cancelHandshake?.()
      this.cancelHandshake = null
      this.setState('ready')
      this.startMic()
    } else if (this.session?.state === 'closed') {
      this.finishClosed()
    }
  }

  private startMic(): void {
    if (this.micRunning || this.state !== 'ready') return
    this.micRunning = true
    try {
      const result = this.mic.start((chunk) => {
        if (this.state === 'ready' && this.session?.state === 'active') this.session.sendAudio(chunk)
      })
      Promise.resolve(result).catch((error) => {
        this.fail(new ProviderError('voice.micStart', 'mic', true, '麦克风启动失败：' + String(error)))
      })
    } catch (error) {
      this.fail(new ProviderError('voice.micStart', 'mic', true, '麦克风启动失败：' + String(error)))
    }
  }

  private stopMic(): void {
    if (!this.micRunning) return
    this.micRunning = false
    try {
      void this.mic.stop()
    } catch {
      // Teardown continues even when a browser audio primitive already disappeared.
    }
  }

  private handleEvents(events: UnifiedVoiceEvent[]): void {
    const forwarded: UnifiedVoiceEvent[] = []
    for (const event of events) {
      if (event.type === 'audioFrame') {
        try {
          const result = this.speaker.play(new Uint8Array(event.samples))
          Promise.resolve(result).catch((error) => {
            this.fail(new ProviderError('voice.playback', 'codec', true, '音频播放失败：' + String(error)))
          })
        } catch (error) {
          this.fail(new ProviderError('voice.playback', 'codec', true, '音频播放失败：' + String(error)))
        }
        forwarded.push(event)
      } else if (event.type === 'error') {
        this.fail(event.error)
      } else {
        forwarded.push(event)
      }
    }
    if (forwarded.length > 0) this.callbacks.onEvent(forwarded)
  }

  private fail(error: ProviderError): void {
    if (this.state === 'closed' || this.state === 'error') return
    this.cancelTimers()
    this.stopMic()
    try { this.speaker.stop() } catch { /* teardown */ }
    this.setState('error')
    try { this.socket?.close() } catch { /* teardown */ }
    this.callbacks.onEvent([{ type: 'error', error }])
  }

  private finishClosed(): void {
    if (this.state === 'closed') return
    this.cancelTimers()
    this.stopMic()
    try { this.speaker.stop() } catch { /* teardown */ }
    this.setState('closed')
    try { this.socket?.close() } catch { /* teardown */ }
  }

  private cancelTimers(): void {
    this.cancelHandshake?.()
    this.cancelHandshake = null
    this.cancelCloseTimeout?.()
    this.cancelCloseTimeout = null
  }

  private setState(state: DuplexClientState): void {
    if (this.state === state) return
    this.state = state
    this.callbacks.onState(state)
  }
}
