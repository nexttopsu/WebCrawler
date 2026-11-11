/**
 * 解析器插件 `parser-content-plaintext` 验收。
 *
 * 重点验证两件事：
 * 1. 分段正确——块级标签产生空行、br/列表项产生单换行、script/style/注释被剔除、
 *    实体被解码（这正是平台 htmlToText 做不到的：它会把段落全部粘连）；
 * 2. parseDetail 的字段语义——只动 content，其它字段原样透传，
 *    空值与非字符串不碰，转完为空时保留原值。
 */
import { describe, expect, it } from 'vitest'
import { htmlToParagraphText, default as plugin } from '../../src/plugins/parsers/content-plaintext.js'
import { validatePluginModule, type PluginContext } from '../../src/plugin-system/index.js'

const ctx: PluginContext = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as PluginContext

describe('htmlToParagraphText', () => {
  it('块级标签之间用空行分段', () => {
    expect(htmlToParagraphText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n\n第二段')
  })

  it('嵌套容器与标题不产生多余空行', () => {
    const html = '<div><h2>标题</h2><p>正文内容</p></div><div>尾部</div>'
    expect(htmlToParagraphText(html)).toBe('标题\n\n正文内容\n\n尾部')
  })

  it('br 与列表项产生单换行', () => {
    expect(htmlToParagraphText('a<br>b<br/>c')).toBe('a\nb\nc')
    const list = '<ul><li>一</li><li>二</li></ul><p>结尾</p>'
    expect(htmlToParagraphText(list)).toBe('一\n二\n\n结尾')
  })

  it('script / style / 注释 / 模板整体剔除', () => {
    const html = [
      '<p>开头</p>',
      '<script>alert(1)</script>',
      '<style>.a{color:red}</style>',
      '<!-- 注释 -->',
      '<template><span>模板内容</span></template>',
      '<p>结尾</p>',
    ].join('')
    expect(htmlToParagraphText(html)).toBe('开头\n\n结尾')
  })

  it('HTML 实体解码（命名与数字）', () => {
    expect(htmlToParagraphText('<p>a&nbsp;&amp;&nbsp;b</p>')).toBe('a & b')
    expect(htmlToParagraphText('<p>&#8212;&#x2014;</p>')).toBe('——')
    // 解码出的 < > 不应被当成标签删除
    expect(htmlToParagraphText('<p>&lt;br&gt;</p>')).toBe('<br>')
  })

  it('正文里的 < 数字与半开标签不受影响', () => {
    expect(htmlToParagraphText('<p>得分 <3 分，价格 <b>高</b>')).toBe('得分 <3 分，价格 高')
  })

  it('行内空白折叠、零宽字符剔除（不补空格，与平台 cleanText 口径一致）、首尾修剪', () => {
    expect(htmlToParagraphText('  <p>a\u200bb\t c  </p>  ')).toBe('ab c')
  })

  it('纯文本输入只做空白归一并保留既有换行', () => {
    expect(htmlToParagraphText('第一段\n\n  第二  段 ')).toBe('第一段\n\n第二 段')
  })

  it('空输入返回空串', () => {
    expect(htmlToParagraphText('')).toBe('')
    expect(htmlToParagraphText('   ')).toBe('')
  })
})

describe('parser-content-plaintext 插件', () => {
  it('插件定义合法且只挂详情', () => {
    expect(validatePluginModule(plugin as never)).toBeNull()
    expect(plugin.config.type).toBe('parser')
    expect(plugin.parseDetail).toBeTypeOf('function')
    expect(plugin.parseList).toBeUndefined()
  })

  it('parseDetail 转换 content 并透传其它字段', async () => {
    const result = await plugin.parseDetail!(
      'https://example.com/a',
      {
        title: '标题',
        author: '作者',
        content: '<p>第一段</p><p>第二段</p>',
        extra: { keep: true },
      },
      ctx,
    )
    expect(result.content).toBe('第一段\n\n第二段')
    expect(result.title).toBe('标题')
    expect(result.author).toBe('作者')
    expect(result.extra).toEqual({ keep: true })
  })

  it('content 为空或非字符串时原样返回', async () => {
    const empty = await plugin.parseDetail!('u', { title: 't', content: '' }, ctx)
    expect(empty).toEqual({ title: 't', content: '' })

    const notString = await plugin.parseDetail!('u', { title: 't', content: null }, ctx)
    expect(notString).toEqual({ title: 't', content: null })
  })

  it('转换后为空（纯图片正文）时保留原值', async () => {
    const fields = { title: 't', content: '<img src="https://example.com/a.jpg">' }
    const result = await plugin.parseDetail!('u', fields, ctx)
    expect(result.content).toBe(fields.content)
  })
})
