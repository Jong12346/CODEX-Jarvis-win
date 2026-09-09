import type { WakeWordEngine } from './wake-coordinator.ts'

export interface SherpaKwsManifest {
  schemaVersion: 1
  wrapperScript: string
  runtimeScript: string
  sampleRate: number
  recognizerConfig: Record<string, unknown>
}

export type SherpaAssetProbe =
  | { available: true; manifest: SherpaKwsManifest; baseUrl: URL }
  | { available: false; reason: string }

interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

interface FetchOptions {
  cache?: RequestCache
}

interface SherpaStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  free(): void
}

interface SherpaRecognizer {
  createStream(): SherpaStream
  isReady(stream: SherpaStream): boolean
  decode(stream: SherpaStream): void
  reset(stream: SherpaStream): void
  getResult(stream: SherpaStream): unknown
  free(): void
}

interface SherpaModule {
  locateFile?: (path: string) => string
  onRuntimeInitialized?: () => void
}

type CreateKws = (module: SherpaModule, config: Record<string, unknown>) => SherpaRecognizer

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeRelativeAsset(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('..')
    && !value.startsWith('/')
    && !/^[a-z][a-z\d+.-]*:/i.test(value)
}

export function validateSherpaKwsManifest(value: unknown): SherpaKwsManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('唤醒模型清单版本无效')
  if (!safeRelativeAsset(value.wrapperScript) || !safeRelativeAsset(value.runtimeScript)) {
    throw new Error('唤醒运行库路径必须是当前站点内的相对路径')
  }
  if (typeof value.sampleRate !== 'number' || !Number.isFinite(value.sampleRate) || value.sampleRate < 8000) {
    throw new Error('唤醒模型采样率无效')
  }
  if (!isRecord(value.recognizerConfig)) throw new Error('唤醒识别器配置缺失')
  return value as unknown as SherpaKwsManifest
}

export function keywordFromSherpaResult(value: unknown): string {
  if (!isRecord(value) || typeof value.keyword !== 'string') return ''
  return value.keyword.trim()
}

export function resampleFloat32(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate || input.length === 0) return new Float32Array(input)
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate))
  const output = new Float32Array(outputLength)
  const scale = sourceRate / targetRate
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * scale
    const left = Math.min(input.length - 1, Math.floor(position))
    const right = Math.min(input.length - 1, left + 1)
    const fraction = position - left
    output[i] = input[left] * (1 - fraction) + input[right] * fraction
  }
  return output
}

export async function probeSherpaKwsAssets(
  base = '/wake/',
  fetcher: (url: string, init?: FetchOptions) => Promise<FetchResponse> = (url, init) => fetch(url, init),
): Promise<SherpaAssetProbe> {
  const baseUrl = new URL(base, globalThis.location?.href ?? 'http://127.0.0.1/')
  const manifestUrl = new URL('sherpa-kws-manifest.json', baseUrl)
  try {
    const response = await fetcher(manifestUrl.href, { cache: 'no-store' })
    if (!response.ok) {
      return {
        available: false,
        reason: response.status === 404 ? '离线唤醒模型未安装' : `无法读取唤醒模型清单（HTTP ${response.status}）`,
      }
    }
    return { available: true, manifest: validateSherpaKwsManifest(await response.json()), baseUrl }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let energy = 0
  for (const sample of samples) energy += sample * sample
  return Math.min(1, Math.sqrt(energy / samples.length) * 4)
}

function loadClassicScript(url: URL): Promise<void> {
  const existing = [...document.scripts].find((script) => script.dataset.sherpaUrl === url.href)
  if (existing?.dataset.loaded === 'true') return Promise.resolve()
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error(`无法加载 ${url.pathname}`)), { once: true })
    })
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url.href
    script.async = false
    script.dataset.sherpaUrl = url.href
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true'
      resolve()
    }, { once: true })
    script.addEventListener('error', () => {
      script.remove()
      reject(new Error(`无法加载 ${url.pathname}`))
    }, { once: true })
    document.head.append(script)
  })
}

