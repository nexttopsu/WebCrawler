import type { ProxyDto } from '@webcrawler/shared'

/**
 * 代理地址格式化。
 *
 * 这些拼接刻意放在脚本里：模板表达式里出现 `://` 会让 vue-tsc 把后半个表达式
 * 当成注释，导致整段 `v-for` 的变量作用域丢失（表现为「Cannot find name 'proxy'」）。
 * 统一走工具函数后，模板里只剩一个函数调用，既规避该问题也避免重复拼接。
 */
export function proxyEndpoint(proxy: Pick<ProxyDto, 'type' | 'host' | 'port'>): string {
  return `${proxy.type}://${proxy.host}:${proxy.port}`
}

/** `名称 · 协议://主机:端口`，用于下拉选项。 */
export function proxyLabel(proxy: ProxyDto): string {
  return `${proxy.name || proxy.host} · ${proxyEndpoint(proxy)}`
}
