<template>
  <div class="editor-viewport-controls absolute bottom-3 right-3 z-[6] flex items-center gap-1 rounded-lg border border-slate-200/90 bg-white/90 p-1 shadow-[0_8px_22px_rgba(35,64,61,0.12)] backdrop-blur sm:bottom-5 sm:right-5 sm:rounded-[10px] dark:border-white/10 dark:bg-[#1d2826]/90">
    <n-tooltip trigger="hover">
      <template #trigger>
        <n-button quaternary circle size="small" aria-label="缩小" @click="editor.zoomOut()">
          <template #icon><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 12h12" /></svg></template>
        </n-button>
      </template>
      缩小
    </n-tooltip>
    <button class="min-w-[54px] rounded-md px-1.5 py-1 text-[11px] font-semibold tabular-nums text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10" title="恢复 100%" @click="editor.resetZoom()">
      {{ zoomPercent }}%
    </button>
    <n-tooltip trigger="hover">
      <template #trigger>
        <n-button quaternary circle size="small" aria-label="放大" @click="editor.zoomIn()">
          <template #icon><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 6v12M6 12h12" /></svg></template>
        </n-button>
      </template>
      放大
    </n-tooltip>
    <div class="mx-0.5 h-4 w-px bg-slate-200 dark:bg-white/10" />
    <n-tooltip trigger="hover">
      <template #trigger>
        <n-button quaternary circle size="small" aria-label="适配全部图形" @click="editor.fitView()">
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5" />
            </svg>
          </template>
        </n-button>
      </template>
      适配全部 Shift+1
    </n-tooltip>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const zoomPercent = computed(() => Math.max(1, Math.round(editor.viewport.scale * 100)))
</script>

<style scoped>
@media (max-width: 639px) {
  .editor-viewport-controls {
    position: fixed;
    right: 10px;
    bottom: 38px;
  }
}
</style>
