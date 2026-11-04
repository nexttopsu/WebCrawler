/**
 * 示例内置插件 · 解析器（列表 + 详情）
 *
 * 解析器不抓页面：平台已经按规则抽好字段，插件拿到「url + 当前字段对象」做二次处理，
 * 返回的对象直接用于保存。想改字段就返回新对象，不想改就原样 return `fields`。
 *
 * 两个函数同样可以只写一个：`parseList` 只作用于列表阶段，`parseDetail` 只作用于详情阶段。
 */
import { definePlugin } from '../../plugin-system/sdk.js'

/** 去掉首尾空白与连续空白；非字符串原样返回。 */
function tidy(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.replace(/\s+/g, ' ').trim()
}

/** 把 2026/01/01、2026年1月1日 10:00 之类统一成 2026-01-01 / 2026-01-01 10:00。 */
function normalizeDate(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const match = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?/.exec(value)
  if (!match) return tidy(value)
  const [, year, month, day, hour, minute] = match
  const date = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`
  return hour && minute ? `${date} ${hour.padStart(2, '0')}:${minute}` : date
}

export default definePlugin({
  config: {
    id: 'example-parser-clean',
    name: '示例 · 字段清洗',
    type: 'parser',
    version: '1.0.0',
    description: '演示 parseList / parseDetail：清洗空白、补默认作者、统一时间格式',
  },

  /** 列表阶段：每个列表条目执行一次。 */
  async parseList(url, fields, ctx) {
    ctx.logger.info(`清洗列表条目：${url}`)
    return {
      ...fields,
      title: tidy(fields.title),
      summary: tidy(fields.summary),
    }
  },

  /** 详情阶段：整篇文章执行一次。 */
  async parseDetail(url, fields, ctx) {
    ctx.logger.info(`清洗详情字段：${url}`)
    return {
      ...fields,
      title: tidy(fields.title),
      author: tidy(fields.author) || '佚名',
      articleTime: normalizeDate(fields.articleTime),
      summary: tidy(fields.summary),
    }
  },
})
