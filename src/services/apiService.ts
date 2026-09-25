import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import { useSettingsStore } from '../stores/settingsStore'
import {
  getOpenAIClient,
  getOpenRouterClient,
  getGroqClient,
  getOllamaClient,
  getLMStudioClient,
  getZAIClient,
  getMiniMaxClient,
  getDeepSeekClient,
  getAPIRouteClient,
  getDoubaoClient,
  getQwenClient,
  QWEN_DASHSCOPE_NATIVE_BASE_URL,
} from './apiClients'
import {
  createOpenAIResponse as createOpenAIResponseWithOpenAI,
  listOpenAIModels,
} from './llmProviders/openai'
import {
  createOpenRouterResponse,
  listOpenRouterModels,
} from './llmProviders/openrouter'
import { createOllamaResponse, listOllamaModels } from './llmProviders/ollama'
import {
  createLMStudioResponse,
  listLMStudioModels,
} from './llmProviders/lmStudio'
import { createZAIResponse, listZAIModels } from './llmProviders/zai'
import {
  createMiniMaxResponse,
  listMiniMaxModels,
} from './llmProviders/minimax'
import {
  createDeepSeekResponse,
  listDeepSeekModels,
} from './llmProviders/deepseek'
import {
  createAPIRouteResponse,
  listAPIRouteModels,
} from './llmProviders/apiRoute'
import {
  createCodexResponse,
  createCodexTextResponse,
  listCodexModels,
} from './llmProviders/codex'
import {
  createChatCompletionForProvider,
  stripReasoningFromMiniMaxContent,
} from './llmProviders/openAICompatible'
import {
  getSafeProviderModel,
  isChatCompletionsProvider,
} from './llmProviders/providerCatalog'
import type { AppChatMessageContentPart } from '../types/chat'
import type { RagSearchResult } from '../types/rag'
import type { EmbeddingInputType } from './backendApi'

/**
 * Parse WAV file ArrayBuffer and extract raw PCM audio data as Float32Array
 */
function parseWavToFloat32Array(arrayBuffer: ArrayBuffer): Float32Array {
  const dataView = new DataView(arrayBuffer)

  // Verify WAV format
  if (dataView.getUint32(0, false) !== 0x52494646) {
    // "RIFF"
    throw new Error('Invalid WAV file: missing RIFF header')
  }

  if (dataView.getUint32(8, false) !== 0x57415645) {
    // "WAVE"
    throw new Error('Invalid WAV file: missing WAVE header')
  }

  // Find data chunk
  let offset = 12
  let dataOffset = -1
  let dataSize = 0

  while (offset < arrayBuffer.byteLength) {
    const chunkId = dataView.getUint32(offset, false)
    const chunkSize = dataView.getUint32(offset + 4, true)

    if (chunkId === 0x64617461) {
      // "data"
      dataOffset = offset + 8
      dataSize = chunkSize
      break
    }

    offset += 8 + chunkSize
  }

  if (dataOffset === -1) {
    throw new Error('Invalid WAV file: data chunk not found')
  }

  // Extract PCM data and convert to Float32
  const pcmData = new Int16Array(arrayBuffer, dataOffset, dataSize / 2)
  const float32Data = new Float32Array(pcmData.length)

  // Convert 16-bit PCM to Float32 (-1.0 to 1.0 range)
  for (let i = 0; i < pcmData.length; i++) {
    float32Data[i] = pcmData[i] / 32768.0
  }

  return float32Data
}

/* 
API Function Exports
*/

function getAIClient(): OpenAI {
  const settings = useSettingsStore().config
  switch (settings.aiProvider) {
    case 'openrouter':
      return getOpenRouterClient()
    case 'ollama':
      return getOllamaClient()
    case 'lm-studio':
      return getLMStudioClient()
    case 'zai':
      return getZAIClient()
    case 'minimax':
      return getMiniMaxClient()
    case 'deepseek':
      return getDeepSeekClient()
    case 'api-route':
      return getAPIRouteClient()
    default:
      return getOpenAIClient()
  }
}

