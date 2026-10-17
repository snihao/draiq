<template>
  <!-- 右侧属性面板：编辑选中实体的图层/颜色/线宽及类型专属字段 -->
  <div
    class="flex h-full min-h-0 flex-col overscroll-contain overflow-y-auto bg-[#fbfcfc] dark:bg-[#18211f]"
    :data-refresh-version="propertyRefreshVersion"
  >
    <!-- 选中状态头部 -->
    <div
      class="px-4 py-3 border-b transition-all"
      :class="selectedCount
        ? 'bg-[#EDF3FA] dark:bg-[#192A40] border-l-[3px] border-l-[#2764AF]'
        : 'bg-[#f7f9f8] dark:bg-[#18211f]'"
    >
      <template v-if="selectedCount > 1">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-[#2764AF]" />
          <span class="text-sm font-semibold text-[#235A9E] dark:text-[#7FADE3]">已选择 {{ selectedCount }} 个图元</span>
        </div>
        <div class="mt-1 ml-4 text-[11px] text-gray-400">拖动任意已选图元可整体移动，按 Delete 批量删除</div>
      </template>
      <template v-else-if="entity">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-[#2764AF]" />
            <span class="text-sm font-semibold text-[#235A9E] dark:text-[#7FADE3]">{{ ENTITY_LABELS[entity.type] }}</span>
          </div>
          <span class="text-[10px] text-gray-400 font-mono truncate max-w-[120px]">{{ entity.id }}</span>
        </div>
      </template>
      <template v-else>
        <div class="text-sm text-gray-400 flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-gray-300" />
          未选中图元
        </div>
        <div class="text-[11px] text-gray-400 mt-1 ml-4">点击图元选择，或用左侧工具绘制</div>
      </template>
    </div>

    <EditorBatchProperties v-if="selectedCount > 1" />

    <template v-if="entity">
      <!-- 组合类型：组合专属面板 -->
      <template v-if="entity.type === 'group'">
        <div class="px-4 py-3 space-y-2.5">
          <div class="text-[11px] font-semibold tracking-wide text-slate-500">组合属性</div>
          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">子图元</span>
            <span class="text-xs text-gray-700 dark:text-gray-200">{{ entity.children?.length || 0 }} 个</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">图层</span>
            <n-input :value="entity.layer" size="small" :disabled="isReadOnly" @update:value="(v: string) => updateField('layer', (v || '').trim() || 'default')" @blur="editor.commit()" />
          </div>
          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">颜色</span>
            <div class="flex items-center gap-2 flex-1">
              <input
                :value="entity.color || DEFAULTS.color"
                type="color"
                class="w-7 h-7 rounded cursor-pointer border border-gray-200"
                :disabled="isReadOnly"
                @input="(e) => updateGroupColor((e.target as HTMLInputElement).value.toUpperCase())"
                @change="editor.commit()"
              >
              <span class="text-xs text-gray-400 font-mono">{{ entity.color || DEFAULTS.color }}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">颜色规则</span>
            <n-select :value="entity.colorMode || 'explicit'" :options="styleModeOptions" size="small" class="flex-1" :disabled="isReadOnly" @update:value="(value: EntityStyleMode) => updateStyleMode('colorMode', value)" />
          </div>
          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">线宽</span>
            <n-input-number
              :value="entity.lineWidth ?? 1"
              :min="0.1"
              :step="0.1"
              size="small"
              class="flex-1"
              :disabled="isReadOnly"
              @update:value="(v: number | null) => updateGroupLineWidth(v !== null ? Math.max(0.1, v) : 1)"
              @blur="editor.commit()"
            />
          </div>
          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">线型</span>
            <n-select :value="entity.lineType || 'solid'" :options="lineTypeOptions" size="small" class="flex-1" :disabled="isReadOnly" @update:value="updateGroupLineType" @blur="editor.commit()" />
          </div>
          <NumberRow label="旋转°" :value="rotationValue" :disabled="isReadOnly" @change="updateRotation" @commit="editor.commit()" />
        </div>
        <div class="mx-4 border-t border-gray-200 dark:border-gray-700" />
        <div class="px-4 py-3 space-y-2.5">
          <div class="text-[11px] font-semibold tracking-wide text-slate-500">组合操作</div>
          <n-button size="small" type="warning" ghost block :disabled="isReadOnly" @click="editor.ungroupSelected()">
            解散组合
          </n-button>
        </div>
        <div class="px-4 py-3 mt-auto border-t border-gray-200 dark:border-gray-700">
          <n-button size="small" type="error" ghost block :disabled="isReadOnly" @click="editor.deleteSelected()">
            删除整个组合
          </n-button>
        </div>
      </template>

      <!-- 子图元（属于某 group）：顶部提示横幅 -->
      <div v-if="entity.groupId" class="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700">
        <div class="text-[11px] text-amber-700 dark:text-amber-300 flex items-center gap-1">
          <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <span>组合内图元（编辑后需解散组合才能独立操作）</span>
        </div>
      </div>

      <!-- 普通顶层图元 / 子图元：共用属性面板 -->
      <template v-if="entity.type !== 'group'">
        <div class="px-4 py-3 space-y-2.5">
          <div class="text-[11px] font-semibold tracking-wide text-slate-500">外观</div>

          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">图层</span>
            <n-input :value="entity.layer" size="small" :disabled="isReadOnly" @update:value="(v: string) => updateField('layer', (v || '').trim() || 'default')" @blur="editor.commit()" />
          </div>

          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">颜色</span>
            <div class="flex items-center gap-2 flex-1">
              <input
                :value="entity.color || DEFAULTS.color"
                type="color"
                class="w-7 h-7 rounded cursor-pointer border border-gray-200"
                :disabled="isReadOnly"
                @input="(e) => updateField('color', (e.target as HTMLInputElement).value.toUpperCase())"
                @change="editor.commit()"
              >
              <span class="text-xs text-gray-400 font-mono">{{ entity.color || DEFAULTS.color }}</span>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">线宽</span>
            <n-input-number
              :value="entity.lineWidth ?? 1"
              :min="0.1"
              :step="0.1"
              size="small"
              class="flex-1"
              :disabled="isReadOnly"
              @update:value="(v: number | null) => updateField('lineWidth', v !== null ? Math.max(0.1, v) : 1)"
              @blur="editor.commit()"
            />
          </div>
          <div v-if="entity.type !== 'text'" class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">线型</span>
            <n-select :value="entity.lineType || 'solid'" :options="lineTypeOptions" size="small" class="flex-1" :disabled="isReadOnly" @update:value="updateEntityLineType" @blur="editor.commit()" />
          </div>
          <div v-if="entity.type !== 'text'" class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">线型规则</span>
            <n-select :value="lineTypeModeValue" :options="styleModeOptions" size="small" class="flex-1" :disabled="isReadOnly" @update:value="(value: EntityStyleMode) => updateStyleMode('lineTypeMode', value)" />
          </div>
          <div v-if="entity.type !== 'text'" class="flex items-center gap-2">
            <span class="w-10 shrink-0 text-xs text-gray-500">线宽规则</span>
            <n-select :value="lineWidthModeValue" :options="styleModeOptions" size="small" class="flex-1" :disabled="isReadOnly" @update:value="(value: EntityStyleMode) => updateStyleMode('lineWidthMode', value)" />
          </div>
        </div>

        <div class="mx-4 border-t border-gray-200 dark:border-gray-700" />

        <!-- 类型专属属性 -->
        <div class="px-4 py-3 space-y-2.5">
          <div class="text-[11px] font-semibold tracking-wide text-slate-500">几何</div>

          <NumberRow
            v-if="entity.type !== 'circle'"
            label="旋转°"
            :value="rotationValue"
            :disabled="isReadOnly"
            @change="updateRotation"
            @commit="editor.commit()"
          />

          <template v-if="entity.type === 'line'">
            <PointRow label="起点" :point="entity.start!" :disabled="isReadOnly" @change="(i, v) => updatePoint('start', i, v)" @commit="editor.commit()" />
            <PointRow label="终点" :point="entity.end!" :disabled="isReadOnly" @change="(i, v) => updatePoint('end', i, v)" @commit="editor.commit()" />
          </template>

          <template v-else-if="entity.type === 'circle'">
            <NumberRow label="圆心X" :value="entity.center![0]" :disabled="isReadOnly" @change="(v) => updateCenter(0, v)" @commit="editor.commit()" />
            <NumberRow label="圆心Y" :value="entity.center![1]" :disabled="isReadOnly" @change="(v) => updateCenter(1, v)" @commit="editor.commit()" />
            <NumberRow label="半径" :value="entity.radius!" :disabled="isReadOnly" @change="(v) => updateField('radius', Math.max(0.1, v))" @commit="editor.commit()" />
          </template>

          <template v-else-if="entity.type === 'polyline'">
            <template v-if="entity.curveGeometry">
              <div class="rounded bg-slate-50 px-2 py-1.5 text-[10px] text-slate-500 dark:bg-white/5 dark:text-slate-300">
                <div class="font-semibold text-slate-600 dark:text-slate-200">{{ entity.curveGeometry.type === 'arc' ? '参数圆弧' : '参数椭圆' }}</div>
                <div class="mt-1">中心：{{ formatPoint(entity.curveGeometry.center) }}</div>
                <div>轴 X：{{ formatPoint(entity.curveGeometry.axisX) }}</div>
                <div>轴 Y：{{ formatPoint(entity.curveGeometry.axisY) }}</div>
                <div>起始参数：{{ formatNumber(entity.curveGeometry.startParameter) }} rad</div>
                <div>扫掠参数：{{ formatNumber(entity.curveGeometry.sweepParameter) }} rad</div>
              </div>
            </template>
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs text-gray-500">闭合</span>
              <n-checkbox :checked="!!entity.closed" :disabled="isReadOnly" @update:checked="(v: boolean) => updateField('closed', v)" />
            </div>
            <div class="text-[11px] text-gray-400">顶点（{{ entity.points?.length || 0 }}）</div>
            <div class="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto pl-1">
              <PointRow
                v-for="(p, i) in entity.points"
                :key="i"
                :label="`#${i + 1}`"
                :point="p"
                :disabled="isReadOnly"
                @change="(idx, v) => updatePointItem(i, idx, v)"
                @commit="editor.commit()"
              />
            </div>
          </template>

          <template v-else-if="entity.type === 'text'">
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs text-gray-500">内容</span>
              <n-input
                :value="textDraft"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 6 }"
                size="small"
                placeholder="输入文字，支持换行"
                :disabled="isReadOnly"
                @update:value="updateTextContent"
                @blur="editor.commit()"
              />
            </div>
            <NumberRow label="字号" :value="fontSizeDraft" :disabled="isReadOnly" @change="updateTextFontSize" @commit="editor.commit()" />
            <PointRow label="位置" :point="entity.position!" :disabled="isReadOnly" @change="(i, v) => updatePoint('position', i, v)" @commit="editor.commit()" />
          </template>

          <template v-else-if="entity.type === 'dimension'">
            <DimensionStyleEditor
              :entity="entity"
              :disabled="isReadOnly"
              @change="updateDimensionStyle"
              @style-change="updateDimensionStyleName"
              @commit="editor.commit()"
            />
            <div class="rounded bg-slate-50 px-2 py-1.5 text-[11px] text-slate-500 dark:bg-white/5 dark:text-slate-300">
              原生标注类型：{{ dimensionTypeLabel(entity.dimensionType) }}
            </div>
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs text-gray-500">文字</span>
              <n-input
                :value="textDraft"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 6 }"
                size="small"
                placeholder="留空时由 CAD 自动计算"
                :disabled="isReadOnly"
                @update:value="updateTextContent"
                @blur="editor.commit()"
              />
            </div>
            <PointRow v-if="entity.dimensionCenter" label="圆心/角顶点" :point="entity.dimensionCenter" :disabled="isReadOnly" @change="(i, v) => updateDimensionPoint('dimensionCenter', i, v)" @commit="editor.commit()" />
            <PointRow v-if="entity.dimensionStart" label="测量点 1" :point="entity.dimensionStart" :disabled="isReadOnly" @change="(i, v) => updateDimensionPoint('dimensionStart', i, v)" @commit="editor.commit()" />
            <PointRow v-if="entity.dimensionEnd" label="测量点 2" :point="entity.dimensionEnd" :disabled="isReadOnly" @change="(i, v) => updateDimensionPoint('dimensionEnd', i, v)" @commit="editor.commit()" />
            <PointRow v-if="entity.dimensionLinePosition" label="尺寸线位置" :point="entity.dimensionLinePosition" :disabled="isReadOnly" @change="(i, v) => updateDimensionPoint('dimensionLinePosition', i, v)" @commit="editor.commit()" />
            <PointRow v-if="entity.dimensionOrigin" label="坐标原点" :point="entity.dimensionOrigin" :disabled="isReadOnly" @change="(i, v) => updateDimensionPoint('dimensionOrigin', i, v)" @commit="editor.commit()" />
            <PointRow v-if="entity.dimensionOffset" label="引线终点" :point="entity.dimensionOffset" :disabled="isReadOnly" @change="(i, v) => updateDimensionPoint('dimensionOffset', i, v)" @commit="editor.commit()" />
            <NumberRow v-if="entity.dimensionRadius != null" label="标注半径" :value="entity.dimensionRadius" :disabled="isReadOnly" @change="updateDimensionRadius" @commit="editor.commit()" />
            <PointRow label="文字位置" :point="currentAnnotationTextPosition(entity)" :disabled="isReadOnly" @change="updateAnnotationPosition" @commit="editor.commit()" />
            <n-button v-if="entity.textPositionManual" size="tiny" quaternary block :disabled="isReadOnly" @click="resetAnnotationTextPosition">
              恢复自动排版
            </n-button>
          </template>

          <template v-else-if="entity.type === 'annotation'">
            <div class="flex items-center gap-2">
              <span class="w-10 shrink-0 text-xs text-gray-500">文字</span>
              <n-input
                :value="textDraft"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 6 }"
                size="small"
                placeholder="输入标注，支持换行"
                :disabled="isReadOnly"
                @update:value="updateTextContent"
                @blur="editor.commit()"
              />
            </div>
            <NumberRow label="字号" :value="fontSizeDraft" :disabled="isReadOnly" @change="updateTextFontSize" @commit="editor.commit()" />
            <div class="text-[11px] text-gray-400">引线顶点</div>
            <div class="flex flex-col gap-1.5 pl-1">
              <PointRow
                v-for="(p, i) in entity.leader"
                :key="i"
                :label="`#${i + 1}`"
                :point="p"
                :disabled="isReadOnly"
                @change="(idx, v) => updateLeader(i, idx, v)"
                @commit="editor.commit()"
              />
            </div>
            <PointRow label="文字位置" :point="currentAnnotationTextPosition(entity)" :disabled="isReadOnly" @change="updateAnnotationPosition" @commit="editor.commit()" />
            <n-button v-if="entity.textPositionManual" size="tiny" quaternary block :disabled="isReadOnly" @click="resetAnnotationTextPosition">
              恢复自动排版
            </n-button>
          </template>
        </div>

        <!-- 底部操作 -->
        <div class="px-4 py-3 mt-auto border-t border-gray-200 dark:border-gray-700">
          <n-button size="small" type="error" ghost block :disabled="isReadOnly" @click="editor.deleteSelected()">
            {{ entity.groupId ? '从组合中删除' : '删除该图元' }}
          </n-button>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { DEFAULTS, ENTITY_LABELS } from '#draiq/utils/editor/config'
