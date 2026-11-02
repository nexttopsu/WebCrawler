<script setup lang="ts">
/**
 * 采集趋势图。
 *
 * 用 ECharts 按需引入（core + 柱状 + 折线 + 网格/提示/图例），
 * 颜色取自设计 Token，主题切换时重新 setOption 而不是重建实例。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { StatsTrendPoint } from '@webcrawler/shared'
import { useThemeStore } from '@/stores/theme'

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{ points: StatsTrendPoint[]; loading?: boolean }>()

const container = ref<HTMLDivElement | null>(null)
const theme = useThemeStore()
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function render(): void {
  if (!chart) return

  const textColor = cssVar('--wb-text-secondary', '#55606f')
  const mutedColor = cssVar('--wb-text-muted', '#8a94a6')
  const borderColor = cssVar('--wb-border', '#e6e9f0')
  const primary = cssVar('--wb-primary', '#2f6bff')
  const success = cssVar('--wb-success', '#12b76a')
  const danger = cssVar('--wb-danger', '#e5484d')

  chart.setOption(
    {
      grid: { left: 8, right: 12, top: 36, bottom: 6, containLabel: true },
      legend: {
        right: 0,
        top: 0,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: textColor, fontSize: 12 },
        data: ['入库文章', '完成任务', '失败任务'],
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: cssVar('--wb-surface', '#fff'),
        borderColor,
        textStyle: { color: cssVar('--wb-text', '#1b2432'), fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        data: props.points.map((point) => point.date.slice(5)),
        axisLine: { lineStyle: { color: borderColor } },
        axisTick: { show: false },
        axisLabel: { color: mutedColor, fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: borderColor, type: 'dashed' } },
        axisLabel: { color: mutedColor, fontSize: 11 },
      },
      series: [
        {
          name: '入库文章',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: primary, borderRadius: [4, 4, 0, 0] },
          data: props.points.map((point) => point.articles),
        },
        {
          name: '完成任务',
          type: 'line',
          smooth: true,
          symbolSize: 6,
          itemStyle: { color: success },
          lineStyle: { width: 2, color: success },
          data: props.points.map((point) => point.completedTasks),
        },
        {
          name: '失败任务',
          type: 'line',
          smooth: true,
          symbolSize: 5,
          itemStyle: { color: danger },
          lineStyle: { width: 1.5, color: danger, type: 'dashed' },
          data: props.points.map((point) => point.failedTasks),
        },
      ],
    },
    true,
  )
}

onMounted(() => {
  if (!container.value) return
  chart = echarts.init(container.value, undefined, { renderer: 'canvas' })
  render()

  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(container.value)
})

watch(() => props.points, render, { deep: true })
watch(() => theme.isDark, () => setTimeout(render, 30))

onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div ref="container" v-loading="loading" class="trend-chart" />
</template>

<style scoped>
.trend-chart {
  width: 100%;
  height: 280px;
}
</style>
