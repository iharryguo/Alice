import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useConversationStore } from './conversationStore'
import { useGeneralStore } from './generalStore'
import {
  DOUBAO_OPENAI_BASE_URL,
  QWEN_OPENAI_BASE_URL,
  reinitializeClients,
} from '../services/apiClients'
import { DEFAULT_PERSONA_PROMPT } from '../prompts/defaultPersonaPrompt'
import { PERSONAS } from '../prompts/personas'
import {
  DEEPSEEK_OPENAI_BASE_URL,
  MINIMAX_OPENAI_BASE_URL,
  PROVIDER_CONFIGS,
  ZAI_CODING_BASE_URL,
  getProviderDisplayName,
  getSafeProviderModel,
  type AIProviderKey,
} from '../services/llmProviders/providerCatalog'

export const DEFAULT_ASSISTANT_PERSONA_PROMPT = DEFAULT_PERSONA_PROMPT

const DEFAULT_SUMMARIZATION_SYSTEM_PROMPT = `You are an expert conversation summarizer.
Your task is to create a **concise and brief** factual summary of the following conversation segment.
Focus on:
- Key topics discussed.
- Important information, facts, or preferences shared by the user or assistant.
- Decisions made.
- Any unresolved questions or outstanding tasks.

The summary should help provide context for future interactions, allowing the conversation to resume naturally.
**Keep the summary to 2-4 sentences and definitely no more than 150 words.**
Do not add any conversational fluff, commentary, or an introductory/concluding sentence like "Here is the summary:". Just provide the factual summary of the conversation transcript.`

export interface AliceSettings {
  VITE_OPENAI_API_KEY: string
  VITE_OPENROUTER_API_KEY: string
  VITE_ZAI_API_KEY: string
  VITE_MINIMAX_API_KEY: string
  VITE_DEEPSEEK_API_KEY: string
  VITE_API_ROUTE_API_KEY: string
  VITE_GROQ_API_KEY: string
  VITE_GOOGLE_API_KEY: string
  VITE_DOUBAO_API_KEY: string
  VITE_QWEN_API_KEY: string
  sttProvider:
    'openai' | 'groq' | 'google' | 'doubao' | 'qwen' | 'volcengine' | 'local'
  aiProvider: AIProviderKey

  // Local Go Backend STT settings
  localSttModel: string
  localSttLanguage: string
  localSttEnabled: boolean
  localSttWakeWord: string
  /** 没叫人格名时的兜底静默：这么久没有新声音就把累积的内容发出去，毫秒；默认 10 秒 */
  voiceSilenceMs: number
  /** 叫了人格名之后，停顿多久算说完，毫秒；默认 2000，太短会把一句话拦腰截断 */
  voiceNamePauseMs: number
  /** 是否启用"按人格名结束说话"；关掉即退回旧的收句行为（回滚开关） */
  voiceNameTurnGateEnabled: boolean

  ollamaBaseUrl: string
  lmStudioBaseUrl: string
  zaiBaseUrl: string
  minimaxBaseUrl: string
  deepseekBaseUrl: string
  doubaoBaseUrl: string
  qwenBaseUrl: string
  doubaoSttModel: string
  qwenSttModel: string
  doubaoTtsModel: string
  qwenTtsModel: string
  doubaoTtsVoice: string
  qwenTtsVoice: string
  doubaoEmbeddingModel: string
  qwenEmbeddingModel: string
  openaiSttModel: string
  openaiTtsModel: string
  openaiEmbeddingModel: string
  codexAuthConnected: boolean
  codexAccountLabel: string

  assistantModel: string
  assistantSystemPrompt: string
  /** 当前身份 id：alice / felix … */
  assistantPersonaId: string
  assistantTemperature: number
  assistantTopP: number
  assistantReasoningEffort: 'minimal' | 'low' | 'medium' | 'high'
  assistantVerbosity: 'low' | 'medium' | 'high'
  assistantTools: string[]
  assistantAvatar: string
  mcpServersConfig?: string
  MAX_HISTORY_MESSAGES_FOR_API: number
  SUMMARIZATION_MESSAGE_COUNT: number
  SUMMARIZATION_MODEL: string
  SUMMARIZATION_SYSTEM_PROMPT: string
  /** 是否在对话收尾时自动整理长期记忆 */
  memoryAutoExtract: boolean
  /** 记忆整理用的模型；留空则跟随对话模型 */
  memoryExtractModel: string
  ttsProvider: 'openai' | 'google' | 'doubao' | 'qwen' | 'volcengine' | 'local'
  ttsVoice:
    | 'alloy'
    | 'ash'
    | 'ballad'
    | 'coral'
    | 'echo'
    | 'fable'
    | 'nova'
    | 'onyx'
    | 'sage'
    | 'shimmer'
    | 'verse'
    | 'marin'
    | 'cedar'
  googleTtsVoice: string
  localTtsVoice: string
  /** 语音识别专用凭据（与合成、嵌入互不影响） */
  sttOpenaiApiKey?: string
  sttGroqApiKey?: string
  sttGoogleApiKey?: string
  sttDoubaoApiKey?: string
  sttDoubaoBaseUrl?: string
  sttQwenApiKey?: string
  sttQwenBaseUrl?: string
  sttVolcengineApiKey?: string
  /** 语音合成专用凭据 */
  ttsOpenaiApiKey?: string
  ttsGoogleApiKey?: string
  ttsDoubaoApiKey?: string
  ttsDoubaoBaseUrl?: string
  ttsQwenApiKey?: string
  ttsQwenBaseUrl?: string
  ttsVolcengineApiKey?: string
  /** 向量嵌入专用凭据 */
  embeddingOpenaiApiKey?: string
  embeddingDoubaoApiKey?: string
  embeddingDoubaoBaseUrl?: string
  embeddingQwenApiKey?: string
  embeddingQwenBaseUrl?: string
  /** 火山引擎语音合成 */
  VOLCENGINE_TTS_API_KEY?: string
  volcengineTtsResourceId?: string
  volcengineTtsSpeaker?: string
  volcengineTtsEmotion?: string
  volcengineTtsSpeechRate?: number
  volcengineAsrResourceId?: string
  volcengineAsrLanguage?: string
  embeddingProvider: 'openai' | 'doubao' | 'qwen' | 'local'
  ragEnabled: boolean
  ragPaths: string[]
  ragTopK: number
  ragMaxContextChars: number

  microphoneToggleHotkey: string
  mutePlaybackHotkey: string
  takeScreenshotHotkey: string

  alwaysOnTop: boolean

  VITE_JACKETT_API_KEY: string
  VITE_JACKETT_URL: string
  VITE_QB_URL: string
  VITE_QB_USERNAME: string
  VITE_QB_PASSWORD: string

  VITE_TAVILY_API_KEY: string

  VITE_SEARXNG_URL: string
  VITE_SEARXNG_API_KEY: string

  websocketPort: number

  approvedCommands: string[]
  onboardingCompleted: boolean
}

