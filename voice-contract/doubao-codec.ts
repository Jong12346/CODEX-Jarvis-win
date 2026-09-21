/**
 * 豆包 Realtime 语音 API 二进制协议 codec（TS 移植自官方 demo protocol.py）。
 * 帧结构：[Header 4B] [可选字段] [payload_size 4B] [payload]
 *
 * Header:
 *   Byte0: version(4b)=0x1 | header_size(4b)=0x1 -> 恒 0x11
 *   Byte1: msg_type(4b) | flags(4b)
 *   Byte2: serialization(4b) | compression(4b)
 *   Byte3: reserved -> 恒 0x00
 *
 * 可选字段（按 flags/msg_type）：
 *   error_code(4B)  当 msg_type == ERROR
 *   sequence(4B)    当 flags & 0b0011 in (1,3)
 *   event_id(4B)    当 flags & 0b0100
 *   connect_id / session_id：connect 级事件(1,2,50,51,52)带 connect_id；session 级(>=100)带 session_id
 * 之后：payload_size(4B) + payload；compression==1 时 payload 为 gzip。
 * 所有整数字段大端。
 */

export const PROTOCOL_VERSION = 0x1
export const FLAG_EVENT = 0b0100

export const MsgType = {
  FULL_CLIENT_REQUEST: 0b0001,
  FULL_SERVER_RESPONSE: 0b1001,
  AUDIO_ONLY_REQUEST: 0b0010,
  AUDIO_ONLY_RESPONSE: 0b1011,
  ERROR: 0b1111,
} as const

export const Serialization = {
  RAW: 0b0000,
  JSON: 0b0001,
} as const

export const ClientEvent = {
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  START_SESSION: 100,
  FINISH_SESSION: 102,
  TASK_REQUEST: 200,
  SAY_HELLO: 300,
  END_ASR: 400,
  CHAT_TTS_TEXT: 500,
  CHAT_TEXT_QUERY: 501,
  CHAT_RAG_TEXT: 502,
  CONVERSATION_CREATE: 510,
  CONVERSATION_UPDATE: 511,
  CONVERSATION_RETRIEVE: 512,
  CONVERSATION_DELETE: 514,
} as const

export const ServerEvent = {
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  CONNECTION_FINISHED: 52,
  SESSION_STARTED: 150,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  TTS_SENTENCE_START: 350,
  TTS_RESPONSE: 352,
  TTS_ENDED: 359,
  ASR_RESPONSE: 451,
  ASR_ENDED: 459,
  CHAT_RESPONSE: 550,
  CHAT_ENDED: 559,
  DIALOG_COMMON_ERROR: 599,
} as const

const CONNECT_LEVEL_EVENTS = new Set([1, 2, 50, 51, 52])

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function utf8(s: string): Uint8Array {
  return encoder.encode(s)
}
function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b)
}

function readU32(buf: Uint8Array, o: number): number {
  return ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0
}

function writeU32(out: number[], n: number): void {
  out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function buildHeader(msgType: number, flags: number, serialization: number, compression = 0): number[] {
  return [0x11, (msgType << 4) | (flags & 0x0f), (serialization << 4) | (compression & 0x0f), 0x00]
}

/** 构造 Full-client-request 事件帧（JSON 载荷）。 */
export function buildEventFrame(
  eventId: number,
  payload: Record<string, unknown> = {},
  sessionId?: string,
  connectId?: string,
): Uint8Array {
  const buf = buildHeader(MsgType.FULL_CLIENT_REQUEST, FLAG_EVENT, Serialization.JSON)
  writeU32(buf, eventId)
  if (connectId && CONNECT_LEVEL_EVENTS.has(eventId)) {
    const cid = utf8(connectId)
    writeU32(buf, cid.length)
    for (const b of cid) buf.push(b)
  }
  if (sessionId && !CONNECT_LEVEL_EVENTS.has(eventId)) {
    const sid = utf8(sessionId)
    writeU32(buf, sid.length)
    for (const b of sid) buf.push(b)
  }
  const payloadBytes = utf8(JSON.stringify(payload))
  writeU32(buf, payloadBytes.length)
  for (const b of payloadBytes) buf.push(b)
  return new Uint8Array(buf)
}

/** 构造 Audio-only-request 帧（上传 PCM，事件号 TASK_REQUEST）。 */
export function buildAudioFrame(audioData: Uint8Array, sessionId: string): Uint8Array {
  const buf = buildHeader(MsgType.AUDIO_ONLY_REQUEST, FLAG_EVENT, Serialization.RAW)
  writeU32(buf, ClientEvent.TASK_REQUEST)
  const sid = utf8(sessionId)
  writeU32(buf, sid.length)
  for (const b of sid) buf.push(b)
  writeU32(buf, audioData.length)
  for (const b of audioData) buf.push(b)
  return new Uint8Array(buf)
}

export interface ParsedFrame {
  msgType: number
  flags: number
  serialization: number
  compression: number
  eventId?: number
  sessionId?: string
  sequence?: number
  errorCode?: number
  payload: Uint8Array
  payloadJson?: unknown
}

/** 解析来自 Volcengine 服务端的二进制帧。 */
export function parseServerFrame(data: Uint8Array): ParsedFrame {
  if (data.length < 4) throw new Error('frame too short: ' + data.length + ' bytes')

  const frame: ParsedFrame = {
    msgType: (data[1] >> 4) & 0x0f,
    flags: data[1] & 0x0f,
    serialization: (data[2] >> 4) & 0x0f,
    compression: data[2] & 0x0f,
    payload: new Uint8Array(0),
  }
  let pos = 4

  if (frame.msgType === MsgType.ERROR && pos + 4 <= data.length) {
    frame.errorCode = readU32(data, pos)
    pos += 4
  }

  const seqMode = frame.flags & 0b0011
  if ((seqMode === 0b0001 || seqMode === 0b0011) && pos + 4 <= data.length) {
    frame.sequence = readU32(data, pos)
    pos += 4
  }

  if ((frame.flags & FLAG_EVENT) !== 0 && pos + 4 <= data.length) {
    frame.eventId = readU32(data, pos)
    pos += 4
    const isSessionLevel = frame.eventId >= 100
    if (isSessionLevel && pos + 4 <= data.length) {
      const sidLen = readU32(data, pos)
      pos += 4
      if (sidLen > 0 && pos + sidLen <= data.length) {
        frame.sessionId = fromUtf8(data.subarray(pos, pos + sidLen))
        pos += sidLen
      }
    }
  }

  if (pos + 4 <= data.length) {
    const payloadSize = readU32(data, pos)
    pos += 4
    if (payloadSize > 0 && pos + payloadSize <= data.length) {
      let raw = data.subarray(pos, pos + payloadSize)
      if (frame.compression === 1) {
        raw = gunzip(raw)
      }
      frame.payload = raw
      if (frame.serialization === Serialization.JSON && raw.length > 0) {
        try {
          frame.payloadJson = JSON.parse(fromUtf8(raw))
        } catch {
          /* 非法 JSON 留给上层按 protocol 错误分类 */
        }
      }
    }
  }

  return frame
}

// gzip 解压（compression==1 时用）。node 内置 zlib；浏览器侧用 DecompressionStream。
import { gunzipSync } from 'node:zlib'
function gunzip(data: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(data))
}