import { annotationTextPosition, entityCenter, releaseDimensionSourceTextPosition, rotateEntity, round } from '#draiq/utils/editor/geometry'
import { applyExplicitEntityStyle } from '#draiq/utils/editor/layers'
import { detachDimensionReference } from '#draiq/utils/editor/associativeDimensions'
import { editorKey } from '#draiq/composables/editorKey'
import EditorBatchProperties from '#draiq/components/editor/EditorBatchProperties.vue'
import DimensionStyleEditor from '#draiq/components/editor/DimensionStyleEditor.vue'
import PointRow from '#draiq/components/editor/_PointRow.vue'
import NumberRow from '#draiq/components/editor/_NumberRow.vue'

const editor = inject(editorKey)!
const isReadOnly = editor.loading
const lineTypeOptions = [
  { label: '实线', value: 'solid' },
  { label: '虚线', value: 'dashed' },
  { label: '点画线', value: 'dashdot' },
]

/** 当前选中实体（响应式） */
const entity = computed(() => {
  void editor.dataVersion.value
  void editor.selectionVersion.value
  return editor.state.selectedIds.length === 1
    ? editor.findEntity(editor.state.selectedId)
    : null
})

/** 当前选择数量 */
const selectedCount = computed(() => {
  void editor.selectionVersion.value
  return editor.state.selectedIds.length
})

