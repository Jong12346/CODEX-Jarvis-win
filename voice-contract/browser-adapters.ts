/**
 * 浏览器侧薄胶水：把已测试的纯逻辑核心（voice-client / pcm / codec）接到真实浏览器 API。
 *
 * 重要声明：浏览器全局（WebSocket/getUserMedia/AudioContext）只在函数内部引用，
 * 因此本文件可在 node 中 import 做语法校验；但真实音频采集/播放行为无法在 node 验证，
 * 必须浏览器实机联调。核心逻辑（帧、会话、格式转换）都已在 voice-client/pcm 中测试。
 *
 * 鉴权说明：浏览器 WebSocket 无法设自定义头，本层只连本地 relay（无鉴权头），
 * 鉴权由 relay（voice-contract/relay.ts）承担。
 */
import { float32ToPcm16, resamplePcm16 } from './pcm.ts'
import type { SocketFactory, SocketHandlers, AudioSource, AudioSink } from './voice-client.ts'
import type { VoiceSocket } from './doubao-session.ts'
import type { DuplexSocketFactory, DuplexSocketHandlers } from './doubao-duplex-client.ts'
import type { TextSocket } from './doubao-duplex.ts'

// ---------- WebSocket 工厂（连本地 relay） ----------

interface BrowserWebSocket {
  binaryType: string
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string | ArrayBuffer): void
  close(): void
}

/** 返回一个连本地 relay 的 SocketFactory；relayUrl 形如 ws://127.0.0.1:8787/ws */
export function browserSocketFactory(
  relayUrl: string,
  getWebSocket: () => unknown = () => globalThis.WebSocket,
): SocketFactory {
  return {
    open(handlers: SocketHandlers): VoiceSocket {
      const Ctor = getWebSocket() as new (url: string) => BrowserWebSocket
      const ws = new Ctor(relayUrl)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => handlers.onOpen()
      ws.onclose = () => handlers.onClose()
      ws.onerror = (event) => handlers.onError(event)
      ws.onmessage = (event) => {
        const data = event.data as ArrayBuffer
        handlers.onMessage(new Uint8Array(data))
      }
      return {
        send(data: Uint8Array): void {
          const copy = new Uint8Array(data.byteLength)
          copy.set(data)
          ws.send(copy.buffer)
        },
        close(): void {
          ws.close()
        },
      }
    },
  }
}

/** JSON Duplex transport over the same localhost relay. */
export function browserDuplexSocketFactory(
  relayUrl: string,
  getWebSocket: () => unknown = () => globalThis.WebSocket,
): DuplexSocketFactory {
  return {
    open(handlers: DuplexSocketHandlers): TextSocket {
      const Ctor = getWebSocket() as new (url: string) => BrowserWebSocket
      const ws = new Ctor(relayUrl)
      ws.onopen = () => handlers.onOpen()
      ws.onclose = () => handlers.onClose()
      ws.onerror = (event) => handlers.onError(event)
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') handlers.onMessage(event.data)
        else handlers.onError(new Error('Doubao Duplex relay returned a non-text frame'))
      }
      return {
        send(text: string): void { ws.send(text) },
        close(): void { ws.close() },
      }
    },
  }
}

// ---------- 麦克风采集（getUserMedia → AudioContext → PCM16@16k） ----------

interface BrowserMediaStream {
  getAudioTracks(): Array<{ stop(): void }>
}

interface BrowserAudioNode {
  connect(destination: unknown): void
  disconnect(): void
}

interface BrowserAudioContext {
  sampleRate: number
  destination: unknown
  createMediaStreamSource(stream: BrowserMediaStream): BrowserAudioNode
  createScriptProcessor(bufferSize: number, inputs: number, outputs: number): BrowserScriptProcessor
  close(): Promise<void>
}

interface BrowserScriptProcessor extends BrowserAudioNode {
  onaudioprocess: ((event: { inputBuffer: BrowserAudioBuffer }) => void) | null
}

interface BrowserAudioBuffer {
  getChannelData(channel: number): Float32Array
}

/**
 * 麦克风采集源：getUserMedia → AudioContext → ScriptProcessorNode，
 * float32 → pcm16 → 重采样到 16000 → 固定 20ms（640 bytes）分帧 → onPcm。
 * 注：ScriptProcessorNode 已废弃但全浏览器可用；AudioWorklet 精确实时路径留待实机优化。
 */
