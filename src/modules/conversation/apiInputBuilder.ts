import type OpenAI from 'openai'
import type { AppChatMessageContentPart } from '../../types/chat'
import { isChatCompletionsProvider } from '../../services/llmProviders/providerCatalog'
import { appendPendingImages } from './pendingImageInjection'

export type ConversationHistoryRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'developer'
  | 'tool'

export interface ConversationHistoryMessage {
  local_id_temp?: string
  api_message_id?: string
  api_response_id?: string
  role: ConversationHistoryRole
  content: string | AppChatMessageContentPart[]
  tool_call_id?: string
  name?: string
  tool_calls?: any[]
}

export interface ApiInputBuilderDependencies {
  getChatHistory(): ConversationHistoryMessage[]
  getMaxHistoryMessagesForApi(): number
  getAiProvider(): string
  /** 工具（take_screenshot）在本轮攒下的截图，仅在构建最新一条 user 消息时注入 */
  getPendingImages?(): string[]
  /** 英语模式下追加到最新一条用户消息末尾的极短语言提醒 */
  getResponseLanguageRule?(): string | null
}

export interface ApiInputBuilder {
  build(params: {
    isNewChain: boolean
  }): Promise<OpenAI.Responses.Request.InputItemLike[]>
}

export function createApiInputBuilder(
  dependencies: ApiInputBuilderDependencies
): ApiInputBuilder {
  return {
    async build({
      isNewChain,
    }): Promise<OpenAI.Responses.Request.InputItemLike[]> {
      // `isNewChain` currently does not affect construction but kept for parity.
      void isNewChain

      const historyToBuildFrom = [...dependencies.getChatHistory()]
      const maxHistory = dependencies.getMaxHistoryMessagesForApi()
      const apiInput: OpenAI.Responses.Request.InputItemLike[] = []
      const recentHistory = historyToBuildFrom.slice(0, maxHistory).reverse()

      // 本轮窗口里最新的一条 user 消息（用对象身份比较，不依赖 local_id_temp 是否存在）
      const newestUserMessage = [...recentHistory]
        .reverse()
        .find(msg => msg.role === 'user')

      const lastUserMessageInFullHistoryId = historyToBuildFrom.find(
        msg => msg.role === 'user'
      )?.local_id_temp

      const aiProvider = dependencies.getAiProvider()

      for (const msg of recentHistory) {
        let apiItemPartial: any

        if (msg.role === 'system') {
          continue
        }

        if (msg.role === 'tool') {
          apiItemPartial = {
            type: 'function_call_output',
            call_id: msg.tool_call_id || `unknown_call_id_${Date.now()}`,
            output:
              typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content),
          }
        } else {
          const currentApiRole = msg.role as 'user' | 'assistant' | 'developer'
          apiItemPartial = { role: currentApiRole, content: [] }
          if (msg.name) apiItemPartial.name = msg.name

          // 必须要求 id 真实存在：否则 undefined === undefined 会让每一条
          // user 消息都吃到工具截图
          const isLastUserMessageWithPotentialImage =
            currentApiRole === 'user' &&
            !!msg.local_id_temp &&
            msg.local_id_temp === lastUserMessageInFullHistoryId

          let messageContentParts: OpenAI.Responses.Request.ContentPartLike[] =
            []

          if (typeof msg.content === 'string') {
            const typeForPart =
              currentApiRole === 'user' || currentApiRole === 'developer'
                ? 'input_text'
                : 'output_text'
            messageContentParts = [{ type: typeForPart, text: msg.content }]
          } else if (Array.isArray(msg.content)) {
            messageContentParts = msg.content
              .map((appPart: AppChatMessageContentPart) => {
                if (appPart.type === 'app_text') {
                  const typeForPart =
                    currentApiRole === 'user' || currentApiRole === 'developer'
                      ? 'input_text'
                      : 'output_text'
                  return { type: typeForPart, text: appPart.text || '' }
                }

                if (appPart.type === 'app_image_uri') {
                  if (!appPart.uri) return null
                  if (
                    isLastUserMessageWithPotentialImage &&
                    (currentApiRole === 'user' ||
                      currentApiRole === 'developer')
                  ) {
                    console.log(
                      '[ApiInputBuilder] Including image part in latest user message:',
                      appPart.uri.slice(0, 30)
                    )
                    return {
                      type: 'input_image',
                      image_url: appPart.uri,
                    } as OpenAI.Responses.Request.InputImagePart
                  }

                  if (
                    currentApiRole === 'user' ||
                    currentApiRole === 'developer'
                  ) {
                    return {
                      type: 'input_text',
                      text: '[User previously sent an image]',
                    }
                  }
                  return null
                }

                if (appPart.type === 'app_file') {
                  if (!appPart.fileId) return null
                  if (
                    currentApiRole === 'user' ||
                    currentApiRole === 'developer'
                  ) {
                    return {
                      type: 'input_file',
                      file_id: appPart.fileId,
                    } as OpenAI.Responses.Request.InputFilePart
                  }
                  return null
                }

                if (appPart.type === 'app_generated_image_path') {
                  if (
                    currentApiRole !== 'user' &&
                    currentApiRole !== 'developer'
                  ) {
                    return {
                      type: 'output_text',
                      text: '[Assistant previously generated an image]',
                    }
                  }
                  return null
                }

                return null
              })
              .filter(Boolean) as OpenAI.Responses.Request.ContentPartLike[]
          }

          // 工具（take_screenshot）抓到的画面在这里并进最新一条 user 消息，
          // 让同一个工具往返里重建出来的输入也能带上图片
          if (isLastUserMessageWithPotentialImage) {
            messageContentParts = appendPendingImages(
              messageContentParts,
              dependencies.getPendingImages?.()
            )
          }

          // 英语模式：紧贴用户这句话再提醒一次，比只放在 system 里更管用。
          // 这里不能和截图注入共用条件——截图依赖 local_id_temp，语言提醒不该被它拖累
          const isLatestUserMessage =
            currentApiRole === 'user' && msg === newestUserMessage
          if (isLatestUserMessage) {
            const languageRule = dependencies.getResponseLanguageRule?.()
            if (languageRule) {
              messageContentParts = [
                ...messageContentParts,
                { type: 'input_text', text: languageRule } as any,
              ]
            }
          }

          apiItemPartial.content =
            messageContentParts.length > 0
              ? messageContentParts
              : [
                  {
                    type:
                      currentApiRole === 'assistant'
                        ? 'output_text'
                        : 'input_text',
                    text: '',
                  },
                ]

          if (
            currentApiRole === 'assistant' &&
            msg.tool_calls &&
            isChatCompletionsProvider(aiProvider)
          ) {
            apiItemPartial.tool_calls = msg.tool_calls
          }
        }

        apiInput.push(apiItemPartial)
      }

      return apiInput
    },
  }
}
