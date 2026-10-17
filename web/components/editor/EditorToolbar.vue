<template>
  <nav
    class="flex shrink-0 flex-col overflow-hidden border-r border-slate-200/80 bg-[#f8faf9] py-2.5 transition-[width] duration-200 dark:border-white/10 dark:bg-[#18211f]"
    :class="effectiveExpanded ? 'w-[176px]' : 'w-[52px] sm:w-[60px]'"
    aria-label="绘图工具"
  >
    <div class="mb-1.5 flex h-7 shrink-0 items-center px-2" :class="effectiveExpanded ? 'justify-between' : 'justify-center'">
      <span v-if="effectiveExpanded" class="text-[9px] font-semibold tracking-[0.16em] text-slate-400">TOOLS</span>
      <n-tooltip v-if="!isCompact" trigger="hover" placement="right">
        <template #trigger>
          <button
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-100"
            :aria-label="effectiveExpanded ? '折叠工具栏' : '展开工具栏'"
            :aria-expanded="effectiveExpanded"
            @click="toggleExpanded"
          >
            <svg class="h-3.5 w-3.5 fill-none stroke-current stroke-[1.8]" viewBox="0 0 24 24" aria-hidden="true">
              <path v-if="effectiveExpanded" d="m15 6-6 6 6 6" stroke-linecap="round" stroke-linejoin="round" />
              <path v-else d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </template>
        {{ effectiveExpanded ? '折叠工具栏' : '展开工具栏' }}
      </n-tooltip>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <template v-for="(name, index) in TOOL_ORDER" :key="name">
        <div v-if="index === 1 || index === 5" class="mb-1 mt-2 flex h-4 items-center gap-2" aria-hidden="true">
          <span class="h-px flex-1 bg-slate-200 dark:bg-white/10" />
          <span v-if="effectiveExpanded" class="shrink-0 text-[9px] font-semibold text-slate-400">
            {{ index === 1 ? '推荐' : '其他工具' }}
          </span>
          <span v-if="effectiveExpanded" class="h-px flex-1 bg-slate-200 dark:bg-white/10" />
        </div>
        <n-tooltip trigger="hover" placement="right" :disabled="effectiveExpanded">
          <template #trigger>
            <button
              class="tool-button group relative"
              :disabled="isReadOnly && name !== 'select'"
              :class="{
                'tool-button-active': editor.state.activeTool === name,
                'tool-button-expanded': effectiveExpanded,
              }"
              :aria-label="`${TOOL_LABELS[name]}，快捷键 ${TOOL_SHORTCUTS[name]}`"
              @click="editor.setTool(name)"
            >
              <span
                v-if="editor.state.activeTool === name"
                class="absolute h-5 w-[3px] rounded-r bg-[#2764AF]"
                :class="effectiveExpanded ? '-left-2' : '-left-[10px]'"
              />
              <svg v-if="name === 'select'" viewBox="0 0 24 24"><path d="M4 3.5 19 11l-6.2 2.1L10.5 20 4 3.5Z" /></svg>
              <svg v-else-if="name === 'line'" viewBox="0 0 24 24"><path d="m5 19 14-14" /><circle cx="5" cy="19" r="1.4" /><circle cx="19" cy="5" r="1.4" /></svg>
              <svg v-else-if="name === 'polyline'" viewBox="0 0 24 24"><path d="m3 17 5-9 5 6 8-9" /></svg>
              <svg v-else-if="name === 'rectangle'" viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.5" /></svg>
              <svg v-else-if="name === 'circle'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>
              <svg v-else-if="name === 'arc'" viewBox="0 0 24 24"><path d="M5 17a8 8 0 0 1 14-10" /><circle cx="5" cy="17" r="1.4" /><circle cx="19" cy="7" r="1.4" /></svg>
              <svg v-else-if="name === 'ellipse'" viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8" ry="4.5" /></svg>
              <svg v-else-if="name === 'text'" viewBox="0 0 24 24"><path d="M5 7V5h14v2M12 5v14M8.5 19h7" /></svg>
              <svg v-else-if="name === 'annotate'" viewBox="0 0 24 24"><path d="m4 19 5-5 4-8h7l-4 8H9" /><circle cx="4" cy="19" r="1.3" /></svg>
              <svg v-else-if="name === 'angular'" viewBox="0 0 24 24"><path d="M5 19 12 5l7 14" /><path d="M8 14a6 6 0 0 1 8 0" /></svg>
              <svg v-else-if="name === 'radius'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" /><path d="M12 12 18 7" /><path d="M15 7h3v3" /></svg>
              <svg v-else-if="name === 'diameter'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" /><path d="m7 17 10-10" /><path d="m7 14v3h3m4-10h3v3" /></svg>
              <svg v-else-if="name === 'arcLength'" viewBox="0 0 24 24"><path d="M5 17a8 8 0 0 1 14-10" /><path d="m16 5 3 2-1 3" /><path d="M7 18h10" /></svg>
              <svg v-else-if="name === 'ordinate'" viewBox="0 0 24 24"><path d="M5 19V5m0 14h14" /><path d="M12 8h7m-7 0 3-3m-3 3 3 3" /><circle cx="5" cy="19" r="1.5" /></svg>
              <svg v-else-if="name === 'measure'" viewBox="0 0 24 24"><path d="M4 18 18 4l2 2L6 20z" /><path d="m8 16 2 2m1-5 2 2m1-5 2 2" /></svg>
              <svg v-else viewBox="0 0 24 24"><path d="M4 19c3-1 5-5 8-8s4-4 7-5m-4-1 4 4" /><path d="m18 3 3 3-3 3" /></svg>
              <span v-if="effectiveExpanded" class="min-w-0 flex-1 truncate text-left text-xs font-medium">
                {{ TOOL_LABELS[name] }}
              </span>
              <kbd v-if="effectiveExpanded" class="shrink-0 text-[9px] font-normal text-slate-400">
                {{ TOOL_SHORTCUTS[name] }}
              </kbd>
            </button>
          </template>
          <div class="flex min-w-28 items-center justify-between gap-5">
            <span>{{ TOOL_LABELS[name] }}</span>
            <kbd class="text-[10px] text-slate-400">{{ TOOL_SHORTCUTS[name] }}</kbd>
          </div>
        </n-tooltip>
      </template>
    </div>

    <div class="shrink-0 border-t border-slate-200/80 px-2 pt-2 dark:border-white/10">
      <n-popover trigger="click" placement="right-end" :width="232">
        <template #trigger>
          <button class="tool-button" :class="{ 'tool-button-expanded': effectiveExpanded }" :disabled="isReadOnly" aria-label="默认绘制设置">
            <svg viewBox="0 0 24 24"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1" /><circle cx="12" cy="12" r="3.5" /></svg>
            <span v-if="effectiveExpanded" class="min-w-0 flex-1 text-left text-xs font-medium">绘制设置</span>
          </button>
        </template>
        <div class="space-y-4 py-1">
        <div>
          <div class="text-xs font-semibold text-slate-700">画布设置</div>
          <div class="mt-1 text-[11px] leading-4 text-slate-400">只影响编辑区域，不影响 DXF 导出</div>
        </div>
        <label class="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>背景颜色</span>
          <div class="flex items-center gap-2">
            <input :value="editor.state.canvasBackground" type="color" class="h-7 w-8 cursor-pointer rounded border border-slate-200" :disabled="isReadOnly" @input="onCanvasBackgroundChange">
            <code class="text-[10px] text-slate-400">{{ editor.state.canvasBackground }}</code>
          </div>
        </label>
        <label class="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>辅助线条</span>
          <n-switch :value="editor.state.showCanvasGuides" size="small" :disabled="isReadOnly" @update:value="onCanvasGuidesChange" />
        </label>
        <div class="h-px bg-slate-100" />
        <div>
          <div class="text-xs font-semibold text-slate-700">默认绘制样式</div>
          <div class="mt-1 text-[11px] leading-4 text-slate-400">应用于接下来创建的新图元</div>
        </div>
        <label class="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>颜色</span>
          <div class="flex items-center gap-2">
            <input :value="editor.state.defaultColor" type="color" class="h-7 w-8 cursor-pointer rounded border border-slate-200" :disabled="isReadOnly" @input="onColorChange">
            <code class="text-[10px] text-slate-400">{{ editor.state.defaultColor }}</code>
          </div>
        </label>
        <label class="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>图层</span>
          <n-input :value="editor.state.defaultLayer" size="small" class="w-32" :disabled="isReadOnly" @update:value="onLayerChange" />
        </label>
        <label class="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>线宽</span>
          <n-input-number :value="editor.state.defaultLineWidth" :min="0.1" :step="0.1" size="small" class="w-32" :disabled="isReadOnly" @update:value="onLineWidthChange" />
        </label>
        <label class="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>字号</span>
          <n-input-number :value="editor.state.defaultFontSize" :min="1" :step="1" size="small" class="w-32" :disabled="isReadOnly" @update:value="onFontSizeChange" />
        </label>
        <label class="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>线型</span>
          <n-select :value="editor.state.defaultLineType" :options="lineTypeOptions" size="small" class="w-32" :disabled="isReadOnly" @update:value="onLineTypeChange" />
        </label>
        </div>
      </n-popover>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { TOOL_LABELS, TOOL_ORDER, TOOL_SHORTCUTS } from '#draiq/utils/editor/config'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const isExpanded = ref(true)