export const fetchOpenAIModels = async (): Promise<OpenAI.Models.Model[]> => {
  const settings = useSettingsStore().config
  if (settings.aiProvider === 'openrouter') {
    return listOpenRouterModels()
  }
  if (settings.aiProvider === 'ollama') {
    return listOllamaModels()
  }
  if (settings.aiProvider === 'lm-studio') {
    return listLMStudioModels()
  }
  if (settings.aiProvider === 'zai') {
    return listZAIModels()
  }
  if (settings.aiProvider === 'minimax') {
    return listMiniMaxModels()
  }
  if (settings.aiProvider === 'deepseek') {
    return listDeepSeekModels()
  }
  if (settings.aiProvider === 'api-route') {
    return listAPIRouteModels()
  }
  if (settings.aiProvider === 'codex') {
    return listCodexModels()
  }
  return listOpenAIModels()
}

export const createOpenAIResponse = async (
  input: OpenAI.Responses.Request.InputItemLike[],
  previousResponseId: string | null,
  stream: boolean = false,
  customInstructions?: string,
  signal?: AbortSignal
): Promise<any> => {
  const settings = useSettingsStore().config

  if (settings.aiProvider === 'openrouter') {
    return createOpenRouterResponse(
      input,
      previousResponseId,
      stream,
      customInstructions,
      signal
    )
  }
  if (settings.aiProvider === 'ollama') {
    return createOllamaResponse(
      input,
      previousResponseId,
      stream,
      customInstructions,
      signal
    )
  }
  if (settings.aiProvider === 'lm-studio') {
    return createLMStudioResponse(
      input,
      previousResponseId,
      stream,
      customInstructions,
      signal
    )
  }
  if (settings.aiProvider === 'zai') {
    return createZAIResponse(
      input,
      previousResponseId,
      stream,
      customInstructions,
      signal
    )
  }
  if (settings.aiProvider === 'minimax') {
    return createMiniMaxResponse(
      input,
      previousResponseId,
      stream,
      customInstructions,
      signal
    )
  }
  if (settings.aiProvider === 'deepseek') {
    return createDeepSeekResponse(
      input,
      previousResponseId,
      stream,
      customInstructions,
      signal
    )
  }
  if (settings.aiProvider === 'api-route') {
    return createAPIRouteResponse(
      input,
      previousResponseId,
      stream,
      customInstructions,
      signal
    )
  }
  if (settings.aiProvider === 'codex') {
    return createCodexResponse(
      input,
      previousResponseId,
      stream,
      customInstructions,
      signal
    )
  }
  return createOpenAIResponseWithOpenAI(
    input,
    previousResponseId,
    stream,
    customInstructions,
    signal
  )
}

function removeLinksFromText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s\)]+/g, '')
    .replace(/www\.[^\s\)]+/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(
      /\[[^\]\n]+?\.(?:pdf|docx?|txt|md|markdown|html?|pptx?)(?:#p[0-9a-zA-Z]+(?:\s*,\s*p[0-9a-zA-Z]+)*)?\]/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim()
}

export const ttsStream = async (
  text: string,
  signal: AbortSignal
): Promise<Response> => {
  const settings = useSettingsStore().config
  const cleanedText = removeLinksFromText(text).trim()
  if (!cleanedText) {
    return new Response(null, { status: 204, statusText: 'No Content' })
  }

  if (settings.ttsProvider === 'local') {
    try {
      // Import the backend API
      const { backendApi } = await import('./backendApi')

      const ttsReady = await backendApi.isTTSReady()

      if (!ttsReady) {
        return fallbackToOpenAITTS(cleanedText, signal)
      }

      const speechResult = await backendApi.synthesizeSpeech(
        cleanedText,
        settings.localTtsVoice
      )

      if (!speechResult.audio) {
        return fallbackToOpenAITTS(cleanedText, signal)
      }

      // Convert number array to ArrayBuffer
      const audioBuffer = new ArrayBuffer(speechResult.audio.length)
      const audioView = new Uint8Array(audioBuffer)
      audioView.set(speechResult.audio)

      const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' })
      return new Response(audioBlob, {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': audioBuffer.byteLength.toString(),
        },
      })
    } catch (error: any) {
      return fallbackToOpenAITTS(cleanedText, signal)
    }
  } else if (settings.ttsProvider === 'google') {
    try {
      return await googleTTS(cleanedText, signal)
    } catch (error) {
      console.error('Google TTS failed, falling back to OpenAI:', error)
      return fallbackToOpenAITTS(cleanedText, signal)
    }
  } else if (settings.ttsProvider === 'doubao') {
    return doubaoTTS(cleanedText, signal)
  } else if (settings.ttsProvider === 'qwen') {
    return qwenTTS(cleanedText, signal)
  } else {
    return fallbackToOpenAITTS(cleanedText, signal)
  }
}

