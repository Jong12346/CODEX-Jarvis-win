export type WakeCoordinatorState =
  | 'idle'
  | 'loading'
  | 'armed'
  | 'releasing'
  | 'suspended'
  | 'error'
  | 'disposed'

export type WakeTrigger = {
  source: 'keyword' | 'manual'
  keyword?: string
}

export interface WakeWordEngine {
  start(onDetected: (keyword: string) => void): void | Promise<void>
  stop(): void | Promise<void>
  dispose(): void | Promise<void>
}

export interface WakeCoordinatorCallbacks {
  onState(state: WakeCoordinatorState, error?: Error): void
  onVoiceRequested(trigger: WakeTrigger): void | Promise<void>
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Owns the hand-off between a local wake engine and a realtime voice client.
 * Voice starts only after the wake engine has confirmed that its microphone is
 * stopped. A stopped voice session re-arms wake only when the user still wants it.
 */
export class WakeVoiceCoordinator {
  private state: WakeCoordinatorState = 'idle'
  private wantsWake = false
  private voiceActive = false
  private operation = 0
  private readonly engine: WakeWordEngine
  private readonly callbacks: WakeCoordinatorCallbacks

  constructor(engine: WakeWordEngine, callbacks: WakeCoordinatorCallbacks) {
    this.engine = engine
    this.callbacks = callbacks
  }

  get currentState(): WakeCoordinatorState {
    return this.state
  }

  get wakeEnabled(): boolean {
    return this.wantsWake
  }

  async arm(): Promise<void> {
    if (this.state === 'disposed') return
    this.wantsWake = true
    if (this.voiceActive || this.state === 'armed' || this.state === 'loading') return

    const operation = ++this.operation
    this.setState('loading')
    try {
      await this.engine.start((keyword) => {
        if (operation !== this.operation || this.state !== 'armed') return
        void this.requestVoice({ source: 'keyword', keyword })
      })
      if (operation !== this.operation || !this.wantsWake || this.voiceActive) {
        await this.engine.stop()
        return
      }
      this.setState('armed')
    } catch (error) {
      if (operation !== this.operation) return
      this.wantsWake = false
      try { await this.engine.stop() } catch { /* keep the original startup error */ }
      this.setState('error', asError(error))
    }
  }

  async disarm(): Promise<void> {
    if (this.state === 'disposed') return
    this.wantsWake = false
    if (this.voiceActive) return
    ++this.operation
    try {
      await this.engine.stop()
      this.setState(this.voiceActive ? 'suspended' : 'idle')
    } catch (error) {
      this.setState('error', asError(error))
    }
  }

  async requestVoice(trigger: WakeTrigger): Promise<void> {
    if (this.state === 'disposed' || this.voiceActive) return
    this.voiceActive = true
    const operation = ++this.operation
    if (this.state === 'armed' || this.state === 'loading') this.setState('releasing')

    try {
      await this.engine.stop()
      if (operation !== this.operation) return
      this.setState('suspended')
      await this.callbacks.onVoiceRequested(trigger)
    } catch (error) {
      this.voiceActive = false
      this.wantsWake = false
      this.setState('error', asError(error))
    }
  }

  async voiceStopped(): Promise<void> {
    if (this.state === 'disposed' || !this.voiceActive) return
    this.voiceActive = false
    if (this.wantsWake) await this.arm()
    else this.setState('idle')
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return
    this.wantsWake = false
    this.voiceActive = false
    ++this.operation
    try {
      await this.engine.stop()
    } finally {
      await this.engine.dispose()
      this.setState('disposed')
    }
  }

  private setState(state: WakeCoordinatorState, error?: Error): void {
    if (this.state === state && !error) return
    this.state = state
    this.callbacks.onState(state, error)
  }
}