const isCompact = ref(false)
const isReadOnly = editor.loading
const effectiveExpanded = computed(() => isExpanded.value && !isCompact.value)
let compactQuery: MediaQueryList | null = null
const lineTypeOptions = [
  { label: '实线', value: 'solid' },
  { label: '虚线', value: 'dashed' },
  { label: '点画线', value: 'dashdot' },
]

onMounted(() => {
  const savedState = window.localStorage.getItem('editor.toolbarExpanded')
  if (savedState !== null) isExpanded.value = savedState === 'true'
  compactQuery = window.matchMedia('(max-width: 1199px)')
  updateCompactState(compactQuery)
  compactQuery.addEventListener('change', updateCompactState)
})

onBeforeUnmount(() => compactQuery?.removeEventListener('change', updateCompactState))

/** 同步紧凑工作区状态，小屏不覆盖用户保存的桌面工具栏偏好。 */
function updateCompactState(event: MediaQueryList | MediaQueryListEvent): void {
  isCompact.value = event.matches
}

/**
 * 切换工具栏的折叠状态并保存用户偏好。
 * @returns 无返回值。
 * @author snihao
 */
function toggleExpanded(): void {
  isExpanded.value = !isExpanded.value
  window.localStorage.setItem('editor.toolbarExpanded', String(isExpanded.value))
}

