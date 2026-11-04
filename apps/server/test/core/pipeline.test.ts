import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { FieldRule } from '../../src/shared/index.js'
import { runPipeline } from '../../src/core/index.js'

const detailHtml = readFileSync(new URL('./fixtures/detail.html', import.meta.url), 'utf8')

const detailFields: Record<string, FieldRule> = {
  title: { type: 'text', selector: '.article-title', required: true, clean: { collapseWhitespace: true } },
  author: { type: 'text', selector: '.author' },
  publishTime: { type: 'text', selector: '.publish-time' },
  content: { type: 'html', selector: '.article-content' },
  source: { type: 'text', selector: '.source', defaultValue: '本站' },
}

const baseInput = {
  siteId: '1',
  categoryId: '10',
  url: 'https://example.com/news/1.html?utm_source=feed#top',
  body: detailHtml,
  fields: detailFields,
  clean: { removeSelectors: ['.ad'] },
}

describe('数据管道：完整流程', () => {
  it('产出统一的 ArticleData', async () => {
    const result = await runPipeline(baseInput)

    expect(result.article).not.toBeNull()
    const article = result.article!

    expect(article.siteId).toBe('1')
    expect(article.categoryId).toBe('10')
    expect(article.title).toBe('第一篇报道：采集平台上线')
    expect(article.author).toBe('张三')
    expect(article.articleTime).toBe('2026-01-01 10:00')
    expect(article.url).toBe('https://example.com/news/1.html')
    expect(article.metadata).toMatchObject({ source: '本站' })
  })

  it('纯文本正文：清洗掉脚本与广告内容', async () => {
    const article = (await runPipeline(baseInput)).article!

    expect(article.content).toContain('第一段正文')
    expect(article.content).not.toContain('document.write')
    expect(article.content).not.toContain('这里是广告')
  })

  it('纯文本正文保留段落换行且不夹带多余空格', async () => {
    const article = (await runPipeline(baseInput)).article!
    expect(article.content).toContain('第一段正文')
    expect(article.content).not.toMatch(/\n\s+/)
  })

  it('记录每个管道的执行阶段', async () => {
    const result = await runPipeline(baseInput)
    expect(result.steps.map((step) => step.stage)).toEqual([
      'parse',
      'clean',
      'validate',
      'normalize',
      'output',
    ])
    expect(result.steps.every((step) => step.ok)).toBe(true)
  })

  it('解析器插件可以重格式化提取结果', async () => {
    const result = await runPipeline({
      ...baseInput,
      transform: async (data) => ({
        ...data,
        // 模拟解密插件：把自定义字段 source 的原始值整体替换为解密后的值
        source: '解密后的来源',
      }),
    })

    expect(result.article?.metadata).toMatchObject({ source: '解密后的来源' })
  })

  it('解析器插件抛错时该篇解析失败', async () => {
    const result = await runPipeline({
      ...baseInput,
      transform: async () => {
        throw new Error('解密失败')
      },
    })

    expect(result.article).toBeNull()
    expect(result.errors[0]).toContain('解密失败')
  })
})

describe('数据管道：封面图（预留字段）', () => {
  it('映射 cover 时转为绝对地址，且不混进 metadata', async () => {
    const article = (
      await runPipeline({
        ...baseInput,
        fields: {
          ...detailFields,
          cover: { type: 'attr', selector: '.article-content img', attribute: 'src' },
        },
      })
    ).article!

    expect(article.coverUrl).toBe('https://example.com/images/a.png')
    expect(article.metadata ?? {}).not.toHaveProperty('cover')
  })

  it('未映射封面时留空', async () => {
    const article = (await runPipeline(baseInput)).article!
    expect(article.coverUrl).toBeNull()
  })

  it('coverUrl 字段同样识别，缺失或伪协议时为空', async () => {
    const mapped = (
      await runPipeline({
        ...baseInput,
        fields: {
          ...detailFields,
          coverUrl: { type: 'text', selector: '.not-exist' },
        },
      })
    ).article!
    expect(mapped.coverUrl).toBeNull()

    const javascript = (
      await runPipeline({
        ...baseInput,
        fields: {
          ...detailFields,
          cover: { type: 'text', selector: '.not-exist', defaultValue: 'javascript:alert(1)' },
        },
      })
    ).article!
    expect(javascript.coverUrl).toBeNull()
  })
})

describe('数据管道：校验与失败处理', () => {
  it('必填字段缺失时不出文章', async () => {
    const result = await runPipeline({
      ...baseInput,
      fields: { title: { type: 'text', selector: '.not-exist', required: true } },
    })

    expect(result.article).toBeNull()
    expect(result.missing).toEqual(['title'])
    expect(result.errors.join()).toContain('title')
  })

  it('标题过短时校验失败', async () => {
    const result = await runPipeline({
      ...baseInput,
      validate: { minTitleLength: 100 },
    })

    expect(result.article).toBeNull()
    expect(result.errors.some((error) => error.includes('标题长度不足'))).toBe(true)
  })

  it('正文过短时校验失败', async () => {
    const result = await runPipeline({
      ...baseInput,
      validate: { minContentLength: 10_000 },
    })

    expect(result.article).toBeNull()
    expect(result.errors.some((error) => error.includes('正文长度不足'))).toBe(true)
  })

  it('字段全部缺失时应用默认值', async () => {
    const result = await runPipeline({
      ...baseInput,
      fields: { title: { type: 'text', selector: '.article-title' }, source: { type: 'text', selector: '.nope', defaultValue: '未知来源' } },
    })
    expect(result.fields.source?.value).toBe('未知来源')
    expect(result.fields.source?.ok).toBe(true)
  })
})

describe('数据管道：JSON 响应', () => {
  it('按 jsonPath 提取文章', async () => {
    const body = JSON.stringify({
      code: 0,
      data: {
        title: '接口文章',
        content: '<p>接口正文</p>',
        author: '李四',
        publishedAt: '2026-01-05',
      },
    })

    const result = await runPipeline({
      siteId: '1',
      categoryId: '10',
      url: 'https://api.example.com/articles/1',
      body,
      contentType: 'json',
      fields: {
        title: { type: 'text', jsonPath: 'data.title', required: true },
        content: { type: 'text', jsonPath: 'data.content' },
        author: { type: 'text', jsonPath: 'data.author' },
        publishTime: { type: 'text', jsonPath: 'data.publishedAt' },
      },
    })

    expect(result.article?.title).toBe('接口文章')
    expect(result.article?.author).toBe('李四')
    expect(result.article?.articleTime).toBe('2026-01-05')
  })

  it('非法 JSON 直接返回解析错误', async () => {
    const result = await runPipeline({
      ...baseInput,
      contentType: 'json',
      body: '{not json}',
    })
    expect(result.article).toBeNull()
    expect(result.errors[0]).toContain('JSON 解析失败')
  })
})
