import { randomUUID } from 'node:crypto'
import { writeAppLog } from '../teaching/logger'

/**
 * 火山引擎（豆包语音）双向流式 TTS 客户端。
 *
 * 为什么要放主进程：浏览器 WebSocket 不能带自定义请求头，
 * 而火山要求 X-Api-Key / X-Api-Resource-Id，所以只能在 Node 侧建连，
 * 再把合成好的音频通过 IPC 交回渲染层播放。
 *
 * 协议格式来自官方 TTS Websocket Bidirection protocols：
 * 4 字节头 + [event] + [session_id] + [payload]。
 */

const WS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
const PROTOCOL_VERSION = 1
const HEADER_SIZE = 4

const MSG_FULL_CLIENT = 0b0001
const MSG_FULL_SERVER = 0b1001
const MSG_AUDIO_ONLY_SERVER = 0b1011
const MSG_ERROR = 0b1111

const FLAG_WITH_EVENT = 0b0100

const EVENT_START_CONNECTION = 1
const EVENT_FINISH_CONNECTION = 2
const EVENT_CONNECTION_STARTED = 50
const EVENT_CONNECTION_FAILED = 51
const EVENT_CONNECTION_FINISHED = 52
const EVENT_START_SESSION = 100
const EVENT_FINISH_SESSION = 102
const EVENT_SESSION_STARTED = 150
const EVENT_SESSION_FINISHED = 152
const EVENT_SESSION_FAILED = 153
const EVENT_TASK_REQUEST = 200
const EVENT_TTS_SENTENCE_START = 350
const EVENT_TTS_SENTENCE_END = 351
const EVENT_TTS_RESPONSE = 352

/**
 * 双向流式接口的命名空间，必须和 payload 里的 event 一起带。
 * 少了它服务端照样回 SessionStarted，但不会把 TaskRequest 里的文本当回事，
 * 结果就是"连接成功、会话开始、然后什么都没合成出来"。
 */
const NAMESPACE = 'BidirectionalTTS'

export interface VolcengineTtsRequest {
  requestId?: string
  text: string
  apiKey: string
  resourceId?: string
  speaker: string
  /** 语音指令：用自然语言描述希望的语气，例如“情绪饱满、语气强烈” */
  emotion?: string
  speechRate?: number
  format?: 'mp3' | 'pcm' | 'ogg_opus'
  sampleRate?: number
}

export interface VolcengineTtsResult {
  audio: Uint8Array
  mime: string
  requestId: string
}

interface EncodedMessage {
  type: number
  flag: number
  event?: number
  sessionId?: string
  payload?: Uint8Array
}

function writeUInt32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value >>> 0, 0)
  return buf
}

/** 编码一条客户端消息（导出用于单元测试） */
export function encodeMessage(message: EncodedMessage): Buffer {
  const parts: Buffer[] = []
  const header = Buffer.alloc(HEADER_SIZE)
  header[0] = (PROTOCOL_VERSION << 4) | 1
  header[1] = (message.type << 4) | message.flag
  // JSON 序列化（1），不压缩（0）
  header[2] = (1 << 4) | 0
  header[3] = 0
  parts.push(header)

  if (message.flag & FLAG_WITH_EVENT) {
    const eventBuf = Buffer.alloc(4)
    eventBuf.writeInt32BE(message.event ?? 0, 0)
    parts.push(eventBuf)

    // 连接级事件没有 session_id
    const isConnectionEvent =
      message.event === EVENT_START_CONNECTION ||
      message.event === EVENT_FINISH_CONNECTION
    if (!isConnectionEvent) {
      const idBytes = Buffer.from(message.sessionId ?? '', 'utf-8')
      parts.push(writeUInt32(idBytes.length))
      if (idBytes.length > 0) parts.push(idBytes)
    }
  }

  const payload = message.payload ?? Buffer.from('{}', 'utf-8')
  parts.push(writeUInt32(payload.length))
  parts.push(Buffer.from(payload))

  return Buffer.concat(parts)
}

