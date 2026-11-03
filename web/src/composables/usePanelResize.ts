import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * 三栏布局的拖拽分隔。
 *
 * 用「左侧占比 + 右侧占比」描述布局，中栏自动占剩余空间；
 * 两项都有 15%–70% 的范围约束，避免把任何一栏拖没。
 */
export function usePanelResize(containerRef: Ref<HTMLElement | null>) {
  const leftRatio = ref(0.42)
  const rightRatio = ref(0.24)

  let dragging: 'left' | 'right' | null = null

  const clamp = (value: number): number => Math.min(0.7, Math.max(0.15, value))

  function ratioFromEvent(event: MouseEvent): number {
    const container = containerRef.value
    if (!container) return 0
    const rect = container.getBoundingClientRect()
    return (event.clientX - rect.left) / rect.width
  }

  function onMove(event: MouseEvent): void {
    if (!dragging) return
    const ratio = ratioFromEvent(event)
    if (dragging === 'left') {
      // 左栏右边缘位置就是左栏占比
      leftRatio.value = clamp(ratio)
    } else {
      // 右栏左边缘位置 = 1 - 右栏占比
      rightRatio.value = clamp(1 - ratio)
    }
  }

  function stop(): void {
    dragging = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  function startLeftDivider(): void {
    dragging = 'left'
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  function startRightDivider(): void {
    dragging = 'right'
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  onMounted(() => {
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stop)
    stop()
  })

  return { leftRatio, rightRatio, startLeftDivider, startRightDivider }
}
