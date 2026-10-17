<template>
  <n-popover trigger="click" placement="bottom-start" :width="258">
    <template #trigger>
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button size="small" quaternary :disabled="!result" aria-label="查看测量结果">
            <template #icon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M4 18 18 4l2 2L6 20z" />
                <path d="m8 16 2 2m1-5 2 2m1-5 2 2" />
              </svg>
            </template>
            <span class="hidden xl:inline">测量结果</span>
          </n-button>
        </template>
        测量结果
      </n-tooltip>
    </template>

    <div v-if="result" class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-semibold text-slate-700 dark:text-slate-100">{{ result.title }}</div>
          <div class="mt-0.5 text-[10px] text-slate-400">{{ result.entityId ? '来自当前图元' : '临时查询，不会创建实体' }}</div>
        </div>
        <n-button size="tiny" quaternary :aria-label="copied ? '已复制测量结果' : '复制测量结果'" @click="copyResult">
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="8" y="8" width="11" height="12" rx="1.5" />
              <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8" />
            </svg>
          </template>
          {{ copied ? '已复制' : '复制' }}
        </n-button>
      </div>
      <div class="divide-y divide-slate-100 rounded-lg border border-slate-200/80 bg-[#f8faf9] px-3 dark:divide-white/10 dark:border-white/10 dark:bg-[#111a18]">
        <div v-for="item in result.values" :key="`${item.label}-${item.kind}`" class="flex items-center justify-between gap-3 py-2 text-xs">
          <span class="text-slate-500 dark:text-slate-400">{{ item.label }}</span>
          <span class="font-mono tabular-nums text-slate-800 dark:text-slate-100">{{ formatValue(item.value, item.kind) }}</span>
        </div>
      </div>
    </div>
    <div v-else class="py-2 text-xs text-slate-400">暂无测量结果</div>
  </n-popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MeasurementValueKind } from '#draiq/utils/editor/measurement'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const result = computed(() => editor.measurement.value)
const copied = ref(false)

/** 按测量类别显示单位，不修改模型精确值。 */
function formatValue(value: number, kind: MeasurementValueKind): string {
  const digits = Math.abs(value) >= 1000 ? 2 : 4
  const number = Number(value.toFixed(digits)).toString()
  if (kind === 'angle') return `${number}°`
  if (kind === 'area') return `${number} ${editor.state.drawing.unit}²`
  return `${number} ${editor.state.drawing.unit}`
}

/** 将当前结果复制为纯文本，便于粘贴到 CAD 或工程记录。 */
async function copyResult(): Promise<void> {
  if (!result.value) return
  const text = [
    result.value.title,
    ...result.value.values.map((item) => `${item.label}: ${formatValue(item.value, item.kind)}`),
  ].join('\n')
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    window.setTimeout(() => { copied.value = false }, 1400)
  } catch {
    copied.value = false
  }
}
</script>