function onCanvasBackgroundChange(event: Event): void {
  if (isReadOnly.value) return
  editor.state.canvasBackground = (event.target as HTMLInputElement).value.toUpperCase()
  window.localStorage.setItem('editor.canvasBackground', editor.state.canvasBackground)
  editor.refreshCanvasAppearance()
}

function onCanvasGuidesChange(value: boolean): void {
  if (isReadOnly.value) return
  editor.state.showCanvasGuides = value
  window.localStorage.setItem('editor.showCanvasGuides', String(value))
  editor.refreshCanvasAppearance()
}

/** 更新新图元默认颜色 */
function onColorChange(event: Event): void {
  if (isReadOnly.value) return
  editor.state.defaultColor = (event.target as HTMLInputElement).value.toUpperCase()
}

/** 更新新图元默认图层 */
function onLayerChange(value: string): void {
  if (isReadOnly.value) return
  editor.state.defaultLayer = value.trim() || 'default'
}

/** 更新新图元默认线宽 */
function onLineWidthChange(value: number | null): void {
  if (isReadOnly.value) return
  if (value !== null && Number.isFinite(value)) editor.state.defaultLineWidth = Math.max(0.1, value)
}

function onFontSizeChange(value: number | null): void {
  if (isReadOnly.value) return
  if (value !== null && Number.isFinite(value)) editor.state.defaultFontSize = Math.max(1, value)
}

function onLineTypeChange(value: LineType): void {
  if (isReadOnly.value) return
  editor.state.defaultLineType = value
}
</script>

<style scoped>
/* 工具轨道按钮需要固定的 CAD 图标尺寸和清晰的按压反馈。 */
.tool-button {
  display: flex;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  color: #71807f;
  transition: color 180ms ease, background-color 180ms ease, transform 120ms ease;
}
.tool-button-expanded {
  width: 100%;
  justify-content: flex-start;
  gap: 10px;
  padding: 0 10px;
}
.tool-button:hover {
  color: #1e4f8d;
  background: #e9f1fb;
}
.tool-button:active {
  transform: translateY(1px) scale(0.98);
}
.tool-button-active {
  color: #235a9e;
  background: #dce8f7;
}
.tool-button svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
