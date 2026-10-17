<template>
  <!-- 数字输入行 -->
  <div class="flex items-center gap-1.5 text-xs">
    <span class="w-12 shrink-0 text-gray-500">{{ label }}</span>
    <n-input-number
      :value="draftValue"
      :step="0.1"
      size="small"
      class="flex-1"
      :disabled="props.disabled"
      @update:value="handleValueUpdate"
      @blur="commitDraft"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { round } from '#draiq/utils/editor/geometry'

const props = defineProps<{
  /** 行标签 */
  label: string
  /** 数值 */
  value: number
  /** 是否处于 CAD 只读锁定态。 */
  disabled?: boolean
}>()

// 输入期间保留本地草稿，避免浅响应编辑器刷新打断 Naive UI 的输入状态。
const draftValue = ref(round(props.value))

watch(() => props.value, (value) => {
  if (Number.isFinite(value)) draftValue.value = round(value)
})

/**
 * 更新数字草稿并实时写入模型。
 * @param value 输入框的新数值。
 * @returns 无返回值。
 * @author snihao
 */
function handleValueUpdate(value: number | null): void {
  if (props.disabled) return
  if (value === null || !Number.isFinite(value)) return
  draftValue.value = value
  emit('change', value)
}

/**
 * 失焦前再次写入当前草稿，再提交历史记录。
 * @returns 无返回值。
 * @author snihao
 */
function commitDraft(): void {
  if (props.disabled) return
  emit('change', draftValue.value)
  emit('commit')
}

const emit = defineEmits<{
  /** 数值变化（实时预览，不入历史栈） */
  (e: 'change', value: number): void
  /** 输入完成提交（入历史栈） */
  (e: 'commit'): void
}>()
</script>
