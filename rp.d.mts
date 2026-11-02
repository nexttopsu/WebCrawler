import { AxiosInstance, AxiosRequestConfig } from 'axios';
import { WorkerOptions } from 'worker_threads';
import { EventEmitter } from 'events';
import iconvLite from 'iconv-lite';

interface ProxyConfig {
    /** 代理协议，默认 http */
    protocol?: 'http' | 'https';
    host: string;
    port: number;
    auth?: {
        username: string;
        password: string;
    };
}
interface RetryOptions {
    /** 重试次数（不含首次请求），默认 0 */
    retries?: number;
    /** 首次退避毫秒，默认 500 */
    delay?: number;
    /** 退避倍数，默认 2 */
    factor?: number;
    /** 单次退避上限毫秒，默认 10_000 */
    maxDelay?: number;
    /** 叠加随机抖动，避免多线程同时重试，默认 true */
    jitter?: boolean;
    /** 自定义重试判定；不传时按网络错误 / 408 / 425 / 429 / 500 / 502 / 503 / 504 判定 */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
}
interface HttpOptions extends AxiosRequestConfig {
    /** 代理配置。不传则直连，绝不偷偷挂代理 */
    proxy?: ProxyConfig;
    /** 失败重试。数字表示次数，对象可细调退避；默认不重试 */
    retry?: number | RetryOptions;
    /** 同一客户端两次请求的最小间隔（毫秒），用于限速。跨线程/跨进程不共享 */
    minInterval?: number;
    /** getText 的兜底编码，默认 'auto'：从响应头与 <meta charset> 推断，推断不出用 utf-8 */
    encoding?: string;
}
interface Http {
    /** 底层 axios 实例，需要更细粒度控制时使用 */
    readonly instance: AxiosInstance;
    /** 通用入口，适合 PUT/DELETE/HEAD 或需要读响应头的场景 */
    request<T = any>(config: AxiosRequestConfig): Promise<T>;
    get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>;
    post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T>;
    /** 抓网页：按 charset 自动解码为字符串（GBK 等非 UTF-8 站点不会乱码） */
    getText(url: string, config?: AxiosRequestConfig): Promise<string>;
    /** 以 Buffer 拉取二进制内容（图片、文件等） */
    getBuffer(url: string, config?: AxiosRequestConfig): Promise<Buffer>;
}
/** 从响应头与 HTML 头部嗅探编码：Content-Type 优先，其次 <meta charset> */
declare function detectCharset(headers: Record<string, any> | undefined, body: Buffer): string | undefined;
/**
 * 创建 HTTP 客户端。所有配置显式传入，无任何隐藏默认值。
 * 依赖官方 axios（>= 1.16.1 起原生支持 HTTPS 代理的 CONNECT 隧道）。
 *
 * @example
 * const http = createHttp({
 *     proxy: { host: '127.0.0.1', port: 1080 },
 *     retry: { retries: 3 },
 *     minInterval: 300,
 * });
 * const html = await http.getText('https://example.com');
 */
declare function createHttp(options?: HttpOptions): Http;

/**
 * 在 worker 文件中注册子线程任务处理器。
 * 主线程 import 该文件时是空操作；只有 worker_threads 派生的子线程会真正挂载消息监听。
 *
 * @example
 * // my-worker.ts
 * export const task = defineThreadTask(async (data: { url: string }) => {
 *     const html = await http.get(data.url);
 *     return parse(html);
 * });
 */