const doubaoTTS = async (
  text: string,
  signal: AbortSignal
): Promise<Response> => {
  const settings = useSettingsStore().config
  const model = settings.doubaoTtsModel?.trim()
  if (!model) {
    throw new Error(
      'Doubao TTS model ID is not configured. Set "Doubao TTS Model ID" in Settings (e.g. an Ark endpoint ID like ep-xxx or a model name).'
    )
  }
  const doubao = getDoubaoClient()
  const response = await doubao.audio.speech.create(
    {
      model,
      voice: settings.doubaoTtsVoice || 'zh_female_cancan_mars_bigtts',
      input: text,
      response_format: 'mp3',
    },
    { signal }
  )
  return response as unknown as Response
}

const qwenTTS = async (
  text: string,
  signal: AbortSignal
): Promise<Response> => {
  const settingsStore = useSettingsStore()
  const apiKey = settingsStore.config.VITE_QWEN_API_KEY
  if (!apiKey) {
    throw new Error('Qwen API Key is not configured')
  }
  const model = settingsStore.config.qwenTtsModel || 'qwen-tts-latest'
  const voice = settingsStore.config.qwenTtsVoice || 'Cherry'

  // Bailian exposes different endpoints per model family:
  // - Qwen-TTS family -> /services/aigc/multimodal-generation/generation
  // - Qwen-Audio-TTS / CosyVoice -> /services/audio/tts/SpeechSynthesizer
  // The base host is user-configurable (qwenBaseUrl) because Qwen-Audio-TTS
  // and CosyVoice require a workspace-specific host. qwenBaseUrl may point at
  // the OpenAI-compatible base (…/compatible-mode/v1) which STT/embedding
  // use; convert it to the native /api/v1 base for TTS calls.
  const rawBase =
    settingsStore.config.qwenBaseUrl || QWEN_DASHSCOPE_NATIVE_BASE_URL
  const baseUrl = rawBase.endsWith('/compatible-mode/v1')
    ? `${rawBase.slice(0, -'/compatible-mode/v1'.length)}/api/v1`
    : rawBase.replace(/\/compatible-mode\/?$/, '/api/v1')
  const isSpeechSynthesizerFamily = /^(qwen-audio|cosyvoice)/i.test(model)
  const endpoint = isSpeechSynthesizerFamily
    ? `${baseUrl}/services/audio/tts/SpeechSynthesizer`
    : `${baseUrl}/services/aigc/multimodal-generation/generation`

  const requestBody = isSpeechSynthesizerFamily
    ? {
        model,
        input: { text, voice, format: 'wav', sample_rate: 24000 },
      }
    : {
        model,
        input: { text, voice },
      }

  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(
      `Qwen TTS Error: ${error?.message || response.statusText}`
    )
  }

  const data = await response.json()
  const audioUrl = data?.output?.audio?.url
  if (audioUrl) {
    const audioResponse = await fetch(audioUrl, { signal })
    if (!audioResponse.ok) {
      throw new Error(
        `Failed to download Qwen TTS audio: ${audioResponse.status}`
      )
    }
    return audioResponse
  }

  // Fallback: some responses inline the audio as base64 instead of a URL.
  const audioBase64 = data?.output?.audio?.data
  if (audioBase64) {
    const binaryString = atob(audioBase64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    return new Response(new Blob([bytes.buffer], { type: 'audio/wav' }))
  }

  throw new Error('Qwen TTS response did not contain an audio URL')
}

