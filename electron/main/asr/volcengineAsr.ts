import { randomUUID } from 'node:crypto'
import { writeAppLog } from '../teaching/logger'

/**
 * 火山引擎「录音文件识别」客户端（HTTP 异步任务）。
 *
 * 为什么用这个而不是流式识别：账号只开通了录音文件识别（`volc.seedasr.auc`），
 * 流式 `sauc` 资源一律 403。实测录音文件识别对 3 秒的短音频，
 * 提交 + 查询总共约 1 秒，课堂上够用。
 *
 * 官方文档只写了 `audio.url`，但实测 `audio.data`（base64）也能用——
 * 这对本地麦克风录音是唯一可行的方式：我们没有公网 URL 可给。
 */

const SUBMIT_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
const QUERY_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query'

const STATUS_OK = '20000000'
const STATUS_PROCESSING = ['20000001', '20000002']

export interface VolcengineAsrRequest {
  apiKey: string
  /** WAV 原始字节（16k / 16bit / 单声道） */
  audio: Uint8Array
  /** volc.seedasr.auc（2.0，默认）/ volc.bigasr.auc（1.0） */
  resourceId?: string
  /** zh-CN / en-US ...；留空走自动识别（中文、英文及方言） */
  language?: string
}

export interface VolcengineAsrResult {
  text: string
  durationMs?: number
}

export interface AsrSubmitPayloadParams {
  audioBase64: string
  format: string
  rate: number
  bits: number
  channel: number
  language?: string
}

/** 组装 submit 请求体（导出用于单测） */
export function buildAsrSubmitPayload(params: AsrSubmitPayloadParams): string {
  const audio: Record<string, unknown> = {
    format: params.format,
    rate: params.rate,
    bits: params.bits,
    channel: params.channel,
    // 文档只写 url，但 data（base64）实际可用，且本地录音没有公网地址
    data: params.audioBase64,
  }

  const request: Record<string, unknown> = {
    model_name: 'bigmodel',
    enable_itn: true,
    enable_punc: true,
    show_utterances: true,
  }
  if (params.language?.trim()) {
    request.language = params.language.trim()
  } else {
    request.enable_auto_lang = true
  }

  return JSON.stringify({ user: { uid: 'alice' }, audio, request })
}

function headerValue(headers: Headers, name: string): string {
  return headers.get(name) ?? ''
}

function describeFailure(status: number, code: string, message: string): string {
  const detail = message ? `：${message}` : ''
  if (code === '45000001') return `火山识别参数不合法（${code}）${detail}`
  if (code === '45000006') return `火山识别拿不到音频（${code}）${detail}`
  if (status === 401 || status === 403) {
    return `火山识别鉴权失败（HTTP ${status}）${detail}`
  }
  return `火山识别失败（HTTP ${status} / ${code || '无状态码'}）${detail}`
}

/**
 * 转写一段音频。
 *
 * 流程：submit 拿任务号 → 轮询 query 直到出结果。
 * 短音频通常第一轮查询就有文本，因此不额外加延迟。
 */
export async function transcribeWithVolcengineAsr(
  params: VolcengineAsrRequest
): Promise<VolcengineAsrResult> {
  const apiKey = params.apiKey?.trim()
  if (!apiKey) throw new Error('火山引擎 API Key 还没填')
  if (!params.audio?.length) throw new Error('待识别音频为空')

  const resourceId = params.resourceId?.trim() || 'volc.seedasr.auc'
  const requestId = randomUUID()
  const startedAt = Date.now()

  const base64 = Buffer.from(params.audio).toString('base64')
  const payload = buildAsrSubmitPayload({
    audioBase64: base64,
    format: 'wav',
    rate: 16000,
    bits: 16,
    channel: 1,
    language: params.language,
  })

  const headers = {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
    'Content-Type': 'application/json',
  }

  const submit = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers,
    body: payload,
  })
  const submitCode = headerValue(submit.headers, 'x-api-status-code')
  const submitMessage = headerValue(submit.headers, 'x-api-message')

  if (!submit.ok || (submitCode && submitCode !== STATUS_OK)) {
    writeAppLog({
      module: 'asr',
      level: 'warn',
      event: 'volcengine.submit_failed',
      data: { status: submit.status, code: submitCode, message: submitMessage },
    })
    throw new Error(describeFailure(submit.status, submitCode, submitMessage))
  }

  // 轮询结果。3 秒音频一般 1~2 轮就出来，最长等 12 秒。
  const deadline = Date.now() + 12000
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    const query = await fetch(QUERY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    const code = headerValue(query.headers, 'x-api-status-code')
    const message = headerValue(query.headers, 'x-api-message')

    if (code === STATUS_OK) {
      const body = (await query.json().catch(() => ({}))) as {
        result?: { text?: string }
        audio_info?: { duration?: number }
      }
      const text = String(body?.result?.text ?? '').trim()
      writeAppLog({
        module: 'asr',
        event: 'volcengine.done',
        data: {
          requestId,
          ms: Date.now() - startedAt,
          attempts: attempt,
          chars: text.length,
          durationMs: body?.audio_info?.duration,
        },
      })
      return { text, durationMs: body?.audio_info?.duration }
    }

    if (!STATUS_PROCESSING.includes(code)) {
      writeAppLog({
        module: 'asr',
        level: 'warn',
        event: 'volcengine.query_failed',
        data: { requestId, status: query.status, code, message },
      })
      throw new Error(describeFailure(query.status, code, message))
    }

    await new Promise(resolve => setTimeout(resolve, 400))
  }

  throw new Error('火山识别超时：12 秒内没有返回结果')
}
