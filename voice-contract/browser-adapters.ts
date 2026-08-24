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

// ---------- WebSocket 工厂（连本地 relay） ----------

interface BrowserWebSocket {
  binaryType: string
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: ArrayBuffer): void
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
          ws.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        },
        close(): void {
          ws.close()
        },
      }
    },
  }
}

// ---------- 麦克风采集（getUserMedia → AudioContext → PCM16@24k） ----------

interface BrowserMediaStream {
  getAudioTracks(): Array<{ stop(): void }>
}

interface BrowserAudioNode {
  connect(destination: unknown): void
  disconnect(): void
}

interface BrowserAudioContext {
  sampleRate: number
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
 * float32 → pcm16 → 重采样到 24000 → onPcm。
 * 注：ScriptProcessorNode 已废弃但全浏览器可用；AudioWorklet 精确实时路径留待实机优化。
 */
export function browserMicSource(
  getStream: () => Promise<unknown>,
  getAudioContext: () => unknown,
  targetSampleRate = 16000,
): AudioSource {
  let stream: BrowserMediaStream | null = null
  let ac: BrowserAudioContext | null = null
  let node: BrowserScriptProcessor | null = null
  let onPcmRef: ((chunk: Uint8Array) => void) | null = null

  return {
    async start(onPcm: (chunk: Uint8Array) => void): Promise<void> {
      onPcmRef = onPcm
      stream = (await getStream()) as BrowserMediaStream
      ac = (getAudioContext() ?? new (globalThis as unknown as { AudioContext: new () => BrowserAudioContext }).AudioContext()) as BrowserAudioContext
      const source = ac.createMediaStreamSource(stream)
      node = ac.createScriptProcessor(4096, 1, 1)
      const deviceRate = ac.sampleRate
      node.onaudioprocess = (event) => {
        const float32 = event.inputBuffer.getChannelData(0)
        const pcm16 = float32ToPcm16(float32)
        const resampled = resamplePcm16(pcm16, deviceRate, targetSampleRate)
        onPcmRef?.(resampled)
      }
      source.connect(node)
      node.connect(ac as unknown as { destination: unknown } as BrowserAudioNode)
    },
    async stop(): Promise<void> {
      node?.onaudioprocess === undefined ? undefined : (node.onaudioprocess = null)
      node?.disconnect()
      stream?.getAudioTracks().forEach((track) => track.stop())
      await ac?.close()
      stream = null
      ac = null
      node = null
    },
  }
}

// ---------- 扬声器播放（PCM16 → AudioBuffer → 播放） ----------

interface BrowserAudioSinkContext {
  sampleRate: number
  createBuffer(channels: number, length: number, sampleRate: number): BrowserAudioBuffer
  destination: unknown
  resume(): Promise<void>
}

interface BrowserAudioBufferSource extends BrowserAudioNode {
  buffer: BrowserAudioBuffer | null
  start(): void
}

export function browserAudioSink(getAudioContext: () => unknown): AudioSink {
  const ac = (getAudioContext() ?? new (globalThis as unknown as { AudioContext: new () => BrowserAudioSinkContext }).AudioContext()) as BrowserAudioSinkContext

  return {
    async play(chunk: Uint8Array): Promise<void> {
      await ac.resume()
      const samples = chunk.length / 2
      if (samples === 0) return
      const buffer = ac.createBuffer(1, samples, ac.sampleRate)
      const channel = buffer.getChannelData(0)
      for (let i = 0; i < samples; i++) {
        const u16 = chunk[i * 2] | (chunk[i * 2 + 1] << 8)
        channel[i] = ((u16 << 16) >> 16) / 0x8000
      }
      const source = new (globalThis as unknown as { AudioBufferSourceNode: new () => BrowserAudioBufferSource }).AudioBufferSourceNode()
      source.buffer = buffer
      source.connect(ac.destination)
      source.start()
    },
    stop(): void {
      // 播放器节点随 GC 停止；显式停止由实机联调补充
    },
  }
}