const googleTTS = async (
  text: string,
  signal: AbortSignal
): Promise<Response> => {
  const settingsStore = useSettingsStore()
  const apiKey = settingsStore.config.VITE_GOOGLE_API_KEY

  if (!apiKey) {
    throw new Error('Google API Key is not configured')
  }

  // Extract language code from voice name (e.g., "en-US-Journey-F" -> "en-US")
  const voiceName = settingsStore.config.googleTtsVoice || 'en-US-Journey-F'
  const languageCode = voiceName.split('-').slice(0, 2).join('-')

  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: languageCode,
          name: voiceName,
        },
        audioConfig: {
          audioEncoding: 'MP3',
        },
      }),
    }
  )

  if (!response.ok) {
    const error = await response.json()
    throw new Error(
      `Google TTS Error: ${error.error?.message || response.statusText}`
    )
  }

  const data = await response.json()
  // data.audioContent is base64 string
  const binaryString = atob(data.audioContent)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  const blob = new Blob([bytes.buffer], { type: 'audio/mp3' })
  return new Response(blob)
}

// Helper function for OpenAI TTS (extracted from original function)
const fallbackToOpenAITTS = async (
  text: string,
  signal: AbortSignal
): Promise<Response> => {
  const openai = getOpenAIClient()
  const settings = useSettingsStore().config

  return openai.audio.speech.create(
    {
      model: settings.openaiTtsModel?.trim() || 'gpt-4o-mini-tts',
      voice: settings.ttsVoice || 'nova',
      input: text,
      response_format: 'mp3',
    },
    { signal }
  )
}

// Helper to map ISO 639-1 language codes to BCP-47 for Google Cloud
function mapLanguageToBCP47(isoCode: string): string {
  const mapping: Record<string, string> = {
    auto: 'en-US',
    zh: 'zh-CN',
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    it: 'it-IT',
    pt: 'pt-BR',
    ru: 'ru-RU',
    ja: 'ja-JP',
    ko: 'ko-KR',
    ar: 'ar-XA', // Google uses ar-XA for standard Arabic
    hi: 'hi-IN',
    tr: 'tr-TR',
    pl: 'pl-PL',
    nl: 'nl-NL',
    sv: 'sv-SE',
    da: 'da-DK',
    no: 'nb-NO', // Google uses nb-NO for Norwegian Bokmål
    fi: 'fi-FI',
    uk: 'uk-UA',
  }
  return mapping[isoCode] || isoCode
}

const GOOGLE_SYNC_RECOGNITION_MAX_DURATION_SECONDS = 60

function getWavDurationSeconds(audioBuffer: ArrayBuffer): number | null {
  const view = new DataView(audioBuffer)
  let offset = 12

  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false)
    const chunkSize = view.getUint32(offset + 4, true)

    if (chunkId === 0x64617461) {
      const bytesPerSecond = view.getUint32(28, true)
      return bytesPerSecond > 0 ? chunkSize / bytesPerSecond : null
    }

    offset += 8 + chunkSize + (chunkSize % 2)
  }

  return null
}

