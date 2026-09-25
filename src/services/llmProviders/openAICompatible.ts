import type OpenAI from 'openai'
import { useSettingsStore } from '../../stores/settingsStore'
import { streamViaMainProcess } from './mainProcessStream'
import { convertLocalLLMStreamToResponsesFormat } from './streamAdapters'
import { buildToolsForProvider } from './tools'
import {
  MINIMAX_OPENAI_BASE_URL,
  type ChatCompletionsProviderKey,
  getSafeProviderModel,
} from './providerCatalog'

type OpenAIClientGetter = () => OpenAI
type OpenAICompatibleProviderKey = 'zai' | 'minimax' | 'deepseek' | 'api-route'

function convertResponsesInputToChatMessages(
  input: OpenAI.Responses.Request.InputItemLike[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const converted = input
    .map((item: any) => {
      if (item.role === 'user') {
        if (Array.isArray(item.content)) {
          const textParts = item.content
            .filter(
              (part: any) => part.type === 'input_text' && part.text?.trim()
            )
            .map((part: any) => part.text)

          // Preserve image parts (screenshots etc.) so vision-capable models
          // (e.g. deepseek-v4-flash) can actually see them. apiInputBuilder
          // already keeps real image URIs only for the latest user message.
          const imageParts = item.content
            .filter(
              (part: any) => part.type === 'input_image' && part.image_url
            )
            .map((part: any) => ({
              type: 'image_url',
              image_url: { url: part.image_url },
            }))

          if (imageParts.length > 0) {
            const content: Array<
              | { type: 'text'; text: string }
              | { type: 'image_url'; image_url: { url: string } }
            > = textParts.map((text: string) => ({ type: 'text', text }))
            content.push(...imageParts)
            return {
              role: 'user',
              content,
            }
          }

          return {
            role: 'user',
            content: textParts.join(' ') || 'Hello',
          }
        }

        return {
          role: 'user',
          content:
            typeof item.content === 'string' && item.content.trim()
              ? item.content
              : 'Hello',
        }
      }

      if (item.role === 'assistant') {
        const textContent = Array.isArray(item.content)
          ? item.content
              .filter(
                (part: any) => part.type === 'output_text' && part.text?.trim()
              )
              .map((part: any) => part.text)
              .join(' ')
          : typeof item.content === 'string' && item.content.trim()
            ? item.content
            : ''

        const toolCalls = item.tool_calls || null
        const chatToolCalls = toolCalls
          ? toolCalls.map((toolCall: any) => ({
              id: toolCall.call_id || toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments:
                  typeof toolCall.arguments === 'string'
                    ? toolCall.arguments
                    : JSON.stringify(toolCall.arguments || {}),
              },
            }))
          : undefined

        return {
          role: 'assistant',
          content: textContent,
          tool_calls: chatToolCalls,
        }
      }

      if (item.role === 'system') {
        const content =
          typeof item.content === 'string'
            ? item.content
            : Array.isArray(item.content)
              ? item.content.map((part: any) => part.text || '').join(' ')
              : 'You are a helpful assistant.'

        return {
          role: 'system',
          content: content.trim() || 'You are a helpful assistant.',
        }
      }

      if (item.type === 'function_call_output') {
        return {
          role: 'tool',
          tool_call_id: item.call_id,
          content:
            typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output),
        }
      }

      return {
        ...item,
        content:
          typeof item.content === 'string' && item.content.trim()
            ? item.content
            : 'Message received.',
      }
    })
    .filter((message: any) => {
      if (message.role === 'assistant' && message.tool_calls?.length) {
        return true
      }
      // Multimodal messages carry array content (text + image parts) — keep
      // them as long as they have at least one part.
      if (Array.isArray(message.content)) {
        return message.content.length > 0
      }
      return typeof message.content === 'string' && !!message.content.trim()
    })

  console.log(
    '[ChatMessages] Converted input:',
    input.length,
    'items →',
    converted.length,
    'messages:',
    converted.map((message: any) => ({
      role: message.role,
      contentTypes: Array.isArray(message.content)
        ? message.content.map((part: any) => part.type)
        : 'text',
    }))
  )

  return converted
}