/** 属性面板刷新版本；直接参与模板渲染，避免实体对象引用不变时被 Vue 跳过更新。 */
const propertyRefreshVersion = computed(() => editor.dataVersion.value + editor.selectionVersion.value)

/** 当前线型继承规则；显式依赖刷新版本，确保浅响应实体修改后下拉框同步。 */
const lineTypeModeValue = computed<EntityStyleMode>(() => {
  void editor.dataVersion.value
  void editor.selectionVersion.value
  return entity.value?.lineTypeMode || 'explicit'
})

/** 当前线宽继承规则；显式依赖刷新版本，确保浅响应实体修改后下拉框同步。 */
const lineWidthModeValue = computed<EntityStyleMode>(() => {
  void editor.dataVersion.value
  void editor.selectionVersion.value
  return entity.value?.lineWidthMode || 'explicit'
})

/** 当前旋转角度；使用标量依赖确保画布拖动时属性输入框实时刷新。 */
const rotationValue = computed(() => {
  void editor.dataVersion.value
  void editor.selectionVersion.value
  return entity.value?.rotation ?? 0
})

/** 更新实体字段（实时预览，不入历史栈） */
const textPropertyState = computed(() => {
  void editor.dataVersion.value
  void editor.selectionVersion.value
  const current = entity.value
  if (!current || (current.type !== 'text' && current.type !== 'annotation' && current.type !== 'dimension')) return null
  return {
    id: current.id,
    type: current.type,
    content: current.type === 'text' ? current.content || '' : current.dimensionTextOverride || current.text || '',
    fontSize: current.fontSize ?? 14,
  }
})
const textDraft = ref('')
const fontSizeDraft = ref(14)
let textDraftIdentity = ''

