<template>
  <n-popover trigger="click" placement="bottom-start" :width="360">
    <template #trigger>
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button size="small" quaternary aria-label="图层管理">
            <template #icon>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="m4 8 8-4 8 4-8 4-8-4Z" />
                <path d="m4 12 8 4 8-4M4 16l8 4 8-4" />
              </svg>
            </template>
            <span class="hidden xl:inline">图层</span>
          </n-button>
        </template>
        图层管理
      </n-tooltip>
    </template>

    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-slate-700 dark:text-slate-100">图层管理</div>
          <div class="mt-0.5 text-[10px] text-slate-400">冻结图层不会参与渲染、选择和捕捉</div>
        </div>
        <n-button size="tiny" quaternary :disabled="isReadOnly" @click="editor.showAllLayers()">显示全部</n-button>
      </div>

      <div class="flex items-center gap-2">
        <n-select v-model:value="currentLayer" size="small" :options="layerOptions" class="min-w-0 flex-1" :disabled="isReadOnly" />
        <n-input v-model:value="newLayer" size="small" placeholder="新图层名称" :disabled="isReadOnly" @keyup.enter="createLayer" />
        <n-button size="small" type="primary" :disabled="isReadOnly || !newLayer.trim()" aria-label="创建图层" @click="createLayer">+</n-button>
      </div>

      <div class="max-h-64 space-y-1 overflow-y-auto pr-1">
        <div
          v-for="layer in layers"
          :key="layer.name"
          class="rounded border border-slate-200/80 px-2 py-1.5 dark:border-white/10"
          :class="{ 'bg-sky-50/70 dark:bg-sky-950/20': layer.name === editor.state.defaultLayer }"
        >
          <div class="flex items-center gap-2">
            <input
              :value="layer.color"
              type="color"
              class="h-6 w-7 cursor-pointer rounded border border-slate-200"
              :disabled="isReadOnly"
              :aria-label="`${layer.name} 颜色`"
              @input="updateColor(layer, $event)"
            >
            <n-input
              :value="layer.name"
              size="tiny"
              class="min-w-0 flex-1"
              :disabled="isReadOnly"
              @blur="rename(layer, $event)"
              @keyup.enter="rename(layer, $event)"
            />
            <n-button size="tiny" quaternary :disabled="isReadOnly" :type="layer.name === editor.state.defaultLayer ? 'primary' : 'default'" @click="setCurrent(layer.name)">当前</n-button>
            <n-button size="tiny" quaternary :disabled="isReadOnly" aria-label="隔离图层" @click="editor.isolateLayer(layer.name)">隔离</n-button>
            <n-popconfirm @positive-click="remove(layer.name)">
              <template #trigger>
                <n-button size="tiny" quaternary type="error" :disabled="isReadOnly" aria-label="删除图层">×</n-button>
              </template>
              非空图层将迁移到当前图层，确认删除？
            </n-popconfirm>
          </div>
          <div class="mt-1.5 flex items-center gap-3 text-[10px] text-slate-500">
            <label class="flex items-center gap-1"><n-switch :value="layer.visible" size="small" :disabled="isReadOnly" @update:value="(value: boolean) => setLayer(layer.name, { visible: value })" />显示</label>
            <label class="flex items-center gap-1"><n-switch :value="layer.frozen" size="small" :disabled="isReadOnly" @update:value="(value: boolean) => setLayer(layer.name, { frozen: value })" />冻结</label>
            <label class="flex items-center gap-1"><n-switch :value="layer.locked" size="small" :disabled="isReadOnly" @update:value="(value: boolean) => setLayer(layer.name, { locked: value })" />锁定</label>
          </div>
        </div>
      </div>
    </div>
  </n-popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const newLayer = ref('')
const isReadOnly = editor.loading

const layers = computed(() => {
  void editor.dataVersion.value
  return editor.getLayers()
})

const layerOptions = computed(() => layers.value.map((layer) => ({ label: layer.name, value: layer.name })))

const currentLayer = computed({
  get: () => editor.state.defaultLayer,
  set: (value: string) => {
    if (!isReadOnly.value) setCurrent(value)
  },
})

function setCurrent(name: string): void {
  if (isReadOnly.value) return
  const layer = layers.value.find((item) => item.name === name)
  if (!layer) return
  editor.state.defaultLayer = name
  editor.statusText.value = `当前图层：${name}`
}

function createLayer(): void {
  if (isReadOnly.value) return
  const name = newLayer.value.trim()
  if (!name || !editor.createLayer(name)) return
  newLayer.value = ''
}

function updateColor(layer: LayerDefinition, event: Event): void {
  if (isReadOnly.value) return
  editor.updateLayer(layer.name, { color: (event.target as HTMLInputElement).value })
}

function setLayer(name: string, patch: Partial<LayerDefinition>): void {
  if (isReadOnly.value) return
  editor.updateLayer(name, patch)
}

function rename(layer: LayerDefinition, event: Event): void {
  if (isReadOnly.value) return
  const value = (event.target as HTMLInputElement).value.trim()
  if (value && value !== layer.name) editor.renameLayer(layer.name, value)
}

function remove(name: string): void {
  if (isReadOnly.value) return
  const target = layers.value.find((layer) => layer.name !== name)?.name
  editor.deleteLayer(name, target)
}
</script>
