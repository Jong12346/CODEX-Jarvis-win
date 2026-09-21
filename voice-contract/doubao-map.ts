/**
 * 豆包 S2S 二进制事件 → UnifiedVoiceEvent 映射（协议层）。
 * 载荷字段名取自官方 demo server.py 的 _relay_to_browser。
 *
 * 关键结论：豆包 S2S 事件表不含任何工具/函数调用事件 —— 走「分离模式」：
 * 语音转写 → DSH agent 执行 → 文本回流语音；AgentBackend 由 DSH 自身承担。
 */
import { ServerEvent, MsgType, type ParsedFrame } from './doubao-codec.ts'
import { ProviderError, type UnifiedVoiceEvent } from './voice-events.ts'

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function errorEvent(code: string, category: ProviderError['category'], recoverable: boolean, adviceZh: string): UnifiedVoiceEvent {
  return { type: 'error', error: new ProviderError(code, category, recoverable, adviceZh) }
}

export function mapDoubaoFrame(frame: ParsedFrame): UnifiedVoiceEvent[] {
  // 帧级错误（msg_type == ERROR，带 error_code）
  if (frame.msgType === MsgType.ERROR) {
    const d = asRecord(frame.payloadJson)
    const message =
      typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : '未知错误'
    return [errorEvent('doubao.frameError', 'protocol', false, message)]
  }

  const eid = frame.eventId
  const d = asRecord(frame.payloadJson)

  switch (eid) {
    case ServerEvent.ASR_RESPONSE: {
      const results = d.results
      if (!Array.isArray(results)) return []
      const out: UnifiedVoiceEvent[] = []
      for (const item of results) {
        const r = asRecord(item)
        const text = r.text
        if (typeof text !== 'string' || text.length === 0) continue
        if (r.is_interim === true) {
          out.push({ type: 'transcriptDelta', role: 'user', text })
        } else {
          out.push({ type: 'transcriptFinal', role: 'user', text })
        }
      }
      return out
    }

    case ServerEvent.TTS_RESPONSE:
      // 裸 pcm_s16le 音频（sample_rate 24000）
      return frame.payload.length > 0 ? [{ type: 'audioFrame', samples: Array.from(frame.payload) }] : []

    case ServerEvent.TTS_SENTENCE_START:
      return [{ type: 'turnStarted' }]

    case ServerEvent.TTS_ENDED:
    case ServerEvent.CHAT_ENDED:
      return [{ type: 'turnCompleted' }]

    case ServerEvent.CHAT_RESPONSE: {
      const content = d.content
      return typeof content === 'string' && content.length > 0
        ? [{ type: 'transcriptFinal', role: 'assistant', text: content }]
        : []
    }

    case ServerEvent.DIALOG_COMMON_ERROR: {
      const message = typeof d.message === 'string' ? d.message : '对话错误'
      return [errorEvent('doubao.dialogError', 'protocol', false, message)]
    }

    case ServerEvent.SESSION_FAILED: {
      const message = typeof d.error === 'string' ? d.error : '会话失败'
      return [errorEvent('doubao.sessionFailed', 'protocol', false, message)]
    }

    case ServerEvent.CONNECTION_FAILED: {
      const message = typeof d.error === 'string' ? d.error : '连接失败'
      return [errorEvent('doubao.connectionFailed', 'network', true, message)]
    }

    // SESSION_STARTED / ASR_INFO / ASR_ENDED / TTS_SENTENCE_END / USAGE_RESPONSE /
    // CHAT_TEXT_QUERY_CONFIRMED：内部簿记，不产出统一事件
    default:
      return []
  }
}
