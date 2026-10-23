import { describe, expect, it } from 'vitest'
import { buildChatDisplayItems } from '../chatDisplay'
import type { ChatMessage } from '../../types/chat'

const userMessage = (text: string): ChatMessage => ({
  role: 'user',
  content: [{ type: 'app_text', text }],
  created_at: 1,
})

// 注意：chatHistory 是「最新在前」，与渲染顺序相反
const history = (...oldestToNewest: ChatMessage[]): ChatMessage[] =>
  [...oldestToNewest].reverse()

describe('buildChatDisplayItems', () => {
  it('按时间正序输出消息，并且隐藏只有工具调用的助手消息', () => {
    const items = buildChatDisplayItems(
      history(
        userMessage('看看 E 盘'),
        {
          role: 'assistant',
          content: [{ type: 'app_text', text: '' }],
          tool_calls: [
            { call_id: 'call-1', name: 'list_directory', arguments: { path: 'E:/' } },
          ],
        },
        { role: 'system', content: [{ type: 'app_text', text: '正在列目录…' }] },
        { role: 'tool', tool_call_id: 'call-1', name: 'list_directory', content: 'a\nb' }
      )
    )

    expect(items.map(item => item.kind)).toEqual(['message', 'tool'])
    const tool = items[1]
    expect(tool.kind).toBe('tool')
    if (tool.kind !== 'tool') return
    expect(tool.tool.name).toBe('list_directory')
    expect(tool.tool.args).toContain('"path"')
    expect(tool.tool.statusText).toBe('正在列目录…')
    expect(tool.tool.status).toBe('success')
  })

  it('把错误结果标记为 error', () => {
    const items = buildChatDisplayItems(
      history(userMessage('跑个命令'), {
        role: 'tool',
        tool_call_id: 'call-2',
        name: 'execute_command',
        content: 'Error: denied',
      })
    )

    const tool = items.find(item => item.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.tool.status).toBe('error')
  })

  it('有正文的助手消息保留文本并附带工具名徽章', () => {
    const items = buildChatDisplayItems(
      history(
        userMessage('列一下目录'),
        {
          role: 'assistant',
          content: [{ type: 'app_text', text: '已经帮你列好了' }],
          tool_calls: [
            { call_id: 'call-3', name: 'list_directory', arguments: {} },
          ],
          created_at: 2,
        }
      )
    )

    const message = items.find(item => item.kind === 'message' && item.role === 'assistant')
    expect(message?.kind).toBe('message')
    if (!message || message.kind !== 'message') return
    expect(message.text).toBe('已经帮你列好了')
    expect(message.toolNames).toEqual(['list_directory'])
    expect(message.time).toBe(2)
  })
})
