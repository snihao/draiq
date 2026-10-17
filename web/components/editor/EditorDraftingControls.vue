<template>
  <div class="hidden h-full items-center gap-0.5 border-l border-white/15 pl-2 md:flex" aria-label="绘图辅助">
    <n-tooltip trigger="hover" placement="top">
      <template #trigger>
        <button
          type="button"
          class="drafting-button"
          :disabled="isReadOnly"
          :class="{ 'drafting-button-active': editor.drafting.snapEnabled }"
          :aria-pressed="editor.drafting.snapEnabled"
          @click="editor.toggleObjectSnap()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 4v7a5 5 0 0 0 10 0V4" />
            <path d="M7 7h3m4 0h3M4 18h16" />
          </svg>
          <span>捕捉</span>
        </button>
      </template>
      对象捕捉 F3
    </n-tooltip>

    <n-tooltip trigger="hover" placement="top">
      <template #trigger>
        <button
          type="button"
          class="drafting-button"
          :disabled="isReadOnly"
          :class="{ 'drafting-button-active': editor.drafting.orthoEnabled }"
          :aria-pressed="editor.drafting.orthoEnabled"
          @click="editor.toggleOrtho()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14h14M5 12h7V5" /></svg>
          <span>正交</span>
        </button>
      </template>
      正交约束 F8
    </n-tooltip>

    <n-tooltip trigger="hover" placement="top">
      <template #trigger>
        <button
          type="button"
          class="drafting-button tabular-nums"
          :disabled="isReadOnly"
          :class="{ 'drafting-button-active': editor.drafting.polarEnabled }"
          :aria-pressed="editor.drafting.polarEnabled"
          @click="editor.togglePolar()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18h14M5 18 17 7M8 18a3 3 0 0 0-3-3" /></svg>
          <span>极轴 {{ editor.drafting.polarIncrement }}°</span>
        </button>
      </template>
      极轴追踪 F10
    </n-tooltip>

    <n-popover trigger="click" placement="top-end" :width="238">
      <template #trigger>
        <button type="button" class="drafting-icon-button" :disabled="isReadOnly" aria-label="捕捉设置">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6" />
          </svg>
        </button>
      </template>
      <div class="space-y-3 py-0.5">
        <div>
          <div class="text-xs font-semibold text-slate-700">对象捕捉</div>
          <div class="mt-0.5 text-[11px] text-slate-400">Alt 临时自由取点 · Tab 切换候选</div>
        </div>
        <label class="setting-row">
          <span>端点</span>
        <n-switch :value="editor.drafting.endpointEnabled" size="small" :disabled="isReadOnly" @update:value="updateEndpoint" />
        </label>
        <label class="setting-row">
          <span>中点</span>
        <n-switch :value="editor.drafting.midpointEnabled" size="small" :disabled="isReadOnly" @update:value="updateMidpoint" />
        </label>
        <label class="setting-row">
          <span>圆心</span>
        <n-switch :value="editor.drafting.centerEnabled" size="small" :disabled="isReadOnly" @update:value="updateCenter" />
        </label>
        <label class="setting-row">
          <span>象限点</span>
        <n-switch :value="editor.drafting.quadrantEnabled" size="small" :disabled="isReadOnly" @update:value="updateQuadrant" />
        </label>
        <label class="setting-row">
          <span>交点</span>
        <n-switch :value="editor.drafting.intersectionEnabled" size="small" :disabled="isReadOnly" @update:value="updateIntersection" />
        </label>
        <label class="setting-row">
          <span>垂足</span>
        <n-switch :value="editor.drafting.perpendicularEnabled" size="small" :disabled="isReadOnly" @update:value="updatePerpendicular" />
        </label>
        <label class="setting-row">
          <span>最近点</span>
        <n-switch :value="editor.drafting.nearestEnabled" size="small" :disabled="isReadOnly" @update:value="updateNearest" />
        </label>
        <label class="setting-row">
          <span>切点</span>
        <n-switch :value="editor.drafting.tangentEnabled" size="small" :disabled="isReadOnly" @update:value="updateTangent" />
        </label>
        <div class="h-px bg-slate-100" />
        <label class="setting-row">
          <span>极轴增量</span>
          <n-select
            :value="editor.drafting.polarIncrement"
            :options="polarOptions"
            size="small"
            class="w-28"
            :disabled="isReadOnly"
            @update:value="updatePolarIncrement"
          />
        </label>
      </div>
    </n-popover>
  </div>
</template>

<script setup lang="ts">
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const isReadOnly = editor.loading
const polarOptions = [5, 15, 30, 45, 90].map((value) => ({ label: `${value}°`, value }))

function updateEndpoint(value: boolean): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ endpointEnabled: value })
}

function updateMidpoint(value: boolean): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ midpointEnabled: value })
}

function updateCenter(value: boolean): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ centerEnabled: value })
}

function updateQuadrant(value: boolean): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ quadrantEnabled: value })
}

function updateIntersection(value: boolean): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ intersectionEnabled: value })
}

function updatePerpendicular(value: boolean): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ perpendicularEnabled: value })
}

function updateNearest(value: boolean): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ nearestEnabled: value })
}

function updateTangent(value: boolean): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ tangentEnabled: value })
}

function updatePolarIncrement(value: number): void {
  if (isReadOnly.value) return
  editor.updateDraftingSettings({ polarIncrement: value })
}
</script>

<style scoped>
/* 状态栏控制保持紧凑，激活态使用现有编辑器主色的浅色反馈。 */
.drafting-button {
  display: inline-flex;
  height: 22px;
  align-items: center;
  gap: 4px;
  border-radius: 4px;
  padding: 0 6px;
  color: rgb(255 255 255 / 55%);
  font-size: 10px;
  transition: color 160ms ease, background-color 160ms ease, transform 120ms ease;
}
.drafting-button:hover,
.drafting-icon-button:hover {
  background: rgb(255 255 255 / 10%);
  color: white;
}
.drafting-button:active,
.drafting-icon-button:active {
  transform: translateY(1px);
}
.drafting-button-active {
  background: rgb(255 255 255 / 16%);
  color: white;
}
.drafting-button svg,
.drafting-icon-button svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.drafting-icon-button {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 4px;
  color: rgb(255 255 255 / 50%);
  transition: color 160ms ease, background-color 160ms ease, transform 120ms ease;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #526170;
  font-size: 12px;
}
</style>
