/** 原生标注样式的默认值、规范化和实体级覆盖解析。 */

/** 标注样式的默认名称。 */
export const DEFAULT_DIMENSION_STYLE_NAME = 'Standard'

/** 返回用于比较 DIMSTYLE 名称的 DXF 规范键。 */
function dimensionStyleKey(name: string): string {
  return name.trim().toUpperCase()
}

/** 编辑器创建新标注时使用的默认 DIMSTYLE。 */
export const DEFAULT_DIMENSION_STYLE: DimensionStyleDefinition = {
  name: DEFAULT_DIMENSION_STYLE_NAME,
  scale: 1,
  textHeight: 2.5,
  arrowSize: 2.5,
  extensionOffset: 0.625,
  extensionBeyond: 0.625,
  textGap: 0.625,
  centerMarkSize: 2.5,
  dimensionLineColor: null,
  extensionLineColor: null,
  textColor: null,
  suppressFirstExtension: false,
  suppressSecondExtension: false,
  suppressDimensionLine: false,
  textStyle: null,
  textPrefix: null,
  textSuffix: null,
}

/** 画布渲染时使用的有效标注样式。 @author snihao */
export interface EffectiveDimensionStyle {
  /** 样式名称。 */
  name: string
  /** 已应用整体比例后的文字高度。 */
  textHeight: number
  /** 已应用整体比例后的箭头长度。 */
  arrowSize: number
  /** 已应用整体比例后的尺寸界线起点留白。 */
  extensionOffset: number
  /** 已应用整体比例后的尺寸界线超出长度。 */
  extensionBeyond: number
  /** 已应用整体比例后的文字间隙。 */
  textGap: number
  /** 已应用整体比例后的圆心标记尺寸。 */
  centerMarkSize: number
  /** 有效尺寸线颜色。 */
  dimensionLineColor: DimensionStyleColor
  /** 有效尺寸界线颜色。 */
  extensionLineColor: DimensionStyleColor
  /** 有效文字颜色。 */
  textColor: DimensionStyleColor
  /** 是否隐藏第一条尺寸界线。 */
  suppressFirstExtension: boolean
  /** 是否隐藏第二条尺寸界线。 */
  suppressSecondExtension: boolean
  /** 是否隐藏尺寸线。 */
  suppressDimensionLine: boolean
  /** 有效文字样式名称。 */
  textStyle: string | null
  /** 有效文字前缀。 */
  textPrefix: string | null
  /** 有效文字后缀。 */
  textSuffix: string | null
}

/** 创建指定名称的标准化 DIMSTYLE 定义。
 * @param name 样式名称。
 * @returns 可写入图纸的样式定义。
 * @author snihao
 */
export function createDimensionStyleDefinition(name = DEFAULT_DIMENSION_STYLE_NAME): DimensionStyleDefinition {
  const normalized = name.trim() || DEFAULT_DIMENSION_STYLE_NAME
  return { ...DEFAULT_DIMENSION_STYLE, name: normalized }
}

/** 返回新建尺寸标注使用的 DIMSTYLE 样式。
 * @param drawing 当前图纸。
 * @returns 当前 DIMSTYLE 名称；未设置时返回 Standard。
 * @author snihao
 */
export function currentDimensionStyleName(drawing: Drawing): string {
  const requested = drawing.currentDimensionStyle?.trim()
  if (!requested) return DEFAULT_DIMENSION_STYLE_NAME
  const key = dimensionStyleKey(requested)
  return drawing.dimensionStyles?.find((style) => dimensionStyleKey(style.name) === key)?.name || requested
}

/** 规范化一个来自快照、导入或旧版本的 DIMSTYLE 定义。
 * @param value 待规范化的样式。
 * @returns 具备完整字段的样式定义。
 * @author snihao
 */
export function normalizeDimensionStyle(value: Partial<DimensionStyleDefinition> & { name?: string | null }): DimensionStyleDefinition {
  const defaults = createDimensionStyleDefinition(value.name || DEFAULT_DIMENSION_STYLE_NAME)
  return {
    ...defaults,
    ...value,
    name: value.name?.trim() || defaults.name,
    scale: positive(value.scale, defaults.scale),
    textHeight: positive(value.textHeight, defaults.textHeight),
    arrowSize: positive(value.arrowSize, defaults.arrowSize),
    extensionOffset: nonNegative(value.extensionOffset, defaults.extensionOffset),
    extensionBeyond: nonNegative(value.extensionBeyond, defaults.extensionBeyond),
    textGap: nonNegative(value.textGap, defaults.textGap),
    centerMarkSize: nonNegative(value.centerMarkSize, defaults.centerMarkSize),
    dimensionLineColor: normalizeColor(value.dimensionLineColor),
    extensionLineColor: normalizeColor(value.extensionLineColor),
    textColor: normalizeColor(value.textColor),
    suppressFirstExtension: value.suppressFirstExtension === true,
    suppressSecondExtension: value.suppressSecondExtension === true,
    suppressDimensionLine: value.suppressDimensionLine === true,
    textStyle: value.textStyle?.trim() || null,
    textPrefix: value.textPrefix || null,
    textSuffix: value.textSuffix || null,
  }
}

/** 补齐图纸 DIMSTYLE 表，并为旧图纸追加 Standard 样式。
 * @param drawing 待规范化的图纸。
 * @returns 规范化后的样式列表。
 * @author snihao
 */
