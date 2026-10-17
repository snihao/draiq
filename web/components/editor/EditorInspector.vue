<template>
  <aside
    class="editor-inspector relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-slate-200/80 bg-[#fbfcfc] transition-[width] duration-200 dark:border-white/10 dark:bg-[#18211f]"
    :style="{ width: `${collapsed ? COLLAPSED_WIDTH : width}px` }"
    aria-label="编辑器检查器"
  >
    <template v-if="collapsed">
      <n-tooltip trigger="hover" placement="left">
        <template #trigger>
          <button class="mx-auto mt-3 grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-[#EAF1F9] hover:text-[#2764AF] dark:hover:bg-white/10" aria-label="展开检查器" @click="toggleCollapsed">
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        </template>
        展开属性面板
      </n-tooltip>
      <div class="mt-5 select-none text-center text-[10px] font-semibold tracking-[0.18em] text-slate-400 [writing-mode:vertical-rl]">INSPECTOR</div>
    </template>

    <template v-else>
      <div
        class="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize after:absolute after:left-[3px] after:top-1/2 after:h-10 after:w-px after:-translate-y-1/2 after:bg-slate-300 after:opacity-0 after:transition hover:after:opacity-100 dark:after:bg-slate-600"
        @pointerdown="startResize"
      />

      <div class="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/80 px-3 dark:border-white/10">
        <div>
          <div class="text-xs font-semibold text-slate-800 dark:text-slate-100">检查器</div>
          <div class="text-[10px] text-slate-400">属性与图层结构</div>
        </div>
        <n-button quaternary circle size="tiny" aria-label="收起检查器" @click="toggleCollapsed">
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="m15 6-6 6 6 6" />
            </svg>
          </template>
        </n-button>
      </div>

      <n-tabs v-model:value="activeTab" type="line" size="small" animated class="inspector-tabs">
        <n-tab-pane name="properties" tab="属性" display-directive="show">
          <EditorProperties />
        </n-tab-pane>
        <n-tab-pane name="entities" tab="图层与图元" display-directive="show">
          <EditorEntityList />
        </n-tab-pane>
      </n-tabs>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'
import EditorProperties from '#draiq/components/editor/EditorProperties.vue'
import EditorEntityList from '#draiq/components/editor/EditorEntityList.vue'

const MIN_WIDTH = 286
const MAX_WIDTH = 460
const COLLAPSED_WIDTH = 44

const editor = inject(editorKey)!
const activeTab = ref<'properties' | 'entities'>('properties')
const width = ref(326)
const props = defineProps<{ initiallyCollapsed?: boolean }>()
const collapsed = ref(props.initiallyCollapsed ?? false)
let resizeStart: { clientX: number; width: number } | null = null

/** 切换检查器收起状态，并让画布跟随新空间重新测量 */
function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
  requestAnimationFrame(editor.resizeCanvas)
}

/** 开始拖拽检查器左边缘 */
function startResize(event: PointerEvent): void {
  resizeStart = { clientX: event.clientX, width: width.value }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onResize)
  window.addEventListener('pointerup', stopResize, { once: true })
}

/** 按指针位移调整检查器宽度 */
function onResize(event: PointerEvent): void {
  if (!resizeStart) return
  const next = resizeStart.width + resizeStart.clientX - event.clientX
  width.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))
}

/** 结束检查器尺寸调整 */
function stopResize(): void {
  resizeStart = null
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onResize)
  requestAnimationFrame(editor.resizeCanvas)
}

onBeforeUnmount(stopResize)

// Tabs 的显示状态切换完成后重新测量 Canvas，避免第三方组件过渡影响尺寸缓存。
watch(activeTab, async () => {
  await nextTick()
  requestAnimationFrame(editor.resizeCanvas)
})
</script>

<style scoped>
@media (max-width: 1199px) {
  .editor-inspector {
    display: none;
  }
}

/* Naive UI Tabs 需要填满检查器剩余高度，面板内部才能独立滚动。 */
.inspector-tabs {
  display: flex;
  width: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}
.inspector-tabs :deep(.n-tabs-nav) {
  flex: none;
  padding: 0 12px;
}
.inspector-tabs :deep(.n-tabs-pane-wrapper),
.inspector-tabs :deep(.n-tab-pane) {
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.inspector-tabs :deep(.n-tabs-pane-wrapper) {
  display: flex;
  flex: 1;
  flex-direction: column;
}
</style>