watch(textPropertyState, (current) => {
  const identity = current ? `${current.id}:${current.type}` : ''
  if (identity !== textDraftIdentity || current?.content !== textDraft.value) {
    textDraft.value = current?.content || ''
  }
  if (identity !== textDraftIdentity || current?.fontSize !== fontSizeDraft.value) {
    fontSizeDraft.value = current?.fontSize ?? 14
  }
  textDraftIdentity = identity
}, { immediate: true })

type EditableField = 'layer' | 'color' | 'lineWidth' | 'lineType' | 'dxfLineType' | 'lineDash' | 'radius' | 'closed' | 'fontSize' | 'content' | 'text'

const styleModeOptions = [
  { label: '显式值', value: 'explicit' },
  { label: 'ByLayer', value: 'byLayer' },
  { label: 'ByBlock', value: 'byBlock' },
]

/** 更新当前实体的可编辑属性并刷新画布。 @param field 属性名。 @param value 新属性值。 @returns 无返回值。 @author snihao */
function updateField(field: EditableField, value: Entity[EditableField]): void {
  if (isReadOnly.value || !entity.value || !editor.isEntityEditable(entity.value)) return
  if (field === 'color') applyExplicitEntityStyle(entity.value, { color: value as Entity['color'] })
  else if (field === 'lineWidth') applyExplicitEntityStyle(entity.value, { lineWidth: value as Entity['lineWidth'] })
  else Object.assign(entity.value, { [field]: value })
  editor.liveUpdate()
}