/** 解析服务端消息（导出用于单元测试） */
export function decodeMessage(data: Buffer): {
  type: number
  flag: number
  event?: number
  sessionId?: string
  connectId?: string
  errorCode?: number
  payload: Buffer
} {
  let offset = 0
  const first = data[offset++]
  const headerSize = (first & 0x0f) * 4
  const typeAndFlag = data[offset++]
  const type = typeAndFlag >> 4
  const flag = typeAndFlag & 0x0f
  offset += 1 // serialization + compression
  offset = headerSize

  let event: number | undefined
  let sessionId: string | undefined
  let connectId: string | undefined
  let errorCode: number | undefined

  if (flag & FLAG_WITH_EVENT) {
    event = data.readInt32BE(offset)
    offset += 4

    const isConnectionEvent =
      event === EVENT_CONNECTION_STARTED ||
      event === EVENT_CONNECTION_FAILED ||
      event === EVENT_CONNECTION_FINISHED ||
      event === EVENT_START_CONNECTION ||
      event === EVENT_FINISH_CONNECTION

    if (isConnectionEvent) {
      const connectIdSize = data.readUInt32BE(offset)
      offset += 4
      if (connectIdSize > 0) {
        connectId = data.subarray(offset, offset + connectIdSize).toString('utf-8')
        offset += connectIdSize
      }
    } else {
      const sessionIdSize = data.readUInt32BE(offset)
      offset += 4
      if (sessionIdSize > 0) {
        sessionId = data.subarray(offset, offset + sessionIdSize).toString('utf-8')
        offset += sessionIdSize
      }
    }
  }

  if (type === MSG_ERROR) {
    errorCode = data.readUInt32BE(offset)
    offset += 4
  }

  const payloadSize = data.readUInt32BE(offset)
  offset += 4
  const payload = payloadSize > 0 ? data.subarray(offset, offset + payloadSize) : Buffer.alloc(0)

  return { type, flag, event, sessionId, connectId, errorCode, payload }
}

/**
 * 组装 StartSession 的请求体。
 *
 * 这里**不能**带 text：双向流式接口的文本要通过 TaskRequest 逐段发，
 * 塞在 StartSession 里会被忽略——实测服务端仍然回 SessionStarted，
 * 紧接着回一个空句子的 TTSSentenceStart 和 SessionFinished，一个字节音频都没有。
 */
export function buildSessionPayload(params: {
  speaker: string
  format: string
  sampleRate: number
  speechRate?: number
  emotion?: string
}): string {
  const reqParams: Record<string, unknown> = {
    speaker: params.speaker,
    audio_params: {
      format: params.format,
      sample_rate: params.sampleRate,
      ...(params.speechRate !== undefined ? { speech_rate: params.speechRate } : {}),
    },
  }
  if (params.emotion?.trim()) {
    reqParams.context_texts = [params.emotion.trim()]
  }
  return JSON.stringify({
    user: { uid: 'alice' },
    event: EVENT_START_SESSION,
    namespace: NAMESPACE,
    req_params: reqParams,
  })
}

/** 组装 TaskRequest 的请求体：文本在这里送进去 */
export function buildTaskPayload(text: string): string {
  return JSON.stringify({
    user: { uid: 'alice' },
    event: EVENT_TASK_REQUEST,
    namespace: NAMESPACE,
    req_params: { text },
  })
}

/** 组装结束会话 / 结束连接的请求体 */
export function buildControlPayload(event: number): string {
  return JSON.stringify({
    user: { uid: 'alice' },
    event,
    namespace: NAMESPACE,
  })
}

function payloadText(payload: Buffer): string {
  try {
    return payload.toString('utf-8')
  } catch {
    return ''
  }
}

/** 正在合成中的连接，用于取消 */
const activeSockets = new Map<string, any>()