declare function defineThreadTask<T = any, R = any>(handler: (data: T) => Promise<R> | R): (data: T) => Promise<R>;
interface TaskPoolOptions {
    /** worker 文件路径，通常是 __filename */
    worker: string;
    /** 最大并发线程数，默认 3 */
    concurrency?: number;
    /** 透传给 worker_threads 的原始配置 */
    workerOption?: WorkerOptions;
    /**
     * 单个任务超时（毫秒），0 或不传表示不限。
     * 超时后该任务记为 timeout 失败，对应线程会被终止并重建——卡死的线程不能复用。
     */
    taskTimeout?: number;
    /**
     * 任务跑完后保留线程供下一批复用，默认 false（每次 run 结束即释放）。
     * 开启后请自行调用 dispose() 释放线程。
     */
    keepAlive?: boolean;
}
type TaskFailureReason = 'task' | 'timeout' | 'crash' | 'disposed';
interface TaskError {
    /** 对应的原始任务数据 */
    task: any;
    /** 错误消息 */
    error: string;
    /** 子线程里的原始堆栈 */
    stack?: string;
    /** 失败原因分类，便于上层统计 */
    reason: TaskFailureReason;
}
interface TaskOutcome<R = any> {
    task: any;
    ok: boolean;
    result?: R;
    error?: TaskError;
}
interface TaskPoolResult<R = any> {
    /** 成功结果，按任务提交顺序排列（不是完成顺序） */
    results: R[];
    errors: TaskError[];
    /** 每个任务的完整去向，成功/失败按提交顺序排列，便于和输入对齐 */
    items: TaskOutcome<R>[];
}
/**
 * 基于 worker_threads 的任务池。
 *
 * @example
 * const pool = new TaskPool({ worker: __filename, concurrency: cpus().length - 1 });
 * pool.on('progress', ({ done, total }) => console.log(`${done}/${total}`));
 * const { results, errors } = await pool.addTasks(tasks).run();
 */
declare class TaskPool<R = any> extends EventEmitter {
    private readonly workerPath;
    private readonly concurrency;
    private readonly workerOption;
    private readonly taskTimeout;
    private readonly keepAlive;
    private queue;
    private slots;
    /** 已派发但未结算的任务：id -> 任务数据 */
    private readonly inflight;
    /** 已结算的任务：id -> 结果 */
    private readonly outcomes;
    private nextId;
    private total;
    private done;
    private running;
    private resolvers;
    constructor(options: TaskPoolOptions);
    /** 添加单个任务 */
    addTask(task: any): this;
    /** 批量添加任务 */
    addTasks(tasks: any[]): this;
    /**
     * 启动任务池并等待全部任务完成。
     * 任务中途可继续 addTask，Promise 会在所有任务结束后才 resolve。
     * 单个任务失败（含超时、线程崩溃）不会中断整体，失败项收集在 errors 中，
     * 同时触发 'taskError' 事件。
     */
    run(): Promise<TaskPoolResult<R>>;
    /** 终止所有子线程并释放资源；未完成的任务按 disposed 记为失败，挂起的 run() 会以当前进度 resolve */
    dispose(): Promise<void>;
    /** dispose() 的别名，保持旧版语义：终止所有线程，丢弃未完成任务 */
    destroy(): Promise<void>;
    private pump;
    private spawn;
    private dispatch;
    private onMessage;
    /** 任务超时：只判该任务失败，并把这个卡住的线程换掉 */
    private onTimeout;
    /** 线程崩溃：只影响派发给这个线程的那一个任务 */
    private onCrash;
    private retire;
    private settle;
    private record;
    private checkDone;
    private finish;
    private terminateAll;
}

