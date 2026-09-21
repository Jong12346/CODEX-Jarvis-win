/**
 * VoiceProvider 契约（TS 版）—— 镜像 tests/contract/voice_provider.rs 的 17 项断言。
 * 零依赖、纯逻辑，是后续 DSH 客户端语音插件的内核；zod schema 在其上再包一层。
 *
 * 序列化约定：统一事件带 type 判别 + camelCase 字段；ErrorCategory/Role 用小写字符串字面量；
 * 会话配置不得出现 thread 键（D4），Key 相关键只能以 Ref 结尾（BYOK）。
 */

// ---------- 基础类型 ----------

export type ErrorCategory = 'network' | 'auth' | 'mic' | 'codec' | 'protocol' | 'rate'

export type Role = 'user' | 'assistant'

export type AudioFormat = 'pcm16' | 'opus' | 'none'

export interface ProviderCapabilities {
  realtime: boolean
  toolEvents: boolean
  interruptable: boolean
  audioFormat: AudioFormat
}

export class ProviderError extends Error {
  code: string
  category: ErrorCategory
  recoverable: boolean
  adviceZh: string

  constructor(code: string, category: ErrorCategory, recoverable: boolean, adviceZh: string) {
    super(code)
    this.name = 'ProviderError'
    this.code = code
    this.category = category
    this.recoverable = recoverable
    this.adviceZh = adviceZh
  }
}

function protocolError(code: string, adviceZh: string): ProviderError {
  return new ProviderError(code, 'protocol', false, adviceZh)
}

// ---------- 统一事件（带 type 判别） ----------

export type UnifiedVoiceEvent =
  | { type: 'transcriptDelta'; role: Role; text: string }
  | { type: 'transcriptFinal'; role: Role; text: string }
  | { type: 'audioFrame'; samples: number[] }
  | { type: 'turnStarted' }
  | { type: 'turnCompleted' }
  | { type: 'toolEvent'; kind: string; summary: string }
  | { type: 'sessionEnded'; reason: string }
  | { type: 'error'; error: ProviderError }

// ---------- 编解码层：音频帧不变量 ----------

export function validateAudioFrame(samples: number[]): boolean {
  return samples.length > 0 && samples.length % 2 === 0
}

// ---------- capability 控制面（纯函数） ----------

export interface ControlSurface {
  showInterrupt: boolean
  showTaskTools: boolean
  showRealtimeBadge: boolean
  pipelineOnly: boolean
  degradedCopyHint: string
}

export function controlSurfaceFor(caps: ProviderCapabilities): ControlSurface {
  return {
    showInterrupt: caps.realtime && caps.interruptable,
    showTaskTools: caps.toolEvents,
    showRealtimeBadge: caps.realtime,
    pipelineOnly: !caps.realtime,
    degradedCopyHint: caps.realtime ? '' : '管线模式：语音经 ASR→LLM→TTS 处理，不支持打断',
  }
}

// ---------- 协议层：厂商事件映射（OpenAI 兼容流派共享，豆包二进制协议另走 codec 层） ----------

function textEvent(payload: unknown): { role: Role; text: string } {
  if (payload === null || typeof payload !== 'object') {
    throw protocolError('protocol.badPayload', '厂商事件载荷不是对象')
  }
  const obj = payload as Record<string, unknown>
  const role = obj.role
  if (role !== 'user' && role !== 'assistant') {
    throw protocolError('protocol.badRole', '未知的说话者角色')
  }
  const text = obj.text
  if (typeof text !== 'string') {
    throw protocolError('protocol.missingText', '事件缺少文本字段')
  }
  return { role, text }
}

export function mapVendorEvent(kind: string, payload: unknown): UnifiedVoiceEvent {
  switch (kind) {
    case 'transcript.delta': {
      const { role, text } = textEvent(payload)
      return { type: 'transcriptDelta', role, text }
    }
    case 'transcript.final': {
      const { role, text } = textEvent(payload)
      return { type: 'transcriptFinal', role, text }
    }
    case 'turn.started':
      return { type: 'turnStarted' }
    case 'turn.completed':
      return { type: 'turnCompleted' }
    case 'session.ended': {
      if (payload === null || typeof payload !== 'object') {
        throw protocolError('protocol.badPayload', '厂商事件载荷不是对象')
      }
      const reason = (payload as Record<string, unknown>).reason
      if (typeof reason !== 'string') {
        throw protocolError('protocol.missingReason', '事件缺少结束原因')
      }
      return { type: 'sessionEnded', reason }
    }
    case 'tool.event': {
      if (payload === null || typeof payload !== 'object') {
        throw protocolError('protocol.badPayload', '厂商事件载荷不是对象')
      }
      const obj = payload as Record<string, unknown>
      const kindValue = obj.kind
      const summary = obj.summary
      if (typeof kindValue !== 'string') {
        throw protocolError('protocol.missingKind', '工具事件缺少类型')
      }
      if (typeof summary !== 'string') {
        throw protocolError('protocol.missingSummary', '工具事件缺少摘要')
      }
      return { type: 'toolEvent', kind: kindValue, summary }
    }
    case 'audio.frame':
      throw protocolError('protocol.audioOnJsonPath', '音频帧必须走二进制/编解码路径')
    default:
      throw protocolError('protocol.unknownEvent', '未知的厂商事件类型，请升级适配器')
  }
}

// ---------- 切换：有序关闭前缀 + D4 边界 ----------

export type VoiceState =
  | 'booting'
  | 'wakeArming'
  | 'wakeReady'
  | 'wakeDetected'
  | 'wakeReleasingMicrophone'
  | 'voiceAcquiringMicrophone'
  | 'voiceConnecting'
  | 'voiceListening'
  | 'voiceSpeaking'
  | 'working'
  | 'voiceStopping'
  | 'wakeRearming'
  | 'degraded'
  | 'stopping'

export type SwitchStep = 'requestVoiceStop' | 'awaitVoiceStopped' | 'instantiate' | 'reject'

export interface SwitchPlan {
  steps: SwitchStep[]
}

export function providerSwitchPrelude(state: VoiceState): SwitchPlan {
  switch (state) {
    case 'voiceConnecting':
    case 'voiceListening':
    case 'voiceSpeaking':
    case 'working':
      return { steps: ['requestVoiceStop', 'awaitVoiceStopped', 'instantiate'] }
    case 'wakeReady':
    case 'degraded':
      return { steps: ['instantiate'] }
    default:
      return { steps: ['reject'] }
  }
}

// ---------- 会话配置：D4 + BYOK 边界 ----------

export interface VoiceSessionConfig {
  workspace: string
  voice: Record<string, unknown>
}

export function voiceSessionConfig(workspace: string, voice: Record<string, unknown>): VoiceSessionConfig {
  return { workspace, voice }
}

// ---------- provider 实现义务（接口形状，FakeProvider 见测试） ----------

export interface VoiceProvider {
  connect(config: VoiceSessionConfig): Promise<void>
  interrupt(): Promise<void>
  sendText(text: string): Promise<void>
  stop(): Promise<void>
  capabilities(): ProviderCapabilities
  nextEvent(): Promise<UnifiedVoiceEvent | undefined>
}