function hasMinimumConfigForOnboarding(config: AliceSettings): boolean {
  if (config.VITE_OPENAI_API_KEY?.trim()) {
    return true
  }
  if (config.VITE_OPENROUTER_API_KEY?.trim()) {
    return true
  }
  if (config.VITE_ZAI_API_KEY?.trim()) {
    return true
  }
  if (config.VITE_MINIMAX_API_KEY?.trim()) {
    return true
  }
  if (config.VITE_DEEPSEEK_API_KEY?.trim()) {
    return true
  }
  if (config.VITE_API_ROUTE_API_KEY?.trim()) {
    return true
  }
  if (config.VITE_DOUBAO_API_KEY?.trim()) {
    return true
  }
  if (config.VITE_QWEN_API_KEY?.trim()) {
    return true
  }
  if (config.codexAuthConnected) {
    return true
  }

  if (config.aiProvider === 'ollama') {
    return Boolean(config.ollamaBaseUrl?.trim())
  }
  if (config.aiProvider === 'lm-studio') {
    return Boolean(config.lmStudioBaseUrl?.trim())
  }

  return false
}

const defaultSettings: AliceSettings = {
  VITE_OPENAI_API_KEY: '',
  VITE_OPENROUTER_API_KEY: '',
  VITE_ZAI_API_KEY: '',
  VITE_MINIMAX_API_KEY: '',
  VITE_DEEPSEEK_API_KEY: '',
  VITE_API_ROUTE_API_KEY: '',
  VITE_GROQ_API_KEY: '',
  VITE_GOOGLE_API_KEY: '',
  VITE_DOUBAO_API_KEY: '',
  VITE_QWEN_API_KEY: '',
  sttProvider: 'openai',
  aiProvider: 'openai',

  localSttModel: 'whisper-base',
  localSttLanguage: 'auto',
  localSttEnabled: false,
  localSttWakeWord: 'alice',
  voiceSilenceMs: 10000,
  voiceNamePauseMs: 2000,
  voiceNameTurnGateEnabled: true,

  ollamaBaseUrl: 'http://localhost:11434',
  lmStudioBaseUrl: 'http://localhost:1234',
  zaiBaseUrl: ZAI_CODING_BASE_URL,
  minimaxBaseUrl: MINIMAX_OPENAI_BASE_URL,
  deepseekBaseUrl: DEEPSEEK_OPENAI_BASE_URL,
  doubaoBaseUrl: DOUBAO_OPENAI_BASE_URL,
  qwenBaseUrl: QWEN_OPENAI_BASE_URL,
  doubaoSttModel: '',
  qwenSttModel: 'qwen3-asr-flash',
  doubaoTtsModel: '',
  qwenTtsModel: 'qwen-tts-latest',
  doubaoTtsVoice: 'zh_female_cancan_mars_bigtts',
  qwenTtsVoice: 'Cherry',
  doubaoEmbeddingModel: 'doubao-embedding-vision-251215',
  qwenEmbeddingModel: 'text-embedding-v4',
  openaiSttModel: 'gpt-4o-transcribe',
  openaiTtsModel: 'gpt-4o-mini-tts',
  openaiEmbeddingModel: 'text-embedding-ada-002',
  codexAuthConnected: false,
  codexAccountLabel: '',

  assistantModel: 'gpt-4.1-mini',
  assistantSystemPrompt: '',
  assistantPersonaId: 'alice',
  assistantTemperature: 0.7,
  assistantTopP: 1.0,
  assistantReasoningEffort: 'medium',
  assistantVerbosity: 'medium',
  assistantTools: [
    'get_current_datetime',
    'perform_web_search',
    'take_screenshot',
    'save_memory',
    'delete_memory',
    'recall_memories',
    'remember_self_fact',
  ],
  assistantAvatar: 'alice',
  mcpServersConfig: '[]',
  MAX_HISTORY_MESSAGES_FOR_API: 10,
  SUMMARIZATION_MESSAGE_COUNT: 20,
  SUMMARIZATION_MODEL: 'gpt-5.6-luna',
  SUMMARIZATION_SYSTEM_PROMPT: DEFAULT_SUMMARIZATION_SYSTEM_PROMPT,
  memoryAutoExtract: true,
  memoryExtractModel: '',
  ttsProvider: 'openai',
  ttsVoice: 'nova',
  googleTtsVoice: 'en-US-Journey-F',
  localTtsVoice: 'en_US-amy-medium',
  sttOpenaiApiKey: '',
  sttGroqApiKey: '',
  sttGoogleApiKey: '',
  sttDoubaoApiKey: '',
  sttDoubaoBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  sttQwenApiKey: '',
  sttQwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  sttVolcengineApiKey: '',
  ttsOpenaiApiKey: '',
  ttsGoogleApiKey: '',
  ttsDoubaoApiKey: '',
  ttsDoubaoBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  ttsQwenApiKey: '',
  ttsQwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  ttsVolcengineApiKey: '',
  embeddingOpenaiApiKey: '',
  embeddingDoubaoApiKey: '',
  embeddingDoubaoBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  embeddingQwenApiKey: '',
  embeddingQwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  VOLCENGINE_TTS_API_KEY: '',
  volcengineTtsResourceId: 'seed-tts-2.0',
  volcengineTtsSpeaker: 'en_female_dacey_uranus_bigtts',
  volcengineTtsEmotion:
    '用情绪饱满、语气强烈的语气朗读：开心时明亮上扬，难过时低沉，愤怒时有力。',
  volcengineTtsSpeechRate: 0,
  volcengineAsrResourceId: 'volc.seedasr.auc',
  volcengineAsrLanguage: '',
  embeddingProvider: 'openai',
  ragEnabled: false,
  ragPaths: [],
  ragTopK: 5,
  ragMaxContextChars: 1500,

  microphoneToggleHotkey: 'Alt+M',
  mutePlaybackHotkey: 'Alt+S',
  takeScreenshotHotkey: 'Alt+C',

  alwaysOnTop: false,

  VITE_JACKETT_API_KEY: '',
  VITE_JACKETT_URL: '',
  VITE_QB_URL: '',
  VITE_QB_USERNAME: '',
  VITE_QB_PASSWORD: '',

  VITE_TAVILY_API_KEY: '',

  VITE_SEARXNG_URL: '',
  VITE_SEARXNG_API_KEY: '',

  websocketPort: 5421,

  approvedCommands: ['ls', 'dir'],
  onboardingCompleted: false,
}

