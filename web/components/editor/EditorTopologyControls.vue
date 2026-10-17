<template>
  <n-popover trigger="click" placement="bottom-start" :width="330">
    <template #trigger>
      <n-tooltip trigger="hover">
        <template #trigger>
            <n-button size="small" quaternary :disabled="isReadOnly">
            <template #icon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M4 5h16M4 12h16M4 19h16" />
                <circle cx="8" cy="5" r="2" fill="currentColor" />
                <circle cx="16" cy="12" r="2" fill="currentColor" />
                <circle cx="10" cy="19" r="2" fill="currentColor" />
              </svg>
            </template>
            <span class="hidden xl:inline">拓扑编辑</span>
          </n-button>
        </template>
        偏移、修剪、延伸、打断和连接
      </n-tooltip>
    </template>

    <div class="space-y-3 py-1">
      <section class="space-y-1.5">
        <div class="text-[10px] font-semibold text-slate-500">轮廓修改</div>
        <div class="grid grid-cols-[1fr_auto_auto] items-center gap-1.5">
          <n-input-number v-model:value="offsetDistance" size="small" :show-button="false" :disabled="isReadOnly" placeholder="偏移距离" />
          <n-button size="small" :disabled="isReadOnly || !hasSelection" @click="applyOffset">偏移</n-button>
          <n-button size="small" :disabled="isReadOnly || selectedCount < 2" @click="applyJoin">连接</n-button>
        </div>
        <div class="grid grid-cols-3 gap-1.5">
          <n-button size="small" :disabled="isReadOnly || selectedCount < 2" @click="applyTrim">修剪</n-button>
          <n-button size="small" :disabled="isReadOnly || selectedCount < 2" @click="applyExtend">延伸</n-button>
          <n-button size="small" :disabled="isReadOnly || !hasSelection" @click="applyBreak">打断</n-button>
        </div>
        <div class="grid grid-cols-2 gap-1.5">
          <n-button size="small" :disabled="isReadOnly || !hasSelection" @click="applyClose">闭合/打开</n-button>
          <n-button size="small" :disabled="isReadOnly || !hasSelection" @click="editor.selectSimilar()">选择同类</n-button>
        </div>
      </section>

      <div class="h-px bg-slate-100 dark:bg-white/10" />

      <section class="space-y-1.5">
        <div class="text-[10px] font-semibold text-slate-500">选择管理</div>
        <div class="grid grid-cols-3 gap-1.5">
          <n-button size="small" :disabled="isReadOnly" @click="editor.selectAll()">全选</n-button>
          <n-button size="small" :disabled="isReadOnly" @click="editor.clearSelection()">取消</n-button>
          <n-button size="small" :disabled="isReadOnly" @click="editor.invertSelection()">反选</n-button>
        </div>
        <div class="grid grid-cols-[1fr_1fr] gap-1.5">
          <n-select v-model:value="filterType" size="small" clearable :disabled="isReadOnly" :options="typeOptions" placeholder="类型" />
          <n-input v-model:value="filterLayer" size="small" clearable :disabled="isReadOnly" placeholder="图层" />
        </div>
        <div class="flex items-center gap-1.5">
          <n-checkbox v-model:checked="filterColorEnabled" size="small" :disabled="isReadOnly">颜色</n-checkbox>
          <input v-model="filterColor" type="color" class="h-7 w-8 cursor-pointer rounded border border-slate-200 bg-transparent p-0.5 dark:border-white/10" :disabled="isReadOnly">
          <n-button size="small" class="flex-1" :disabled="isReadOnly" @click="applyFilter">按条件筛选</n-button>
        </div>
      </section>
    </div>
  </n-popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const offsetDistance = ref(10)
const filterType = ref<EntityType | null>(null)
const filterLayer = ref('')
const filterColor = ref('#2764AF')
const filterColorEnabled = ref(false)

const selectedCount = computed(() => editor.state.selectedIds.length)
const hasSelection = computed(() => selectedCount.value > 0)
const isReadOnly = editor.loading
const typeOptions = [
  { label: '直线', value: 'line' },
  { label: '多段线', value: 'polyline' },
  { label: '圆', value: 'circle' },
  { label: '文字', value: 'text' },
  { label: '标注', value: 'annotation' },
  { label: '原生标注', value: 'dimension' },
  { label: '组合', value: 'group' },
]

/** 提交偏移命令，使用当前光标位置决定偏移侧。 @returns 无返回值。 @author snihao */
function applyOffset(): void {
  if (isReadOnly.value) return
  editor.offsetSelected(offsetDistance.value || 0)
}

/** 提交修剪命令，按住 Shift 时临时切换为延伸。 @param event 按钮事件。 @returns 无返回值。 @author snihao */
function applyTrim(event?: MouseEvent): void {
  if (isReadOnly.value) return
  if (event?.shiftKey) editor.extendSelected()
  else editor.trimSelected()
}

/** 提交延伸命令，按住 Shift 时临时切换为修剪。 @param event 按钮事件。 @returns 无返回值。 @author snihao */
function applyExtend(event?: MouseEvent): void {
  if (isReadOnly.value) return
  if (event?.shiftKey) editor.trimSelected()
  else editor.extendSelected()
}

/** 提交打断命令，使用当前光标位置或实体中点。 @returns 无返回值。 @author snihao */
function applyBreak(): void {
  if (isReadOnly.value) return
  editor.breakSelected()
}

/** 提交连接命令。 @returns 无返回值。 @author snihao */
function applyJoin(): void {
  if (isReadOnly.value) return
  editor.joinSelected()
}

/** 切换当前选中多段线的闭合状态。 @returns 无返回值。 @author snihao */
function applyClose(): void {
  if (isReadOnly.value) return
  editor.closeSelected()
}

/** 根据筛选控件提交类型、图层和颜色筛选。 @returns 无返回值。 @author snihao */
function applyFilter(): void {
  if (isReadOnly.value) return
  editor.selectByFilter({
    type: filterType.value || undefined,
    layer: filterLayer.value.trim() || undefined,
    color: filterColorEnabled.value ? filterColor.value.toUpperCase() : undefined,
  })
}
</script>
