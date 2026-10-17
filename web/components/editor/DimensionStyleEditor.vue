<template>
  <div class="space-y-2 rounded border border-slate-200 bg-slate-50/70 p-2 dark:border-slate-700 dark:bg-white/5">
    <div class="text-[11px] font-semibold tracking-wide text-slate-500">标注样式</div>

    <div class="flex items-center gap-2">
      <span class="w-14 shrink-0 text-xs text-gray-500">DIMSTYLE</span>
      <n-select
        :value="selectedStyleName"
        :options="styleOptions"
        size="small"
        class="flex-1"
        :disabled="props.disabled"
        @update:value="updateStyleName"
      />
    </div>

    <NumberRow label="字高" :value="effectiveStyle.textHeight" :disabled="props.disabled" @change="(value) => updateNumber('textHeight', value)" @commit="emit('commit')" />
    <NumberRow label="箭头" :value="effectiveStyle.arrowSize" :disabled="props.disabled" @change="(value) => updateNumber('arrowSize', value)" @commit="emit('commit')" />
    <NumberRow label="界线留白" :value="effectiveStyle.extensionOffset" :disabled="props.disabled" @change="(value) => updateNumber('extensionOffset', value)" @commit="emit('commit')" />
    <NumberRow label="界线超出" :value="effectiveStyle.extensionBeyond" :disabled="props.disabled" @change="(value) => updateNumber('extensionBeyond', value)" @commit="emit('commit')" />
    <NumberRow label="文字间隙" :value="effectiveStyle.textGap" :disabled="props.disabled" @change="(value) => updateNumber('textGap', value)" @commit="emit('commit')" />
    <NumberRow label="圆心标记" :value="effectiveStyle.centerMarkSize" :disabled="props.disabled" @change="(value) => updateNumber('centerMarkSize', value)" @commit="emit('commit')" />

    <div class="flex items-center gap-2">
      <span class="w-14 shrink-0 text-xs text-gray-500">文字前缀</span>
      <n-input :value="effectiveStyle.textPrefix || ''" size="small" class="flex-1" :disabled="props.disabled" @update:value="(value: string) => updateTextPart('textPrefix', value)" @blur="emit('commit')" />
    </div>
    <div class="flex items-center gap-2">
      <span class="w-14 shrink-0 text-xs text-gray-500">文字后缀</span>
      <n-input :value="effectiveStyle.textSuffix || ''" size="small" class="flex-1" :disabled="props.disabled" @update:value="(value: string) => updateTextPart('textSuffix', value)" @blur="emit('commit')" />
    </div>

    <div class="flex items-center gap-2">
      <span class="w-14 shrink-0 text-xs text-gray-500">尺寸线色</span>
      <input
        :value="effectiveStyle.dimensionLineColor || '#526170'"
        type="color"
        class="h-7 w-8 cursor-pointer rounded border border-gray-200"
        :disabled="props.disabled"
        @input="updateColor('dimensionLineColor', $event)"
      >
      <n-button v-if="hasOverride('dimensionLineColor')" size="tiny" quaternary :disabled="props.disabled" @click="resetField('dimensionLineColor')">沿用实体</n-button>
    </div>

    <div class="flex items-center gap-2">
      <span class="w-14 shrink-0 text-xs text-gray-500">界线色</span>
      <input
        :value="effectiveStyle.extensionLineColor || '#526170'"
        type="color"
        class="h-7 w-8 cursor-pointer rounded border border-gray-200"
        :disabled="props.disabled"
        @input="updateColor('extensionLineColor', $event)"
      >
      <n-button v-if="hasOverride('extensionLineColor')" size="tiny" quaternary :disabled="props.disabled" @click="resetField('extensionLineColor')">沿用实体</n-button>
    </div>

    <div class="flex items-center gap-2">
      <span class="w-14 shrink-0 text-xs text-gray-500">文字色</span>
      <input
        :value="effectiveStyle.textColor || '#526170'"
        type="color"
        class="h-7 w-8 cursor-pointer rounded border border-gray-200"
        :disabled="props.disabled"
        @input="updateColor('textColor', $event)"
      >
      <n-button v-if="hasOverride('textColor')" size="tiny" quaternary :disabled="props.disabled" @click="resetField('textColor')">沿用实体</n-button>
    </div>

    <n-checkbox :checked="effectiveStyle.suppressFirstExtension" :disabled="props.disabled" @update:checked="(value: boolean) => updateToggle('suppressFirstExtension', value)">
      隐藏第一条界线
    </n-checkbox>
    <n-checkbox :checked="effectiveStyle.suppressSecondExtension" :disabled="props.disabled" @update:checked="(value: boolean) => updateToggle('suppressSecondExtension', value)">
      隐藏第二条界线
    </n-checkbox>
    <n-checkbox :checked="effectiveStyle.suppressDimensionLine" :disabled="props.disabled" @update:checked="(value: boolean) => updateToggle('suppressDimensionLine', value)">
      隐藏尺寸线
    </n-checkbox>

    <n-button v-if="hasOverrides" size="tiny" quaternary block :disabled="props.disabled" @click="resetAll">清除本标注覆盖</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { getDimensionStyleDefinition, resolveDimensionStyle } from '#draiq/utils/editor/dimensionStyles'