/** 修改实体样式继承模式。 @param field 样式字段。 @param value 继承模式。 @returns 无返回值。 @author snihao */
function updateStyleMode(field: 'colorMode' | 'lineTypeMode' | 'lineWidthMode', value: EntityStyleMode): void {
  if (isReadOnly.value || !entity.value || !editor.isEntityEditable(entity.value)) return
  entity.value[field] = value
  editor.commit()
}

/** 格式化曲线参数面板中的数值。 @param value 数值。 @returns 格式化文本。 @author snihao */
function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString()
}

/** 格式化曲线点或轴向量。 @param point 二维点。 @returns 格式化文本。 @author snihao */
function formatPoint(point: Point): string {
  return `${formatNumber(point[0])}, ${formatNumber(point[1])}`
}

function updateTextContent(value: string): void {
  if (isReadOnly.value) return
  const current = entity.value
  if (!current || (current.type !== 'text' && current.type !== 'annotation' && current.type !== 'dimension')) return
  textDraft.value = value
  if (current.type === 'annotation') current.dimensionTextManual = true
  if (current.type === 'dimension') {
    current.dimensionTextManual = value.trim().length > 0
    current.dimensionTextOverride = value.trim() || null
  }
  updateField(current.type === 'text' ? 'content' : 'text', value)
}

