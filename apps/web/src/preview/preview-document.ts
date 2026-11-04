/**
 * 预览文档装配。
 *
 * 服务端返回的快照 HTML 已清洗（无 script / 事件属性 / 危险协议），
 * 直接放入 `sandbox="allow-scripts"` 的 iframe（srcdoc）展示。
 *
 * 隔离要点：
 * - iframe 无 allow-same-origin：opaque origin，读不到管理后台的任何数据；
 * - 无 allow-top-navigation / allow-popups：预览页无法导航父页面或弹窗。
 */

/** 快照为空时的占位文档。 */
export function emptyPreviewDocument(): string {
  return '<!doctype html><html><body style="font-family:sans-serif;color:#8a94a6;display:grid;place-items:center;height:100vh;margin:0">输入地址并点击「加载页面」开始</body></html>'
}

/** 装配最终放入 iframe srcdoc 的 HTML；快照为空时回退占位文档。 */
export function buildPreviewDocument(snapshotHtml: string): string {
  const html = snapshotHtml.trim()
  return html || emptyPreviewDocument()
}
