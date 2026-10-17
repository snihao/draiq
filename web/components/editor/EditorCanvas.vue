<template>
  <!-- 主画布：Canvas 2D 渲染区，承载指针/滚轮/键盘事件 -->
  <div
    class="relative min-h-0 flex-1 overflow-hidden rounded-md border border-slate-200/90 bg-[#f7f9f8] shadow-[0_12px_34px_rgba(42,68,65,0.10)] sm:rounded-[12px] dark:border-white/10 dark:bg-[#111817] dark:shadow-[0_12px_34px_rgba(0,0,0,0.18)]"
    :style="{ backgroundColor: editor.state.canvasBackground }"
  >
    <!-- 原始 DXF 高保真 WebGL 层；所有编辑交互仍由上层 Canvas 接管。 -->
    <canvas ref="dxfCanvasRef" class="pointer-events-none absolute inset-0 block h-full w-full" />
    <canvas
      ref="canvasRef"
      class="absolute inset-0 z-[1] block h-full w-full touch-none select-none overscroll-none"
      :class="canvasClass"
      @wheel.prevent="editor.onCanvasWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerleave="editor.onCanvasPointerLeave"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @dblclick="editor.onCanvasDoubleClick"
      @contextmenu.prevent
    />

    <EditorDynamicInput />

    <!-- 新增文字落脚点：明确文字基线起点，并连接到输入浮层。 -->
    <svg
      v-if="editor.textInput.value?.mode === 'create'"
      class="pointer-events-none absolute inset-0 z-[7] h-full w-full overflow-visible"
      aria-hidden="true"
    >
      <line
        :x1="editor.textInput.value.screenX"
        :y1="editor.textInput.value.screenY"
        :x2="textInputPosition.left"
        :y2="textInputPosition.top + 20"
        stroke="#2764AF"
        stroke-width="1"
        stroke-dasharray="4 4"
        opacity="0.72"
      />
      <circle
        :cx="editor.textInput.value.screenX"
        :cy="editor.textInput.value.screenY"
        r="5"
        fill="white"
        stroke="#2764AF"
        stroke-width="2"
      />
      <path
        :d="`M ${editor.textInput.value.screenX - 9} ${editor.textInput.value.screenY} H ${editor.textInput.value.screenX + 9} M ${editor.textInput.value.screenX} ${editor.textInput.value.screenY - 9} V ${editor.textInput.value.screenY + 9}`"
        stroke="#2764AF"
        stroke-width="1"
        opacity="0.9"
      />
    </svg>

    <!-- 画布文字编辑器：首次输入与双击编辑共用，支持多行。 -->
    <div
      v-if="editor.textInput.value"
      class="absolute z-[8] w-[300px] overflow-hidden rounded-xl border border-[#2764AF]/35 bg-white/95 shadow-[0_16px_42px_rgba(39,100,175,0.22)] ring-1 ring-white/80 backdrop-blur dark:border-[#7FADE3]/30 dark:bg-[#182321]/95 dark:ring-white/5"
      :style="textInputStyle"
      @pointerdown.stop
    >
      <div class="flex items-center justify-between border-b border-slate-200/80 px-3 py-2 dark:border-white/10">
        <div>
          <div class="text-xs font-semibold text-slate-700 dark:text-slate-100">
            {{ editor.textInput.value.mode === 'edit' ? '编辑文字' : '添加文字' }}
          </div>
          <div class="mt-0.5 text-[10px] text-slate-400">Enter 换行 · Ctrl/⌘ + Enter 保存</div>
        </div>
        <button
          type="button"
          class="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 active:scale-95 dark:hover:bg-white/10 dark:hover:text-white"
          aria-label="取消文字编辑"
          @click="cancelTextInput"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="p-3">
        <textarea
          ref="textInputRef"
          v-model="editor.textInput.value.value"
          rows="4"
          class="block min-h-[104px] w-full resize-y rounded-lg border border-slate-200 bg-[#f8faf9] px-3 py-2.5 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-[#2764AF] focus:ring-2 focus:ring-[#2764AF]/15 dark:border-white/10 dark:bg-[#111a18] dark:text-white dark:focus:border-[#7FADE3]"
          placeholder="输入文字，支持多行…"
          :disabled="isReadOnly"
          @keydown="handleTextInputKeydown"
        />
        <div class="mt-3 flex items-center justify-end gap-2">
          <n-button size="small" quaternary @click="cancelTextInput">取消</n-button>
          <n-button size="small" type="primary" :disabled="isReadOnly || !editor.textInput.value.value.trim()" @click="confirmTextInput">
            {{ editor.textInput.value.mode === 'edit' ? '保存修改' : '添加文字' }}
          </n-button>
        </div>
      </div>
    </div>

    <!-- 加载遮罩 -->
    <div
      v-if="editor.loading.value"
      class="absolute inset-0 z-10 flex items-center justify-center bg-[#1E4F8D]/45 backdrop-blur-[2px]"
    >
      <n-spin size="large" />
      <span class="ml-3 text-white">{{ editor.loadingText.value }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'
import EditorDynamicInput from './EditorDynamicInput.vue'

const editor = inject(editorKey)!
const isReadOnly = editor.loading

/** 画布引用，同步给 composable */
const canvasRef = ref<HTMLCanvasElement | null>(null)
const dxfCanvasRef = ref<HTMLCanvasElement | null>(null)
const textInputRef = ref<HTMLTextAreaElement | null>(null)

/** 是否处于中键平移状态 */
const isPanning = ref(false)

/** 画布光标样式 */
const canvasClass = computed(() => {
  if (isPanning.value) return 'cursor-grabbing'
  if (editor.state.activeTool !== 'select') return 'cursor-crosshair'
  return 'cursor-default'
})

/** 把输入框限制在画布可视区域内 */
const textInputPosition = computed(() => {
  const input = editor.textInput.value
  const canvas = canvasRef.value
  if (!input || !canvas) return { left: 12, top: 12 }
  const left = Math.min(Math.max(12, input.screenX + 14), Math.max(12, canvas.clientWidth - 312))
  const top = Math.min(Math.max(12, input.screenY + 14), Math.max(12, canvas.clientHeight - 230))
  return { left, top }
})

/** 浮层定位样式。 */
const textInputStyle = computed(() => {
  const position = textInputPosition.value
  return { left: `${position.left}px`, top: `${position.top}px` }
})

watch(() => editor.textInput.value, async (input) => {
  if (!input) return
  await nextTick()
  // 等创建输入框的 pointerdown / pointerup / click 完整结束后再聚焦。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => textInputRef.value?.focus())
  })
})

