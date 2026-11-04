import { ref, watch, type Ref } from 'vue'

/**
 * 逗号分隔列表的单行输入状态。
 *
 * 输入框与数组单向同步：打字时只把文本解析进数组（绝不回写字符串），
 * 这样用户敲的逗号 / 空格不会被立即「规范化」掉；只有数组被外部修改
 * （如导入规则、打开编辑弹窗）且与当前文本解析结果不一致时才回写文本。
 *
 * @param source 数组的 getter（响应式）
 * @param apply 把解析结果写回数组
 */
export function useCommaText(
  source: () => string[],
  apply: (value: string[]) => void,
): Ref<string> {
  const parse = (value: string): string[] =>
    value
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  const join = (list: string[]): string => list.join(', ')

  const text = ref(join(source()))

  watch(text, (value) => {
    apply(parse(value))
  })

  watch(source, (value) => {
    if (join(parse(text.value)) !== join(value)) {
      text.value = join(value)
    }
  })

  return text
}
