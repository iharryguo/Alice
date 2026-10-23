import { describe, expect, it } from 'vitest'
import { appendPendingImages } from '../pendingImageInjection'

const textPart = { type: 'input_text', text: '帮我看看屏幕上是什么' } as any

describe('appendPendingImages', () => {
  it('把截图追加到内容末尾', () => {
    const result = appendPendingImages([textPart], ['data:image/jpeg;base64,AAA'])

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(textPart)
    expect(result[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,AAA',
    })
  })

  it('没有待注入图片时返回原数组', () => {
    const parts = [textPart]
    expect(appendPendingImages(parts, [])).toBe(parts)
    expect(appendPendingImages(parts, undefined)).toBe(parts)
  })

  it('已经存在的同一张图不会重复追加', () => {
    const uri = 'data:image/jpeg;base64,AAA'
    const parts = [textPart, { type: 'input_image', image_url: uri } as any]

    const result = appendPendingImages(parts, [uri])

    expect(result).toHaveLength(2)
  })

  it('忽略空字符串与非法值', () => {
    const result = appendPendingImages(
      [textPart],
      ['', undefined as unknown as string, 'data:image/jpeg;base64,BBB']
    )

    expect(result).toHaveLength(2)
    expect((result[1] as any).image_url).toBe('data:image/jpeg;base64,BBB')
  })
})