function updateTextFontSize(value: number): void {
  if (isReadOnly.value) return
  const next = Math.max(1, value)
  fontSizeDraft.value = next
  if (entity.value?.type === 'dimension') {
    entity.value.dimensionTextHeightManual = true
    entity.value.dimensionTextSourceHeight = false
  }
  updateField('fontSize', next)
}

/** 更新原生标注的实体级样式覆盖。
 * @param field 样式字段。
 * @param value 新值；空值表示清除覆盖。
 * @returns 无返回值。
 * @author snihao
 */
function updateDimensionStyle(field: keyof DimensionStyleOverride, value: number | boolean | string | null): void {
  const current = entity.value
  if (isReadOnly.value || !current || current.type !== 'dimension' || !editor.isEntityEditable(current)) return
  const overrides: DimensionStyleOverride = { ...(current.dimensionStyleOverrides || {}) }
  if (value === null) delete overrides[field]
  else Object.assign(overrides, { [field]: value })
  current.dimensionStyleOverrides = Object.values(overrides).some((item) => item != null) ? overrides : null
  current.dimensionDisplaySegments = null
  if (field === 'textHeight') {
    current.dimensionTextHeightManual = false
    current.dimensionTextSourceHeight = false
    current.fontSize = null
  }
  editor.liveUpdate()
}

/** 修改原生标注引用的 DIMSTYLE 名称。
 * @param name 样式名称。
 * @returns 无返回值。
 * @author snihao
 */
function updateDimensionStyleName(name: string): void {
  const current = entity.value
  if (isReadOnly.value || !current || current.type !== 'dimension' || !editor.isEntityEditable(current)) return
  current.dimensionStyle = name.trim() || 'Standard'
  current.dimensionDisplaySegments = null
  if (current.dimensionTextSourceHeight) {
    current.dimensionTextSourceHeight = false
    if (!current.dimensionTextHeightManual) current.fontSize = null
  }
  editor.liveUpdate()
}

/** 返回原生标注类型的中文名称。 */
function dimensionTypeLabel(type: DimensionType | null | undefined): string {
  const labels: Record<DimensionType, string> = {
    linear: '线性',
    aligned: '对齐',
    angular: '角度',
    radius: '半径',
    diameter: '直径',
    arcLength: '弧长',
    ordinate: '坐标',
  }
  return type ? labels[type] : '未知'
}

/** 按目标角度旋转图元，并同步实际几何坐标。 */
function updateRotation(value: number): void {
  if (isReadOnly.value || !entity.value || entity.value.type === 'circle' || !editor.isEntityEditable(entity.value)) return
  const current = entity.value.rotation || 0
  const delta = value - current
  if (Math.abs(delta) < 1e-6) return
  rotateEntity(entity.value, (delta * Math.PI) / 180, entityCenter(entity.value))
  editor.liveUpdate()
}

/** 更新点位字段（start/end/position） */
function updatePoint(field: 'start' | 'end' | 'position', index: number, value: number): void {
  if (isReadOnly.value || !entity.value || !editor.isEntityEditable(entity.value)) return
  const pt = entity.value[field]
  if (pt) {
    pt[index] = round(value)
    editor.liveUpdate()
  }
}

/** 更新多段线顶点 */
function updatePointItem(itemIndex: number, axis: number, value: number): void {
  if (isReadOnly.value || !entity.value?.points || !editor.isEntityEditable(entity.value)) return
  entity.value.curveGeometry = null
  entity.value.points[itemIndex][axis] = round(value)
  editor.liveUpdate()
}

/** 更新圆心 */
function updateCenter(axis: number, value: number): void {
  if (isReadOnly.value || !entity.value?.center || !editor.isEntityEditable(entity.value)) return
  entity.value.center[axis] = round(value)
  editor.liveUpdate()
}

/** 更新引线顶点 */
function updateLeader(itemIndex: number, axis: number, value: number): void {
  if (isReadOnly.value || !entity.value?.leader || !editor.isEntityEditable(entity.value)) return
  detachDimensionReference(entity.value, itemIndex)
  entity.value.leader[itemIndex][axis] = round(value)
  editor.liveUpdate()
}