interface QueryOptions {
    /** 只取第一个匹配元素 */
    first?: boolean;
    /** 取第 N 个匹配元素（从 0 开始） */
    index?: number;
}
interface TextField extends QueryOptions {
    type: 'text';
    /** 元素选择器，空字符串表示当前节点自身 */
    selector: string;
    /** 未匹配时返回 null 而不是空字符串（用 nullable() 包一层） */
    nullable?: boolean;
}
interface HtmlField extends QueryOptions {
    type: 'html';
    selector: string;
    nullable?: boolean;
}
interface AttrField {
    type: 'attr';
    /** 属性名 */
    name: string;
    /** 可选的元素选择器，缺省时取当前节点自身的属性 */
    selector?: string;
    /** 取第 N 个匹配元素（从 0 开始） */
    index?: number;
    nullable?: boolean;
}
interface JsonField {
    type: 'json';
    /** 选择器，通常指向 <script type="application/ld+json"> */
    selector: string;
}
interface LoopField<S extends Schema | Field = Schema> {
    type: 'loop';
    /** 列表元素选择器 */
    selector: string;
    /** 单条模版：对象 schema → 对象数组；单个字段 → 标量数组 */
    schema: S;
}
interface ObjectField<S extends Schema = Schema> {
    type: 'object';
    /** 作用域选择器，缺省时在当前节点内查找 */
    selector?: string;
    schema: S;
}
type Field = TextField | HtmlField | AttrField | JsonField | LoopField<Schema | Field> | ObjectField;
type Schema = Record<string, Field>;
/** 提取文本 */
declare const text: (selector: string, options?: QueryOptions) => TextField;
/** 提取 innerHTML */
declare const html: (selector: string, options?: QueryOptions) => HtmlField;
/** 提取属性 */
declare const attr: (name: string, selector?: string, options?: QueryOptions) => AttrField;
/** 把元素文本当 JSON 解析（如 <script type="application/ld+json">） */
declare const json: (selector: string) => JsonField;
/** 遍历列表，每个元素按子 schema 解析为对象；schema 传单个字段时解析为标量数组 */
declare const loop: <S extends Schema | Field>(selector: string, schema: S) => LoopField<S>;
/** 在某个子树内解析，产出嵌套对象 */
declare function object<S extends Schema>(schema: S): ObjectField<S>;
declare function object<S extends Schema>(selector: string, schema: S): ObjectField<S>;
/** 让字段在未匹配时返回 null（类型同步变为 string | null） */
declare const nullable: <F extends Field>(field: F) => F & {
    nullable: true;
};
type Nullable<F> = F extends {
    nullable: true;
} ? string | null : string;
type FieldResult<F> = F extends LoopField<infer S> ? Array<S extends Schema ? ParsedResult<S> : Nullable<S>> : F extends ObjectField<infer S> ? ParsedResult<S> : F extends JsonField ? any : Nullable<F>;
type ParsedResult<S extends Schema> = {
    [K in keyof S]: FieldResult<S[K]>;
};
/**
 * 将 HTML 按 schema 解析为结构化对象，结果类型可自动推导。
 *
 * @example
 * const schema = {
 *     title: text('title'),
 *     h1:    html('h1.todo'),
 *     price: nullable(text('.price')),                       // 未匹配 → null
 *     first: text('li', { first: true }),                    // 只取第一个
 *     card:  object('.card', { name: text('h2') }),          // 子树内取多个字段
 *     ld:    json('script[type="application/ld+json"]'),     // JSON-LD
 *     list:  loop('#list li', {
 *         href: attr('data-href'),
 *         name: text('span'),
 *     }),
 * };
 * const data = html2object(html, schema);
 */
declare function html2object<S extends Schema>(htmlStr: string, schema: S, removeSelector?: string[]): ParsedResult<S>;

declare function delay(ms: number): Promise<void>;
declare function decode(buff: Buffer, encoding: string): string;
/** 把可能相对的链接解析为绝对地址；无法解析时原样返回 */
declare function resolveUrl(href: string, base?: string): string;
/** 取文档里的 <base href>，没有则返回 undefined */
declare function getBaseHref(html: string): string | undefined;
/**
 * 计算文档的基准地址：优先 <base href>（相对页面地址解析），否则用页面地址本身。
 * 抓取页面后用它把相对链接转成绝对链接。
 */
declare function getDocumentBase(html: string, pageUrl: string): string;

declare const utils_decode: typeof decode;
declare const utils_delay: typeof delay;
declare const utils_getBaseHref: typeof getBaseHref;
declare const utils_getDocumentBase: typeof getDocumentBase;
declare const utils_resolveUrl: typeof resolveUrl;
declare namespace utils {
  export {
    utils_decode as decode,
    utils_delay as delay,
    utils_getBaseHref as getBaseHref,
    utils_getDocumentBase as getDocumentBase,
    iconvLite as iconv,
    utils_resolveUrl as resolveUrl,
  };
}

export { TaskPool, attr, createHttp, defineThreadTask, detectCharset, html, html2object, json, loop, nullable, object, text, utils };
export type { AttrField, Field, HtmlField, Http, HttpOptions, JsonField, LoopField, ObjectField, ParsedResult, ProxyConfig, QueryOptions, RetryOptions, Schema, TaskError, TaskFailureReason, TaskOutcome, TaskPoolOptions, TaskPoolResult, TextField };
