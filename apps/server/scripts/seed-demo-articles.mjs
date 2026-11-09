#!/usr/bin/env node
/**
 * 往库里灌一批演示数据，配合 `apps/web/public/open-api-demo.html`（接口示例页）看效果。
 *
 *   node scripts/seed-demo-articles.mjs           # 重建演示数据（先删后插，可重复执行）
 *   node scripts/seed-demo-articles.mjs --clean   # 只清理演示数据
 *
 * 只动自己造的数据：
 *   - 站点 domain = demo.local
 *   - 栏目属于该站点
 *   - 文章链接以 https://demo.local/ 开头
 * 真实采集的站点/栏目/文章一条都不会被删改。
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLEAN_ONLY = process.argv.includes('--clean')
const DB_PATH = process.env.DB_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), '../data/webcrawler.db')

const DEMO_DOMAIN = 'demo.local'
const DEMO_URL_PREFIX = `https://${DEMO_DOMAIN}/`
/** 封面图放在前端 public 下，随示例页一起提供，不依赖外网 */
const COVER_PATH = ['/demo-covers/01.svg', '/demo-covers/02.svg', '/demo-covers/03.svg', '/demo-covers/04.svg', '/demo-covers/05.svg', '/demo-covers/06.svg', '/demo-covers/07.svg', '/demo-covers/08.svg']

const SITE = {
  name: '示例资讯站',
  description: '接口示例用的测试站点，数据由 scripts/seed-demo-articles.mjs 生成，可随时删除',
}

const CATEGORIES = [
  { name: '城市观察', code: 'demo-city', sortOrder: 10 },
  { name: '产业经济', code: 'demo-industry', sortOrder: 20 },
  { name: '文化生活', code: 'demo-culture', sortOrder: 30 },
  { name: '科技前沿', code: 'demo-tech', sortOrder: 40 },
  { name: '影像', code: 'demo-photo', sortOrder: 50 },
]

const AUTHORS = ['本报记者 陈默', '本报记者 林一', '本报记者 赵岚', '通讯员 周晓', '摄影 王岩']