/** 更新原生标注的测量点或尺寸线位置。 */
function updateDimensionPoint(
  field: 'dimensionStart' | 'dimensionEnd' | 'dimensionCenter' | 'dimensionLinePosition' | 'dimensionOrigin' | 'dimensionOffset',
  axis: number,
  value: number,
): void {
  const current = entity.value
  if (isReadOnly.value || !current || current.type !== 'dimension' || !current[field] || !editor.isEntityEditable(current)) return
  detachDimensionReference(current, field === 'dimensionStart' ? 0 : field === 'dimensionEnd' ? 1 : -1)
  current.dimensionDisplaySegments = null
  releaseDimensionSourceTextPosition(current)
  current[field]![axis] = round(value)
  if (field === 'dimensionCenter' && current.dimensionStart) current.dimensionRadius = round(Math.hypot(current.dimensionStart[0] - current[field]![0], current.dimensionStart[1] - current[field]![1]), 9)
  editor.liveUpdate()
}

/** 修改半径标注的参数半径，并同步测量点。 */
function updateDimensionRadius(value: number): void {
  const current = entity.value
  if (isReadOnly.value || !current || current.type !== 'dimension' || !current.dimensionCenter || !current.dimensionStart || !editor.isEntityEditable(current)) return
  const radius = Math.max(0.1, value)
  const dx = current.dimensionStart[0] - current.dimensionCenter[0]
  const dy = current.dimensionStart[1] - current.dimensionCenter[1]
  const length = Math.max(Math.hypot(dx, dy), 1e-9)
  current.dimensionRadius = radius
  current.dimensionStart = [
    round(current.dimensionCenter[0] + dx / length * radius),
    round(current.dimensionCenter[1] + dy / length * radius),
  ]
  current.dimensionDisplaySegments = null
  releaseDimensionSourceTextPosition(current)
  editor.liveUpdate()
}

/** 手动调整标注文字位置。 */
function updateAnnotationPosition(axis: number, value: number): void {
  if (isReadOnly.value || !entity.value || !editor.isEntityEditable(entity.value) || (entity.value.type !== 'annotation' && entity.value.type !== 'dimension')) return
  const position = currentAnnotationTextPosition(entity.value).slice() as Point
  position[axis] = round(value)
  entity.value.position = position
  entity.value.textPositionManual = true
  entity.value.dimensionTextSourcePosition = false
  editor.liveUpdate()
}

/** 恢复标注文字自动居中/外置排版。 */
function resetAnnotationTextPosition(): void {
  if (isReadOnly.value || !entity.value || !editor.isEntityEditable(entity.value) || (entity.value.type !== 'annotation' && entity.value.type !== 'dimension')) return
  entity.value.textPositionManual = false
  entity.value.dimensionTextSourcePosition = false
  entity.value.position = currentAnnotationTextPosition(entity.value)
  editor.commit()
}

/**
 * 使用当前图纸 DIMSTYLE 解析标注文字位置。
 * @param current 标注实体。
 * @returns 画布中的文字锚点。
 * @author snihao
 */
function currentAnnotationTextPosition(current: Entity): Point {
  return annotationTextPosition(current, undefined, editor.state.drawing)
}

/** 统一修改组合内所有子图元的颜色 */
function updateGroupColor(color: string): void {
  if (isReadOnly.value || !entity.value?.children || !editor.isEntityEditable(entity.value)) return
  applyGroupStyle(entity.value, { color })
  editor.liveUpdate()
}

/** 统一修改组合内所有子图元的线宽 */
function updateGroupLineWidth(lw: number): void {
  if (isReadOnly.value || !entity.value?.children || !editor.isEntityEditable(entity.value)) return
  applyGroupStyle(entity.value, { lineWidth: lw })
  editor.liveUpdate()
}

function updateGroupLineType(lineType: LineType): void {
  if (isReadOnly.value || !entity.value?.children || !editor.isEntityEditable(entity.value)) return
  applyGroupStyle(entity.value, { lineType })
  editor.liveUpdate()
}

/** 将组合样式应用到所有子实体，覆盖导入时的 ByLayer/ByBlock 继承值。 */
function applyGroupStyle(group: Entity, patch: Partial<Pick<Entity, 'color' | 'lineWidth' | 'lineType'>>): void {
  applyExplicitEntityStyle(group, patch)
  for (const child of group.children || []) {
    applyExplicitEntityStyle(child, patch)
    if (child.type === 'group') applyGroupStyle(child, patch)
  }
}

function updateEntityLineType(lineType: LineType): void {
  if (isReadOnly.value || !entity.value || !editor.isEntityEditable(entity.value)) return
  applyExplicitEntityStyle(entity.value, { lineType })
  editor.liveUpdate()
}
</script>
