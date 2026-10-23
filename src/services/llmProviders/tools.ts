import { useSettingsStore } from '../../stores/settingsStore'
import { useCustomToolsStore } from '../../stores/customToolsStore'
import {
  PREDEFINED_OPENAI_TOOLS,
  type ApiRequestBodyFunctionTool,
} from '../../utils/assistantTools'
import { PROVIDER_CONFIGS } from './providerCatalog'

const OPENAI_IMAGE_GENERATION_MODEL = 'gpt-image-2'
const BROWSER_STATUS_CACHE_MS = 2000

let browserStatusCache: { clients: number; checkedAt: number } | null = null

/**
 * Chrome 扩展没连上时，browser_context 必然失败（模型还会一直误选它）。
 * 这里查一次主进程的 WebSocket 连接数，没客户端就把工具从列表里摘掉；
 * 查询本身失败也按"不可用"处理（fail-closed）。
 */
async function isBrowserExtensionConnected(): Promise<boolean> {
  const now = Date.now()
  if (
    browserStatusCache &&
    now - browserStatusCache.checkedAt < BROWSER_STATUS_CACHE_MS
  ) {
    return browserStatusCache.clients > 0
  }

  if (typeof window === 'undefined' || !window.aliceIPC?.invoke) {
    return false
  }

  try {
    const status = await window.aliceIPC.invoke('websocket:status')
    const clients = Number(status?.clients) || 0
    browserStatusCache = { clients, checkedAt: now }
    return clients > 0
  } catch (error) {
    console.warn(
      '[Tools] 读取浏览器扩展连接状态失败，本次下架 browser_context:',
      error
    )
    browserStatusCache = { clients: 0, checkedAt: now }
    return false
  }
}

export async function buildToolsForProvider(): Promise<any[]> {
  const settings = useSettingsStore().config
  const finalToolsForApi: any[] = []

  if (settings.assistantTools && settings.assistantTools.length > 0) {
    for (const toolName of settings.assistantTools) {
      if (
        toolName === 'browser_context' &&
        !(await isBrowserExtensionConnected())
      ) {
        continue
      }

      const toolDefinition = PREDEFINED_OPENAI_TOOLS.find(
        (tool: ApiRequestBodyFunctionTool) => tool.name === toolName
      )
      if (toolDefinition) {
        finalToolsForApi.push({
          type: 'function',
          name: toolDefinition.name,
          description: toolDefinition.description,
          parameters: toolDefinition.parameters,
        })
      }
    }
  }

  const customToolsStore = useCustomToolsStore()
  await customToolsStore.ensureInitialized()
  for (const customTool of customToolsStore.enabledAndValidTools) {
    finalToolsForApi.push({
      type: 'function',
      name: customTool.name,
      description: customTool.description,
      parameters: customTool.parameters,
      strict: customTool.strict ?? false,
    })
  }

  if (
    settings.mcpServersConfig &&
    settings.mcpServersConfig.trim() !== '[]' &&
    settings.mcpServersConfig.trim() !== ''
  ) {
    try {
      const mcpServerDefinitions = JSON.parse(settings.mcpServersConfig)
      if (Array.isArray(mcpServerDefinitions)) {
        mcpServerDefinitions.forEach(mcpTool => {
          if (
            mcpTool.type === 'mcp' &&
            mcpTool.server_label &&
            mcpTool.server_url
          ) {
            finalToolsForApi.push(mcpTool)
          }
        })
      }
    } catch (e) {
      console.error('Failed to parse MCP servers config JSON:', e)
    }
  }

  const modelName = settings.assistantModel || ''
  const isOModel = modelName.startsWith('o')

  if (settings.aiProvider === 'openai') {
    const isGpt5WithMinimalReasoning =
      settings.assistantModel.startsWith('gpt-5') &&
      settings.assistantReasoningEffort === 'minimal'

    if (!isOModel) {
      if (!isGpt5WithMinimalReasoning) {
        finalToolsForApi.push({
          type: 'image_generation',
          model: OPENAI_IMAGE_GENERATION_MODEL,
          partial_images: 2,
        })
        finalToolsForApi.push({ type: 'web_search_preview' })
      }
    } else {
      if (modelName.includes('o3-pro') && modelName === 'o3') {
        finalToolsForApi.push({
          type: 'image_generation',
          model: OPENAI_IMAGE_GENERATION_MODEL,
          partial_images: 2,
        })
        finalToolsForApi.push({ type: 'web_search_preview' })
      }
    }
  }

  if (settings.aiProvider === 'openrouter') {
    const allowedTools = finalToolsForApi
      .filter(tool => {
        if (
          tool.type === 'image_generation' ||
          tool.type === 'web_search_preview' ||
          tool.name === 'perform_web_search'
        ) {
          return false
        }
        return true
      })
      .map(tool => {
        if (tool.name === 'open_path') {
          return {
            ...tool,
            description: tool.description?.replace(
              'Use this tool to open web search result url for user command.',
              'Do NOT use this tool for web searches. For web searches, use the built-in web search capabilities.'
            ),
          }
        }
        return tool
      })
    allowedTools.push({ type: 'openrouter:web_search' })
    finalToolsForApi.length = 0
    finalToolsForApi.push(...allowedTools)
  } else if (!PROVIDER_CONFIGS[settings.aiProvider].nativeWebSearch) {
    const allowedTools = finalToolsForApi.filter(tool => {
      if (
        tool.type === 'image_generation' ||
        tool.type === 'web_search_preview'
      ) {
        return false
      }
      return true
    })
    finalToolsForApi.length = 0
    finalToolsForApi.push(...allowedTools)
  }

  return finalToolsForApi
}