export function ensureDrawingDimensionStyles(drawing: Drawing): DimensionStyleDefinition[] {
  const styles = new Map<string, DimensionStyleDefinition>()
  for (const value of drawing.dimensionStyles || []) {
    const normalized = normalizeDimensionStyle(value)
    const key = dimensionStyleKey(normalized.name)
    if (key && !styles.has(key)) styles.set(key, normalized)
  }
  const defaultKey = dimensionStyleKey(DEFAULT_DIMENSION_STYLE_NAME)
  if (!styles.has(defaultKey)) {
    styles.set(defaultKey, createDimensionStyleDefinition())
  }
  const referenced = new Map<string, string>()
  const canonicalName = (name: string | null | undefined): string | null => {
    const normalized = name?.trim()
    if (!normalized) return null
    const key = dimensionStyleKey(normalized)
    return styles.get(key)?.name || referenced.get(key) || normalized
  }
  const registerReference = (name: string | null | undefined): string | null => {
    const canonical = canonicalName(name)
    if (!canonical) return null
    referenced.set(dimensionStyleKey(canonical), canonical)
    return canonical
  }
  let inferredCurrent: string | null = null
  const visit = (entities: Entity[]): void => {
    for (const entity of entities) {
      if (entity.type === 'dimension' && entity.dimensionStyle?.trim()) {
        const name = registerReference(entity.dimensionStyle)
        if (name) {
          entity.dimensionStyle = name
          if (!inferredCurrent) inferredCurrent = name
        }
      }
      if (entity.children) visit(entity.children)
    }
  }
  visit(drawing.entities)
  const explicitCurrent = registerReference(drawing.currentDimensionStyle)
  drawing.currentDimensionStyle = explicitCurrent || inferredCurrent || DEFAULT_DIMENSION_STYLE_NAME
  registerReference(drawing.currentDimensionStyle)
  for (const [key, name] of referenced) {
    if (!styles.has(key)) styles.set(key, createDimensionStyleDefinition(name))
  }
  drawing.dimensionStyles = [...styles.values()]
  return drawing.dimensionStyles
}

/** 按名称读取样式，不修改图纸。
 * @param drawing 当前图纸。
 * @param name 样式名称。
 * @returns 样式定义；找不到时回退 Standard。
 * @author snihao
 */
export function getDimensionStyleDefinition(drawing: Drawing, name: string | null | undefined): DimensionStyleDefinition {
  const normalized = name?.trim() || DEFAULT_DIMENSION_STYLE_NAME
  const key = dimensionStyleKey(normalized)
  const style = (drawing.dimensionStyles || []).find((item) => dimensionStyleKey(item.name) === key)
  return style ? normalizeDimensionStyle(style) : createDimensionStyleDefinition(normalized)
}

/** 解析实体最终使用的 DIMSTYLE，并应用实体级覆盖。
 * @param entity 原生标注实体。
 * @param drawing 当前图纸。
 * @returns 已应用整体比例和覆盖项的有效样式。
 * @author snihao
 */
export function resolveDimensionStyle(entity: Entity, drawing: Drawing): EffectiveDimensionStyle {
  const definition = getDimensionStyleDefinition(drawing, entity.dimensionStyle)
  const override = entity.dimensionStyleOverrides || {}
  const scale = Math.max(definition.scale, 1e-6)
  const usesEntityTextHeight = (entity.dimensionTextHeightManual || entity.dimensionTextSourceHeight)
    && entity.fontSize != null
  const textHeight = usesEntityTextHeight
    ? positive(entity.fontSize, definition.textHeight * scale)
    : positive(override.textHeight, definition.textHeight * scale)
  return {
    name: definition.name,
    textHeight,
    arrowSize: positive(override.arrowSize, definition.arrowSize * scale),
    extensionOffset: nonNegative(override.extensionOffset, definition.extensionOffset * scale),
    extensionBeyond: nonNegative(override.extensionBeyond, definition.extensionBeyond * scale),
    textGap: nonNegative(override.textGap, definition.textGap * scale),
    centerMarkSize: nonNegative(override.centerMarkSize, definition.centerMarkSize * scale),
    dimensionLineColor: override.dimensionLineColor ?? definition.dimensionLineColor,
    extensionLineColor: override.extensionLineColor ?? definition.extensionLineColor,
    textColor: override.textColor ?? definition.textColor,
    suppressFirstExtension: override.suppressFirstExtension ?? definition.suppressFirstExtension,
    suppressSecondExtension: override.suppressSecondExtension ?? definition.suppressSecondExtension,
    suppressDimensionLine: override.suppressDimensionLine ?? definition.suppressDimensionLine,
    textStyle: override.textStyle ?? definition.textStyle ?? null,
    textPrefix: override.textPrefix ?? definition.textPrefix ?? null,
    textSuffix: override.textSuffix ?? definition.textSuffix ?? null,
  }
}

/** 读取一个有限数值；无效值使用后备值。
 * @param value 待检查的数值。
 * @param fallback 后备值。
 * @returns 有限数值或后备值。
 * @author snihao
 */
function finite(value: number | null | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) ? value : fallback
}

/** 读取一个正数。
 * @param value 待检查的数值。
 * @param fallback 后备值。
 * @returns 大于零的数值。
 * @author snihao
 */
function positive(value: number | null | undefined, fallback: number): number {
  return Math.max(finite(value, fallback), 1e-6)
}

/** 读取一个非负数。
 * @param value 待检查的数值。
 * @param fallback 后备值。
 * @returns 非负数值。
 * @author snihao
 */
function nonNegative(value: number | null | undefined, fallback: number): number {
  return Math.max(finite(value, fallback), 0)
}

/** 规范化可选颜色。
 * @param value 待检查的颜色。
 * @returns 大写十六进制颜色或空值。
 * @author snihao
 */
function normalizeColor(value: DimensionStyleColor | undefined): DimensionStyleColor {
  return value && /^#[0-9A-F]{6}$/i.test(value) ? value.toUpperCase() : null
}
