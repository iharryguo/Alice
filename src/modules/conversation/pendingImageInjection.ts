import type OpenAI from 'openai'

type ContentPart = OpenAI.Responses.Request.ContentPartLike

/**
 * 把工具抓到的截图追加到最后一条 user 消息的内容里。
 *
 * 为什么是"构建期注入"而不是把图片写进 chatHistory：
 * - chatHistory 会被渲染成消息气泡，写进去等于让用户看到一条自己没发过的图
 * - 写进去还会被会话库序列化，base64 直接把 SQLite 撑爆
 * - apiInputBuilder 本来就只给"最新一条 user 消息"保留真实图片，更早的图
 *   自动降级成占位文本，所以注入点天然就是一次性的
 */
export function appendPendingImages(
  parts: ContentPart[],
  images: string[] | undefined | null
): ContentPart[] {
  if (!images || images.length === 0) return parts

  const existing = new Set(
    parts
      .filter(part => (part as any)?.type === 'input_image')
      .map(part => (part as any)?.image_url)
  )

  const additions: ContentPart[] = []
  for (const uri of images) {
    if (typeof uri !== 'string' || uri.length === 0) continue
    if (existing.has(uri)) continue
    existing.add(uri)
    additions.push({ type: 'input_image', image_url: uri } as ContentPart)
  }

  return additions.length > 0 ? [...parts, ...additions] : parts
}
