/**
 * 顶层语音客户端：把 DoubaoSession、麦克风、扬声器、WebSocket 生命周期、握手超时、
 * STOP 串成一个可注入的编排层。浏览器胶水只需提供真实 SocketFactory / AudioSource /
 * AudioSink（见下一步 browser-adapters），本层不碰任何浏览器 API。
 */
import { DoubaoSession, type DoubaoSessionConfig, type VoiceSocket } from './doubao-session.ts'
import { ProviderError, type UnifiedVoiceEvent } from './voice-events.ts'

export interface SocketHandlers {
  onOpen(): void
  onMessage(data: Uint8Array): void
  onClose(): void
  onError(error: unknown): void
}

export interface SocketFactory {
  open(handlers: SocketHandlers): VoiceSocket
}

export interface AudioSource {
  start(onPcm: (chunk: Uint8Array) => void): void
  stop(): void
}

export interface AudioSink {
  play(chunk: Uint8Array): void
  stop(): void
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): () => void
}

export type ClientState = 'idle' | 'connecting' | 'ready' | 'error' | 'closed'

export interface VoiceClientCallbacks {
  onEvent(events: UnifiedVoiceEvent[]): void
  onState(state: ClientState): void
}

const DEFAULT_CLOCK: Clock = {
  setTimeout: (fn, ms) => {
    const t = globalThis.setTimeout(fn, ms)
    return () => globalThis.clearTimeout(t)
  },
}

export class DoubaoVoiceClient {
  private session: DoubaoSession | null = null
  private socket: VoiceSocket | null = null
  private state: ClientState = 'idle'
  private cancelHandshake: (() => void) | null = null
  private readonly socketFactory: SocketFactory
  private readonly mic: AudioSource
  private readonly speaker: AudioSink
  private readonly config: DoubaoSessionConfig
  private readonly callbacks: VoiceClientCallbacks
  private readonly clock: Clock
  private readonly handshakeTimeoutMs: number

  constructor(
    socketFactory: SocketFactory,
    mic: AudioSource,
    speaker: AudioSink,
    config: DoubaoSessionConfig,
    callbacks: VoiceClientCallbacks,
    clock: Clock = DEFAULT_CLOCK,
    handshakeTimeoutMs = 10000,
  ) {
    this.socketFactory = socketFactory
    this.mic = mic
    this.speaker = speaker
    this.config = config
    this.callbacks = callbacks
    this.clock = clock
    this.handshakeTimeoutMs = handshakeTimeoutMs
  }

  connect(): void {
    this.setState('connecting')
    this.socket = this.socketFactory.open({
      onOpen: () => {
        this.session = new DoubaoSession(this.config, (events) => this.handleEvents(events))
        this.session.onSocketOpen(this.socket as VoiceSocket)
        this.cancelHandshake = this.clock.setTimeout(() => {
          if (this.state === 'connecting') {
            this.fail(new ProviderError('voice.handshakeTimeout', 'network', true, '握手超时，请检查网络或 Key'))
          }
        }, this.handshakeTimeoutMs)
      },
      onMessage: (data) => {
        this.session?.onServerBytes(data)
        this.syncState()
      },
      onClose: () => {
        this.teardown('closed')
      },
      onError: (error) => {
        this.fail(new ProviderError('voice.wsError', 'network', true, 'WebSocket 错误：' + String(error)))
      },
    })
  }

  sendText(text: string): void {
    this.session?.sendText(text)
  }

  stop(): void {
    this.session?.stop()
    this.teardown('closed')
  }

  private syncState(): void {
    if (this.state === 'connecting' && this.session?.state === 'active') {
      this.cancelHandshake?.()
      this.cancelHandshake = null
      this.setState('ready')
      this.mic.start((chunk) => {
        if (this.session?.state === 'active') this.session.sendAudio(chunk)
      })
    }
  }

  private handleEvents(events: UnifiedVoiceEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'audioFrame') {
        this.speaker.play(new Uint8Array(ev.samples))
      } else if (ev.type === 'error') {
        this.fail(ev.error)
      }
    }
    this.callbacks.onEvent(events)
  }

  private fail(error: ProviderError): void {
    if (this.state === 'closed') return
    this.cancelHandshake?.()
    this.cancelHandshake = null
    this.setState('error')
    this.callbacks.onEvent([{ type: 'error', error }])
  }

  private teardown(finalState: ClientState): void {
    this.cancelHandshake?.()
    this.cancelHandshake = null
    this.mic.stop()
    this.speaker.stop()
    this.setState(finalState)
  }

  private setState(s: ClientState): void {
    if (this.state === s) return
    this.state = s
    this.callbacks.onState(s)
  }
}