/** 标题 + 摘要。[分类, 标题, 摘要] */
const ARTICLES = [
  ['城市观察', '老城区三条街道启动更新改造，居民议事会同步成立', '本次改造涉及 42 个院落、约 2100 户居民，先做管网与立面，再补绿地和停车位。'],
  ['城市观察', '地铁 6 号线二期首台盾构始发，预计 2027 年贯通', '二期全长 14.6 公里，设站 9 座，其中 4 座可换乘，建成后老城到新城约 20 分钟。'],
  ['城市观察', '早高峰公交专用道延长 3 公里，通勤时间平均缩短 8 分钟', '新增路段覆盖三个大型居住区，早 7 点至 9 点、晚 17 点至 19 点社会车辆禁行。'],
  ['城市观察', '社区食堂扩容，60 岁以上老人可享两荤一素套餐', '全区已建成 68 家社区食堂，统一菜品价格上限，行动不便的老人可申请送餐上门。'],
  ['城市观察', '城市体检报告发布：内涝点减少 12 处，老楼加装电梯 386 部', '报告同时指出停车缺口仍有 3.4 万个，下一步将利用桥下空间和边角地补建。'],
  ['城市观察', '夜间经济示范街区开街，首批 47 家商户入驻', '街区实行「外摆备案制」，商户可在划定区域内设置桌椅，营业时间延至次日凌晨 1 点。'],
  ['城市观察', '口袋公园新增 20 处，见缝插绿覆盖六个街道', '最小的一处只有 260 平方米，配了长椅和健身器材，由周边居民认养维护。'],
  ['城市观察', '生活垃圾分类投放点升级，误时投放有了智能柜', '全区 1260 个投放点完成改造，误时投放需刷卡开门，后台可追溯混投情况。'],

  ['产业经济', '前三季度规上工业增加值同比增长 6.4%', '装备制造和高技术制造业分别增长 9.1% 和 11.3%，是主要拉动力量。'],
  ['产业经济', '新材料产业园二期封顶，12 家企业签约入驻', '二期建筑面积 18 万平方米，配套建设中试平台和共享检测实验室。'],
  ['产业经济', '跨境电商出口单量翻倍，海外仓增至 18 个', '主要市场集中在东南亚与中东欧，小包平均时效从 12 天缩短到 7 天。'],
  ['产业经济', '专精特新企业新增 63 家，研发投入强度达 4.7%', '其中 11 家主导产品在国内细分市场占有率进入前三。'],
  ['产业经济', '港口集装箱吞吐量创单月新高', '当月完成 218 万标箱，同比增长 8.9%，外贸航线新增 3 条。'],
  ['产业经济', '智能网联汽车测试道路扩至 320 公里', '新增路段包含隧道、匝道和收费站场景，可支撑 L4 级自动驾驶测试。'],
  ['产业经济', '农产品区域公用品牌发布，首批授权 28 家企业', '品牌覆盖蔬菜、水果和水产三大类，统一质量标准与包装标识。'],

  ['文化生活', '城市图书馆夜间开放至 22 点，自习座位增至 800 个', '夜间时段以自习和讲座为主，读者可提前一天在线预约座位。'],
  ['文化生活', '非遗市集周末开市，20 位手艺人现场展示', '包含木版年画、竹编、面塑等项目，市集设在老城隍庙广场，免费入场。'],
  ['文化生活', '儿童剧演出季启幕，12 部剧目轮番上演', '演出季持续两个月，最低票价 60 元，每场保留 10% 的公益票。'],
  ['文化生活', '老厂房变身美术馆，首展聚焦工业记忆', '改造保留了原有的行车梁与红砖墙，展厅面积 4200 平方米。'],
  ['文化生活', '城市马拉松报名开启，赛道串联六个地标', '设全程、半程和 5 公里欢乐跑，报名需提交近一年的体检证明。'],
  ['文化生活', '社区书屋换新，新增童书与外文原版 3000 册', '书屋与市图书馆通借通还，居民凭身份证即可办证借阅。'],
  ['文化生活', '电影节露天放映排片公布，连续七晚免费入场', '放映地点在滨江草坪，需自带坐垫，现场提供字幕耳机租借。'],

  ['科技前沿', '城市大脑接入 5.2 万路视频，事件处置缩短至 4 分钟', '系统可自动识别占道经营、井盖缺失等 18 类事件并派单到属地。'],
  ['科技前沿', '政务大模型上线，136 项事项可对话办理', '支持自然语言描述需求，系统自动匹配事项并预填表单，仍需本人确认提交。'],
  ['科技前沿', '智能水表覆盖老旧小区，漏损率下降 9 个百分点', '首批改造 2.3 万户，异常用水会在 2 小时内推送提醒。'],
  ['科技前沿', '无人机巡检河道，单次覆盖 12 公里', '搭载可见光与热成像双光吊舱，可识别排污口和垃圾堆放点。'],
  ['科技前沿', '算力中心投运，首批 200P 智算资源开放申请', '面向本地中小企业和高校开放，按实际使用量计费，前三个月有补贴。'],
  ['科技前沿', '数字孪生平台完成主城区建模', '模型精度达到 5 厘米，可用于内涝推演和消防预案演练。'],
  ['科技前沿', '高校联合实验室发布开源数据集', '数据集包含 12 万条标注样本，覆盖交通、气象和能耗三类场景。'],

  ['影像', '图集：清晨的菜市场', '五点开市，摊主们把菜码得整整齐齐，第一批顾客多是附近餐馆的采购。'],
  ['影像', '图集：雪后老城', '雪停后的第二天，屋檐下的冰凌和巷子里的脚印成了主角。'],
  ['影像', '图集：港口夜航', '桥吊的灯光连成一条线，夜班工人正在为凌晨的班轮装船。'],
  ['影像', '图集：工地上的午后', '安全帽下的脸被晒得发红，钢筋绑扎的声音一整个下午没停过。'],
  ['影像', '图集：公园里的合唱团', '每周三上午，二十多位退休老人自带谱架，在湖边唱两个小时的歌。'],
  ['影像', '图集：老街理发店', '店里还留着八十年代的转椅，师傅给老顾客修面已经修了三十年。'],
  ['影像', '图集：桥下的篮球场', '高架桥挡住了正午的太阳，下班后这里就成了附近年轻人的主场。'],
]

