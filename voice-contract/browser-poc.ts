import { browserAudioSink, browserDuplexSocketFactory, browserMicSource } from './browser-adapters.ts'
import { DoubaoDuplexVoiceClient, type DuplexClientState } from './doubao-duplex-client.ts'
import { JarvisParticleVisualizer, type ParticleVoiceMode } from './particle-visualizer.ts'
import { SherpaKwsBrowserEngine, probeSherpaKwsAssets } from './sherpa-kws-browser.ts'
import { WakeVoiceCoordinator, type WakeCoordinatorState, type WakeTrigger } from './wake-coordinator.ts'
import type { UnifiedVoiceEvent } from './voice-events.ts'

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`missing #${id}`)
  return element as T
}

const status = required<HTMLElement>('status')
const statusDot = required<HTMLElement>('status-dot')
const relayUrl = required<HTMLInputElement>('relay-url')
const startButton = required<HTMLButtonElement>('start')
const muteButton = required<HTMLButtonElement>('mute')
const stopButton = required<HTMLButtonElement>('stop')
const speakButton = required<HTMLButtonElement>('speak')
const speechText = required<HTMLInputElement>('speech-text')
const clearButton = required<HTMLButtonElement>('clear')
const log = required<HTMLElement>('log')
const partial = required<HTMLElement>('partial')
const visualContainer = required<HTMLElement>('voice-visual')
const visualState = required<HTMLElement>('visual-state')
const wakeStatus = required<HTMLElement>('wake-status')
const wakeButton = required<HTMLButtonElement>('wake-toggle')
const visualizer = new JarvisParticleVisualizer(
  required<HTMLCanvasElement>('voice-particles'),
  required<HTMLImageElement>('jarvis-character'),
  visualContainer,
)

let client: DoubaoDuplexVoiceClient | null = null
let wakeCoordinator: WakeVoiceCoordinator | null = null
let muted = false

const stateLabels: Record<DuplexClientState, string> = {
  idle: '尚未连接',
  connecting: '正在连接 relay 与豆包',
  ready: '已连接，正在监听',
  closing: '正在正常关闭会话',
  error: '连接失败',
  closed: '已停止',
}

const visualModes: Record<DuplexClientState, ParticleVoiceMode> = {
  idle: 'idle',
  connecting: 'connecting',
  ready: 'listening',
  closing: 'closing',
  error: 'error',
  closed: 'idle',
}

const visualLabels: Record<ParticleVoiceMode, string> = {
  idle: 'STANDBY',
  connecting: 'FORMING',
  listening: 'LISTENING',
  muted: 'MIC MUTED',
  speaking: 'SPEAKING',
  closing: 'CLOSING',
  error: 'CONNECTION ERROR',
}

const wakeLabels: Record<WakeCoordinatorState, string> = {
  idle: '模型已就绪，唤醒未启用',
  loading: '正在加载模型并获取麦克风…',
  armed: '正在本机等待唤醒词',
  releasing: '已命中，正在释放唤醒麦克风…',
  suspended: '实时对话占用麦克风',
  error: '离线唤醒发生错误',
  disposed: '唤醒监听已关闭',
}

function setVisualMode(mode: ParticleVoiceMode): void {
  visualizer.setMode(mode)
  visualState.textContent = visualLabels[mode]
}

function setState(state: DuplexClientState): void {
  status.textContent = stateLabels[state]
  statusDot.dataset.state = state
  setVisualMode(visualModes[state])
  const ready = state === 'ready'
  startButton.disabled = state === 'connecting' || state === 'ready' || state === 'closing'
  muteButton.disabled = !ready
  stopButton.disabled = !ready && state !== 'connecting' && state !== 'closing'
  speakButton.disabled = !ready
  relayUrl.disabled = startButton.disabled
  if (!ready) {
    muted = false
    muteButton.textContent = '静音'
  }
}

function append(text: string, kind: 'user' | 'assistant' | 'system' | 'error' = 'system'): void {
  log.querySelector('.hint')?.remove()
  const line = document.createElement('p')
  line.className = kind
  line.textContent = text
  log.append(line)
  log.scrollTop = log.scrollHeight
}

