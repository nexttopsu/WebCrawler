import { z } from 'zod'
import { jsonOk } from '../lib/response.js'
import { parseOptionalBody } from '../lib/validation.js'
import {
  applySettings,
  buildSettingsDto,
  parseSettingsPatch,
  saveSettings,
} from '../services/settings-service.js'
import type { ServiceDeps } from './deps.js'
import type { ApiRoute } from './types.js'

/** 原始请求体：键名与类型都交给 `parseSettingsPatch` 做白名单校验，好给出中文报错。 */
const rawPatchSchema = z.record(z.string(), z.unknown())

/**
 * 系统设置。
 *
 * GET 返回可编辑项 + 只读运行信息；PATCH 只接受白名单键，
 * 保存后立即作用到运行时（并发、限速、日志级别、时区、默认代理），
 * 响应里的 `applied` 标明本次真正生效的键。
 */
export function settingRoutes(deps: ServiceDeps): ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/settings',
      handler: (event) => jsonOk(event, buildSettingsDto(deps.config)),
    },
    {
      method: 'PATCH',
      path: '/api/settings',
      handler: async (event) => {
        const raw = (await parseOptionalBody(event, rawPatchSchema)) ?? {}
        const patch = parseSettingsPatch(raw)
        const values = saveSettings(patch)
        const applied = applySettings(values, {
          runtime: deps.runtime,
          logger: deps.logger,
          config: deps.config,
        })
        return jsonOk(event, { ...buildSettingsDto(deps.config), applied })
      },
    },
  ]
}