function addCustomInstructions(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  customInstructions?: string
): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'system') {
      messages.splice(index, 1)
    }
  }

  if (!customInstructions) {
    return
  }

  messages.unshift({
    role: 'system',
    content: customInstructions,
  })
}

function prepareMiniMaxMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  customInstructions?: string
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const instructionBlock = customInstructions?.trim() || ''
  const nonSystemMessages = messages.filter(
    message => message.role !== 'system'
  )

  if (!instructionBlock) {
    return nonSystemMessages
  }

  const firstUserMessage = nonSystemMessages.find(
    message => message.role === 'user'
  ) as any

  if (firstUserMessage) {
    const originalContent =
      typeof firstUserMessage.content === 'string'
        ? firstUserMessage.content
        : JSON.stringify(firstUserMessage.content || '')
    firstUserMessage.content = `${instructionBlock}\n\n${originalContent}`
    return nonSystemMessages
  }

  return [
    {
      role: 'user',
      content: instructionBlock,
    },
    ...nonSystemMessages,
  ]
}

function prepareChatMessagesForProvider(
  provider: OpenAICompatibleProviderKey,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  customInstructions?: string
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (provider === 'minimax') {
    return prepareMiniMaxMessages(messages, customInstructions)
  }

  addCustomInstructions(messages, customInstructions)
  return messages
}

function convertToolsForChatCompletions(finalToolsForApi: any[]) {
  if (finalToolsForApi.length === 0) {
    return undefined
  }

  return finalToolsForApi.map(tool => {
    if (tool.type === 'function') {
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }
    }
    return tool
  })
}

export async function listOpenAICompatibleModels(
  getClient: OpenAIClientGetter
): Promise<OpenAI.Models.Model[]> {
  const modelsPage = await getClient().models.list()
  return modelsPage.data.sort((a, b) => a.id.localeCompare(b.id))
}

export function stripReasoningFromMiniMaxContent(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(
      /^\s*(?:reasoning|thinking)[\s_-]*content\s*:\s*[\s\S]*?\n{2,}/i,
      ''
    )
    .trim()
}

function normalizeBaseUrl(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

export async function createMiniMaxChatCompletionViaMain(
  params: OpenAI.Chat.ChatCompletionCreateParams,
  signal?: AbortSignal
): Promise<any> {
  const settings = useSettingsStore().config
  if (!settings.VITE_MINIMAX_API_KEY?.trim()) {
    throw new Error('MiniMax API Key is not configured.')
  }

  const body = {
    ...params,
    stream: !!params.stream,
    reasoning_split: true,
  }

  const request = {
    url: `${normalizeBaseUrl(settings.minimaxBaseUrl || MINIMAX_OPENAI_BASE_URL)}/chat/completions`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.VITE_MINIMAX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    data: body,
    timeout: 120 * 1000,
  }

  if (body.stream) {
    return streamViaMainProcess(request, signal)
  }

  if (typeof window === 'undefined' || !window.httpAPI) {
    throw new Error('Electron HTTP bridge is unavailable.')
  }

  const response = await window.httpAPI.request(request)

  if (!response.success) {
    throw new Error(response.error || 'MiniMax chat completion request failed.')
  }

  if (response.status && response.status >= 400) {
    const message =
      response.data?.error?.message ||
      response.data?.message ||
      `MiniMax chat completion failed with status ${response.status}.`
    const error = new Error(message) as Error & { status?: number; data?: any }
    error.status = response.status
    error.data = response.data
    throw error
  }

  const data = response.data
  const message = data?.choices?.[0]?.message
  if (message && typeof message.content === 'string') {
    message.content = stripReasoningFromMiniMaxContent(message.content)
  }
  return data
}

export async function createChatCompletionForProvider(
  provider: ChatCompletionsProviderKey,
  getClient: OpenAIClientGetter,
  params: OpenAI.Chat.ChatCompletionCreateParams,
  signal?: AbortSignal
): Promise<any> {
  if (provider === 'minimax') {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    return createMiniMaxChatCompletionViaMain(params, signal)
  }

  return getClient().chat.completions.create(params as any, { signal })
}

// DeepSeek/OpenAI-strict endpoints reject a 'tool' message that does not
// directly follow an assistant message carrying the matching 'tool_calls'
// (and vice versa). Interrupted turns (barge-in) or history trimming can
// leave such orphans in the conversation history, so sanitize before
// sending: drop tool results without a matching tool_calls entry, and strip
// tool_calls entries whose results are missing.
function sanitizeToolMessageSequence<
  T extends {
    role: string
    tool_calls?: { id?: string }[]
    tool_call_id?: string
  },
>(messages: T[]): T[] {
  const toolResultIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) {
      toolResultIds.add(message.tool_call_id)
    }
  }

  const sanitized: T[] = []
  const validToolCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const usableCalls = message.tool_calls.filter(
        call => call?.id && toolResultIds.has(call.id)
      )
      for (const call of usableCalls) {
        validToolCallIds.add(call.id as string)
      }
      if (usableCalls.length === message.tool_calls.length) {
        sanitized.push(message)
      } else if (usableCalls.length > 0) {
        sanitized.push({ ...message, tool_calls: usableCalls })
      } else {
        // No results for any of the calls (turn was interrupted): strip the
        // tool_calls entirely so the assistant message stays valid on its own.
        const { tool_calls: _dropped, ...rest } = message
        const fallbackContent =
          typeof (rest as any).content === 'string' &&
          (rest as any).content.trim()
            ? (rest as any).content
            : '(上一轮操作被用户中断)'
        sanitized.push({ ...(rest as any), content: fallbackContent } as T)
      }
      continue
    }

    if (message.role === 'tool') {
      if (message.tool_call_id && validToolCallIds.has(message.tool_call_id)) {
        sanitized.push(message)
      }
      continue
    }

    sanitized.push(message)
  }

  return sanitized
}