/** Browser adapter for the official sherpa-onnx WebAssembly KWS wrapper. */
export class SherpaKwsBrowserEngine implements WakeWordEngine {
  private recognizer: SherpaRecognizer | null = null
  private stream: SherpaStream | null = null
  private mediaStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private loadPromise: Promise<void> | null = null
  private run = 0
  private onDetected: ((keyword: string) => void) | null = null
  private readonly manifest: SherpaKwsManifest
  private readonly baseUrl: URL
  private readonly onLevel: (level: number) => void

  constructor(probe: Extract<SherpaAssetProbe, { available: true }>, onLevel: (level: number) => void = () => {}) {
    this.manifest = probe.manifest
    this.baseUrl = probe.baseUrl
    this.onLevel = onLevel
  }

  async start(onDetected: (keyword: string) => void): Promise<void> {
    const run = ++this.run
    this.onDetected = onDetected
    await this.prepare()
    if (run !== this.run) return

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    if (run !== this.run) {
      for (const track of mediaStream.getAudioTracks()) track.stop()
      return
    }

    this.mediaStream = mediaStream
    try {
      const context = new AudioContext({ sampleRate: this.manifest.sampleRate })
      const source = context.createMediaStreamSource(mediaStream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const stream = this.recognizer!.createStream()
      this.audioContext = context
      this.source = source
      this.processor = processor
      this.stream = stream
      processor.onaudioprocess = (event) => {
        if (run !== this.run || !this.recognizer || this.stream !== stream) return
        const input = event.inputBuffer.getChannelData(0)
        const samples = resampleFloat32(input, context.sampleRate, this.manifest.sampleRate)
        this.onLevel(rmsLevel(samples))
        stream.acceptWaveform(this.manifest.sampleRate, samples)
        while (this.recognizer.isReady(stream)) {
          this.recognizer.decode(stream)
          const keyword = keywordFromSherpaResult(this.recognizer.getResult(stream))
          if (keyword) {
            this.recognizer.reset(stream)
            this.onDetected?.(keyword)
            break
          }
        }
      }
      source.connect(processor)
      processor.connect(context.destination)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    ++this.run
    this.onDetected = null
    if (this.processor) {
      this.processor.onaudioprocess = null
      try { this.processor.disconnect() } catch { /* browser node already disconnected */ }
    }
    if (this.source) {
      try { this.source.disconnect() } catch { /* browser node already disconnected */ }
    }
    for (const track of this.mediaStream?.getAudioTracks() ?? []) track.stop()
    this.stream?.free()
    const context = this.audioContext
    this.processor = null
    this.source = null
    this.mediaStream = null
    this.stream = null
    this.audioContext = null
    this.onLevel(0)
    if (context) await context.close().catch(() => {})
  }

  async dispose(): Promise<void> {
    await this.stop()
    this.recognizer?.free()
    this.recognizer = null
  }

  private prepare(): Promise<void> {
    if (this.recognizer) return Promise.resolve()
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.loadRuntime().catch((error) => {
      this.loadPromise = null
      throw error
    })
    return this.loadPromise
  }

  private async loadRuntime(): Promise<void> {
    const wrapperUrl = new URL(this.manifest.wrapperScript, this.baseUrl)
    const runtimeUrl = new URL(this.manifest.runtimeScript, this.baseUrl)
    await loadClassicScript(wrapperUrl)

    const runtimeReady = new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => reject(new Error('sherpa-onnx WASM 初始化超时')), 30000)
      const module: SherpaModule = {
        locateFile: (path) => new URL(path, this.baseUrl).href,
        onRuntimeInitialized: () => {
          globalThis.clearTimeout(timeout)
          resolve()
        },
      }
      ;(globalThis as unknown as { Module: SherpaModule }).Module = module
    })
    await loadClassicScript(runtimeUrl)
    await runtimeReady

    const globals = globalThis as unknown as { Module: SherpaModule; createKws?: CreateKws }
    if (typeof globals.createKws !== 'function') throw new Error('sherpa-onnx KWS 包装器未导出 createKws')
    this.recognizer = globals.createKws(globals.Module, this.manifest.recognizerConfig)
  }
}