export function cancelVolcengineTts(requestId: string): boolean {
  const socket = activeSockets.get(requestId)
  if (!socket) return false
  try {
    socket.close()
  } catch {
    // 已经关闭的连接忽略
  }
  activeSockets.delete(requestId)
  writeAppLog({ module: 'tts', event: 'volcengine.cancel', data: { requestId } })
  return true
}

/**
 * 服务端错误帧的可读文案。
 *
 * 这类帧是 type=0xF 的独立消息，没有 event 字段；只按 event 分流会把它当未知消息丢掉，
 * 于是音色不对、资源不匹配这些明确原因全变成 30 秒后的"超时"。
 */
function describeErrorFrame(code?: number, detail?: string): string {
  const body = (detail || '').replace(/\s+/g, ' ').slice(0, 300)
  const lower = body.toLowerCase()

  if (lower.includes('mismatched with speaker') || lower.includes('resource id')) {
    return `火山引擎 TTS 拒绝了这次请求（${code ?? '未知'}）：音色与模型版本不匹配。2.0 音色要配 seed-tts-2.0，复刻音色要配 seed-icl-2.0；请到控制台音色库复制准确的音色 ID。（${body}）`
  }
  if (lower.includes('speaker')) {
    return `火山引擎 TTS 不认识这个音色（${code ?? '未知'}）：请到控制台音色库确认音色 ID 与账号已开通的模型。（${body}）`
  }
  if (lower.includes('quota') || lower.includes('limit')) {
    return `火山引擎 TTS 额度或并发受限（${code ?? '未知'}）：${body}`
  }
  return `火山引擎 TTS 返回错误（${code ?? '未知'}）${body ? `：${body}` : ''}`
}

/**
 * 握手被拒时的可读错误。
 *
 * ws 遇到 401 不会触发 error，而是抛 unexpected-response 且连接一直挂着，
 * 以前只能等 30 秒超时并报"超时"，用户根本不知道是 Key 不对。
 */
function describeHandshakeFailure(statusCode?: number, body?: string): string {
  const detail = (body || '').replace(/\s+/g, ' ').slice(0, 200)
  if (statusCode === 401) {
    return `火山引擎 TTS 鉴权失败（401）：API Key 无效或已过期${detail ? `（${detail}）` : ''}`
  }
  if (statusCode === 403) {
    return `火山引擎 TTS 无权访问（403）：确认这个 Key 已开通语音合成服务、且模型版本与音色匹配${detail ? `（${detail}）` : ''}`
  }
  if (statusCode === 404) {
    return `火山引擎 TTS 接口不存在（404）：检查模型版本（X-Api-Resource-Id）${detail ? `（${detail}）` : ''}`
  }
  return `火山引擎 TTS 握手失败（HTTP ${statusCode ?? '未知'}）${detail ? `：${detail}` : ''}`
}

/** 已授权的默认资源；复刻音色在这个资源下同样能合成 */
const DEFAULT_RESOURCE = 'seed-tts-2.0'

/** 中英双语兜底音色：单语音色遇到另一种语言会直接返回零字节音频 */
const BILINGUAL_FALLBACK_SPEAKER = 'zh_female_vv_uranus_bigtts'

/** 资源未授权的握手错误 */
function isResourceNotGranted(error: unknown): boolean {
  const message = (error as Error)?.message || ''
  return /403/.test(message) && /not granted|resource/i.test(message)
}

/**
 * 合成入口。
 *
 * 三层兜底，都是实测踩出来的：
 * 1. 复刻音色（ICL_*）常用 seed-icl-2.0，但账号没开通这个资源时会 403；
 *    这类音色在 seed-tts-2.0 下能正常合成，所以先自动回落一次资源版本。
 * 2. 单语音色遇到另一种语言会"成功结束但零字节"，换双语音色再来一次。
 * 3. 都不行就报能看懂的原因，不再让用户对着沉默的应用猜。
 */