export async function createOpenAICompatibleResponse(
  provider: OpenAICompatibleProviderKey,
  getClient: OpenAIClientGetter,
  input: OpenAI.Responses.Request.InputItemLike[],
  stream: boolean = false,
  customInstructions?: string,
  signal?: AbortSignal
): Promise<any> {
  const settings = useSettingsStore().config
  const finalToolsForApi = await buildToolsForProvider()
  const messages = sanitizeToolMessageSequence(
    prepareChatMessagesForProvider(
      provider,
      convertResponsesInputToChatMessages(input),
      customInstructions
    )
  )

  console.log(
    `[${provider}] Final messages:`,
    JSON.stringify(messages, null, 2)
  )

  const model = getSafeProviderModel(provider, settings.assistantModel)

  // 紧凑摘要：避免巨型 base64 把控制台刷屏，导致看不清消息结构
  console.log(
    `[${provider}] Request summary: model=${model}, messages=`,
    messages.map(message => ({
      role: message.role,
      contentTypes: Array.isArray((message as any).content)
        ? ((message as any).content as any[]).map((part: any) => part.type)
        : 'text',
      toolCalls: (message as any).tool_calls
        ? (message as any).tool_calls.map((call: any) => call.function?.name)
        : undefined,
    }))
  )
  const params: OpenAI.Chat.ChatCompletionCreateParams = {
    model,
    messages,
    ...(!model.startsWith('gpt-5')
      ? {
          temperature: settings.assistantTemperature,
          top_p: settings.assistantTopP,
        }
      : {}),
    tools: convertToolsForChatCompletions(finalToolsForApi),
    stream,
  }

  if (provider === 'deepseek') {
    ;(params as any).thinking = { type: 'disabled' }
  }

  if (provider === 'minimax') {
    const completion = await createChatCompletionForProvider(
      provider,
      getClient,
      params,
      signal
    )
    return stream
      ? convertLocalLLMStreamToResponsesFormat(completion, provider)
      : completion
  }

  if (stream) {
    const chatStream = await createChatCompletionForProvider(
      provider,
      getClient,
      params,
      signal
    )
    return convertLocalLLMStreamToResponsesFormat(chatStream, provider)
  }

  return createChatCompletionForProvider(provider, getClient, params, signal)
}