import { editorKey } from '#draiq/composables/editorKey'
import NumberRow from '#draiq/components/editor/_NumberRow.vue'

/** 可编辑的数值样式字段。 */
type NumericStyleField = 'textHeight' | 'arrowSize' | 'extensionOffset' | 'extensionBeyond' | 'textGap' | 'centerMarkSize'

/** 可编辑的开关样式字段。 */
type ToggleStyleField = 'suppressFirstExtension' | 'suppressSecondExtension' | 'suppressDimensionLine'

/** 可编辑的颜色样式字段。 */
type ColorStyleField = 'dimensionLineColor' | 'extensionLineColor' | 'textColor'

const props = defineProps<{
  /** 当前选中的原生标注。 */
  entity: Entity
  /** 是否处于 CAD 只读锁定态。 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 更新标注样式覆盖项。 */
  change: [field: keyof DimensionStyleOverride, value: number | boolean | string | null]
  /** 更新 DIMSTYLE 引用。 */
  styleChange: [name: string]
  /** 提交一次历史记录。 */
  commit: []
}>()

const editor = inject(editorKey)!

/** 当前标注引用的 DIMSTYLE 名称。 */
const selectedStyleName = computed(() => {
  void editor.selectionVersion.value
  return getDimensionStyleDefinition(editor.state.drawing, props.entity.dimensionStyle).name
})

/** 当前标注使用的有效样式。 */
const effectiveStyle = computed(() => {
  void editor.selectionVersion.value
  void editor.dataVersion.value
  return resolveDimensionStyle(props.entity, editor.state.drawing)
})

/** 面板中的 DIMSTYLE 选项。 */
const styleOptions = computed(() => {
  void editor.dataVersion.value
  return (editor.state.drawing.dimensionStyles || []).map((style) => ({ label: style.name, value: style.name }))
})

/** 判断字段是否已经写入实体覆盖。 */
const hasOverride = (field: keyof DimensionStyleOverride): boolean => {
  const overrides = props.entity.dimensionStyleOverrides
  return !!overrides && overrides[field] != null
}

/** 判断当前标注是否存在任意覆盖。 */
const hasOverrides = computed(() => {
  void editor.selectionVersion.value
  void editor.dataVersion.value
  const overrides = props.entity.dimensionStyleOverrides
  return !!overrides && Object.values(overrides).some((value) => value != null)
})

/** 修改样式引用。
 * @param value 样式名称。
 * @author snihao
 */
function updateStyleName(value: string): void {
  if (props.disabled) return
  emit('styleChange', value || 'Standard')
}

/** 修改数值覆盖项。
 * @param field 样式字段。
 * @param value 新数值。
 * @author snihao
 */
function updateNumber(field: NumericStyleField, value: number): void {
  if (props.disabled) return
  emit('change', field, Math.max(0, value))
}

/** 修改开关覆盖项。
 * @param field 样式字段。
 * @param value 是否启用。
 * @author snihao
 */
function updateToggle(field: ToggleStyleField, value: boolean): void {
  if (props.disabled) return
  emit('change', field, value)
}

/** 修改文字前后缀覆盖项。
 * @param field 文字字段。
 * @param value 新文字。
 * @author snihao
 */
function updateTextPart(field: 'textPrefix' | 'textSuffix', value: string): void {
  if (props.disabled) return
  emit('change', field, value || null)
}

/** 修改颜色覆盖项。
 * @param field 颜色字段。
 * @param event 原生颜色输入事件。
 * @author snihao
 */
function updateColor(field: ColorStyleField, event: Event): void {
  if (props.disabled) return
  const input = event.target as HTMLInputElement | null
  if (input?.value) emit('change', field, input.value.toUpperCase())
}

/** 清除一个覆盖字段。
 * @param field 待清除字段。
 * @author snihao
 */
function resetField(field: keyof DimensionStyleOverride): void {
  if (props.disabled) return
  emit('change', field, null)
  emit('commit')
}

/** 清除当前标注的全部覆盖。
 * @author snihao
 */
function resetAll(): void {
  if (props.disabled) return
  emit('change', 'textHeight', null)
  emit('change', 'arrowSize', null)
  emit('change', 'extensionOffset', null)
  emit('change', 'extensionBeyond', null)
  emit('change', 'textGap', null)
  emit('change', 'centerMarkSize', null)
  emit('change', 'dimensionLineColor', null)
  emit('change', 'extensionLineColor', null)
  emit('change', 'textColor', null)
  emit('change', 'suppressFirstExtension', null)
  emit('change', 'suppressSecondExtension', null)
  emit('change', 'suppressDimensionLine', null)
  emit('change', 'textPrefix', null)
  emit('change', 'textSuffix', null)
  emit('commit')
}
</script>