/** 正文：把摘要展开成三段，纯文本（示例页按纯文本渲染）。 */
function buildContent(title, summary, category) {
  return [
    summary,
    `记者现场走访了解到，${category}相关工作已进入实施阶段，主管部门表示会按季度公开进展，接受社会监督。`,
    '本文为接口示例生成的测试数据，不代表真实事件，仅用于验证文章列表、文章详情与瀑布流渲染效果。',
  ].join('\n\n')
}

const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA busy_timeout = 5000')

/** 删除演示数据（真实数据不受影响）。 */
function clean() {
  const site = db.prepare('SELECT id FROM site WHERE domain = ?').get(DEMO_DOMAIN)
  if (!site) return { articles: 0, categories: 0, sites: 0 }

  const articles = db.prepare('DELETE FROM article WHERE url LIKE ?').run(`${DEMO_URL_PREFIX}%`).changes
  const categories = db.prepare('DELETE FROM category WHERE siteId = ?').run(site.id).changes
  const sites = db.prepare('DELETE FROM site WHERE id = ?').run(site.id).changes
  return { articles, categories, sites }
}

if (CLEAN_ONLY) {
  const removed = clean()
  console.log(`已清理演示数据：站点 ${removed.sites}、栏目 ${removed.categories}、文章 ${removed.articles}`)
  db.close()
  process.exit(0)
}

clean()

const insertSite = db.prepare(`
  INSERT INTO site (createdAt, updatedAt, name, domain, baseUrl, pluginName, status, description)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const siteInfo = insertSite.run(iso(now), iso(now), SITE.name, DEMO_DOMAIN, `https://${DEMO_DOMAIN}`, 'static', 'active', SITE.description)
const siteId = Number(siteInfo.lastInsertRowid)

const insertCategory = db.prepare(`
  INSERT INTO category (createdAt, updatedAt, siteId, name, code, listUrl, enabled, sortOrder, parentId)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const categoryIds = new Map()
for (const category of CATEGORIES) {
  const info = insertCategory.run(
    iso(now),
    iso(now),
    siteId,
    category.name,
    category.code,
    `${DEMO_URL_PREFIX}${category.code}`,
    1,
    category.sortOrder,
    null,
  )
  categoryIds.set(category.name, Number(info.lastInsertRowid))
}

const insertArticle = db.prepare(`
  INSERT INTO article (createdAt, updatedAt, siteId, categoryId, taskId, title, url, author, summary, content, rawHtml, coverUrl, extra, detailStatus, articleTime)
  VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, 'collected', ?)
`)

db.exec('BEGIN')
try {
  ARTICLES.forEach(([category, title, summary], index) => {
    // 每 4 篇留 1 篇没有封面（演示「暂无图片」占位），影像栏目则一律有图
    const hasCover = category === '影像' || index % 4 !== 3
    const coverUrl = hasCover ? COVER_PATH[index % COVER_PATH.length] : null

    // 时间从最近往前推，间隔 6~30 小时，保证排序与翻页效果自然
    const articleTime = now - (index * 19 + (index % 5) * 4) * 60 * 60 * 1000
    const url = `${DEMO_URL_PREFIX}article/${index + 1}.html`

    insertArticle.run(
      iso(articleTime),
      iso(articleTime),
      siteId,
      categoryIds.get(category),
      title,
      url,
      AUTHORS[index % AUTHORS.length],
      summary,
      buildContent(title, summary, category),
      coverUrl,
      iso(articleTime),
    )
  })
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}

const stats = db
  .prepare('SELECT COUNT(*) AS total, SUM(coverUrl IS NULL) AS noCover FROM article WHERE siteId = ?')
  .get(siteId)

console.log(`演示数据已写入 ${DB_PATH}`)
console.log(`  站点 #${siteId} ${SITE.name}（${DEMO_DOMAIN}）`)
console.log(`  栏目 ${CATEGORIES.length} 个：${CATEGORIES.map((c) => c.name).join('、')}`)
console.log(`  文章 ${stats.total} 篇，其中 ${stats.noCover} 篇没有封面（走「暂无图片」占位）`)
console.log('清理：node scripts/seed-demo-articles.mjs --clean')

db.close()