export const transcribeWithGoogle = async (
  audioBuffer: ArrayBuffer
): Promise<string> => {
  const settingsStore = useSettingsStore()
  const apiKey = settingsStore.config.VITE_GOOGLE_API_KEY

  if (!apiKey) {
    throw new Error('Google API Key is not configured')
  }

  const durationSeconds = getWavDurationSeconds(audioBuffer)
  if (
    durationSeconds !== null &&
    durationSeconds > GOOGLE_SYNC_RECOGNITION_MAX_DURATION_SECONDS
  ) {
    throw new Error(
      'Google STT only supports recordings up to 60 seconds. Please retry with a shorter utterance.'
    )
  }

  // Convert ArrayBuffer to Base64 using FileReader (more efficient for large files)
  const base64Audio = await new Promise<string>((resolve, reject) => {
    const blob = new Blob([audioBuffer], { type: 'audio/wav' })
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // result is like "data:audio/wav;base64,....."
      const base64 = result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })

  const languageCode = mapLanguageToBCP47(
    settingsStore.config.localSttLanguage || 'auto'
  )

  const response = await fetch(
    `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          // If we don't specify encoding, Google attempts to detect it from the header (WAV)
          languageCode: languageCode,
          model: 'latest_short',
        },
        audio: {
          content: base64Audio,
        },
      }),
    }
  )

  if (!response.ok) {
    const error = await response.json()
    throw new Error(
      `Google STT Error: ${error.error?.message || response.statusText}`
    )
  }

  const data = await response.json()
  return (
    data.results?.map((r: any) => r.alternatives?.[0]?.transcript).join(' ') ||
    ''
  )
}

export const transcribeWithGroq = async (
  audioBuffer: ArrayBuffer
): Promise<string> => {
  const groq = getGroqClient()
  const file = await toFile(audioBuffer, 'audio.wav', {
    type: 'audio/wav',
  })
  const transcription = await groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    response_format: 'json',
  })
  return transcription?.text || ''
}

export const transcribeWithBackend = async (
  audioBuffer: ArrayBuffer,
  language?: string
): Promise<string> => {
  try {
    const settingsStore = useSettingsStore()
    const selectedLanguage =
      language || settingsStore.config.localSttLanguage || 'auto'

    // Import the backend API
    const { backendApi } = await import('./backendApi')

    // Check if Go backend is ready
    const isHealthy = await backendApi.isHealthy()
    if (!isHealthy) {
      throw new Error('Go backend not available - server not running')
    }

    const sttReady = await backendApi.isSTTReady()
    if (!sttReady) {
      throw new Error(
        'Go STT service not ready - AI dependencies may not be installed'
      )
    }

    // Parse WAV file to extract raw PCM audio data
    const audioData = parseWavToFloat32Array(audioBuffer)

    // Filter out null/NaN values and ensure valid number range
    const cleanedAudioData = Array.from(audioData).filter(
      value =>
        value !== null &&
        value !== undefined &&
        !isNaN(value) &&
        isFinite(value) &&
        Math.abs(value) <= 1.5 // Allow slight headroom beyond -1.0 to 1.0 range
    )

    if (cleanedAudioData.length === 0) {
      throw new Error('Audio data contains no valid samples')
    }

    // Skip very short audio clips
    if (cleanedAudioData.length / 16000 < 0.5) {
      throw new Error('Audio clip too short for reliable transcription')
    }

    const audioDataFloat32 = new Float32Array(cleanedAudioData)
    const result = await backendApi.transcribeAudio(
      audioDataFloat32,
      16000,
      selectedLanguage === 'auto' ? undefined : selectedLanguage
    )

    return result.text
  } catch (error: any) {
    throw error
  }
}

export const transcribeWithOpenAI = async (
  audioBuffer: ArrayBuffer
): Promise<string> => {
  const openai = getOpenAIClient()
  const file = await toFile(audioBuffer, 'audio.wav', {
    type: 'audio/wav',
  })
  const settings = useSettingsStore().config
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: settings.openaiSttModel?.trim() || 'gpt-4o-transcribe',
    response_format: 'json',
  })
  return transcription?.text || ''
}

export const transcribeWithDoubao = async (
  audioBuffer: ArrayBuffer
): Promise<string> => {
  const settings = useSettingsStore().config
  const model = settings.doubaoSttModel?.trim()
  if (!model) {
    throw new Error(
      'Doubao STT model ID is not configured. Set "Doubao STT Model ID" in Settings (e.g. an Ark endpoint ID like ep-xxx or a model name).'
    )
  }
  const doubao = getDoubaoClient()
  const file = await toFile(audioBuffer, 'audio.wav', {
    type: 'audio/wav',
  })
  const transcription = await doubao.audio.transcriptions.create({
    file,
    model,
    response_format: 'json',
  })
  return transcription?.text || ''
}

export const transcribeWithQwen = async (
  audioBuffer: ArrayBuffer
): Promise<string> => {
  const settings = useSettingsStore().config
  const model = settings.qwenSttModel?.trim() || 'qwen3-asr-flash'
  const qwen = getQwenClient()
  const file = await toFile(audioBuffer, 'audio.wav', {
    type: 'audio/wav',
  })
  const transcription = await qwen.audio.transcriptions.create({
    file,
    model,
    response_format: 'json',
  })
  return transcription?.text || ''
}

function extractTextForEmbedding(textInput: any): string {
  if (typeof textInput === 'string') {
    return textInput
  }
  if (textInput && typeof textInput.content === 'string') {
    return textInput.content
  }
  if (textInput && Array.isArray(textInput.content)) {
    const contentArray = textInput.content as AppChatMessageContentPart[]
    const textParts = contentArray
      .filter(item => item.type === 'app_text')
      .map(item => item.text || '')
    return textParts.join(' ')
  }
  return ''
}

async function generateLocalEmbedding(
  textToEmbed: string,
  inputType: EmbeddingInputType = 'query'
): Promise<number[]> {
  const { backendApi } = await import('./backendApi')
  const embeddingsReady = await backendApi.isEmbeddingsReady()
  if (!embeddingsReady) {
    return []
  }
  return await backendApi.generateEmbedding(textToEmbed, inputType)
}

export const createLocalEmbedding = async (
  textInput: any,
  inputType: EmbeddingInputType = 'query'
): Promise<number[]> => {
  const textToEmbed = extractTextForEmbedding(textInput)
  if (!textToEmbed.trim()) return []
  try {
    return await generateLocalEmbedding(textToEmbed, inputType)
  } catch (error) {
    return []
  }
}

export const createEmbedding = async (
  textInput: any,
  inputType: EmbeddingInputType = 'query'
): Promise<number[]> => {
  const settings = useSettingsStore().config
  const textToEmbed = extractTextForEmbedding(textInput)

  if (!textToEmbed.trim()) return []

  if (settings.embeddingProvider === 'doubao') {
    return await doubaoEmbedding(textToEmbed)
  }
  if (settings.embeddingProvider === 'qwen') {
    return await qwenEmbedding(textToEmbed)
  }

  const hasOpenAIKey = !!settings.VITE_OPENAI_API_KEY?.trim()
  const shouldPreferLocal =
    settings.embeddingProvider === 'local' ||
    (!hasOpenAIKey && settings.aiProvider !== 'openai')

  if (shouldPreferLocal) {
    try {
      const embedding = await generateLocalEmbedding(textToEmbed, inputType)
      if (embedding && embedding.length > 0) {
        return embedding
      }
      return hasOpenAIKey ? fallbackToOpenAIEmbedding(textToEmbed) : []
    } catch (error) {
      return hasOpenAIKey ? fallbackToOpenAIEmbedding(textToEmbed) : []
    }
  }

  if (!hasOpenAIKey) {
    try {
      return await generateLocalEmbedding(textToEmbed, inputType)
    } catch (error) {
      return []
    }
  }

  return fallbackToOpenAIEmbedding(textToEmbed)
}

export const createDualEmbeddings = async (
  textInput: any
): Promise<{ openai?: number[]; local?: number[]; doubao?: number[] }> => {
  const settings = useSettingsStore().config
  const textToEmbed = extractTextForEmbedding(textInput)

  if (!textToEmbed.trim()) return {}

  const hasOpenAIKey = !!settings.VITE_OPENAI_API_KEY?.trim()
  const results: { openai?: number[]; local?: number[]; doubao?: number[] } = {}

  try {
    const localEmbedding = await generateLocalEmbedding(textToEmbed, 'passage')
    if (localEmbedding && localEmbedding.length > 0) {
      results.local = localEmbedding
    }
  } catch (error) {
    // Ignore local embedding failures.
  }

  if (hasOpenAIKey) {
    try {
      const openaiEmbedding = await fallbackToOpenAIEmbedding(textToEmbed)
      if (openaiEmbedding && openaiEmbedding.length > 0) {
        results.openai = openaiEmbedding
      }
    } catch (error) {
      // Ignore OpenAI embedding failures.
    }
  }

  // When Doubao is the selected embedding provider, also generate a
  // doubao-embedding-large (4096-dim) vector so long-term memories can be
  // recalled semantically with the same provider.
  if (settings.embeddingProvider === 'doubao') {
    try {
      const doubaoVector = await doubaoEmbedding(textToEmbed)
      if (doubaoVector && doubaoVector.length > 0) {
        results.doubao = doubaoVector
      }
    } catch (error) {
      // Ignore doubao embedding failures.
    }
  }

  return results
}

const fallbackToOpenAIEmbedding = async (
  textToEmbed: string
): Promise<number[]> => {
  const settings = useSettingsStore().config
  const openai = getOpenAIClient()
  const response = await openai.embeddings.create({
    model: settings.openaiEmbeddingModel?.trim() || 'text-embedding-ada-002',
    input: textToEmbed,
    encoding_format: 'float',
  })
  return response.data[0]?.embedding || []
}

// Doubao embedding-large outputs a native 4096-dim vector and does not
// support the "dimensions" parameter, so it gets its own 4096-dim bucket in
// the Electron main process. Qwen text-embedding-v4 supports "dimensions" and
// is requested at 1536 so it can share the OpenAI-sized bucket.
const doubaoEmbedding = async (textToEmbed: string): Promise<number[]> => {
  const settings = useSettingsStore().config
  const model = settings.doubaoEmbeddingModel?.trim()
  if (!model) {
    throw new Error(
      'Doubao embedding model ID is not configured. Set "Doubao Embedding Model ID" in Settings.'
    )
  }
  const doubao = getDoubaoClient()
  const response = await doubao.embeddings.create({
    model,
    input: textToEmbed,
    encoding_format: 'float',
  } as any)
  return (response.data[0]?.embedding as number[]) || []
}

const qwenEmbedding = async (textToEmbed: string): Promise<number[]> => {
  const settings = useSettingsStore().config
  const model = settings.qwenEmbeddingModel?.trim() || 'text-embedding-v4'
  const qwen = getQwenClient()
  const response = await qwen.embeddings.create({
    model,
    input: textToEmbed,
    dimensions: 1536,
    encoding_format: 'float',
  } as any)
  return (response.data[0]?.embedding as number[]) || []
}

export const indexMessageForThoughts = async (
  conversationId: string,
  role: string,
  message: any
): Promise<void> => {
  const embedding = await createEmbedding(message, 'passage')
  if (embedding.length === 0) return

  let textContentForMetadata = 'No textual content'
  if (message.content && Array.isArray(message.content)) {
    const firstTextPart = message.content.find(
      (item: any) => item.type === 'app_text'
    )
    if (firstTextPart) {
      textContentForMetadata = firstTextPart.text || ''
    }
  } else if (typeof message.content === 'string') {
    textContentForMetadata = message.content
  }

  await window.aliceIPC.invoke('thoughtVector:add', {
    conversationId,
    role,
    textContent: textContentForMetadata,
    embedding,
  })
}

export type RetrievedThought =
  | string
  | {
      role?: string
      textContent?: string
    }

export const retrieveRelevantThoughtsForPrompt = async (
  content: string,
  topK = 3
): Promise<RetrievedThought[]> => {
  if (!content.trim()) return []
  const queryEmbedding = await createEmbedding(content)
  if (queryEmbedding.length === 0) return []

  const ipcResult = await window.aliceIPC.invoke('thoughtVector:search', {
    queryEmbedding,
    topK,
  })
  if (!ipcResult.success || !Array.isArray(ipcResult.data)) {
    return []
  }
  return ipcResult.data
}

export const retrieveRelevantDocumentsForPrompt = async (
  content: string,
  topK = 5
): Promise<RagSearchResult[]> => {
  if (!content.trim()) return []

  const queryEmbedding = await createLocalEmbedding(content)

  const ipcResult = await window.aliceIPC.invoke('rag:search', {
    queryEmbedding,
    queryText: content,
    topK,
  })
  if (!ipcResult.success || !Array.isArray(ipcResult.data)) {
    return []
  }
  return ipcResult.data
}

export const createSummarizationResponse = async (
  messagesToSummarize: { role: string; content: string }[],
  summarizationModel: string,
  systemPrompt: string
): Promise<string | null> => {
  const settings = useSettingsStore().config
  const combinedText = messagesToSummarize
    .map(msg => `${msg.role}: ${msg.content}`)
    .join('\n\n')

  if (settings.aiProvider === 'codex') {
    return createCodexTextResponse(
      combinedText,
      summarizationModel,
      systemPrompt
    )
  }

  const client = getAIClient()

  if (isChatCompletionsProvider(settings.aiProvider)) {
    const params = {
      model: getSafeProviderModel(settings.aiProvider, summarizationModel),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: combinedText },
      ],
      stream: false,
    } as any
    const response = await createChatCompletionForProvider(
      settings.aiProvider,
      () => client,
      params
    )

    const content = response.choices[0]?.message?.content?.trim()
    return content ? stripReasoningFromMiniMaxContent(content) : null
  } else {
    const response = await client.responses.create({
      model: summarizationModel,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: combinedText }] },
      ],
      instructions: systemPrompt,
      ...(summarizationModel.startsWith('gpt-5')
        ? {
            reasoning: {
              effort: summarizationModel.startsWith('gpt-5.6')
                ? 'none'
                : 'minimal',
            },
            text: {
              verbosity: 'low',
            },
          }
        : {}),
      stream: false,
      store: false,
    } as any)

    const outputItem = response.output?.[0] as any
    const textPart = outputItem?.content?.[0]
    if (textPart?.type === 'output_text') {
      return textPart.text.trim()
    }
    return null
  }
}

export const createContextAnalysisResponse = async (
  messagesToAnalyze: { role: string; content: string }[],
  analysisModel: string
): Promise<string | null> => {
  const settings = useSettingsStore().config
  const analysisSystemPrompt = `You are an expert in emotional intelligence. Analyze the tone and emotional state of the 'user' in the following conversation transcript. Provide a single, concise sentence describing their likely emotional state. Do not add any extra commentary.`
  const combinedText = messagesToAnalyze
    .map(msg => `${msg.role}: ${msg.content}`)
    .join('\n\n')

  if (settings.aiProvider === 'codex') {
    const content = await createCodexTextResponse(
      combinedText,
      analysisModel,
      analysisSystemPrompt
    )
    return content ? content.replace(/"/g, '') : null
  }

  const client = getAIClient()

  if (isChatCompletionsProvider(settings.aiProvider)) {
    const params = {
      model: getSafeProviderModel(settings.aiProvider, analysisModel),
      messages: [
        { role: 'system', content: analysisSystemPrompt },
        { role: 'user', content: combinedText },
      ],
      stream: false,
    } as any
    const response = await createChatCompletionForProvider(
      settings.aiProvider,
      () => client,
      params
    )

    const content = response.choices[0]?.message?.content?.trim()
    return content
      ? stripReasoningFromMiniMaxContent(content).replace(/"/g, '')
      : null
  } else {
    const response = await client.responses.create({
      model: analysisModel,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: combinedText }] },
      ],
      instructions: analysisSystemPrompt,
      ...(analysisModel.startsWith('gpt-5')
        ? {
            reasoning: {
              effort: analysisModel.startsWith('gpt-5.6') ? 'none' : 'minimal',
            },
            text: {
              verbosity: 'low',
            },
          }
        : {}),
      stream: false,
      store: false,
    } as any)

    const outputItem = response.output?.[0] as any
    const textPart = outputItem?.content?.[0]
    if (textPart?.type === 'output_text') {
      return textPart.text.trim().replace(/"/g, '')
    }
    return null
  }
}

export const uploadFileToOpenAI = async (
  file: File
): Promise<string | null> => {
  const settings = useSettingsStore().config

  if (settings.aiProvider !== 'openai') {
    console.error('File upload is only supported with OpenAI provider')
    return null
  }

  try {
    const supportedTypes = [
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]
    if (!supportedTypes.includes(file.type)) {
      console.error(
        `Unsupported file type: ${file.type}. Supported types: ${supportedTypes.join(', ')}`
      )
      return null
    }

    const maxSize = 32 * 1024 * 1024
    if (file.size > maxSize) {
      console.error(
        `File too large: ${file.size} bytes. Maximum allowed: ${maxSize} bytes (32MB)`
      )
      return null
    }

    const openai = getOpenAIClient()
    const fileUpload = await openai.files.create({
      file: file,
      purpose: 'user_data',
    })

    console.log(
      `File uploaded successfully: ${fileUpload.id} (${file.name}, ${file.type})`
    )
    return fileUpload.id
  } catch (error) {
    console.error('Error uploading file to OpenAI:', error)
    if (error instanceof Error && error.message.includes('purpose')) {
      try {
        console.log('Retrying with assistants purpose...')
        const openai = getOpenAIClient()
        const fileUpload = await openai.files.create({
          file: file,
          purpose: 'assistants',
        })
        console.log(
          `File uploaded successfully with assistants purpose: ${fileUpload.id}`
        )
        return fileUpload.id
      } catch (fallbackError) {
        console.error('Fallback upload also failed:', fallbackError)
        return null
      }
    }
    return null
  }
}
