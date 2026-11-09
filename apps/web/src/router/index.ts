import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import DefaultLayout from '@/layouts/DefaultLayout.vue'

/**
 * 路由表。
 *
 * 详情页用 `meta.crumb` 把标题追加到面包屑末尾（例如 采集任务 / 任务详情）。
 * 所有页面懒加载，首屏只加载布局与仪表盘。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: DefaultLayout,
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '仪表盘' },
      },
      {
        path: 'sites',
        name: 'sites',
        component: () => import('@/views/SitesView.vue'),
        meta: { title: '网站管理' },
      },
      {
        path: 'categories',
        name: 'categories',
        component: () => import('@/views/CategoriesView.vue'),
        meta: { title: '栏目管理' },
      },
      {
        path: 'rules',
        name: 'rules',
        component: () => import('@/views/RulesView.vue'),
        meta: { title: '采集规则' },
      },
      {
        path: 'tester',
        name: 'rule-tester',
        component: () => import('@/views/RuleTesterView.vue'),
        meta: { title: '规则测试器' },
      },
      {
        path: 'tasks',
        name: 'tasks',
        component: () => import('@/views/TasksView.vue'),
        meta: { title: '采集任务' },
      },
      {
        path: 'tasks/:id',
        name: 'task-detail',
        component: () => import('@/views/TaskDetailView.vue'),
        meta: { title: '任务详情', crumb: '任务详情' },
      },
      {
        path: 'articles',
        name: 'articles',
        component: () => import('@/views/ArticlesView.vue'),
        meta: { title: '文章数据' },
      },
      {
        path: 'articles/:id',
        name: 'article-detail',
        component: () => import('@/views/ArticleDetailView.vue'),
        meta: { title: '文章详情', crumb: '文章详情' },
      },
      {
        path: 'proxies',
        name: 'proxies',
        component: () => import('@/views/ProxiesView.vue'),
        meta: { title: '代理管理' },
      },
      {
        path: 'plugins',
        name: 'plugins',
        component: () => import('@/views/PluginsView.vue'),
        meta: { title: '插件管理' },
      },
      {
        path: 'logs',
        name: 'logs',
        component: () => import('@/views/LogsView.vue'),
        meta: { title: '日志中心' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '系统设置' },
      },
      {
        // 注意：不要用 /api-docs 这类以 /api 开头的路径，
        // 会被 Vite / Nginx 的 /api 前缀代理转发给后端
        path: 'docs',
        name: 'api-docs',
        component: () => import('@/views/ApiDocsView.vue'),
        meta: { title: '接口文档' },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.afterEach((to) => {
  const title = to.meta.title
  document.title = title ? `${title} · WebCrawler` : 'WebCrawler'
})

export default router