function handleEvents(events: UnifiedVoiceEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case 'transcriptDelta':
        partial.textContent = `${event.role === 'user' ? '你' : '豆包'}：${event.text}`
        break
      case 'transcriptFinal':
        partial.textContent = ''
        if (event.text) append(event.text, event.role)
        break
      case 'turnStarted':
        setVisualMode('speaking')
        append('开始回复…')
        break
      case 'turnCompleted':
        setVisualMode(muted ? 'muted' : 'listening')
        append('回复完成')
        break
      case 'toolEvent':
        append(`工具请求：${event.kind} ${event.summary}`)
        break
      case 'error':
        append(event.error.adviceZh || event.error.message, 'error')
        break
      default:
        break
    }
  }
}

function startConversation(trigger?: WakeTrigger): void {
  if (trigger?.source === 'keyword') append(`唤醒词命中：${trigger.keyword || 'Jarvis'}`)
  const playbackContext = new AudioContext()
  const mic = browserMicSource(
    () => navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }),
    () => new AudioContext(),
    16000,
    (level) => visualizer.setLevel(level),
  )
  const speaker = browserAudioSink(() => playbackContext, 24000, (level) => visualizer.setLevel(level))
  client = new DoubaoDuplexVoiceClient(
    browserDuplexSocketFactory(relayUrl.value.trim()),
    mic,
    speaker,
    { inputSampleRate: 16000, outputSampleRate: 24000 },
    {
      onState: (state) => {
        setState(state)
        if (state === 'closed' || state === 'error') {
          void playbackContext.close().catch(() => {})
          void wakeCoordinator?.voiceStopped()
        }
      },
      onEvent: handleEvents,
    },
  )
  append('正在建立会话…')
  client.connect()
}

startButton.addEventListener('click', () => {
  if (wakeCoordinator) void wakeCoordinator.requestVoice({ source: 'manual' })
  else startConversation({ source: 'manual' })
})

muteButton.addEventListener('click', () => {
  muted = !muted
  if (muted) client?.mute()
  else client?.unmute()
  muteButton.textContent = muted ? '恢复麦克风' : '静音'
  status.textContent = muted ? '已连接，麦克风静音' : stateLabels.ready
  setVisualMode(muted ? 'muted' : 'listening')
})

stopButton.addEventListener('click', () => client?.stop())
speakButton.addEventListener('click', () => {
  const text = speechText.value.trim()
  if (text) client?.sendText(text)
})
clearButton.addEventListener('click', () => {
  log.replaceChildren()
  partial.textContent = ''
})
wakeButton.addEventListener('click', () => {
  if (!wakeCoordinator) return
  if (wakeCoordinator.wakeEnabled) void wakeCoordinator.disarm()
  else void wakeCoordinator.arm()
})
window.addEventListener('beforeunload', () => {
  client?.stop()
  void wakeCoordinator?.dispose()
  visualizer.destroy()
})

async function setupWake(): Promise<void> {
  const probe = await probeSherpaKwsAssets()
  if (!probe.available) {
    wakeStatus.textContent = `${probe.reason}，可继续手动开始对话`
    return
  }

  const engine = new SherpaKwsBrowserEngine(probe, (level) => visualizer.setLevel(level))
  wakeCoordinator = new WakeVoiceCoordinator(engine, {
    onState: (state, error) => {
      wakeStatus.textContent = error?.message || wakeLabels[state]
      wakeButton.textContent = wakeCoordinator?.wakeEnabled ? '关闭唤醒' : '启用唤醒'
      wakeButton.disabled = state === 'loading' || state === 'releasing' || state === 'disposed'
      if (state === 'armed') visualState.textContent = 'WAKE ARMED'
    },
    onVoiceRequested: (trigger) => startConversation(trigger),
  })
  wakeStatus.textContent = wakeLabels.idle
  wakeButton.disabled = false
}

setState('idle')
void setupWake()
