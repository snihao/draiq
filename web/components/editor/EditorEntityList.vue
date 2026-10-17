<template>
  <!-- 图元列表：按图层分组 + 组合嵌套折叠 + 虚拟滚动 -->
  <div class="flex h-full min-h-0 flex-col overflow-hidden bg-[#fbfcfc] dark:bg-[#18211f]">
    <!-- 标题栏 -->
    <div class="flex shrink-0 items-center justify-between border-b border-slate-200/80 bg-[#f7f9f8] px-4 py-2.5 dark:border-white/10 dark:bg-[#18211f]">
      <div class="flex items-center gap-1.5">
        <svg class="w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <circle cx="3.5" cy="6" r="1.5" />
          <circle cx="3.5" cy="12" r="1.5" />
          <circle cx="3.5" cy="18" r="1.5" />
        </svg>
        <span class="text-xs font-medium text-gray-600 dark:text-gray-300">图元列表</span>
        <span class="text-[10px] text-gray-400">({{ totalCount }})</span>
      </div>
      <div class="flex items-center gap-1">
        <button class="text-[10px] text-gray-400 hover:text-blue-500 transition" @click="collapseAll">全部折叠</button>
        <span class="text-gray-300">|</span>
        <button class="text-[10px] text-gray-400 hover:text-blue-500 transition" @click="expandAll">全部展开</button>
      </div>
    </div>

    <!-- 列表区域 -->
    <div ref="listRef" class="relative min-h-0 flex-1 overscroll-contain overflow-y-auto" @scroll="onScroll">
      <div v-if="!totalCount" class="flex items-center justify-center h-full text-xs text-gray-400">
        暂无图元
      </div>
      <div v-else :style="{ height: totalHeight + 'px', position: 'relative' }">
        <template v-for="row in visibleRows" :key="row.key">
          <!-- 图层分组头 -->
          <div
            v-if="row.type === 'header'"
            class="absolute left-0 right-0 flex items-center px-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition"
            :style="{ top: row.top + 'px', height: HEADER_H + 'px' }"
            @click="toggleLayer(row.layer!)"
          >
            <svg
              class="w-3 h-3 text-gray-400 transition-transform mr-1"
              :class="{ '-rotate-90': collapsedLayers.has(row.layer!) }"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span
              class="w-2.5 h-2.5 rounded-sm mr-2 shrink-0"
              :style="{ background: layerColor(row.layer!) }"
            />
            <span class="text-xs font-medium text-gray-700 dark:text-gray-200 flex-1 truncate">{{ row.layer }}</span>
            <span class="text-[10px] text-gray-400 ml-1">{{ layerCount(row.layer!) }}</span>
          </div>

          <!-- 顶层图元条目（含组合） -->
          <div
            v-else-if="row.type === 'entity'"
            class="absolute left-0 right-0 flex items-center pl-8 pr-3 text-xs cursor-pointer transition"
            :class="[
              editor.state.selectedIds.includes(row.entity!.id)
                ? 'bg-[#E8F0FA] dark:bg-[#1C2B40] text-[#235A9E] dark:text-[#7FADE3] border-l-2 border-l-[#2764AF]'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50',
              isReadOnly ? 'cursor-not-allowed opacity-75' : '',
            ]"
            :aria-disabled="isReadOnly"
            :style="{ top: row.top + 'px', height: ROW_H + 'px' }"
            @click="selectEntity(row.entity!.id)"
          >
            <!-- 组合折叠箭头 -->
            <svg
              v-if="row.entity!.type === 'group'"
              class="w-3 h-3 text-gray-400 transition-transform mr-1 shrink-0"
              :class="{ '-rotate-90': collapsedGroups.has(row.entity!.id) }"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
              @click.stop="toggleGroup(row.entity!.id)"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span v-else class="w-3 mr-1 shrink-0" />
            <!-- 组合图标 -->
            <svg v-if="row.entity!.type === 'group'" class="w-3.5 h-3.5 text-amber-500 mr-1.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span class="flex-1 truncate">{{ ENTITY_LABELS[row.entity!.type] }}<span v-if="row.entity!.type === 'group'" class="text-gray-400 ml-1">({{ row.entity!.children?.length || 0 }})</span></span>
            <span class="text-[10px] text-gray-400 font-mono ml-2 shrink-0">{{ row.entity!.id.slice(0, 6) }}</span>
          </div>

          <!-- 组合子图元条目（缩进） -->
          <div
            v-else-if="row.type === 'child'"
            class="absolute left-0 right-0 flex items-center pl-14 pr-3 text-xs cursor-pointer transition"
            :class="[
              editor.state.selectedIds.includes(row.entity!.id)
                ? 'bg-[#E8F0FA] dark:bg-[#1C2B40] text-[#235A9E] dark:text-[#7FADE3] border-l-2 border-l-[#2764AF]'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50',
              isReadOnly ? 'cursor-not-allowed opacity-75' : '',
            ]"
            :aria-disabled="isReadOnly"
            :style="{ top: row.top + 'px', height: ROW_H + 'px' }"
            @click="selectEntity(row.entity!.id)"
          >
            <span class="w-1 h-1 rounded-full bg-gray-300 mr-2 shrink-0" />
            <span class="flex-1 truncate">{{ ENTITY_LABELS[row.entity!.type] }}</span>
            <span class="text-[10px] text-gray-400 font-mono ml-2 shrink-0">{{ row.entity!.id.slice(0, 6) }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ENTITY_LABELS } from '#draiq/utils/editor/config'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const isReadOnly = editor.loading