// 子组件 onMounted 先于父组件执行：在此同步 DOM 引用给 composable
onMounted(() => {
  if (dxfCanvasRef.value) editor.initDxfCanvas(dxfCanvasRef.value)
  if (canvasRef.value) editor.initCanvas(canvasRef.value)
})

/** 指针按下：先检测中键平移，否则委托给编辑器 */
function onPointerDown(event: PointerEvent): void {
  if (event.button === 1) isPanning.value = true
  editor.onCanvasPointerDown(event)
}

/** 指针移动：委托给编辑器 */
function onPointerMove(event: PointerEvent): void {
  editor.onCanvasPointerMove(event)
}

/** 指针抬起：清除平移状态并委托给编辑器 */
function onPointerUp(event: PointerEvent): void {
  isPanning.value = false
  editor.onCanvasPointerUp(event)
}

/** 指针被系统取消时放弃当前未完成操作，避免提交断裂图元。 */
function onPointerCancel(event: PointerEvent): void {
  isPanning.value = false
  editor.onCanvasPointerCancel(event)
}

/** 确认文字输入。 */
function confirmTextInput(): void {
  if (!editor.textInput.value) return
  editor.confirmTextInput()
}

/** 取消文字输入 */
function cancelTextInput(): void {
  editor.cancelTextInput()
}

/** Enter 保留为换行，Ctrl/Cmd + Enter 保存，Esc 取消。 */
function handleTextInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelTextInput()
    return
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    confirmTextInput()
  }
}
</script>
