import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createOpenAIResponse } from '../../services/apiService'

/**
 * 把没有文字层的页面交给模型读图。
 *
 * 不走 OCR：页面在浏览器里栅格化成图，直接作为多模态输入交给当前配置的模型
 * （DeepSeek 的 flash 系列支持图像理解）。读出来的文字写回页面记录，
 * 之后的课程编译、锚点、讲解全部按普通文本处理。
 */

if (!GlobalWorkerOptions.workerSrc) {
  GlobalWorkerOptions.workerSrc = workerSrc
}

const MAX_PAGES_PER_IMPORT = 12
const RENDER_SCALE = 1.8

export async function renderPageToDataUrl(
  bytes: Uint8Array,
  pageIndex: number
): Promise<string> {
  const documentProxy = await getDocument({ data: bytes.slice() }).promise
  try {
    const page = await documentProxy.getPage(pageIndex)
    const viewport = page.getViewport({ scale: RENDER_SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布')

    await page.render({ canvas, canvasContext: context, viewport } as any).promise
    return canvas.toDataURL('image/jpeg', 0.86)
  } finally {
    await documentProxy.destroy()
  }
}

/** 收一路流式响应里的文本增量 */
async function collectStreamText(stream: any): Promise<string> {
  let text = ''
  for await (const event of stream) {
    if (event?.type === 'response.output_text.delta' && event.delta) {
      text += event.delta
    }
  }
  return text.trim()
}

export async function transcribePageImage(
  dataUrl: string,
  pageIndex: number
): Promise<string> {
  const stream = await createOpenAIResponse(
    [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `这是教学材料的第 ${pageIndex} 页。`,
              '请把这一页的内容完整转成纯文本：标题、正文、要点、表格都按阅读顺序写出来。',
              '如果页面上有图，用一句「[图：...]」说明它画的是什么。',
              '不要添加解释、不要总结、不要翻译，只输出这一页本身的文字。',
            ].join('\n'),
          },
          { type: 'input_image', image_url: dataUrl },
        ],
      },
    ],
    null,
    true
  )

  return collectStreamText(stream)
}

export async function transcribeBlankPages(params: {
  bytes: Uint8Array
  blankPages: number[]
  onProgress?: (done: number, total: number) => void
}): Promise<Array<{ pageIndex: number; text: string }>> {
  const targets = params.blankPages.slice(0, MAX_PAGES_PER_IMPORT)
  const results: Array<{ pageIndex: number; text: string }> = []

  for (let index = 0; index < targets.length; index += 1) {
    const pageIndex = targets[index]
    try {
      const dataUrl = await renderPageToDataUrl(params.bytes, pageIndex)
      const text = await transcribePageImage(dataUrl, pageIndex)
      if (text) results.push({ pageIndex, text })
    } catch (error) {
      console.warn(`[Teaching] 第 ${pageIndex} 页读图失败:`, error)
    }
    params.onProgress?.(index + 1, targets.length)
  }

  return results
}

export const pageVisionLimit = MAX_PAGES_PER_IMPORT
