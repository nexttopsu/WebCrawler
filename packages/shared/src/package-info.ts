/**
 * 工作空间包的元信息。
 * 服务端的 `/api/system/info` 会把各包的名称与版本一并返回，便于确认实际加载的模块。
 */
export interface PackageInfo {
  name: string
  version: string
  description: string
}

export const SHARED_PACKAGE: PackageInfo = {
  name: '@webcrawler/shared',
  version: '0.6.0',
  description: '公共类型与常量',
}