export async function synthesizeVolcengineTts(
  params: VolcengineTtsRequest
): Promise<VolcengineTtsResult> {
  const selected = params.speaker?.trim() || BILINGUAL_FALLBACK_SPEAKER
  const resource = params.resourceId?.trim() || DEFAULT_RESOURCE

  let first: VolcengineTtsResult
  try {
    first = await runSynthesis(params, selected, resource)
  } catch (error) {
    if (resource === DEFAULT_RESOURCE || !isResourceNotGranted(error)) throw error

    writeAppLog({
      module: 'tts',
      level: 'warn',
      event: 'volcengine.resource_fallback',
      data: {
        from: resource,
        to: DEFAULT_RESOURCE,
        speaker: selected,
        message: (error as Error).message.slice(0, 160),
      },
    })
    first = await runSynthesis(params, selected, DEFAULT_RESOURCE)
  }

  if (first.audio.length > 0) return first

  if (selected !== BILINGUAL_FALLBACK_SPEAKER) {
    writeAppLog({
      module: 'tts',
      level: 'warn',
      event: 'volcengine.empty_fallback',
      data: {
        speaker: selected,
        text: String(params.text || '').slice(0, 40),
      },
    })
    const second = await runSynthesis(params, BILINGUAL_FALLBACK_SPEAKER, DEFAULT_RESOURCE)
    if (second.audio.length > 0) return second
  }

  throw new Error(
    '火山引擎 TTS 没有返回音频：这个音色可能不支持当前文本的语种，换一个中英双语音色（例如 zh_female_vv_uranus_bigtts）试试'
  )
}