const settingKeyToLabelMap: Record<keyof AliceSettings, string> = {
  VITE_OPENAI_API_KEY: 'OpenAI API Key',
  VITE_OPENROUTER_API_KEY: 'OpenRouter API Key',
  VITE_ZAI_API_KEY: 'Z.ai API Key',
  VITE_MINIMAX_API_KEY: 'MiniMax API Key',
  VITE_DEEPSEEK_API_KEY: 'DeepSeek API Key',
  VITE_API_ROUTE_API_KEY: 'API Route API Key',
  VITE_GROQ_API_KEY: 'Groq API Key (STT)',
  VITE_GOOGLE_API_KEY: 'Google API Key',
  VITE_DOUBAO_API_KEY: 'Doubao (Volcengine Ark) API Key',
  VITE_QWEN_API_KEY: 'Qwen (Alibaba DashScope) API Key',
  sttProvider: 'Speech-to-Text Provider',
  aiProvider: 'AI Provider',

  // Local Go Backend STT labels
  localSttModel: 'Local STT Model',
  localSttLanguage: 'Language',
  localSttEnabled: 'Enable Wake Word',
  localSttWakeWord: 'Wake Word',
  voiceSilenceMs: 'Fallback Silence When No Name (ms)',
  voiceNamePauseMs: 'Name Pause (ms)',
  voiceNameTurnGateEnabled: 'Name-gated Turn End',

  ollamaBaseUrl: 'Ollama Base URL',
  lmStudioBaseUrl: 'LM Studio Base URL',
  zaiBaseUrl: 'Z.ai Base URL',
  minimaxBaseUrl: 'MiniMax Base URL',
  deepseekBaseUrl: 'DeepSeek Base URL',
  doubaoBaseUrl: 'Doubao Base URL',
  qwenBaseUrl: 'Qwen Base URL',
  doubaoSttModel: 'Doubao STT Model ID',
  qwenSttModel: 'Qwen STT Model',
  doubaoTtsModel: 'Doubao TTS Model ID',
  qwenTtsModel: 'Qwen TTS Model',
  doubaoTtsVoice: 'Doubao TTS Voice',
  qwenTtsVoice: 'Qwen TTS Voice',
  doubaoEmbeddingModel: 'Doubao Embedding Model ID',
  qwenEmbeddingModel: 'Qwen Embedding Model',
  openaiSttModel: 'OpenAI STT Model',
  openaiTtsModel: 'OpenAI TTS Model',
  openaiEmbeddingModel: 'OpenAI Embedding Model',
  codexAuthConnected: 'ChatGPT Codex authorization',
  codexAccountLabel: 'ChatGPT Codex account',

  assistantModel: 'Assistant Model',
  assistantSystemPrompt: 'Additional Persona Notes',
  assistantPersonaId: 'Assistant Persona',
  assistantTemperature: 'Assistant Temperature',
  assistantTopP: 'Assistant Top P',
  assistantReasoningEffort: 'Reasoning Effort',
  assistantVerbosity: 'Response Verbosity',
  assistantTools: 'Enabled Assistant Tools',
  assistantAvatar: 'Assistant Avatar',
  MAX_HISTORY_MESSAGES_FOR_API: 'Max History Messages for API',
  SUMMARIZATION_MESSAGE_COUNT: 'Summarization Message Count',
  SUMMARIZATION_MODEL: 'Summarization Model',
  SUMMARIZATION_SYSTEM_PROMPT: 'Summarization System Prompt',
  memoryAutoExtract: 'Auto-extract Long-term Memory',
  memoryExtractModel: 'Memory Extraction Model',
  ttsProvider: 'Text-to-Speech Provider',
  ttsVoice: 'OpenAI TTS Voice',
  googleTtsVoice: 'Google TTS Voice',
  localTtsVoice: 'Local TTS Voice',
  sttOpenaiApiKey: '语音识别 · OpenAI API Key',
  sttGroqApiKey: '语音识别 · Groq API Key',
  sttGoogleApiKey: '语音识别 · Google API Key',
  sttDoubaoApiKey: '语音识别 · 豆包 API Key',
  sttDoubaoBaseUrl: '语音识别 · 豆包 Base URL',
  sttQwenApiKey: '语音识别 · 通义 API Key',
  sttQwenBaseUrl: '语音识别 · 通义 Base URL',
  sttVolcengineApiKey: '语音识别 · 火山引擎 API Key',
  ttsOpenaiApiKey: '语音合成 · OpenAI API Key',
  ttsGoogleApiKey: '语音合成 · Google API Key',
  ttsDoubaoApiKey: '语音合成 · 豆包 API Key',
  ttsDoubaoBaseUrl: '语音合成 · 豆包 Base URL',
  ttsQwenApiKey: '语音合成 · 通义 API Key',
  ttsQwenBaseUrl: '语音合成 · 通义 Base URL',
  ttsVolcengineApiKey: '语音合成 · 火山引擎 API Key',
  embeddingOpenaiApiKey: '向量嵌入 · OpenAI API Key',
  embeddingDoubaoApiKey: '向量嵌入 · 豆包 API Key',
  embeddingDoubaoBaseUrl: '向量嵌入 · 豆包 Base URL',
  embeddingQwenApiKey: '向量嵌入 · 通义 API Key',
  embeddingQwenBaseUrl: '向量嵌入 · 通义 Base URL',
  VOLCENGINE_TTS_API_KEY: '火山引擎 API Key',
  volcengineTtsResourceId: '火山引擎模型版本',
  volcengineTtsSpeaker: '火山引擎音色',
  volcengineTtsEmotion: '火山引擎语气指令',
  volcengineTtsSpeechRate: '火山引擎语速',
  volcengineAsrResourceId: '火山引擎识别模型版本',
  volcengineAsrLanguage: '火山引擎识别语种',
  embeddingProvider: 'Embedding Provider',
  ragEnabled: 'Local Documents (RAG) Enabled',
  ragPaths: 'Local Documents Paths',
  ragTopK: 'Local Documents Top K',
  ragMaxContextChars: 'Local Documents Max Context Chars',
  microphoneToggleHotkey: 'Microphone Toggle Hotkey',
  mutePlaybackHotkey: 'Mute Playback Hotkey',
  takeScreenshotHotkey: 'Take Screenshot Hotkey',

  alwaysOnTop: 'Window Always on Top',

  VITE_JACKETT_API_KEY: 'Jackett API Key (Torrents)',
  VITE_JACKETT_URL: 'Jackett URL (Torrents)',
  VITE_QB_URL: 'qBittorrent URL',
  VITE_QB_USERNAME: 'qBittorrent Username',
  VITE_QB_PASSWORD: 'qBittorrent Password',

  VITE_TAVILY_API_KEY: 'Tavily API Key (Web Search)',

  VITE_SEARXNG_URL: 'SearXNG Instance URL',
  VITE_SEARXNG_API_KEY: 'SearXNG API Key (optional)',

  websocketPort: 'WebSocket Port',
  mcpServersConfig: 'MCP Servers JSON Configuration',
  approvedCommands: 'Approved Commands',
  onboardingCompleted: 'Onboarding Completed',
}

const ESSENTIAL_CORE_API_KEYS: (keyof AliceSettings)[] = [
  'VITE_OPENAI_API_KEY',
  'VITE_OPENROUTER_API_KEY',
  'VITE_ZAI_API_KEY',
  'VITE_MINIMAX_API_KEY',
  'VITE_DEEPSEEK_API_KEY',
  'VITE_API_ROUTE_API_KEY',
]

