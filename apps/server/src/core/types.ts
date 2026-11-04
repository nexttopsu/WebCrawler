/**
 * 采集核心的类型入口。
 *
 * 数据契约统一放在 src/shared，这里只做「命名空间收敛」，
 * 让调用方可以从同一个包拿到引擎所需类型，同时避免循环依赖。
 */
import type { CrawlErrorStage } from '../shared/index.js'

/** 采集阶段，与错误记录中的 stage 取值一致。 */
export type CrawlStage = CrawlErrorStage

export type {
  ArticleData,
  ArticleLink,
  CrawlContext,
  CrawlLogger,
  CrawlRequestOptions,
  CrawlRuleConfig,
  FieldRule,
  RuleSnapshot,
  SiteSnapshot,
  CategorySnapshot,
} from '../shared/index.js'

export type {
  CrawlServices,
  CrawlEngineOptions,
  CategoryCrawlResult,
  CrawlErrorRecord,
  FetchedPage,
  ListPageResult,
} from './engine.js'
export type { ExtractionResult, FieldExtraction } from './parser/extract.js'
export type { PipelineInput, PipelineResult, PipelineStep } from './pipeline.js'
