<template>
  <!-- 坐标点输入行：X/Y 两个数字输入框 -->
  <div class="flex items-center gap-1.5 text-xs">
    <span class="w-12 shrink-0 text-gray-500">{{ label }}</span>
    <n-input-number
      :value="draftPoint[0]"
      :step="0.1"
      size="small"
      class="flex-1"
      :disabled="props.disabled"
      @update:value="(value: number | null) => updateDraft(0, value)"
      @blur="commitDraft(0)"
    />
    <n-input-number
      :value="draftPoint[1]"
      :step="0.1"
      size="small"
      class="flex-1"
      :disabled="props.disabled"
      @update:value="(value: number | null) => updateDraft(1, value)"
      @blur="commitDraft(1)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'
import { round } from '#draiq/utils/editor/geometry'

const props = defineProps<{
  /** 行标签 */
  label: string
  /** 坐标点 */
  point: Point
  /** 是否处于 CAD 只读锁定态。 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 坐标变化：axis 0=X 1=Y（实时预览，不入历史栈） */
  (e: 'change', axis: number, value: number): void
  /** 输入完成提交（入历史栈） */
  (e: 'commit'): void
}>()

const editor = inject(editorKey)!
const draftPoint = ref<Point>([round(props.point[0]), round(props.point[1])])

/** 当前模型坐标；显式依赖编辑器版本以跟踪非响应式坐标数组。 */
const modelPoint = computed<Point>(() => {
  void editor.dataVersion.value
  void editor.selectionVersion.value
  return [round(props.point[0]), round(props.point[1])]
})

watch(modelPoint, (point) => {
  draftPoint.value = point
}, { immediate: true })

/**
 * 更新坐标草稿并实时写入模型。
 * @param axis 坐标轴下标，0 表示 X，1 表示 Y。
 * @param value 输入框的新数值。
 * @returns 无返回值。
 * @author snihao
 */
function updateDraft(axis: number, value: number | null): void {
  if (props.disabled) return
  if (value === null || !Number.isFinite(value)) return
  draftPoint.value[axis] = value
  emit('change', axis, value)
}

/**
 * 失焦前再次写入当前草稿，再提交历史记录。
 * @param axis 坐标轴下标，0 表示 X，1 表示 Y。
 * @returns 无返回值。
 * @author snihao
 */
function commitDraft(axis: number): void {
  if (props.disabled) return
  emit('change', axis, draftPoint.value[axis])
  emit('commit')
}
</script>