/** 行高常量 */
const ROW_H = 26
const HEADER_H = 30

/** 列表容器引用 */
const listRef = ref<HTMLElement | null>(null)
/** 滚动位置 */
const scrollTop = ref(0)
/** 折叠的图层集合 */
const collapsedLayers = ref<Set<string>>(new Set())
/** 折叠的组合集合 */
const collapsedGroups = ref<Set<string>>(new Set())

/** 实体列表（依赖 version 刷新） */
const entities = computed(() => {
  void editor.dataVersion.value
  return editor.state.drawing.entities
})

/** 总图元数（顶层） */
const totalCount = computed(() => entities.value.length)

/** 按图层分组的实体 */
interface LayerGroup {
  layer: string
  entities: Entity[]
}
const groups = computed<LayerGroup[]>(() => {
  const map = new Map<string, Entity[]>()
  for (const e of entities.value) {
    const layer = e.layer || 'default'
    if (!map.has(layer)) map.set(layer, [])
    map.get(layer)!.push(e)
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([layer, ents]) => ({ layer, entities: ents }))
})

/** 图层颜色 */
function layerColor(layer: string): string {
  void editor.dataVersion.value
  return editor.getLayers().find((item) => item.name === layer)?.color || '#6b7280'
}

/** 图层图元数 */
function layerCount(layer: string): number {
  return groups.value.find(g => g.layer === layer)?.entities.length ?? 0
}

/** 切换图层折叠 */
function toggleLayer(layer: string): void {
  const s = new Set(collapsedLayers.value)
  if (s.has(layer)) s.delete(layer)
  else s.add(layer)
  collapsedLayers.value = s
}

/** 切换组合折叠 */
function toggleGroup(id: string): void {
  const s = new Set(collapsedGroups.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  collapsedGroups.value = s
}

/** 全部折叠 */
function collapseAll(): void {
  collapsedLayers.value = new Set(groups.value.map(g => g.layer))
  collapsedGroups.value = new Set(
    entities.value.filter(e => e.type === 'group').map(e => e.id)
  )
}

/** 全部展开 */
function expandAll(): void {
  collapsedLayers.value = new Set()
  collapsedGroups.value = new Set()
}

/** 扁平化行（header / entity / child），用于虚拟滚动定位 */
interface FlatRow {
  key: string
  type: 'header' | 'entity' | 'child'
  layer?: string
  entity?: Entity
  top: number
}
const flatRows = computed<FlatRow[]>(() => {
  const rows: FlatRow[] = []
  let top = 0
  for (const g of groups.value) {
    rows.push({ key: `h-${g.layer}`, type: 'header', layer: g.layer, top })
    top += HEADER_H
    if (!collapsedLayers.value.has(g.layer)) {
      for (const e of g.entities) {
        rows.push({ key: `e-${e.id}`, type: 'entity', layer: g.layer, entity: e, top })
        top += ROW_H
        // 组合展开时插入子图元行
        if (e.type === 'group' && !collapsedGroups.value.has(e.id) && e.children) {
          for (const child of e.children) {
            rows.push({ key: `c-${child.id}`, type: 'child', layer: g.layer, entity: child, top })
            top += ROW_H
          }
        }
      }
    }
  }
  return rows
})

/** 总高度 */
const totalHeight = computed(() => {
  if (!flatRows.value.length) return 0
  const last = flatRows.value[flatRows.value.length - 1]
  return last.top + (last.type === 'header' ? HEADER_H : ROW_H)
})

/** 可见行（虚拟滚动） */
const visibleRows = computed<FlatRow[]>(() => {
  const rows = flatRows.value
  if (!rows.length) return []
  const viewH = listRef.value?.clientHeight || 140
  const top = scrollTop.value
  const bottom = top + viewH
  // 二分查找第一个可见行
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = rows[mid]
    const rBottom = r.top + (r.type === 'header' ? HEADER_H : ROW_H)
    if (rBottom < top) lo = mid + 1
    else hi = mid
  }
  const start = Math.max(0, lo - 2)
  const result: FlatRow[] = []
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]
    if (r.top > bottom) break
    result.push(r)
  }
  return result
})

/** 滚动事件 */
function onScroll(): void {
  if (listRef.value) scrollTop.value = listRef.value.scrollTop
}

/** 选中实体 */
function selectEntity(id: string): void {
  if (isReadOnly.value) return
  editor.setSelection([id])
  editor.notify()
}

onMounted(() => {
  if (listRef.value) {
    listRef.value.addEventListener('scroll', onScroll, { passive: true })
  }
})

onBeforeUnmount(() => {
  listRef.value?.removeEventListener('scroll', onScroll)
})
</script>
