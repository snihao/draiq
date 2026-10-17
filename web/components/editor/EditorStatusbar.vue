<template>
  <footer class="flex h-7 shrink-0 items-center gap-3 bg-[#1E4F8D] px-3 text-[10px] text-white/70 shadow-[0_-1px_8px_rgba(39,100,175,0.08)]">
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[#7FADE3] shadow-[0_0_0_3px_rgba(127,173,227,0.14)]" />
      <span class="truncate">{{ editor.statusText.value }}</span>
    </div>
    <EditorDraftingControls />
    <div class="hidden items-center gap-3 tabular-nums sm:flex">
      <span>{{ TOOL_LABELS[editor.state.activeTool] }}</span>
      <span class="h-3 w-px bg-white/15" />
      <span>{{ entityCount }} 个图元</span>
      <span class="h-3 w-px bg-white/15" />
      <span v-if="activePointer">X {{ pointerX }} · Y {{ pointerY }} {{ editor.state.drawing.unit }}</span>
      <span v-else>移动鼠标查看坐标</span>
      <span class="h-3 w-px bg-white/15" />
      <span>{{ zoomPercent }}%</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { TOOL_LABELS } from '#draiq/utils/editor/config'
import { round } from '#draiq/utils/editor/geometry'
import { editorKey } from '#draiq/composables/editorKey'
import EditorDraftingControls from '#draiq/components/editor/EditorDraftingControls.vue'

const editor = inject(editorKey)!
const entityCount = computed(() => {
  void editor.dataVersion.value
  return editor.state.drawing.entities.length
})
const zoomPercent = computed(() => Math.max(1, Math.round(editor.viewport.scale * 100)))
const activePointer = computed(() => editor.resolvedPointerPosition.value || editor.pointerPosition.value)
const pointerX = computed(() => round(activePointer.value?.x ?? 0))
const pointerY = computed(() => round(activePointer.value?.y ?? 0))
</script>
