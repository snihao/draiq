<template>
  <!-- 小屏导航图：左下角概览，点击/拖拽平移主画布视口 -->
  <div class="editor-minimap absolute bottom-5 left-5 z-[5] overflow-hidden rounded-[10px] border border-slate-200/90 bg-white/92 shadow-[0_8px_24px_rgba(35,64,61,0.12)] backdrop-blur dark:border-white/10 dark:bg-[#1d2826]/92">
    <div class="flex h-6 items-center justify-between border-b border-slate-200/80 px-2 text-[9px] font-semibold tracking-[0.12em] text-slate-400 dark:border-white/10">
      <span>导航</span>
      <span>{{ editor.state.drawing.unit }}</span>
    </div>
    <canvas
      ref="minimapRef"
      class="block cursor-pointer"
      style="width: 168px; height: 116px;"
      @pointerdown="editor.onMinimapPointerDown"
      @pointermove="editor.onMinimapPointerMove"
      @pointerup="editor.onMinimapPointerUp"
      @pointercancel="editor.onMinimapPointerUp"
      @wheel.stop.prevent
    >
    </canvas>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!

/** 小屏画布引用 */
const minimapRef = ref<HTMLCanvasElement | null>(null)

// 子组件 onMounted 先于父组件执行：在此同步 DOM 引用给 composable
onMounted(() => {
  if (minimapRef.value) editor.initMinimap(minimapRef.value)
})
</script>

<style scoped>
@media (max-width: 899px) {
  .editor-minimap {
    display: none;
  }
}
</style>