async function runSynthesis(
  params: VolcengineTtsRequest,
  speaker: string,
  resourceId: string
): Promise<VolcengineTtsResult> {
  const apiKey = params.apiKey?.trim()
  if (!apiKey) throw new Error('火山引擎 TTS 的 API Key 还没填')
  const text = params.text?.trim()
  if (!text) throw new Error('待合成文本为空')

  const requestId = params.requestId || randomUUID()
  const sessionId = randomUUID()
  const format = params.format || 'mp3'
  const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/wav'

  const wsModule: any = await import('ws')
  const WebSocket = wsModule.default ?? wsModule

  return new Promise<VolcengineTtsResult>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let socket: any

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      activeSockets.delete(requestId)
      try {
        socket?.close()
      } catch {
        // ignore
      }
      if (error) {
        writeAppLog({
          module: 'tts',
          level: 'warn',
          event: 'volcengine.failed',
          data: { requestId, message: error.message },
        })
        reject(error)
        return
      }
      const audio = Buffer.concat(chunks)
      writeAppLog({
        module: 'tts',
        event: 'volcengine.done',
        data: {
          requestId,
          bytes: audio.length,
          textLength: text.length,
          speaker,
          emotion: params.emotion ? params.emotion.slice(0, 40) : '',
        },
      })
      resolve({ audio: new Uint8Array(audio), mime, requestId })
    }

    timer = setTimeout(() => finish(new Error('火山引擎 TTS 超时（30 秒）')), 30000)

    try {
      socket = new WebSocket(WS_URL, {
        headers: {
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Connect-Id': requestId,
        },
      })
    } catch (error) {
      finish(new Error(`建立火山 TTS 连接失败：${(error as Error).message}`))
      return
    }

    activeSockets.set(requestId, socket)

    socket.on('open', () => {
      socket.send(
        encodeMessage({
          type: MSG_FULL_CLIENT,
          flag: FLAG_WITH_EVENT,
          event: EVENT_START_CONNECTION,
          payload: Buffer.from('{}', 'utf-8'),
        })
      )
    })

    socket.on('message', (raw: Buffer) => {
      let msg: ReturnType<typeof decodeMessage>
      try {
        msg = decodeMessage(Buffer.from(raw))
      } catch (error) {
        writeAppLog({
          module: 'tts',
          level: 'warn',
          event: 'volcengine.decode_failed',
          data: { message: (error as Error).message },
        })
        return
      }

      // 错误帧没有 event，必须在按事件分流之前拦下来
      if (msg.type === MSG_ERROR) {
        finish(new Error(describeErrorFrame(msg.errorCode, payloadText(msg.payload))))
        return
      }

      switch (msg.event) {
        case EVENT_CONNECTION_STARTED: {
          socket.send(
            encodeMessage({
              type: MSG_FULL_CLIENT,
              flag: FLAG_WITH_EVENT,
              event: EVENT_START_SESSION,
              sessionId,
              payload: Buffer.from(
                buildSessionPayload({
                  speaker,
                  format,
                  sampleRate: params.sampleRate || 24000,
                  speechRate: params.speechRate,
                  emotion: params.emotion,
                }),
                'utf-8'
              ),
            })
          )
          break
        }

        case EVENT_SESSION_STARTED: {
          // 会话建好之后再送文本，送完立刻告诉服务端"没有更多了"。
          // 顺序不能颠倒：先 FinishSession 再发文本，服务端会当成空会话直接结束。
          socket.send(
            encodeMessage({
              type: MSG_FULL_CLIENT,
              flag: FLAG_WITH_EVENT,
              event: EVENT_TASK_REQUEST,
              sessionId,
              payload: Buffer.from(buildTaskPayload(text), 'utf-8'),
            })
          )
          socket.send(
            encodeMessage({
              type: MSG_FULL_CLIENT,
              flag: FLAG_WITH_EVENT,
              event: EVENT_FINISH_SESSION,
              sessionId,
              payload: Buffer.from(buildControlPayload(EVENT_FINISH_SESSION), 'utf-8'),
            })
          )
          break
        }

        case EVENT_TTS_RESPONSE: {
          if (msg.payload.length > 0) chunks.push(Buffer.from(msg.payload))
          break
        }

        case EVENT_TTS_SENTENCE_START:
        case EVENT_TTS_SENTENCE_END: {
          // 句子级事件只用于观测：合成是流式的，音频在 352 里逐块到达
          break
        }

        case EVENT_SESSION_FINISHED: {
          try {
            socket.send(
              encodeMessage({
                type: MSG_FULL_CLIENT,
                flag: FLAG_WITH_EVENT,
                event: EVENT_FINISH_CONNECTION,
                payload: Buffer.from('{}', 'utf-8'),
              })
            )
          } catch {
            // 连接已断也要把已收到的音频交出去
          }
          finish()
          break
        }

        case EVENT_SESSION_FAILED:
        case EVENT_CONNECTION_FAILED: {
          const detail = payloadText(msg.payload)
          finish(
            new Error(
              `火山 TTS 失败${msg.event === EVENT_CONNECTION_FAILED ? '（连接）' : '（会话）'}：${detail.slice(0, 300)}`
            )
          )
          break
        }

        default:
          break
      }
    })

    socket.on('error', (error: Error) => finish(new Error(`火山 TTS 连接错误：${error.message}`)))

    // 鉴权/资源不对时服务端直接回 HTTP 401/403，ws 走的是这个分支而不是 error
    socket.on('unexpected-response', (_req: unknown, res: any) => {
      const bodyChunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => bodyChunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        finish(
          new Error(
            describeHandshakeFailure(
              res.statusCode,
              Buffer.concat(bodyChunks).toString('utf-8')
            )
          )
        )
      })
      res.on('error', () =>
        finish(new Error(describeHandshakeFailure(res.statusCode)))
      )
    })

    socket.on('close', () => {
      // 收到 SessionFinished 前就断开，说明没合成完整
      if (!settled) {
        finish(
          new Error(
            chunks.length > 0
              ? '火山 TTS 连接提前关闭，音频可能不完整'
              : '火山 TTS 连接被关闭，没有返回音频'
          )
        )
      }
    })
  })
}
