/** 图层表和实体样式继承工具，统一服务于渲染、捕捉、编辑和导出。 */
import { DEFAULTS, LAYER_COLORS } from '#draiq/utils/editor/config'

/** 解析后的实体有效样式。 @author snihao */
export interface EffectiveEntityStyle {
  color: string
  lineWidth: number
  lineType: LineType
  dxfLineType: string | null
  lineDash: number[] | null
}

/** 用户编辑后应改为显式值的实体样式字段。 */
export type ExplicitEntityStylePatch = Partial<Pick<Entity, 'color' | 'lineWidth' | 'lineType'>>

/** 应用用户输入的样式值，并停止继承已编辑字段。 */
export function applyExplicitEntityStyle(entity: Entity, patch: ExplicitEntityStylePatch): void {
  if (patch.color !== undefined) {
    entity.color = patch.color
    entity.colorMode = 'explicit'
  }
  if (patch.lineWidth !== undefined) {
    entity.lineWidth = patch.lineWidth
    entity.lineWidthMode = 'explicit'
  }
  if (patch.lineType !== undefined) {
    entity.lineType = patch.lineType
    entity.lineTypeMode = 'explicit'
    entity.dxfLineType = null
    entity.lineDash = null
  }
}

/** 创建一个可安全写入图纸的图层定义。 @param name 图层名称。 @returns 新图层。 @author snihao */
export function createLayerDefinition(name: string): LayerDefinition {
  const normalized = name.trim() || DEFAULTS.layer
  return {
    name: normalized,
    color: (LAYER_COLORS as Record<string, string>)[normalized] || DEFAULTS.color,
    lineWidth: null,
    lineType: 'solid',
    dxfLineType: 'CONTINUOUS',
    lineDash: null,
    visible: true,
    frozen: false,
    locked: false,
  }
}

/** 递归收集图纸中的图层名称。 @param entities 实体列表。 @returns 去重后的图层名称。 @author snihao */
export function collectLayerNames(entities: Entity[]): string[] {
  const names = new Set<string>()
  const visit = (items: Entity[]): void => {
    for (const entity of items) {
      names.add(entity.layer?.trim() || DEFAULTS.layer)
      if (entity.children) visit(entity.children)
    }
  }
  visit(entities)
  if (!names.size) names.add(DEFAULTS.layer)
  return [...names]
}

/** 补齐图纸图层表并清理重复名称。 @param drawing 待规范化图纸。 @returns 规范化后的图层表。 @author snihao */
export function ensureDrawingLayers(drawing: Drawing): LayerDefinition[] {
  const existing = new Map<string, LayerDefinition>()
  for (const layer of drawing.layers || []) {
    const name = layer.name?.trim()
    if (!name || existing.has(name)) continue
    const defaults = createLayerDefinition(name)
    existing.set(name, {
      ...defaults,
      ...layer,
      name,
      color: normalizeColor(layer.color) || defaults.color,
      lineType: layer.lineType || 'solid',
      visible: layer.visible !== false,
      frozen: layer.frozen === true,
      locked: layer.locked === true,
    })
  }
  for (const name of collectLayerNames(drawing.entities)) {
    if (!existing.has(name)) existing.set(name, createLayerDefinition(name))
  }
  drawing.layers = [...existing.values()]
  return drawing.layers
}

/** 按名称查找图层；不存在时返回默认定义，不修改图纸。 @param drawing 图纸。 @param name 图层名称。 @returns 图层定义。 @author snihao */
export function getLayerDefinition(drawing: Drawing, name: string | null | undefined): LayerDefinition {
  const normalized = name?.trim() || DEFAULTS.layer
  return (drawing.layers || []).find((layer) => layer.name === normalized) || createLayerDefinition(normalized)
}

/** 判断图层是否冻结或隐藏。 @param drawing 图纸。 @param name 图层名称。 @returns 是否不可见。 @author snihao */
export function isLayerFrozen(drawing: Drawing, name: string | null | undefined): boolean {
  const layer = getLayerDefinition(drawing, name)
  return layer.visible === false || layer.frozen === true
}

/** 判断图层是否锁定。 @param drawing 图纸。 @param name 图层名称。 @returns 是否锁定。 @author snihao */
export function isLayerLocked(drawing: Drawing, name: string | null | undefined): boolean {
  return getLayerDefinition(drawing, name).locked === true
}

/** 计算实体的最终显示样式。 @param entity 实体。 @param drawing 图纸。 @param inherited 可选块继承样式。 @returns 有效样式。 @author snihao */
export function resolveEntityStyle(
  entity: Entity,
  drawing: Drawing,
  inherited?: Partial<EffectiveEntityStyle>,
): EffectiveEntityStyle {
  const layer = getLayerDefinition(drawing, entity.layer)
  const color = resolveValue(entity.colorMode, entity.color, layer.color, inherited?.color || layer.color)
  const lineWidth = resolveValue(
    entity.lineWidthMode,
    entity.lineWidth,
    layer.lineWidth ?? inherited?.lineWidth ?? DEFAULTS.lineWidth,
    inherited?.lineWidth ?? layer.lineWidth ?? DEFAULTS.lineWidth,
  )
  const lineType = resolveValue(entity.lineTypeMode, entity.lineType, layer.lineType, inherited?.lineType || layer.lineType)
  const lineDash = entity.lineTypeMode === 'byLayer'
    ? layer.lineDash || null
    : entity.lineTypeMode === 'byBlock'
      ? inherited?.lineDash || layer.lineDash || null
      : entity.lineDash || null
  const dxfLineType = entity.lineTypeMode === 'byLayer'
    ? layer.dxfLineType || null
    : entity.lineTypeMode === 'byBlock'
      ? inherited?.dxfLineType || layer.dxfLineType || null
      : entity.dxfLineType || null
  return {
    color: normalizeColor(color) || DEFAULTS.color,
    lineWidth: Number.isFinite(lineWidth) ? Math.max(0.05, lineWidth) : DEFAULTS.lineWidth,
    lineType,
    dxfLineType,
    lineDash,
  }
}

/** 判断实体是否处于可修改状态。 @param drawing 图纸。 @param entity 实体。 @returns 是否可编辑。 @author snihao */
export function isEntityEditable(drawing: Drawing, entity: Entity | null | undefined): boolean {
  return !!entity && !isLayerLocked(drawing, entity.layer) && !isLayerFrozen(drawing, entity.layer)
}

function resolveValue<T>(mode: EntityStyleMode | undefined, explicit: T | null | undefined, layerValue: T, blockValue: T): T {
  if (mode === 'byBlock') return blockValue
  if (mode === 'byLayer' || explicit == null) return layerValue
  return explicit
}

function normalizeColor(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : null
}
