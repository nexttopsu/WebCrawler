import type { Server } from 'node:http'

export interface FixtureOptions {
  port?: number
  host?: string
}

export interface FixtureServer {
  server: Server
  origin: string
  close(): Promise<void>
}

/** 创建 fixture HTTP 服务（不自动监听）。 */
export function createFixtureServer(): Server

/** 监听随机端口（或指定端口）并返回 origin。 */
export function startFixture(options?: FixtureOptions): Promise<FixtureServer>