function requiresOpenAIKey(config: AliceSettings): boolean {
  return config.aiProvider === 'openai'
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AliceSettings>({ ...defaultSettings })
  const isLoading = ref(false)
  const isSaving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)
  const initialLoadAttempted = ref(false)
  const coreOpenAISettingsValid = ref(false)
  const sessionApprovedCommands = ref<string[]>([])

  const validateAndFixSettings = (
    loadedSettings: Partial<AliceSettings>
  ): { settings: AliceSettings; migrated: boolean } => {
    const validated = { ...defaultSettings, ...loadedSettings }
    let migrated = false

    // 把旧的共享 Key 复制进各能力自己的字段：识别、合成、嵌入从此各存各的
    const splitKeys: Array<[keyof AliceSettings, Array<keyof AliceSettings>]> =
      [
        [
          'VITE_OPENAI_API_KEY',
          ['sttOpenaiApiKey', 'ttsOpenaiApiKey', 'embeddingOpenaiApiKey'],
        ],
        ['VITE_GROQ_API_KEY', ['sttGroqApiKey']],
        ['VITE_GOOGLE_API_KEY', ['sttGoogleApiKey', 'ttsGoogleApiKey']],
        [
          'VITE_DOUBAO_API_KEY',
          ['sttDoubaoApiKey', 'ttsDoubaoApiKey', 'embeddingDoubaoApiKey'],
        ],
        [
          'VITE_QWEN_API_KEY',
          ['sttQwenApiKey', 'ttsQwenApiKey', 'embeddingQwenApiKey'],
        ],
        [
          'VOLCENGINE_TTS_API_KEY',
          ['sttVolcengineApiKey', 'ttsVolcengineApiKey'],
        ],
      ]
    for (const [legacyKey, targets] of splitKeys) {
      const legacyValue = String(validated[legacyKey] ?? '').trim()
      if (!legacyValue) continue
      for (const target of targets) {
        if (!String(validated[target] ?? '').trim()) {
          ;(validated as Record<string, unknown>)[target as string] =
            legacyValue
          migrated = true
        }
      }
    }

    // Migration: 老配置里没有 take_screenshot（看屏幕），补一次；只补一次，
    // 之后用户手动关掉不会再被强行加回来。
    try {
      const toolsetMigrationKey = 'alice:toolset-migrated:v2'
      const alreadyMigrated =
        window.localStorage.getItem(toolsetMigrationKey) === '1'
      const toolList = Array.isArray(validated.assistantTools)
        ? validated.assistantTools
        : []
      if (!alreadyMigrated) {
        if (!toolList.includes('take_screenshot')) {
          validated.assistantTools = [...toolList, 'take_screenshot']
          migrated = true
          console.log('🖥️ 迁移设置：启用 take_screenshot 工具')
        }
        window.localStorage.setItem(toolsetMigrationKey, '1')
      }
    } catch (error) {
      console.warn('工具集迁移跳过（localStorage 不可用）:', error)
    }

    // Migration: 人设从"一整段提示词"改成"可切换的人格档案 + 补充设定"。
    // 老配置里的 assistantSystemPrompt 就是 Alice 的旧底稿，留着会和新档案重复；
    // 只有它恰好等于旧默认值时才清空，用户改过的内容一律保留成补充设定。
    try {
      const personaMigratedKey = 'alice:persona-arch:v1'
      const personaMigrated =
        window.localStorage.getItem(personaMigratedKey) === '1'
      if (!personaMigrated) {
        const tools = Array.isArray(validated.assistantTools)
          ? validated.assistantTools
          : []
        if (!tools.includes('remember_self_fact')) {
          validated.assistantTools = [...tools, 'remember_self_fact']
          migrated = true
        }
        if (
          String(validated.assistantSystemPrompt || '').trim() ===
          DEFAULT_PERSONA_PROMPT.trim()
        ) {
          validated.assistantSystemPrompt = ''
          migrated = true
        }
        window.localStorage.setItem(personaMigratedKey, '1')
      }
    } catch (error) {
      console.warn('人格迁移跳过（localStorage 不可用）:', error)
    }

    if (
      !PERSONAS.some(persona => persona.id === validated.assistantPersonaId)
    ) {
      validated.assistantPersonaId = 'alice'
      migrated = true
    }

    // Migration: Handle old 'transformers' provider
    if ((validated.sttProvider as any) === 'transformers') {
      console.log(
        '🔄 Migrating settings: Converting old "transformers" provider to "local" (Go backend)'
      )
      validated.sttProvider = 'local'
      migrated = true

      // Migrate old transformers settings to new local settings
      if ((loadedSettings as any).transformersModel) {
        validated.localSttModel = (loadedSettings as any).transformersModel
        console.log(`📝 Migrated STT model: ${validated.localSttModel}`)
      }
      if ((loadedSettings as any).transformersLanguage) {
        validated.localSttLanguage = (
          loadedSettings as any
        ).transformersLanguage
        console.log(`🌐 Migrated STT language: ${validated.localSttLanguage}`)
      }
      if ((loadedSettings as any).transformersWakeWordEnabled !== undefined) {
        validated.localSttEnabled = (
          loadedSettings as any
        ).transformersWakeWordEnabled
        console.log(`🎤 Migrated STT enabled: ${validated.localSttEnabled}`)
      }
      if ((loadedSettings as any).transformersWakeWord) {
        validated.localSttWakeWord = (
          loadedSettings as any
        ).transformersWakeWord
        console.log(`🎯 Migrated wake word: ${validated.localSttWakeWord}`)
      }
      console.log('✅ Settings migration completed successfully')
    }

    const validSTTProviders = ['doubao', 'qwen', 'volcengine', 'local'] as const
    if (!validSTTProviders.includes(validated.sttProvider as any)) {
      validated.sttProvider = 'volcengine'
      migrated = true
    }

    const validTTSProviders = ['doubao', 'qwen', 'volcengine', 'local'] as const
    if (!validTTSProviders.includes(validated.ttsProvider as any)) {
      validated.ttsProvider = 'volcengine'
      migrated = true
    }

    const validEmbeddingProviders = ['doubao', 'qwen', 'local'] as const
    if (!validEmbeddingProviders.includes(validated.embeddingProvider as any)) {
      validated.embeddingProvider = 'local'
      migrated = true
    }

    const validAIProviders = [
      'deepseek',
      'zai',
      'minimax',
      'ollama',
      'lm-studio',
    ] as const
    if (!validAIProviders.includes(validated.aiProvider as any)) {
      validated.aiProvider = 'deepseek'
      migrated = true
    }

    const safeAssistantModel = getSafeProviderModel(
      validated.aiProvider,
      validated.assistantModel
    )
    if (safeAssistantModel !== validated.assistantModel) {
      validated.assistantModel = safeAssistantModel
      migrated = true
    }

    const safeSummarizationModel = getSafeProviderModel(
      validated.aiProvider,
      validated.SUMMARIZATION_MODEL
    )
    if (safeSummarizationModel !== validated.SUMMARIZATION_MODEL) {
      validated.SUMMARIZATION_MODEL = safeSummarizationModel
      migrated = true
    }

    if (!Array.isArray(validated.ragPaths)) {
      validated.ragPaths = []
      migrated = true
    }

    // 收句时长：兜底静默不能小于 300ms，名字停顿不能小于 800ms，
    // 否则一句话会被切成碎片（旧配置里没有这两项时由默认值兜住）
    if (
      !Number.isFinite(validated.voiceSilenceMs) ||
      validated.voiceSilenceMs < 300
    ) {
      validated.voiceSilenceMs = defaultSettings.voiceSilenceMs
      migrated = true
    }

    if (
      !Number.isFinite(validated.voiceNamePauseMs) ||
      validated.voiceNamePauseMs < 800
    ) {
      validated.voiceNamePauseMs = defaultSettings.voiceNamePauseMs
      migrated = true
    }

    if (typeof validated.voiceNameTurnGateEnabled !== 'boolean') {
      validated.voiceNameTurnGateEnabled =
        defaultSettings.voiceNameTurnGateEnabled
      migrated = true
    }

    if (!Number.isFinite(validated.ragTopK) || validated.ragTopK < 1) {
      validated.ragTopK = defaultSettings.ragTopK
      migrated = true
    }

    if (
      !Number.isFinite(validated.ragMaxContextChars) ||
      validated.ragMaxContextChars < 300
    ) {
      validated.ragMaxContextChars = defaultSettings.ragMaxContextChars
      migrated = true
    }

    if (validated.sttProvider === 'local') {
      const validModelIds = [
        'whisper-tiny.en',
        'whisper-base',
        'whisper-small',
        'whisper-medium',
        'whisper-large',
      ]
      if (!validModelIds.includes(validated.localSttModel)) {
        validated.localSttModel = validModelIds[1] || 'whisper-base'
      }
    }

    return { settings: validated, migrated }
  }

  const isProduction = computed(() => import.meta.env.PROD)

  const areEssentialSettingsProvided = computed(() => {
    if (!isProduction.value) return true
    const essentialKeys: (keyof AliceSettings)[] = [
      'assistantModel',
      'SUMMARIZATION_MODEL',
    ]

    // API keys requirements based on provider
    if (settings.value.aiProvider === 'openai') {
      essentialKeys.push('VITE_OPENAI_API_KEY')
    } else if (settings.value.aiProvider === 'openrouter') {
      essentialKeys.push('VITE_OPENROUTER_API_KEY')
    } else if (settings.value.aiProvider === 'zai') {
      essentialKeys.push('VITE_ZAI_API_KEY', 'zaiBaseUrl')
    } else if (settings.value.aiProvider === 'minimax') {
      essentialKeys.push('VITE_MINIMAX_API_KEY', 'minimaxBaseUrl')
    } else if (settings.value.aiProvider === 'deepseek') {
      essentialKeys.push('VITE_DEEPSEEK_API_KEY', 'deepseekBaseUrl')
    } else if (settings.value.aiProvider === 'api-route') {
      essentialKeys.push('VITE_API_ROUTE_API_KEY')
    } else if (settings.value.aiProvider === 'codex') {
      essentialKeys.push('codexAuthConnected')
    } else if (settings.value.aiProvider === 'ollama') {
      essentialKeys.push('ollamaBaseUrl')
    } else if (settings.value.aiProvider === 'lm-studio') {
      essentialKeys.push('lmStudioBaseUrl')
    }

    if (requiresOpenAIKey(settings.value)) {
      essentialKeys.push('VITE_OPENAI_API_KEY')
    }

    if (settings.value.sttProvider === 'groq') {
      essentialKeys.push('VITE_GROQ_API_KEY')
    }

    if (
      settings.value.sttProvider === 'doubao' ||
      settings.value.ttsProvider === 'doubao' ||
      settings.value.embeddingProvider === 'doubao'
    ) {
      essentialKeys.push('VITE_DOUBAO_API_KEY')
    }

    if (
      settings.value.sttProvider === 'qwen' ||
      settings.value.ttsProvider === 'qwen' ||
      settings.value.embeddingProvider === 'qwen'
    ) {
      essentialKeys.push('VITE_QWEN_API_KEY')
    }

    if (
      settings.value.sttProvider === 'google' ||
      settings.value.ttsProvider === 'google'
    ) {
      essentialKeys.push('VITE_GOOGLE_API_KEY')
    }

    if (settings.value.sttProvider === 'local') {
      essentialKeys.push('localSttModel')
    }

    return essentialKeys.every(key => {
      const value = settings.value[key]
      if (typeof value === 'string') return !!value.trim()
      if (typeof value === 'number') return true
      if (Array.isArray(value)) return true
      return false
    })
  })

  const areCoreApiKeysSufficientForTesting = computed(() => {
    if (!isProduction.value) return true

    const needsOpenAI = requiresOpenAIKey(settings.value)

    if (needsOpenAI && !settings.value.VITE_OPENAI_API_KEY?.trim()) {
      return false
    }

    if (settings.value.aiProvider === 'openrouter') {
      return !!settings.value.VITE_OPENROUTER_API_KEY?.trim()
    }

    if (settings.value.aiProvider === 'zai') {
      return (
        !!settings.value.VITE_ZAI_API_KEY?.trim() &&
        !!settings.value.zaiBaseUrl?.trim()
      )
    }

    if (settings.value.aiProvider === 'minimax') {
      return (
        !!settings.value.VITE_MINIMAX_API_KEY?.trim() &&
        !!settings.value.minimaxBaseUrl?.trim()
      )
    }

    if (settings.value.aiProvider === 'deepseek') {
      return (
        !!settings.value.VITE_DEEPSEEK_API_KEY?.trim() &&
        !!settings.value.deepseekBaseUrl?.trim()
      )
    }

    if (settings.value.aiProvider === 'api-route') {
      return !!settings.value.VITE_API_ROUTE_API_KEY?.trim()
    }

    if (settings.value.aiProvider === 'ollama') {
      return !!settings.value.ollamaBaseUrl?.trim()
    }

    if (settings.value.aiProvider === 'lm-studio') {
      return !!settings.value.lmStudioBaseUrl?.trim()
    }

    if (settings.value.aiProvider === 'codex') {
      return settings.value.codexAuthConnected
    }

    return true
  })

  const config = computed<Readonly<AliceSettings>>(() => {
    if (isProduction.value) {
      return settings.value
    }

    const envOverrides = Object.fromEntries(
      Object.entries(import.meta.env)
        .filter(
          ([key]) =>
            key.startsWith('VITE_') ||
            key.startsWith('assistant') ||
            key === 'MAX_HISTORY_MESSAGES_FOR_API' ||
            key === 'SUMMARIZATION_MESSAGE_COUNT' ||
            key === 'SUMMARIZATION_MODEL' ||
            key === 'SUMMARIZATION_SYSTEM_PROMPT' ||
            key === 'sttProvider' ||
            key === 'aiProvider' ||
            key === 'onboardingCompleted'
        )
        .map(([key, value]) => {
          if (
            key === 'MAX_HISTORY_MESSAGES_FOR_API' ||
            key === 'SUMMARIZATION_MESSAGE_COUNT' ||
            key === 'assistantTemperature' ||
            key === 'assistantTopP' ||
            key === 'ragTopK' ||
            key === 'ragMaxContextChars'
          ) {
            return [key, parseFloat(String(value))]
          }
          if (key === 'assistantTools' && typeof value === 'string') {
            return [
              key,
              value
                .split(',')
                .map(t => t.trim())
                .filter(Boolean),
            ]
          }
          return [key, String(value)]
        })
    )

    return {
      ...defaultSettings,
      ...envOverrides,
      ...settings.value,
    }
  })

  async function loadSettings() {
    if (initialLoadAttempted.value) {
      return
    }

    initialLoadAttempted.value = true
    isLoading.value = true
    error.value = null
    successMessage.value = null
    coreOpenAISettingsValid.value = false
    try {
      if (isProduction.value) {
        const loaded = await window.settingsAPI.loadSettings()
        if (loaded) {
          const result = validateAndFixSettings(
            loaded as Partial<AliceSettings>
          )
          settings.value = result.settings
          await ensureOnboardingStateConsistency()

          let needsSave = false
          if (result.migrated) {
            needsSave = true
            console.log('💾 Automatically saving migrated settings to file')
          }

          if (
            !settings.value.onboardingCompleted &&
            settings.value.VITE_OPENAI_API_KEY?.trim()
          ) {
            settings.value.onboardingCompleted = true
            needsSave = true
          }

          if (needsSave) {
            await saveSettingsToFile()
          }
        } else {
          const result = validateAndFixSettings({})
          settings.value = result.settings
        }
      } else {
        let devCombinedSettings: AliceSettings = { ...defaultSettings }
        if (window.settingsAPI) {
          const loadedDevSettings = await window.settingsAPI.loadSettings()
          if (loadedDevSettings) {
            devCombinedSettings = {
              ...devCombinedSettings,
              ...(loadedDevSettings as Partial<AliceSettings>),
            }

            if (
              !devCombinedSettings.onboardingCompleted &&
              (loadedDevSettings as any).VITE_OPENAI_API_KEY?.trim()
            ) {
              devCombinedSettings.onboardingCompleted = true
            }
          }
        }
        for (const key of Object.keys(defaultSettings) as Array<
          keyof AliceSettings
        >) {
          if (key === 'onboardingCompleted') {
            continue
          }

          if (import.meta.env[key]) {
            const envValue = import.meta.env[key]
            if (
              key === 'assistantTemperature' ||
              key === 'assistantTopP' ||
              key === 'MAX_HISTORY_MESSAGES_FOR_API' ||
              key === 'SUMMARIZATION_MESSAGE_COUNT'
            ) {
              ;(devCombinedSettings as any)[key] = parseFloat(
                envValue as string
              )
            } else if (
              key === 'assistantTools' &&
              typeof envValue === 'string'
            ) {
              ;(devCombinedSettings as any)[key] = envValue
                .split(',')
                .map(t => t.trim())
                .filter(Boolean)
            } else {
              ;(devCombinedSettings as any)[key] = envValue
            }
          }
        }
        try {
          const result = validateAndFixSettings(devCombinedSettings)
          settings.value = result.settings

          if (result.migrated && window.settingsAPI) {
            console.log('💾 Automatically saving migrated dev settings to file')
            await saveSettingsToFile()
          }

          await ensureOnboardingStateConsistency()
        } catch (error) {
          console.error(
            '[SettingsStore] Settings validation failed, using unvalidated settings:',
            error
          )
          settings.value = devCombinedSettings as AliceSettings
        }
      }

      if (config.value.VITE_OPENAI_API_KEY) {
        try {
          const conversationStore = useConversationStore()
          await conversationStore.fetchModels()
          coreOpenAISettingsValid.value = true
        } catch (e: any) {
          console.warn(
            `[SettingsStore] Core OpenAI API key validation failed on load: ${e.message}`
          )
          coreOpenAISettingsValid.value = false
        }
      }
    } catch (e: any) {
      error.value = `Failed to load settings: ${e.message}`
      settings.value = { ...defaultSettings }
      coreOpenAISettingsValid.value = false
    } finally {
      isLoading.value = false
    }
  }

  async function ensureOnboardingStateConsistency() {
    if (settings.value.onboardingCompleted) {
      return
    }

    if (!hasMinimumConfigForOnboarding(settings.value)) {
      return
    }

    settings.value.onboardingCompleted = true
    try {
      await saveSettingsToFile()
    } catch (error) {
      console.warn(
        '[SettingsStore] Failed to persist onboarding completion state:',
        error
      )
    }
  }

  function updateSetting(
    key: keyof AliceSettings,
    value: string | boolean | number | string[]
  ) {
    if (
      key === 'assistantTemperature' ||
      key === 'assistantTopP' ||
      key === 'MAX_HISTORY_MESSAGES_FOR_API' ||
      key === 'SUMMARIZATION_MESSAGE_COUNT' ||
      key === 'websocketPort' ||
      key === 'ragTopK' ||
      key === 'ragMaxContextChars' ||
      key === 'voiceSilenceMs' ||
      key === 'voiceNamePauseMs'
    ) {
      ;(settings.value as any)[key] = Number(value)
    } else if (
      (key === 'assistantTools' || key === 'ragPaths') &&
      Array.isArray(value)
    ) {
      settings.value[key] = value as string[]
    } else {
      ;(settings.value as any)[key] = String(value)
    }
    if (key === 'sttProvider') {
      settings.value[key] = value as
        'openai' | 'groq' | 'google' | 'doubao' | 'qwen' | 'local'
    }
    if (key === 'aiProvider') {
      settings.value[key] = value as AIProviderKey
      if (settings.value.aiProvider === 'zai') {
        settings.value.assistantModel = PROVIDER_CONFIGS.zai.defaultModel
        settings.value.SUMMARIZATION_MODEL = PROVIDER_CONFIGS.zai.defaultModel
      } else if (settings.value.aiProvider === 'minimax') {
        settings.value.assistantModel = PROVIDER_CONFIGS.minimax.defaultModel
        settings.value.SUMMARIZATION_MODEL =
          PROVIDER_CONFIGS.minimax.defaultModel
      } else if (settings.value.aiProvider === 'deepseek') {
        settings.value.assistantModel = PROVIDER_CONFIGS.deepseek.defaultModel
        settings.value.SUMMARIZATION_MODEL =
          PROVIDER_CONFIGS.deepseek.defaultModel
      } else if (settings.value.aiProvider === 'api-route') {
        settings.value.assistantModel =
          PROVIDER_CONFIGS['api-route'].defaultModel
        settings.value.SUMMARIZATION_MODEL =
          PROVIDER_CONFIGS['api-route'].defaultModel
      } else if (settings.value.aiProvider === 'codex') {
        settings.value.assistantModel = PROVIDER_CONFIGS.codex.defaultModel
        settings.value.SUMMARIZATION_MODEL = PROVIDER_CONFIGS.codex.defaultModel
      }
    }
    if (key === 'assistantReasoningEffort') {
      settings.value[key] = value as 'minimal' | 'low' | 'medium' | 'high'
    }
    if (key === 'assistantVerbosity') {
      settings.value[key] = value as 'low' | 'medium' | 'high'
    }
    if (key === 'localSttModel') {
      settings.value[key] = value as string
    }
    if (key === 'localSttLanguage') {
      settings.value[key] = value as string
    }
    if (key === 'localSttEnabled') {
      settings.value[key] = value as boolean
    }
    if (key === 'voiceNameTurnGateEnabled') {
      settings.value[key] = value as boolean
    }
    if (key === 'alwaysOnTop') {
      settings.value[key] = value as boolean
    }
    if (key === 'ragEnabled') {
      settings.value[key] = value as boolean
    }
    if (key === 'ttsProvider') {
      settings.value[key] = value as
        'openai' | 'google' | 'doubao' | 'qwen' | 'local'
    }
    if (key === 'localTtsVoice') {
      settings.value[key] = value as string
    }
    if (key === 'googleTtsVoice') {
      settings.value[key] = value as string
    }
    if (key === 'embeddingProvider') {
      settings.value[key] = value as 'openai' | 'doubao' | 'qwen' | 'local'
    }

    successMessage.value = null
    error.value = null
    if (
      key === 'VITE_OPENAI_API_KEY' ||
      key === 'VITE_OPENROUTER_API_KEY' ||
      key === 'VITE_ZAI_API_KEY' ||
      key === 'VITE_MINIMAX_API_KEY' ||
      key === 'VITE_DEEPSEEK_API_KEY' ||
      key === 'VITE_API_ROUTE_API_KEY' ||
      key === 'ollamaBaseUrl' ||
      key === 'lmStudioBaseUrl' ||
      key === 'zaiBaseUrl' ||
      key === 'minimaxBaseUrl' ||
      key === 'deepseekBaseUrl' ||
      key === 'codexAuthConnected' ||
      key === 'aiProvider'
    ) {
      coreOpenAISettingsValid.value = false
    }

    if (
      key === 'aiProvider' &&
      settings.value.aiProvider !== 'openai' &&
      !settings.value.VITE_OPENAI_API_KEY?.trim() &&
      settings.value.embeddingProvider === 'openai'
    ) {
      settings.value.embeddingProvider = 'local'
    }

    if (
      key === 'VITE_OPENAI_API_KEY' &&
      !settings.value.VITE_OPENAI_API_KEY?.trim() &&
      settings.value.aiProvider !== 'openai' &&
      settings.value.embeddingProvider === 'openai'
    ) {
      settings.value.embeddingProvider = 'local'
    }
  }

  async function saveSettingsToFile(): Promise<boolean> {
    if (!isProduction.value && !window.settingsAPI?.saveSettings) {
      successMessage.value =
        'Settings updated (Dev Mode - Not saved to file unless IPC available)'
      return true
    }
    isSaving.value = true
    error.value = null
    try {
      /**
       * 整份序列化，不再手写字段清单。
       * 手写清单最大的问题是"新加字段忘了登记就静默丢失"。
       */
      const plainSettings = JSON.parse(
        JSON.stringify(settings.value)
      ) as AliceSettings

      const saveResult = await window.settingsAPI.saveSettings(plainSettings)

      if (saveResult.success) {
        isSaving.value = false
        return true
      } else {
        error.value = `Failed to save settings to file: ${saveResult.error || 'Unknown error'}`
        console.error(
          '[SettingsStore saveSettingsToFile] IPC save failed:',
          saveResult.error
        )
        isSaving.value = false
        return false
      }
    } catch (e: any) {
      error.value = `Error during settings save: ${e.message}`
      console.error(
        '[SettingsStore saveSettingsToFile] Exception during save:',
        e
      )
      isSaving.value = false
      return false
    }
  }

  async function saveAndTestSettings() {
    isSaving.value = true
    error.value = null
    successMessage.value = null
    const generalStore = useGeneralStore()
    const conversationStore = useConversationStore()

    const currentConfigForTest = config.value

    // 允许只填一部分设置就保存：这里不做任何"缺项拦截"，
    // 哪个能力没配好，等真正用到它的时候再报错。
    const settingsPersistedInitially = await saveSettingsToFile()
    if (!settingsPersistedInitially) {
      generalStore.statusMessage = 'Error saving settings to file.'
      return
    }

    reinitializeClients()

    let openAIServiceTestSuccess = false
    try {
      await conversationStore.fetchModels()
      openAIServiceTestSuccess = true
      coreOpenAISettingsValid.value = true
    } catch (e: any) {
      const providerName = getProviderDisplayName(
        currentConfigForTest.aiProvider
      )
      error.value = `${providerName} API connection test failed: ${e.message}. Check your ${providerName} configuration.`
      coreOpenAISettingsValid.value = false
      openAIServiceTestSuccess = false
    }

    if (openAIServiceTestSuccess) {
      if (!currentConfigForTest.assistantModel?.trim()) {
        const providerName = getProviderDisplayName(
          currentConfigForTest.aiProvider
        )
        error.value = `${providerName} connection is valid. Please select an '${settingKeyToLabelMap.assistantModel}'.`
        generalStore.statusMessage = 'Assistant model not selected.'
        successMessage.value = `${providerName} connection is valid. Models loaded. Please complete model selections.`
        isSaving.value = false
        return
      }
      if (!currentConfigForTest.SUMMARIZATION_MODEL?.trim()) {
        const providerName = getProviderDisplayName(
          currentConfigForTest.aiProvider
        )
        error.value = `${providerName} connection is valid. Please select a '${settingKeyToLabelMap.SUMMARIZATION_MODEL}'.`
        generalStore.statusMessage = 'Summarization model not selected.'
        successMessage.value = `${providerName} connection is valid. Models loaded. Please complete model selections.`
        isSaving.value = false
        return
      }

      successMessage.value = 'Settings are valid and saved!'
      if (!isProduction.value) {
        successMessage.value +=
          ' (Dev mode - .env might override for operation if not using UI for all settings)'
      }
      generalStore.statusMessage = 'Re-initializing Alice with new settings...'

      if (conversationStore.isInitialized) {
        conversationStore.isInitialized = false
      }
      const initSuccess = await conversationStore.initialize()
      if (initSuccess) {
        successMessage.value += ' Alice is ready.'
        generalStore.setAudioState('IDLE')
      } else {
        const initErrorMsg = generalStore.statusMessage.includes('Error:')
          ? generalStore.statusMessage
          : 'Failed to re-initialize Alice with new settings.'
        error.value = (error.value ? error.value + '; ' : '') + initErrorMsg
        successMessage.value = `Settings valid, but ${initErrorMsg}`
      }
    } else {
      generalStore.statusMessage =
        'Settings validation failed. Check API Key(s).'
    }
    isSaving.value = false
    setTimeout(() => {
      successMessage.value = null
    }, 5000)
  }

  async function completeOnboarding(onboardingData: {
    VITE_OPENAI_API_KEY: string
    VITE_OPENROUTER_API_KEY: string
    VITE_ZAI_API_KEY?: string
    VITE_MINIMAX_API_KEY?: string
    VITE_DEEPSEEK_API_KEY?: string
    VITE_API_ROUTE_API_KEY?: string
    sttProvider:
      'openai' | 'groq' | 'google' | 'doubao' | 'qwen' | 'volcengine' | 'local'
    ttsProvider?: 'openai' | 'google' | 'doubao' | 'qwen' | 'local'
    embeddingProvider?: 'openai' | 'doubao' | 'qwen' | 'local'
    aiProvider: AIProviderKey
    assistantModel?: string
    summarizationModel?: string
    VITE_GROQ_API_KEY: string
    VITE_GOOGLE_API_KEY: string
    VITE_DOUBAO_API_KEY?: string
    VITE_QWEN_API_KEY?: string
    ollamaBaseUrl?: string
    lmStudioBaseUrl?: string
    zaiBaseUrl?: string
    minimaxBaseUrl?: string
    deepseekBaseUrl?: string
    doubaoBaseUrl?: string
    qwenBaseUrl?: string
    doubaoSttModel?: string
    doubaoTtsModel?: string
    doubaoEmbeddingModel?: string
    qwenSttModel?: string
    qwenTtsModel?: string
    qwenEmbeddingModel?: string
    openaiSttModel?: string
    openaiTtsModel?: string
    openaiEmbeddingModel?: string
    useLocalModels?: boolean
    localSttLanguage?: string
  }) {
    settings.value.VITE_OPENAI_API_KEY = onboardingData.VITE_OPENAI_API_KEY
    settings.value.VITE_OPENROUTER_API_KEY =
      onboardingData.VITE_OPENROUTER_API_KEY
    settings.value.VITE_ZAI_API_KEY = onboardingData.VITE_ZAI_API_KEY || ''
    settings.value.VITE_MINIMAX_API_KEY =
      onboardingData.VITE_MINIMAX_API_KEY || ''
    settings.value.VITE_DEEPSEEK_API_KEY =
      onboardingData.VITE_DEEPSEEK_API_KEY || ''
    settings.value.VITE_API_ROUTE_API_KEY =
      onboardingData.VITE_API_ROUTE_API_KEY || ''
    settings.value.sttProvider = onboardingData.sttProvider
    settings.value.aiProvider = onboardingData.aiProvider
    settings.value.VITE_GROQ_API_KEY = onboardingData.VITE_GROQ_API_KEY
    settings.value.VITE_GOOGLE_API_KEY = onboardingData.VITE_GOOGLE_API_KEY
    settings.value.VITE_DOUBAO_API_KEY =
      onboardingData.VITE_DOUBAO_API_KEY || ''
    settings.value.VITE_QWEN_API_KEY = onboardingData.VITE_QWEN_API_KEY || ''

    // Set models if provided
    if (onboardingData.assistantModel) {
      settings.value.assistantModel = onboardingData.assistantModel
    }
    if (onboardingData.summarizationModel) {
      settings.value.SUMMARIZATION_MODEL = onboardingData.summarizationModel
    }

    if (onboardingData.localSttLanguage) {
      settings.value.localSttLanguage = onboardingData.localSttLanguage
    }

    // Set TTS and embedding providers based on local models preference
    if (onboardingData.useLocalModels) {
      settings.value.ttsProvider = 'local'
      settings.value.embeddingProvider = 'local'
    } else {
      // Respect the user's choice from the wizard if available, otherwise default to openai
      settings.value.ttsProvider = onboardingData.ttsProvider || 'openai'
      settings.value.embeddingProvider =
        onboardingData.embeddingProvider || 'openai'
    }

    if (onboardingData.ollamaBaseUrl) {
      settings.value.ollamaBaseUrl = onboardingData.ollamaBaseUrl
    }
    if (onboardingData.lmStudioBaseUrl) {
      settings.value.lmStudioBaseUrl = onboardingData.lmStudioBaseUrl
    }
    if (onboardingData.zaiBaseUrl) {
      settings.value.zaiBaseUrl = onboardingData.zaiBaseUrl
    }
    if (onboardingData.minimaxBaseUrl) {
      settings.value.minimaxBaseUrl = onboardingData.minimaxBaseUrl
    }
    if (onboardingData.deepseekBaseUrl) {
      settings.value.deepseekBaseUrl = onboardingData.deepseekBaseUrl
    }
    if (onboardingData.doubaoBaseUrl) {
      settings.value.doubaoBaseUrl = onboardingData.doubaoBaseUrl
    }
    if (onboardingData.qwenBaseUrl) {
      settings.value.qwenBaseUrl = onboardingData.qwenBaseUrl
    }
    if (onboardingData.doubaoSttModel !== undefined) {
      settings.value.doubaoSttModel = onboardingData.doubaoSttModel
    }
    if (onboardingData.doubaoTtsModel !== undefined) {
      settings.value.doubaoTtsModel = onboardingData.doubaoTtsModel
    }
    if (onboardingData.doubaoEmbeddingModel !== undefined) {
      settings.value.doubaoEmbeddingModel = onboardingData.doubaoEmbeddingModel
    }
    if (onboardingData.qwenSttModel !== undefined) {
      settings.value.qwenSttModel = onboardingData.qwenSttModel
    }
    if (onboardingData.qwenTtsModel !== undefined) {
      settings.value.qwenTtsModel = onboardingData.qwenTtsModel
    }
    if (onboardingData.qwenEmbeddingModel !== undefined) {
      settings.value.qwenEmbeddingModel = onboardingData.qwenEmbeddingModel
    }
    if (onboardingData.openaiSttModel !== undefined) {
      settings.value.openaiSttModel = onboardingData.openaiSttModel
    }
    if (onboardingData.openaiTtsModel !== undefined) {
      settings.value.openaiTtsModel = onboardingData.openaiTtsModel
    }
    if (onboardingData.openaiEmbeddingModel !== undefined) {
      settings.value.openaiEmbeddingModel = onboardingData.openaiEmbeddingModel
    }

    settings.value.onboardingCompleted = true

    const success = await saveSettingsToFile()
    if (success) {
      reinitializeClients()
      const conversationStore = useConversationStore()
      await conversationStore.initialize()
      isSaving.value = false
    }
    return success
  }

  function addApprovedCommand(command: string) {
    const commandName = command.split(' ')[0]
    if (!settings.value.approvedCommands.includes(commandName)) {
      settings.value.approvedCommands.push(commandName)
      saveSettingsToFile()
    }
  }

  function addSessionApprovedCommand(command: string) {
    const commandName = command.split(' ')[0]
    if (!sessionApprovedCommands.value.includes(commandName)) {
      sessionApprovedCommands.value.push(commandName)
    }
  }

  function isCommandApproved(command: string): boolean {
    const commandName = command.split(' ')[0]
    return (
      settings.value.approvedCommands.includes(commandName) ||
      sessionApprovedCommands.value.includes(commandName)
    )
  }

  async function removeApprovedCommand(command: string) {
    const commandName = command.split(' ')[0]
    const index = settings.value.approvedCommands.indexOf(commandName)
    if (index > -1) {
      settings.value.approvedCommands.splice(index, 1)
      await saveSettingsToFile()
    }
  }

  /**
   * 从磁盘重新读一遍设置。
   *
   * 设置窗口保存后，主窗口需要换掉内存里的旧配置，但不该为此重建整个界面。
   * loadSettings 有"只加载一次"的闸门，这里显式放开一次再合上。
   */
  async function reloadFromDisk(): Promise<void> {
    initialLoadAttempted.value = false
    try {
      await loadSettings()
    } finally {
      initialLoadAttempted.value = true
    }
  }

  return {
    settings,
    isLoading,
    isSaving,
    error,
    successMessage,
    initialLoadAttempted,
    coreOpenAISettingsValid,
    sessionApprovedCommands,
    isProduction,
    areEssentialSettingsProvided,
    areCoreApiKeysSufficientForTesting,
    config,
    loadSettings,
    reloadFromDisk,
    updateSetting,
    saveSettingsToFile,
    saveAndTestSettings,
    completeOnboarding,
    addApprovedCommand,
    addSessionApprovedCommand,
    isCommandApproved,
    removeApprovedCommand,
  }
})
