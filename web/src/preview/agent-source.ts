/**
 * 预览文档装配。
 *
 * 服务端返回的快照 HTML 已清洗（无 script / 事件属性 / 危险协议），
 * 这里把自包含的注入脚本（Selector 生成器 + 预览代理）以 IIFE 形式拼进去，
 * 由前端放进 `sandbox="allow-scripts"` 的 iframe（srcdoc）执行。
 *
 * 隔离要点：
 * - iframe 无 allow-same-origin：opaque origin，读不到管理后台的任何数据；
 * - 无 allow-top-navigation / allow-popups：预览页无法导航父页面或弹窗；
 * - 注入脚本是唯一受控入口，消息协议见 packages/shared/src/tester.ts。
 */
import agentSource from './preview-agent.js?raw'
import generatorSource from './selector-generator.js?raw'

/** 注入脚本全文（按依赖顺序拼接：生成器在前，代理在后）。 */
export const PREVIEW_AGENT_SCRIPT = `${generatorSource}\n${agentSource}`

/** 防 `</script>` 提前闭合（快照已清洗，这里是对注入代码自身的防御性转义）。 */
function inlineScript(code: string): string {
  const escaped = code.replace(/<\/script/gi, '<\\/script')
  return `<script>${escaped}</script>`
}

/**
 * 装配最终放入 iframe srcdoc 的完整 HTML。
 * 快照来自可信的服务端清洗输出，这里只负责把脚本挂到文档尾部。
 */
export function buildPreviewDocument(snapshotHtml: string, agentScript: string = PREVIEW_AGENT_SCRIPT): string {
  const html = snapshotHtml.trim()
  const script = inlineScript(agentScript)
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`)
  }
  return `${html}${script}`
}
