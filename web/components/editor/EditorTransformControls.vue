<template>
  <n-popover trigger="click" placement="bottom-start" :width="300">
    <template #trigger>
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button size="small" quaternary :disabled="isReadOnly || (!hasSelection && !hasClipboard)">
            <template #icon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M5 5h5M5 5v5M19 19h-5M19 19v-5" />
                <path d="M10 5 5 10m9 9 5-5" />
                <path d="M12 8v8M8 12h8" />
              </svg>
            </template>
            <span class="hidden xl:inline">变换</span>
          </n-button>
        </template>
        复制、移动、旋转、缩放与镜像
      </n-tooltip>
    </template>

    <div class="space-y-3 py-1">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-slate-700 dark:text-slate-100">命令变换</div>
          <div class="mt-0.5 text-[10px] text-slate-400">当前选择：{{ selectedCount }} 个图元</div>
        </div>
        <div class="flex items-center gap-1">
          <n-button size="tiny" quaternary :disabled="isReadOnly || !hasSelection" @click="editor.copySelected()">复制</n-button>
          <n-button size="tiny" quaternary :disabled="isReadOnly || !hasClipboard" @click="editor.pasteClipboard()">粘贴</n-button>
        </div>
      </div>

      <div class="h-px bg-slate-100 dark:bg-white/10" />

      <section class="space-y-1.5">
        <div class="text-[10px] font-semibold text-slate-500">精确移动（X/Y 位移）</div>
        <div class="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
          <n-input-number v-model:value="moveX" size="small" :show-button="false" :disabled="isReadOnly" placeholder="X" />
          <n-input-number v-model:value="moveY" size="small" :show-button="false" :disabled="isReadOnly" placeholder="Y" />
          <n-button size="small" type="primary" :disabled="isReadOnly || !hasSelection" @click="applyMove">移动</n-button>
        </div>
      </section>

      <section class="space-y-1.5">
        <div class="text-[10px] font-semibold text-slate-500">旋转（绕选择中心）</div>
        <div class="grid grid-cols-[1fr_auto] items-center gap-1.5">
          <n-input-number v-model:value="rotateAngle" size="small" :show-button="false" :disabled="isReadOnly" placeholder="角度（度）" />
          <n-button size="small" :disabled="isReadOnly || !hasSelection" @click="applyRotate">旋转</n-button>
        </div>
      </section>

      <section class="space-y-1.5">
        <div class="text-[10px] font-semibold text-slate-500">缩放（绕选择中心）</div>
        <div class="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5">
          <n-input-number v-model:value="scaleX" size="small" :show-button="false" :disabled="isReadOnly" placeholder="X 比例" />
          <n-input-number v-model:value="scaleY" size="small" :show-button="false" :disabled="isReadOnly" placeholder="Y 比例" />
          <n-button size="small" :disabled="isReadOnly || !hasSelection" @click="applyScale">缩放</n-button>
        </div>
      </section>

      <section class="space-y-1.5">
        <div class="text-[10px] font-semibold text-slate-500">镜像轴（两点）</div>
        <div class="grid grid-cols-4 gap-1.5">
          <n-input-number v-model:value="axisStartX" size="small" :show-button="false" :disabled="isReadOnly" placeholder="X1" />
          <n-input-number v-model:value="axisStartY" size="small" :show-button="false" :disabled="isReadOnly" placeholder="Y1" />
          <n-input-number v-model:value="axisEndX" size="small" :show-button="false" :disabled="isReadOnly" placeholder="X2" />
          <n-input-number v-model:value="axisEndY" size="small" :show-button="false" :disabled="isReadOnly" placeholder="Y2" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <label class="flex items-center gap-1.5 text-[11px] text-slate-500">
            <n-switch v-model:value="keepSource" size="small" :disabled="isReadOnly" />
            保留源对象
          </label>
          <label class="flex items-center gap-1.5 text-[11px] text-slate-500">
            <n-switch v-model:value="mirrorText" size="small" :disabled="isReadOnly" />
            镜像文字
          </label>
          <n-button size="small" :disabled="isReadOnly || !hasSelection" @click="applyMirror">镜像</n-button>
        </div>
      </section>
    </div>
  </n-popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'
import { entityBounds } from '#draiq/utils/editor/geometry'

const editor = inject(editorKey)!
const moveX = ref(0)
const moveY = ref(0)
const rotateAngle = ref(90)
const scaleX = ref(1)
const scaleY = ref(1)
const axisStartX = ref(0)
const axisStartY = ref(0)
const axisEndX = ref(100)
const axisEndY = ref(0)
const keepSource = ref(false)
const mirrorText = ref(false)

const selectedCount = computed(() => editor.state.selectedIds.length)
const hasSelection = computed(() => selectedCount.value > 0)
const hasClipboard = computed(() => !!editor.clipboard.value)
const isReadOnly = editor.loading

/** 根据当前选择初始化镜像轴，默认使用水平中心轴。 @author snihao */
function refreshAxisDefaults(): void {
  const ids = editor.state.selectedIds
  if (!ids.length) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of ids) {
    const entity = editor.findEntity(id)
    if (!entity) continue
    const bounds = entityBounds(entity)
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
  }
  if (!Number.isFinite(minX)) return
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const span = Math.max(maxX - minX, maxY - minY, 1)
  axisStartX.value = centerX - span / 2
  axisStartY.value = centerY
  axisEndX.value = centerX + span / 2
  axisEndY.value = centerY
}

watch(() => editor.state.selectedIds.join('|'), refreshAxisDefaults, { immediate: true })

/** 提交 X/Y 精确移动命令。 @author snihao */
function applyMove(): void {
  if (isReadOnly.value) return
  editor.moveSelectedBy(moveX.value || 0, moveY.value || 0)
}

/** 提交绕选择中心的旋转命令。 @author snihao */
function applyRotate(): void {
  if (isReadOnly.value) return
  editor.rotateSelected(rotateAngle.value || 0)
}

/** 提交绕选择中心的缩放命令。 @author snihao */
function applyScale(): void {
  if (isReadOnly.value) return
  editor.scaleSelected(scaleX.value || 1, scaleY.value || 1)
}

/** 提交按两点定义镜像轴的镜像命令。 @author snihao */
function applyMirror(): void {
  if (isReadOnly.value) return
  editor.mirrorSelected(
    [axisStartX.value || 0, axisStartY.value || 0],
    [axisEndX.value || 0, axisEndY.value || 0],
    mirrorText.value,
    keepSource.value,
  )
}
</script>
