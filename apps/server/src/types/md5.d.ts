/**
 * `md5` 包的类型声明（https://www.npmjs.com/package/md5，无官方 types）。
 * 计算结果为 32 位十六进制小写字符串。
 */
declare module 'md5' {
  function md5(message: string | Buffer | Uint8Array): string
  export default md5
}
