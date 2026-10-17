<template>
  <header class="flex h-12 shrink-0 items-center gap-1.5 border-b border-slate-200/80 bg-[#fbfcfc] px-2 text-slate-700 shadow-[0_1px_12px_rgba(32,61,58,0.05)] sm:h-14 sm:gap-3 sm:px-3 dark:border-white/10 dark:bg-[#18211f] dark:text-slate-200">
    <div class="flex min-w-0 items-center gap-3 sm:pr-2">
      <img src="/brand/draiq-icon.png" alt="Draiq" class="h-8 w-8 shrink-0 object-contain" />
      <div class="hidden min-w-0 sm:block">
        <div class="text-[13px] font-semibold text-slate-900 dark:text-white">Draiq</div>
        <div class="max-w-36 truncate text-[10px] text-slate-400">{{ editor.documentName.value }}</div>
      </div>
    </div>

    <div class="hidden h-5 w-px bg-slate-200 sm:block dark:bg-white/10" />

    <div class="flex items-center gap-1">
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button size="small" quaternary :disabled="isReadOnly" @click="triggerImport">
            <template #icon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 3v12m0-12L7.5 7.5M12 3l4.5 4.5" />
                <path d="M5 14v5h14v-5" />
              </svg>
            </template>
            <span class="hidden lg:inline">导入文件</span>
          </n-button>
        </template>
        导入 SVG 或 DXF 文件
      </n-tooltip>
      <input ref="fileInputRef" type="file" accept=".svg,.dxf,image/svg+xml,application/dxf" class="hidden" :disabled="isReadOnly" @change="onFileChange">

      <n-tooltip trigger="hover">
        <template #trigger>
      <n-button size="small" quaternary :disabled="!canUndo" @click="editor.undo()">
            <template #icon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M4 8v5h5" />
                <path d="M4.5 12.5A8 8 0 1 0 7 6.7L4 9" />
              </svg>
            </template>
          </n-button>
        </template>
        撤销 Ctrl+Z
      </n-tooltip>

      <n-tooltip trigger="hover">
        <template #trigger>
      <n-button size="small" quaternary :disabled="!canRedo" @click="editor.redo()">
            <template #icon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M20 8v5h-5" />
                <path d="M19.5 12.5A8 8 0 1 1 17 6.7L20 9" />
              </svg>
            </template>
          </n-button>
        </template>
        重做 Ctrl+Shift+Z
      </n-tooltip>
    </div>

    <div class="hidden h-5 w-px bg-slate-200 dark:bg-white/10 md:block" />
    <div class="hidden md:contents">
      <EditorTransformControls />
      <EditorTopologyControls />
      <EditorLayerManager />
      <EditorMeasurementPanel />
    </div>

    <div class="hidden h-5 w-px bg-slate-200 dark:bg-white/10 md:block" />

    <div class="hidden items-center gap-1 md:flex">
      <n-button size="small" quaternary :disabled="isReadOnly || !entitiesCount" @click="editor.autoGroupAll()">
        <template #icon>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="4" y="4" width="6" height="6" rx="1" />
            <rect x="14" y="4" width="6" height="6" rx="1" />
            <rect x="4" y="14" width="6" height="6" rx="1" />
            <rect x="14" y="14" width="6" height="6" rx="1" />
          </svg>
        </template>
        <span class="hidden xl:inline">智能组合</span>
      </n-button>
      <n-button size="small" quaternary :disabled="isReadOnly || !isGroupSelected" @click="editor.ungroupSelected()">
        <template #icon>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="4" y="4" width="6" height="6" rx="1" />
            <rect x="14" y="14" width="6" height="6" rx="1" />
            <path d="m10 10 4 4" stroke-dasharray="2 2" />
          </svg>
        </template>
        <span class="hidden xl:inline">解散组合</span>
      </n-button>
    </div>

    <div class="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
      <n-tooltip trigger="hover">
      <template #trigger>
        <n-button class="lg:hidden" size="small" quaternary circle aria-label="全屏横向工作区" @click="toggleLandscapeWorkspace">
          <template #icon>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
              <path d="M8 12h8m-3-3 3 3-3 3" />
            </svg>
          </template>
        </n-button>
      </template>
      {{ isFullscreen ? '退出全屏' : '全屏横向工作区' }}
      </n-tooltip>

      <n-popover trigger="click" placement="bottom-end" :width="190">
      <template #trigger>
        <n-button size="small" quaternary circle aria-label="更多操作">
          <template #icon>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
            </svg>
          </template>
        </n-button>
      </template>
      <div class="space-y-1">
        <button
          class="flex w-full items-center justify-between rounded-md px-2 py-[7px] text-xs text-[#526170] transition-colors duration-200 hover:bg-[#eef4fb] hover:text-[#2764af] sm:hidden dark:text-slate-300 dark:hover:bg-slate-700/40 dark:hover:text-sky-300"
            :disabled="isReadOnly || !entitiesCount"
          @click="editor.handleExport()"
        >
          <span>导出 DXF</span><span class="text-[10px]">文件</span>
        </button>
        <button
          class="flex w-full items-center justify-between rounded-md px-2 py-[7px] text-xs text-[#526170] transition-colors duration-200 hover:bg-[#eef4fb] hover:text-[#2764af] dark:text-slate-300 dark:hover:bg-slate-700/40 dark:hover:text-sky-300"
          @click="editor.fitView()"
        >
          <span>适配全部图形</span><kbd class="font-mono text-[9px] text-[#93a09f]">Shift+1</kbd>
        </button>
        <n-popconfirm @positive-click="editor.handleClear()">
          <template #trigger>
            <button class="flex w-full items-center justify-between rounded-md px-2 py-[7px] text-xs text-red-500 transition-colors duration-200 hover:bg-red-50 dark:hover:bg-red-950/30" :disabled="isReadOnly">
              <span>清空画布</span><span class="text-[10px]">不可撤回</span>
            </button>
          </template>
          确认清空当前画布？
        </n-popconfirm>
      </div>
      </n-popover>

      <n-button class="hidden sm:inline-flex" type="primary" size="small" :disabled="!entitiesCount" @click="editor.handleExport()">
      <template #icon>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
          <path d="M5 15v4h14v-4" />
        </svg>
      </template>
        <span>导出 DXF</span>
      </n-button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import EditorTransformControls from '#draiq/components/editor/EditorTransformControls.vue'