export function browserMicSource(
  getStream: () => Promise<unknown>,
  getAudioContext: () => unknown,
  targetSampleRate = 16000,
  onLevel: (level: number) => void = () => {},
): AudioSource {
  let stream: BrowserMediaStream | null = null
  let ac: BrowserAudioContext | null = null
  let source: BrowserAudioNode | null = null
  let node: BrowserScriptProcessor | null = null
  let generation = 0
  let starting = false
  const frameBytes = Math.round(targetSampleRate * 0.02) * 2

  return {
    async start(onPcm: (chunk: Uint8Array) => void): Promise<void> {
      if (starting || stream || ac || node) throw new Error('microphone is already running')
      const startGeneration = ++generation
      starting = true
      let acquiredStream: BrowserMediaStream | null = null
      let createdContext: BrowserAudioContext | null = null

      try {
        acquiredStream = (await getStream()) as BrowserMediaStream
        if (startGeneration !== generation) {
          acquiredStream.getAudioTracks().forEach((track) => track.stop())
          return
        }

        createdContext = (getAudioContext() ?? new (globalThis as unknown as { AudioContext: new () => BrowserAudioContext }).AudioContext()) as BrowserAudioContext
        const createdSource = createdContext.createMediaStreamSource(acquiredStream)
        const createdNode = createdContext.createScriptProcessor(1024, 1, 1)
        const deviceRate = createdContext.sampleRate
        let pending = new Uint8Array(0)
        createdNode.onaudioprocess = (event) => {
          if (startGeneration !== generation) return
          const float32 = event.inputBuffer.getChannelData(0)
          let energy = 0
          for (const sample of float32) energy += sample * sample
          onLevel(Math.min(1, Math.sqrt(energy / Math.max(1, float32.length)) * 4))
          const pcm16 = float32ToPcm16(float32)
          const resampled = resamplePcm16(pcm16, deviceRate, targetSampleRate)
          const combined = new Uint8Array(pending.length + resampled.length)
          combined.set(pending)
          combined.set(resampled, pending.length)
          let offset = 0
          while (combined.length - offset >= frameBytes) {
            onPcm(combined.slice(offset, offset + frameBytes))
            offset += frameBytes
          }
          pending = combined.slice(offset)
        }
        createdSource.connect(createdNode)
        createdNode.connect(createdContext.destination)
        stream = acquiredStream
        ac = createdContext
        source = createdSource
        node = createdNode
      } catch (error) {
        acquiredStream?.getAudioTracks().forEach((track) => track.stop())
        if (createdContext) await createdContext.close().catch(() => {})
        throw error
      } finally {
        if (startGeneration === generation) starting = false
      }
    },
    async stop(): Promise<void> {
      generation += 1
      starting = false
      const activeNode = node
      const activeSource = source
      const activeStream = stream
      const activeContext = ac
      stream = null
      ac = null
      source = null
      node = null
      if (activeNode) activeNode.onaudioprocess = null
      activeNode?.disconnect()
      activeSource?.disconnect()
      activeStream?.getAudioTracks().forEach((track) => track.stop())
      onLevel(0)
      await activeContext?.close()
    },
  }
}

// ---------- 扬声器播放（PCM16 → AudioBuffer → 播放） ----------

interface BrowserAudioSinkContext {
  currentTime: number
  createBuffer(channels: number, length: number, sampleRate: number): BrowserAudioBuffer
  createBufferSource(): BrowserAudioBufferSource
  destination: unknown
  resume(): Promise<void>
}

interface BrowserAudioBufferSource extends BrowserAudioNode {
  buffer: BrowserAudioBuffer | null
  onended: (() => void) | null
  start(when?: number): void
  stop(): void
}

export function browserAudioSink(
  getAudioContext: () => unknown,
  sourceSampleRate = 24000,
  onLevel: (level: number) => void = () => {},
): AudioSink {
  const ac = (getAudioContext() ?? new (globalThis as unknown as { AudioContext: new () => BrowserAudioSinkContext }).AudioContext()) as BrowserAudioSinkContext
  const activeSources = new Set<BrowserAudioBufferSource>()
  let nextStartAt = 0
  let generation = 0
  let scheduling = Promise.resolve()

  return {
    async play(chunk: Uint8Array): Promise<void> {
      const playGeneration = generation
      const scheduled = scheduling.then(async () => {
        await ac.resume()
        if (playGeneration !== generation) return
        if (chunk.length % 2 !== 0) throw new Error('PCM16 audio must contain whole samples')
        const samples = chunk.length / 2
        if (samples === 0) return
        const buffer = ac.createBuffer(1, samples, sourceSampleRate)
        const channel = buffer.getChannelData(0)
        let energy = 0
        for (let i = 0; i < samples; i++) {
          const u16 = chunk[i * 2] | (chunk[i * 2 + 1] << 8)
          const normalized = ((u16 << 16) >> 16) / 0x8000
          channel[i] = normalized
          energy += normalized * normalized
        }
        onLevel(Math.min(1, Math.sqrt(energy / samples) * 4))
        const source = ac.createBufferSource()
        source.buffer = buffer
        source.connect(ac.destination)
        source.onended = () => {
          activeSources.delete(source)
          if (activeSources.size === 0) onLevel(0)
        }
        activeSources.add(source)
        nextStartAt = Math.max(nextStartAt, ac.currentTime)
        source.start(nextStartAt)
        nextStartAt += samples / sourceSampleRate
      })
      scheduling = scheduled.catch(() => {})
      await scheduled
    },
    stop(): void {
      generation += 1
      for (const source of activeSources) {
        try { source.stop() } catch { /* source may already have ended */ }
      }
      activeSources.clear()
      onLevel(0)
      nextStartAt = ac.currentTime
      scheduling = Promise.resolve()
    },
  }
}
