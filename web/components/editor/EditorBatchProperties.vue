<template>
  <section class="space-y-2 border-b border-slate-200/80 px-4 py-3 dark:border-white/10">
    <div class="text-[11px] font-semibold tracking-wide text-slate-500">批量属性</div>
    <div class="flex items-center gap-2">
      <span class="w-10 shrink-0 text-xs text-gray-500">图层</span>
      <n-input v-model:value="layer" size="small" :disabled="isReadOnly" placeholder="保持不变" />
    </div>
    <div class="flex items-center gap-2">
      <span class="w-10 shrink-0 text-xs text-gray-500">颜色</span>
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <input v-model="color" type="color" class="h-7 w-8 cursor-pointer rounded border border-slate-200 bg-transparent p-0.5 dark:border-white/10" :disabled="isReadOnly">
        <span class="truncate font-mono text-xs text-gray-400">{{ color }}</span>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <span class="w-10 shrink-0 text-xs text-gray-500">线宽</span>
      <n-input-number v-model:value="lineWidth" :min="0.1" :step="0.1" size="small" class="flex-1" :disabled="isReadOnly" placeholder="保持不变" />
    </div>
    <div class="flex items-center gap-2">
      <span class="w-10 shrink-0 text-xs text-gray-500">线型</span>
      <n-select v-model:value="lineType" :options="lineTypeOptions" size="small" class="flex-1" :disabled="isReadOnly" />
    </div>
    <n-button size="small" type="primary" block :disabled="isReadOnly" @click="applyStyle">应用到 {{ selectedCount }} 个图元</n-button>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const layer = ref('')
const color = ref('#2764AF')
const lineWidth = ref<number | null>(null)
const lineType = ref<LineType>('solid')
const selectedCount = computed(() => editor.state.selectedIds.length)
const isReadOnly = editor.loading
const lineTypeOptions = [
  { label: '实线', value: 'solid' },
  { label: '虚线', value: 'dashed' },
  { label: '点划线', value: 'dashdot' },
]

/** 用主选中实体初始化批量编辑值。 @returns 无返回值。 @author snihao */
function refreshValues(): void {
  const entity = editor.findEntity(editor.state.selectedId)
  if (!entity) return
  layer.value = entity.layer || ''
  color.value = entity.color || '#2764AF'
  lineWidth.value = entity.lineWidth
  lineType.value = entity.lineType || 'solid'
}

/** 将批量样式应用到当前选择。 @returns 无返回值。 @author snihao */
function applyStyle(): void {
  if (isReadOnly.value) return
  editor.applySelectedStyle({
    layer: layer.value.trim() || undefined,
    color: color.value.toUpperCase(),
    lineWidth: lineWidth.value == null ? undefined : Math.max(0.1, lineWidth.value),
    lineType: lineType.value,
  })
}

watch(() => editor.state.selectedIds.join('|'), refreshValues, { immediate: true })
</script>
