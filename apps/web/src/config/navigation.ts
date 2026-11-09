import type { Component } from 'vue'
import {
  Activity,
  ArrowLeftRight,
  Braces,
  FileText,
  FlaskConical,
  FolderTree,
  Globe,
  LayoutDashboard,
  ListChecks,
  Puzzle,
  ScrollText,
  Settings,
} from '@lucide/vue'

export interface NavItem {
  label: string
  icon: Component
  to: string
  /** 分组名，侧栏与面包屑共用 */
  group: string
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

/**
 * 一级导航。
 *
 * 顺序与任务书一致：仪表盘 → 站点 → 栏目 → 规则 → 测试器 → 任务 → 文章 → 代理 → 插件 → 日志 → 设置。
 * 分组只影响视觉层次，不影响权限（本版本没有权限体系）。
 */
export const navigation: NavItem[] = [
  { label: '仪表盘', icon: LayoutDashboard, to: '/', group: '概览' },
  { label: '网站管理', icon: Globe, to: '/sites', group: '采集配置' },
  { label: '栏目管理', icon: FolderTree, to: '/categories', group: '采集配置' },
  { label: '采集规则', icon: ListChecks, to: '/rules', group: '采集配置' },
  { label: '规则测试器', icon: FlaskConical, to: '/tester', group: '采集配置' },
  { label: '采集任务', icon: Activity, to: '/tasks', group: '运行监控' },
  { label: '文章数据', icon: FileText, to: '/articles', group: '运行监控' },
  { label: '日志中心', icon: ScrollText, to: '/logs', group: '运行监控' },
  { label: '代理管理', icon: ArrowLeftRight, to: '/proxies', group: '系统资源' },
  { label: '插件管理', icon: Puzzle, to: '/plugins', group: '系统资源' },
  { label: '系统设置', icon: Settings, to: '/settings', group: '系统资源' },
  { label: '接口文档', icon: Braces, to: '/docs', group: '系统资源' },
]

/** 按分组归并，侧栏按组渲染。 */
export const navigationGroups: NavGroup[] = navigation.reduce<NavGroup[]>((groups, item) => {
  const existing = groups.find((group) => group.label === item.group)
  if (existing) existing.items.push(item)
  else groups.push({ label: item.group, items: [item] })
  return groups
}, [])