import EditorTopologyControls from '#draiq/components/editor/EditorTopologyControls.vue'
import EditorLayerManager from '#draiq/components/editor/EditorLayerManager.vue'
import EditorMeasurementPanel from './EditorMeasurementPanel.vue'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const fileInputRef = ref<HTMLInputElement | null>(null)
const isFullscreen = ref(false)

const isReadOnly = editor.loading
const canUndo = computed(() => !isReadOnly.value && editor.state.historyIndex > 0)
const canRedo = computed(() => !isReadOnly.value && editor.state.historyIndex < editor.state.history.length - 1)
const entitiesCount = computed(() => {
  void editor.dataVersion.value
  return editor.state.drawing.entities.length
})
const isGroupSelected = computed(() => editor.state.selectedIds.length === 1 && editor.findEntity(editor.state.selectedId)?.type === 'group')

onMounted(() => document.addEventListener('fullscreenchange', updateFullscreenState))
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', updateFullscreenState))

/** 同步浏览器全屏状态。 */
function updateFullscreenState(): void {
  isFullscreen.value = document.fullscreenElement !== null
  requestAnimationFrame(editor.resizeCanvas)
}

/** 由用户手势进入全屏并在浏览器支持时锁定横屏。 */
async function toggleLandscapeWorkspace(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen()
    screen.orientation?.unlock?.()
    return
  }
  const shell = document.querySelector<HTMLElement>('.editor-shell')
  try {
    if (shell?.requestFullscreen) await shell.requestFullscreen()
  } catch {
    // 浏览器拒绝全屏时继续尝试方向锁定，并保持紧凑布局可用。
  }
  const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> }
  try {
    await orientation?.lock?.('landscape')
  } catch {
    // iOS 等浏览器不支持方向锁定时，紧凑布局仍可正常使用。
  }
}

/**
 * 打开 SVG / DXF 文件选择器。
 * @returns 无返回值。
 * @author snihao
 */
function triggerImport(): void {
  if (isReadOnly.value) return
  fileInputRef.value?.click()
}

/**
 * 根据扩展名读取并导入选中的 SVG 或 DXF 文件。
 * @param event 文件输入变化事件。
 * @returns 文件导入完成后的异步结果。
 * @author snihao
 */
async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.name.toLowerCase().endsWith('.dxf')) await editor.handleImportDxf(file)
  else await editor.handleImportSvg(file)
  input.value = ''
}
</script>
