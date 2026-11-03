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
  crawlTime: '2026-02-01T00:00:00.000Z',
}

describe('数据管道：完整流程', () => {
  it('产出统一的 ArticleData', () => {
    const result = runPipeline(baseInput)

    expect(result.article).not.toBeNull()
    const article = result.article!

    expect(article.siteId).toBe('1')
    expect(article.categoryId).toBe('10')
    expect(article.title).toBe('第一篇报道：采集平台上线')
    expect(article.author).toBe('张三')
    expect(article.publishTime).toBe('2026-01-01 10:00')
    expect(article.url).toBe('https://example.com/news/1.html')
    expect(article.crawlTime).toBe('2026-02-01T00:00:00.000Z')
    expect(article.metadata).toMatchObject({ source: '本站' })
  })

  it('正文同时给出清洗后的 HTML 与纯文本', () => {
    const article = runPipeline(baseInput).article!

    expect(article.html).not.toContain('<script')
    expect(article.html).not.toContain('onclick')
    expect(article.html).not.toContain('javascript:')
    expect(article.html).not.toContain('这里是广告')
    expect(article.content).toContain('第一段正文')
    expect(article.content).not.toContain('document.write')
  })

  it('图片转为绝对地址并去重', () => {
    const article = runPipeline(baseInput).article!
    expect(article.images).toEqual([
      'https://example.com/images/a.png',
      'https://cdn.example.com/b.png',
    ])
  })

  it('正文 HTML 中的相对地址被改写为绝对地址', () => {
    const article = runPipeline(baseInput).article!
    expect(article.html).toContain('src="https://example.com/images/a.png"')
    expect(article.html).not.toContain('src="/images/a.png"')
  })

  it('不带协议前缀的站内相对图片不会被清洗掉', () => {
    // 不少 CMS 存的是 `upload/2026/a.jpg` 这种没有前导斜杠的相对地址。
    // 清洗阶段若按「不是 http(s) 就删掉」处理，图片和 images 列表会一起丢。
    const article = runPipeline({
      ...baseInput,
      body: `<html><body>
        <h1 class="article-title">相对图片</h1>
        <div class="article-content">
          <p>正文内容足够长，用来通过最基础的正文长度校验。</p>
          <img src="upload/20260101/a.jpg" alt="站内图" />
        </div>
      </body></html>`,
    }).article!

    expect(article.html).toContain('src="https://example.com/news/upload/20260101/a.jpg"')
    expect(article.images).toEqual(['https://example.com/news/upload/20260101/a.jpg'])
  })

  it('纯文本正文保留段落换行且不夹带多余空格', () => {
    const article = runPipeline(baseInput).article!
    expect(article.content).toContain('第一段正文')
    expect(article.content).not.toMatch(/\n\s+/)
  })

  it('内容 Hash 稳定且可区分不同内容', () => {
    const first = runPipeline(baseInput).article!
    const second = runPipeline(baseInput).article!
    expect(first.contentHash).toHaveLength(64)
    expect(first.contentHash).toBe(second.contentHash)

    const changed = runPipeline({
      ...baseInput,
      fields: { ...detailFields, title: { type: 'text', selector: '.author' } },
    }).article!
    expect(changed.contentHash).not.toBe(first.contentHash)
  })

  it('记录每个管道的执行阶段', () => {
    const result = runPipeline(baseInput)
    expect(result.steps.map((step) => step.stage)).toEqual([
      'parse',
      'clean',
      'validate',
      'normalize',
      'hash',
      'output',
    ])
    expect(result.steps.every((step) => step.ok)).toBe(true)
  })
})

describe('数据管道：封面图（预留字段）', () => {
  it('映射 cover 时转为绝对地址，且不混进 metadata', () => {
    const article = runPipeline({
      ...baseInput,
      fields: {
        ...detailFields,
        cover: { type: 'attr', selector: '.article-content img', attribute: 'src' },
      },
    }).article!

    expect(article.coverUrl).toBe('https://example.com/images/a.png')
    expect(article.metadata ?? {}).not.toHaveProperty('cover')
  })

  it('未映射封面时留空，正文图片照旧', () => {
    const article = runPipeline(baseInput).article!
    expect(article.coverUrl).toBeNull()
    expect(article.images.length).toBeGreaterThan(0)
  })

  it('coverUrl 字段同样识别，缺失或伪协议时为空', () => {
    const mapped = runPipeline({
      ...baseInput,
      fields: {
        ...detailFields,
        coverUrl: { type: 'text', selector: '.not-exist' },
      },
    }).article!
    expect(mapped.coverUrl).toBeNull()

    const javascript = runPipeline({
      ...baseInput,
      fields: {
        ...detailFields,
        cover: { type: 'text', selector: '.not-exist', defaultValue: 'javascript:alert(1)' },
      },
    }).article!
    expect(javascript.coverUrl).toBeNull()
  })
})

describe('数据管道：校验与失败处理', () => {
  it('必填字段缺失时不出文章', () => {
    const result = runPipeline({
      ...baseInput,
      fields: { title: { type: 'text', selector: '.not-exist', required: true } },
    })

    expect(result.article).toBeNull()
    expect(result.missing).toEqual(['title'])
    expect(result.errors.join()).toContain('title')
  })

  it('标题过短时校验失败', () => {
    const result = runPipeline({
      ...baseInput,
      validate: { minTitleLength: 100 },
    })

    expect(result.article).toBeNull()
    expect(result.errors.some((error) => error.includes('标题长度不足'))).toBe(true)
  })

  it('正文过短时校验失败', () => {
    const result = runPipeline({
      ...baseInput,
      validate: { minContentLength: 10_000 },
    })

    expect(result.article).toBeNull()
    expect(result.errors.some((error) => error.includes('正文长度不足'))).toBe(true)
  })

  it('字段全部缺失时应用默认值', () => {
    const result = runPipeline({
      ...baseInput,
      fields: { title: { type: 'text', selector: '.article-title' }, source: { type: 'text', selector: '.nope', defaultValue: '未知来源' } },
    })
    expect(result.fields.source?.value).toBe('未知来源')
    expect(result.fields.source?.ok).toBe(true)
  })
})

describe('数据管道：JSON 响应', () => {
  it('按 jsonPath 提取文章', () => {
    const body = JSON.stringify({
      code: 0,
      data: {
        title: '接口文章',
        content: '<p>接口正文</p>',
        author: '李四',
        images: ['https://cdn.example.com/1.png'],
        publishedAt: '2026-01-05',
      },
    })

    const result = runPipeline({
      siteId: '1',
      categoryId: '10',
      url: 'https://api.example.com/articles/1',
      body,
      contentType: 'json',
      crawlTime: '2026-02-01T00:00:00.000Z',
      fields: {
        title: { type: 'text', jsonPath: 'data.title', required: true },
        content: { type: 'text', jsonPath: 'data.content' },
        author: { type: 'text', jsonPath: 'data.author' },
        publishTime: { type: 'text', jsonPath: 'data.publishedAt' },
        images: { type: 'text', jsonPath: 'data.images[*]', multiple: true },
      },
    })

    expect(result.article?.title).toBe('接口文章')
    expect(result.article?.author).toBe('李四')
    expect(result.article?.publishTime).toBe('2026-01-05')
    expect(result.article?.images).toEqual(['https://cdn.example.com/1.png'])
  })

  it('非法 JSON 直接返回解析错误', () => {
    const result = runPipeline({
      ...baseInput,
      contentType: 'json',
      body: '{not json}',
    })
    expect(result.article).toBeNull()
    expect(result.errors[0]).toContain('JSON 解析失败')
  })
})
