import { DEFAULTS } from '#draiq/utils/editor/config'
import { curveCircle, flipCurveGeometryY, sampleCurve, scaleCurveGeometry, transformCurveGeometry } from '#draiq/utils/editor/curveGeometry'
import { dimensionMeasurementText, drawingBounds, genId, moveEntity, round } from '#draiq/utils/editor/geometry'
import { createLayerDefinition } from '#draiq/utils/editor/layers'
import { createDimensionStyleDefinition, DEFAULT_DIMENSION_STYLE_NAME, normalizeDimensionStyle } from '#draiq/utils/editor/dimensionStyles'
import { buildDxfHatchSegments } from '#draiq/utils/editor/dxfHatch'

interface Pair { code: number; value: string }
interface RawEntity { type: string; pairs: Pair[] }
/** DXF 图层解析结果。 @author snihao */
interface LayerStyle extends LayerDefinition {
  lineTypeName: string
}
interface BlockDefinition { base: Point; entities: RawEntity[] }
/** 匿名标注块中的文字布局，保持 CAD 原始文字的锚点与字形比例。 */
interface DimensionTextLayout {
  /** 原始文字字高。 */
  fontSize: number | null
  /** 编辑器画布坐标系中的旋转角度。 */
  rotation: number
  /** DXF STYLE 样式名称。 */
  textStyle: string | null
  /** 原始文字实体类型。 */
  dxfTextType: 'TEXT' | 'MTEXT'
  /** 水平锚点。 */
  textAlign: Entity['textAlign']
  /** 垂直锚点。 */
  textBaseline: Entity['textBaseline']
  /** TEXT 的水平宽度因子。 */
  textWidthFactor: number | null
}
interface DimensionTextTemplate {
  prefix: string
  suffix: string
}
interface InheritedEntityStyle { layer: string; color: string; lineWidth: number; lineType: LineType; dxfLineType: string; lineDash: number[] | null }
interface DxfUnitInfo { unit: DrawingUnit; scale: number }
interface PolylineVertex { point: Point; bulge: number }
interface EditorSourceStyle { color?: string; lineWidth?: number }

const MAX_CURVE_SEGMENTS = 2048
const EDITOR_STYLE_APPID = 'TOOLS_ERA_STYLE'

const ACI_COLORS: Record<number, string> = {
  1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF',
  5: '#0000FF', 6: '#FF00FF',
  // dxf-render 将 ACI 7 解析为浅色主题前景色（#000000）。
  // 使编辑器模型与未修改的参考原图使用相同颜色空间。
  7: '#000000', 8: '#808080', 9: '#C0C0C0',
}

export interface DxfImportResult {
  drawing: Drawing
  unsupported: Record<string, number>
  referenceTransform: DxfReferenceTransform
}

/** 原始 DXF WCS 坐标到编辑器 world 坐标的仿射变换。 */
export interface DxfReferenceTransform {
  scale: number
  offsetX: number
  offsetY: number
}

export function parseDxfFile(text: string): DxfImportResult {
  const pairs = tokenize(text)
  const unitInfo = parseUnit(pairs)
  const unit = unitInfo.unit
  const declaredCurrentDimensionStyle = parseCurrentDimensionStyle(pairs)
  const lineTypePatterns = parseLineTypePatterns(pairs)
  const layerStyles = parseLayerStyles(pairs, unit, lineTypePatterns)
  const dimensionStyles = parseDimensionStyles(pairs, unitInfo.scale)
  const blocks = parseBlocks(pairs)
  const entities = combineLegacyPolylines(parseEntitiesSection(pairs))
  const unsupported: Record<string, number> = {}
  const converted: Entity[] = []

  for (const raw of entities) {
    if (isInvisibleDxfEntity(raw)) continue
    const result = convertEntity(raw, layerStyles, lineTypePatterns, unit, blocks)
    if (!result.length) unsupported[raw.type] = (unsupported[raw.type] || 0) + 1
    converted.push(...result)
  }

  if (!converted.length) {
    return {
      drawing: {
        unit,
        width: DEFAULTS.width,
        height: DEFAULTS.height,
        entities: [],
        layers: layerDefinitions(layerStyles),
        dimensionStyles,
        currentDimensionStyle: declaredCurrentDimensionStyle || DEFAULT_DIMENSION_STYLE_NAME,
      },
      unsupported,
      referenceTransform: { scale: unitInfo.scale, offsetX: 0, offsetY: 0 },
    }
  }

  if (unitInfo.scale !== 1) {
    for (const entity of converted) scaleImportedEntity(entity, unitInfo.scale)
  }

  // DXF 使用 Y 轴向上，编辑器画布使用 Y 轴向下。
  for (const entity of converted) flipEntityY(entity)
  const rawDrawing: Drawing = { unit, width: DEFAULTS.width, height: DEFAULTS.height, entities: converted, layers: layerDefinitions(layerStyles), dimensionStyles }
  const bounds = drawingBounds(rawDrawing)
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX)
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY)
  const margin = Math.max(20, Math.max(contentWidth, contentHeight) * 0.08)
  rawDrawing.width = round(contentWidth + margin * 2)
  rawDrawing.height = round(contentHeight + margin * 2)
  const dx = margin - bounds.minX
  const dy = margin - bounds.minY
  for (const entity of converted) moveEntity(entity, dx, dy)
  linkImportedCircularDimensions(converted)
  const currentDimensionStyle = firstImportedDimensionStyle(converted)
    || declaredCurrentDimensionStyle
    || DEFAULT_DIMENSION_STYLE_NAME
  rawDrawing.currentDimensionStyle = currentDimensionStyle
  return {
    drawing: rawDrawing,
    unsupported,
    referenceTransform: { scale: unitInfo.scale, offsetX: dx, offsetY: dy },
  }
}

function tokenize(text: string): Pair[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const pairs: Pair[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10)
    if (Number.isFinite(code)) pairs.push({ code, value: lines[i + 1].trimEnd() })
  }
  if (!pairs.length) throw new Error('无法解析 DXF：仅支持 ASCII DXF 文件')
  return pairs
}

/** 将 DXF 声明单位归一为编辑器支持的 mm/inch，并返回坐标缩放倍率。 */
function parseUnit(pairs: Pair[]): DxfUnitInfo {
  let code = 0
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim().toUpperCase() === '$INSUNITS') {
      code = Number(pairs[i + 1].value)
      break
    }
  }
  if (code === 1) return { unit: 'inch', scale: 1 }
  const millimeters: Record<number, number> = {
    2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1000000,
    8: 0.0000254, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6,
    13: 0.001, 14: 100, 15: 10000, 16: 100000, 17: 1e12,
    18: 149597870700000, 19: 9.4607304725808e18, 20: 3.085677581491367e19,
    21: 1200 / 3937 * 1000, 22: 100 / 3937 * 1000,
    23: 3600 / 3937 * 1000, 24: 6336000 / 3937 * 1000,
  }
  return { unit: 'mm', scale: millimeters[code] || 1 }
}

function parseLayerStyles(pairs: Pair[], unit: DrawingUnit, patterns: Map<string, number[]>): Map<string, LayerStyle> {
  const styles = new Map<string, LayerStyle>()
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== 0 || pairs[i].value !== 'LAYER') continue
    let name = 'default', aci = 7, colorValue = 7, trueColor: number | null = null, lineWeight = -3, flags = 0, lineType = 'CONTINUOUS'
    let editorStyleActive = false
    const editorStyle: EditorSourceStyle = {}
    for (i += 1; i < pairs.length && pairs[i].code !== 0; i++) {
      if (pairs[i].code === 2) name = pairs[i].value || 'default'
      if (pairs[i].code === 62) {
        colorValue = Number(pairs[i].value)
        aci = Math.abs(colorValue)
      }
      if (pairs[i].code === 420) trueColor = Number(pairs[i].value)
      if (pairs[i].code === 370) lineWeight = Number(pairs[i].value)
      if (pairs[i].code === 70) flags = Number(pairs[i].value)
      if (pairs[i].code === 6) lineType = pairs[i].value
      if (pairs[i].code === 1001) editorStyleActive = pairs[i].value === EDITOR_STYLE_APPID
      if (editorStyleActive && pairs[i].code === 1000) applyEditorStyleValue(editorStyle, pairs[i].value)
    }
    i -= 1
    const defaults = createLayerDefinition(name)
    styles.set(name, {
      ...defaults,
      color: editorStyle.color || (trueColor !== null ? trueColorHex(trueColor) : aciColor(aci)),
      lineWidth: editorStyle.lineWidth ?? (lineWeight >= 0 ? normalizeLineWidth(lineWeight, unit) : null),
      lineType: normalizeLineType(lineType),
      lineTypeName: lineType || 'CONTINUOUS',
      lineDash: patterns.get(lineType.toUpperCase())?.slice() || null,
      dxfLineType: lineType || 'CONTINUOUS',
      visible: colorValue >= 0,
      frozen: (flags & 1) !== 0,
      locked: (flags & 4) !== 0,
    })
  }
  return styles
}

/** 把 DXF 图层样式转换为图纸图层表。 @param styles DXF 图层样式。 @returns 图层定义列表。 @author snihao */
function layerDefinitions(styles: Map<string, LayerStyle>): LayerDefinition[] {
  const result = [...styles.values()].map((style): LayerDefinition => ({
    name: style.name,
    color: style.color,
    lineWidth: style.lineWidth,
    lineType: style.lineType,
    dxfLineType: style.dxfLineType,
    lineDash: style.lineDash,
    visible: style.visible,
    frozen: style.frozen,
    locked: style.locked,
  }))
  if (!result.some((layer) => layer.name === DEFAULTS.layer)) result.push(createLayerDefinition(DEFAULTS.layer))
  return result
}

/** 解析 DXF DIMSTYLE 表中的可视化字段，并换算到编辑器图纸单位。
 * @param pairs DXF 分组码序列。
 * @param unitScale DXF 单位到编辑器单位的坐标倍率。
 * @returns DIMSTYLE 定义列表。
 * @author snihao
 */
function parseDimensionStyles(pairs: Pair[], unitScale: number): DimensionStyleDefinition[] {
  const styles = new Map<string, DimensionStyleDefinition>()
  const scaleUnit = Number.isFinite(unitScale) && unitScale > 0 ? unitScale : 1
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== 0 || pairs[i].value.trim().toUpperCase() !== 'DIMSTYLE') continue
    let name = DEFAULT_DIMENSION_STYLE_NAME
    let scale = 1
    let textHeight = 2.5
    let arrowSize = 2.5
    let extensionOffset = 0.625
    let extensionBeyond = 0.625
    let textGap = 0.625
    let centerMarkSize = 2.5
    let dimensionLineColor: DimensionStyleColor = null
    let extensionLineColor: DimensionStyleColor = null
    let textColor: DimensionStyleColor = null
    let suppressFirstExtension = false
    let suppressSecondExtension = false
    let textPrefix: string | null = null
    let textSuffix: string | null = null
    for (i += 1; i < pairs.length && pairs[i].code !== 0; i++) {
      const pair = pairs[i]
      if (pair.code === 2) name = pair.value.trim() || DEFAULT_DIMENSION_STYLE_NAME
      else if (pair.code === 40) scale = positiveDimensionValue(pair.value, 1)
      else if (pair.code === 41) arrowSize = positiveDimensionValue(pair.value, 2.5) * scaleUnit
      else if (pair.code === 42) extensionOffset = nonNegativeDimensionValue(pair.value, 0.625) * scaleUnit
      else if (pair.code === 44) extensionBeyond = nonNegativeDimensionValue(pair.value, 0.625) * scaleUnit
      else if (pair.code === 140) textHeight = positiveDimensionValue(pair.value, 2.5) * scaleUnit
      else if (pair.code === 147) textGap = nonNegativeDimensionValue(pair.value, 0.625) * scaleUnit
      else if (pair.code === 141) centerMarkSize = nonNegativeDimensionValue(pair.value, 2.5) * scaleUnit
      else if (pair.code === 176) dimensionLineColor = dimensionStyleColor(pair.value)
      else if (pair.code === 177) extensionLineColor = dimensionStyleColor(pair.value)
      else if (pair.code === 178) textColor = dimensionStyleColor(pair.value)
      else if (pair.code === 75) suppressFirstExtension = Number(pair.value) === 1
      else if (pair.code === 76) suppressSecondExtension = Number(pair.value) === 1
      else if (pair.code === 3 || pair.code === 4) {
        const separator = pair.value.indexOf('<>')
        if (separator >= 0) {
          textPrefix = decodeDxfText(pair.value.slice(0, separator)) || null
          textSuffix = decodeDxfText(pair.value.slice(separator + 2)) || null
        }
      }
    }
    i -= 1
    const style = normalizeDimensionStyle({
      ...createDimensionStyleDefinition(name),
      name,
      scale,
      textHeight,
      arrowSize,
      extensionOffset,
      extensionBeyond,
      textGap,
      centerMarkSize,
      dimensionLineColor,
      extensionLineColor,
      textColor,
      suppressFirstExtension,
      suppressSecondExtension,
      textPrefix,
      textSuffix,
    })
    const key = style.name.trim().toUpperCase()
    if (!styles.has(key)) styles.set(key, style)
  }
  const standardKey = DEFAULT_DIMENSION_STYLE_NAME.toUpperCase()
  if (!styles.has(standardKey)) styles.set(standardKey, createDimensionStyleDefinition())
  return [...styles.values()]
}

/** 读取 DIMSTYLE 的正数参数。
 * @param value 原始字符串。
 * @param fallback 无效值的后备值。
 * @returns 正数值。
 * @author snihao
 */
function positiveDimensionValue(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** 读取 DIMSTYLE 的非负参数。
 * @param value 原始字符串。
 * @param fallback 无效值的后备值。
 * @returns 非负数值。
 * @author snihao
 */
function nonNegativeDimensionValue(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** 从 DXF 文件头读取当前 DIMSTYLE 名称。
 * @param pairs 已解析的 DXF 分组码和值。
 * @returns 声明的当前 DIMSTYLE 名称；未声明时返回 null。
 * @author snihao
 */
function parseCurrentDimensionStyle(pairs: Pair[]): string | null {
  for (let index = 0; index < pairs.length - 1; index++) {
    if (pairs[index].code !== 9 || pairs[index].value.trim().toUpperCase() !== '$DIMSTYLE') continue
    const value = pairs[index + 1]
    if (value?.code === 2 && value.value.trim()) return value.value.trim()
  }
  return null
}

/** DXF 文件头未指定当前样式时，查找首个导入的原生尺寸样式。
 * @param entities 待扫描的导入实体。
 * @returns 首个引用的 DIMSTYLE 名称；不存在尺寸标注时返回 null。
 * @author snihao
 */
function firstImportedDimensionStyle(entities: Entity[]): string | null {
  for (const entity of entities) {
    if (entity.type === 'dimension' && entity.dimensionStyle?.trim()) return entity.dimensionStyle.trim()
    if (entity.children) {
      const nested = firstImportedDimensionStyle(entity.children)
      if (nested) return nested
    }
  }
  return null
}

/** DXF 同时包含圆及其原生尺寸标注时恢复径向关联。
 * @param entities 待扫描的导入实体。
 * @returns 无返回值，直接更新匹配的尺寸标注。
 * @author snihao
 */
function linkImportedCircularDimensions(entities: Entity[]): void {
  const circles: Entity[] = []
  const dimensions: Entity[] = []
  const visit = (items: Entity[]): void => {
    for (const entity of items) {
      if (entity.type === 'circle') circles.push(entity)
      if (entity.type === 'dimension'
        && (entity.dimensionType === 'radius' || entity.dimensionType === 'diameter')) dimensions.push(entity)
      if (entity.children) visit(entity.children)
    }
  }
  visit(entities)

  for (const dimension of dimensions) {
    if (!dimension.dimensionCenter || dimension.dimensionRadius == null) continue
    const matches = circles.filter((circle) => {
      if (!circle.center || circle.radius == null) return false
      const tolerance = Math.max(1e-6, Math.abs(dimension.dimensionRadius!) * 1e-6)
      return Math.hypot(
        circle.center[0] - dimension.dimensionCenter![0],
        circle.center[1] - dimension.dimensionCenter![1],
      ) <= tolerance && Math.abs(circle.radius - dimension.dimensionRadius!) <= tolerance
    })
    if (matches.length === 1) dimension.dimensionSource = { kind: 'circle', entityId: matches[0].id }
  }
}

/** 解析 DIMENSION group code 1 中的自动测量占位符及其前后缀。 */
function dimensionTextTemplate(value: string): DimensionTextTemplate | null {
  const marker = value.indexOf('<>')
  if (marker < 0) return null
  const prefix = value.slice(0, marker)
  const suffix = value.slice(marker + 2)
  return { prefix, suffix }
}

/** 将 DIMSTYLE 的 ACI 颜色转换为可选十六进制颜色。
 * @param value 原始颜色索引。
 * @returns 十六进制颜色或空值。
 * @author snihao
 */
function dimensionStyleColor(value: string): DimensionStyleColor {
  const index = Math.trunc(Number(value))
  return index > 0 && index < 256 ? aciColor(index) : null
}

function parseLineTypePatterns(pairs: Pair[]): Map<string, number[]> {
  const patterns = new Map<string, number[]>()
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== 0 || pairs[i].value !== 'LTYPE') continue
    let name = ''
    const elements: number[] = []
    for (i += 1; i < pairs.length && pairs[i].code !== 0; i++) {
      if (pairs[i].code === 2) name = pairs[i].value.toUpperCase()
      if (pairs[i].code === 49) elements.push(Number(pairs[i].value))
    }
    i -= 1
    if (!name || !elements.length) continue
    const dash = elements.map((value) => Math.max(0.05, Math.abs(value)))
    if (dash.length % 2 === 1) dash.push(...dash)
    patterns.set(name, dash)
  }
  return patterns
}

function parseEntitiesSection(pairs: Pair[]): RawEntity[] {
  let inEntities = false
  const entities: RawEntity[] = []
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
    if (pair.code === 0 && pair.value === 'SECTION' && pairs[i + 1]?.code === 2) {
      inEntities = pairs[i + 1].value === 'ENTITIES'
      i += 1
      continue
    }
    if (inEntities && pair.code === 0 && pair.value === 'ENDSEC') { inEntities = false; continue }
    if (!inEntities || pair.code !== 0) continue
    const raw: RawEntity = { type: pair.value.toUpperCase(), pairs: [] }
    for (i += 1; i < pairs.length && pairs[i].code !== 0; i++) raw.pairs.push(pairs[i])
    i -= 1
    entities.push(raw)
  }
  return entities
}

function parseBlocks(pairs: Pair[]): Map<string, BlockDefinition> {
  const blocks = new Map<string, BlockDefinition>()
  let inBlocks = false
  let currentName = ''
  let currentBase: Point = [0, 0]
  let currentEntities: RawEntity[] = []
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
    if (pair.code === 0 && pair.value === 'SECTION' && pairs[i + 1]?.code === 2) {
      inBlocks = pairs[i + 1].value === 'BLOCKS'
      i += 1
      continue
    }
    if (!inBlocks) continue
    if (pair.code === 0 && pair.value === 'BLOCK') {
      const header: Pair[] = []
      for (i += 1; i < pairs.length && pairs[i].code !== 0; i++) header.push(pairs[i])
      i -= 1
      currentName = header.find((item) => item.code === 2)?.value || ''
      currentBase = [Number(header.find((item) => item.code === 10)?.value) || 0, Number(header.find((item) => item.code === 20)?.value) || 0]
      currentEntities = []
      continue
    }
    if (pair.code === 0 && pair.value === 'ENDBLK') {
      if (currentName) blocks.set(currentName, { base: currentBase, entities: combineLegacyPolylines(currentEntities) })
      currentName = ''
      continue
    }
    if (pair.code === 0 && pair.value === 'ENDSEC') { inBlocks = false; continue }
    if (!currentName || pair.code !== 0) continue
    const raw: RawEntity = { type: pair.value.toUpperCase(), pairs: [] }
    for (i += 1; i < pairs.length && pairs[i].code !== 0; i++) raw.pairs.push(pairs[i])
    i -= 1
    currentEntities.push(raw)
  }
  return blocks
}

function combineLegacyPolylines(entities: RawEntity[]): RawEntity[] {
  const combined: RawEntity[] = []
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i]
    if (entity.type !== 'POLYLINE') { combined.push(entity); continue }
    // 传统 POLYLINE 头部的 10/20/30 是高程占位点，不能当成真实 VERTEX。
    const headerElevation = entity.pairs.find((pair) => pair.code === 30)
    const pairs = entity.pairs.filter((pair) => pair.code !== 10 && pair.code !== 20 && pair.code !== 30)
    if (headerElevation && !pairs.some((pair) => pair.code === 38)) {
      pairs.push({ code: 38, value: headerElevation.value })
    }
    for (i += 1; i < entities.length && entities[i].type !== 'SEQEND'; i++) {
      if (entities[i].type !== 'VERTEX') continue
      const x = entities[i].pairs.find((pair) => pair.code === 10)
      const y = entities[i].pairs.find((pair) => pair.code === 20)
      const bulge = entities[i].pairs.find((pair) => pair.code === 42)
      const startWidth = entities[i].pairs.find((pair) => pair.code === 40)
      const endWidth = entities[i].pairs.find((pair) => pair.code === 41)
      if (x && y) pairs.push(x, y, ...(bulge ? [bulge] : []), ...(startWidth ? [startWidth] : []), ...(endWidth ? [endWidth] : []))
    }
    combined.push({ type: 'POLYLINE', pairs })
  }
  return combined
}

function convertEntity(raw: RawEntity, layerStyles: Map<string, LayerStyle>, patterns: Map<string, number[]>, unit: DrawingUnit, blocks: Map<string, BlockDefinition>, depth = 0, inherited?: InheritedEntityStyle): Entity[] {
  if (isInvisibleDxfEntity(raw)) return []
  const rawLayer = str(raw, 8) || 'default'
  const layer = inherited && rawLayer === '0' ? inherited.layer : rawLayer
  const layerStyle = layerStyles.get(layer)
  const aciValue = Math.abs(num(raw, 62, 256))
  const color = aciValue === 0 && inherited ? inherited.color : entityColor(raw, layerStyle?.color)
  const rawWeight = num(raw, 370, -1)
  const lineWidth = rawWeight === -2 && inherited ? inherited.lineWidth : lineWidthOf(raw, layerStyle?.lineWidth, unit)
  const rawLineType = str(raw, 6)
  const lineType = rawLineType.toUpperCase() === 'BYBLOCK' && inherited
    ? inherited.lineType
    : !rawLineType || rawLineType.toUpperCase() === 'BYLAYER'
    ? (layerStyle?.lineType || 'solid')
    : normalizeLineType(rawLineType)
  const dxfLineType = rawLineType.toUpperCase() === 'BYBLOCK' && inherited
    ? inherited.dxfLineType
    : !rawLineType || rawLineType.toUpperCase() === 'BYLAYER'
    ? (layerStyle?.lineTypeName || 'CONTINUOUS')
    : rawLineType
  const entityScale = Math.max(0.0001, Math.abs(num(raw, 48, 1)))
  const inheritedPattern = rawLineType.toUpperCase() === 'BYBLOCK' && inherited
    ? inherited.lineDash
    : !rawLineType || rawLineType.toUpperCase() === 'BYLAYER'
    ? layerStyle?.lineDash
    : patterns.get(rawLineType.toUpperCase())
  const lineDash = inheritedPattern ? inheritedPattern.map((value) => value * entityScale) : null
  const sourceHandle = str(raw, 5).trim().toUpperCase() || null
  const colorMode = entityColorMode(raw)
  const lineTypeMode = entityLineTypeMode(rawLineType)
  const lineWidthMode = entityLineWidthMode(raw)
  const sourceCanvasStyle = needsSourceCanvasStyle(raw, layerStyle)
  const base = () => ({
    id: genId(`dxf-${raw.type.toLowerCase()}`), layer, color, lineWidth, lineType, dxfLineType, lineDash,
    colorMode, lineTypeMode, lineWidthMode,
    lineCap: 'butt' as const, lineJoin: 'miter' as const, sourceHandle, sourceEdited: false, sourceCanvasStyle,
  })
  const point = (xCode: number, yCode: number): Point => [num(raw, xCode), num(raw, yCode)]
  const ocsPoint = (xCode: number, yCode: number): Point => transformOcsPoint(raw, [num(raw, xCode), num(raw, yCode)], num(raw, xCode + 20))

  if (raw.type === 'LINE') return [{ ...base(), type: 'line', start: point(10, 20), end: point(11, 21), rotation: 0 }]
  if (raw.type === 'CIRCLE') {
    const center = ocsPoint(10, 20)
    const radius = Math.abs(num(raw, 40))
    if (isTopPlane(raw)) return [{ ...base(), type: 'circle', center, radius }]
    const curve = ocsCurve(raw, [num(raw, 10), num(raw, 20)], radius, 0, Math.PI * 2)
    return [curvePolylineEntity(base(), curve, true)]
  }
  if (raw.type === 'ARC') {
    const radius = Math.abs(num(raw, 40))
    const start = num(raw, 50) * Math.PI / 180
    const endRaw = num(raw, 51) * Math.PI / 180
    const sweep = positiveAngle(endRaw - start) || Math.PI * 2
    const curve = ocsCurve(raw, [num(raw, 10), num(raw, 20)], radius, start, sweep)
    return [curvePolylineEntity(base(), curve, false)]
  }
  if (raw.type === 'LWPOLYLINE' || raw.type === 'POLYLINE') {
    const closed = (num(raw, 70) & 1) === 1
    const elevation = num(raw, 38, num(raw, 30))
    const points = expandBulgeVertices(polylineVertices(raw), closed)
      .map((item) => transformOcsPoint(raw, item, elevation))
    return points.length >= 2 ? [{ ...base(), type: 'polyline', points, closed, rotation: 0, polylineWidth: polylineWidthOf(raw) }] : []
  }
  if (raw.type === 'HATCH') {
    const segments = buildDxfHatchSegments(raw.pairs, (item, z) => transformOcsPoint(raw, item, z))
    if (!segments.length) return []
    const groupBase = base()
    const groupId = groupBase.id
    const children: Entity[] = segments.map((segment, index) => ({
      ...groupBase,
      id: `${groupId}-line-${index}`,
      type: 'line',
      start: segment.start,
      end: segment.end,
      sourceHandle: null,
      sourceEdited: false,
      groupId,
    }))
    return [{ ...groupBase, id: groupId, type: 'group', children, groupId: null, rotation: 0 }]
  }
  if (raw.type === 'SPLINE') {
    const points = splinePoints(raw)
    const closed = (num(raw, 70) & 1) === 1
    return points.length >= 2 ? [{ ...base(), type: 'polyline', points, closed, rotation: 0, polylineWidth: null }] : []
  }
  if (raw.type === 'TEXT' || raw.type === 'MTEXT' || raw.type === 'ATTRIB') {
    const chunks = raw.pairs.filter((p) => p.code === 1 || p.code === 3).map((p) => p.value)
    const content = decodeDxfText(chunks.join(''), raw.type === 'MTEXT')
    if (!content) return []
    if (raw.type === 'MTEXT') {
      const attachment = Math.trunc(num(raw, 71, 1))
      const directionX = num(raw, 11, Number.NaN)
      const directionY = num(raw, 21, Number.NaN)
      const rotation = Number.isFinite(directionX) && Number.isFinite(directionY)
        ? -Math.atan2(directionY, directionX) * 180 / Math.PI
        : -num(raw, 50)
      return [{
        ...base(), type: 'text', position: point(10, 20), content,
        fontSize: Math.abs(num(raw, 40, 2.5)), rotation,
        textStyle: str(raw, 7) || null, textBoxWidth: has(raw, 41) ? Math.abs(num(raw, 41)) : null,
        dxfTextType: 'MTEXT',
        textAlign: mtextAlign(attachment), textBaseline: mtextBaseline(attachment), groupId: null,
      }]
    }
    const horizontal = Math.trunc(num(raw, 72))
    const vertical = Math.trunc(num(raw, raw.type === 'ATTRIB' ? 74 : 73))
    const hasAlignmentPoint = (horizontal !== 0 || vertical !== 0) && has(raw, 11) && has(raw, 21)
    const insertion = ocsPoint(10, 20)
    const alignment = hasAlignmentPoint ? ocsPoint(11, 21) : insertion
    const aligned = (horizontal === 3 || horizontal === 5) && hasAlignmentPoint
    const position: Point = aligned
      ? [(insertion[0] + alignment[0]) / 2, (insertion[1] + alignment[1]) / 2]
      : alignment
    return [{
      ...base(), type: 'text', position, content,
      fontSize: Math.abs(num(raw, 40, 2.5)),
      textStyle: str(raw, 7) || null,
      textWidthFactor: has(raw, 41) ? Math.abs(num(raw, 41, 1)) : null,
      dxfTextType: 'TEXT',
      rotation: aligned ? canvasAngleBetween(insertion, alignment) : textRotation(raw, num(raw, 50)),
      textAlign: textAlign(horizontal), textBaseline: textBaseline(vertical), groupId: null,
    }]
  }
  if (raw.type === 'ELLIPSE') {
    const curve = ellipseCurve(raw)
    return [curvePolylineEntity(base(), curve, Math.abs(curve.sweepParameter) >= Math.PI * 2 - 1e-7)]
  }
  if (raw.type === 'DIMENSION' || raw.type === 'ARC_DIMENSION') {
    const rawDimensionType = Math.trunc(num(raw, 70))
    const type = rawDimensionType & 15
    const linePoint = point(10, 20)
    const rawText = str(raw, 1)
    const decodedText = rawText ? decodeDxfText(rawText, true) : ''
    const textTemplate = dimensionTextTemplate(decodedText)
    const override = decodedText && !textTemplate ? decodedText : null
    const hasTextPosition = has(raw, 11) && has(raw, 21)
    const textPosition = hasTextPosition ? point(11, 21) : linePoint
    const sourceBlock = blocks.get(str(raw, 2))
    const displaySegments = sourceBlock ? dimensionBlockSegments(sourceBlock) : null
    const textLayout = dimensionBlockTextLayout(sourceBlock)
    const common = {
      ...base(),
      type: 'dimension' as const,
      dimensionStyle: str(raw, 3).trim() || null,
      dimensionStyleOverrides: textTemplate && (textTemplate.prefix || textTemplate.suffix)
        ? { textPrefix: textTemplate.prefix, textSuffix: textTemplate.suffix }
        : null,
      dimensionTextOverride: override,
      position: textPosition.slice() as Point,
      fontSize: textLayout?.fontSize ?? null,
      rotation: textLayout?.rotation ?? 0,
      textStyle: textLayout?.textStyle ?? null,
      dxfTextType: textLayout?.dxfTextType ?? null,
      textAlign: textLayout?.textAlign ?? null,
      textBaseline: textLayout?.textBaseline ?? null,
      textWidthFactor: textLayout?.textWidthFactor ?? null,
      textPositionManual: (rawDimensionType & 128) !== 0,
      dimensionTextSourcePosition: hasTextPosition && (rawDimensionType & 128) === 0,
      dimensionRefs: [null, null] as [PointReference | null, PointReference | null],
      dimensionTextManual: !!override,
      dimensionTextHeightManual: false,
      dimensionTextSourceHeight: textLayout?.fontSize != null,
      dimensionDisplaySegments: displaySegments,
    }
    if (raw.type !== 'ARC_DIMENSION' && (type === 0 || type === 1)) {
      const start = point(13, 23), end = point(14, 24)
      const dimension: Entity = {
        ...common,
        dimensionType: type === 1 ? 'aligned' : 'linear',
        dimensionStart: start.slice() as Point,
        dimensionEnd: end.slice() as Point,
        dimensionLinePosition: linePoint.slice() as Point,
        dimensionAngle: type === 0 ? -num(raw, 50) : null,
        text: override,
      }
      dimension.text = override || dimensionMeasurementText(dimension) || ''
      return [dimension]
    }
    if (raw.type !== 'ARC_DIMENSION' && (type === 2 || type === 5)) {
      const firstLineStart = point(13, 23)
      const firstLineEnd = point(14, 24)
      const secondLineStart = point(15, 25)
      const secondLineEnd = point(10, 20)
      let start = type === 5 ? firstLineStart : firstLineEnd
      let end = type === 5 ? firstLineEnd : secondLineEnd
      const center = type === 5
        ? secondLineStart
        : intersectionPoint(firstLineStart, firstLineEnd, secondLineStart, secondLineEnd)
      const dimensionLinePosition = type === 2 && has(raw, 16) && has(raw, 26)
        ? point(16, 26)
        : linePoint
      if (type === 2 && center) {
        ;[start, end] = angularDimensionRays(
          center,
          firstLineStart,
          firstLineEnd,
          secondLineStart,
          secondLineEnd,
          dimensionLinePosition,
        )
      }
      const angle = center ? dimensionAngle(center, start, end) : 0
      return [{
        ...common,
        dimensionType: 'angular',
        dimensionAngularMode: type === 5 ? 'threePoint' : 'twoLine',
        dimensionStart: start.slice() as Point,
        dimensionEnd: end.slice() as Point,
        dimensionCenter: center ? center.slice() as Point : null,
        dimensionLinePosition: dimensionLinePosition.slice() as Point,
        dimensionAngularLine1Start: type === 2 ? (center || firstLineStart).slice() as Point : null,
        dimensionAngularLine2Start: type === 2 ? (center || secondLineStart).slice() as Point : null,
        text: override || `${round(angle)}°`,
      }]
    }
    if (type === 3 || type === 4) {
      const first = type === 4 ? point(15, 25) : point(10, 20)
      const second = type === 4 ? linePoint : point(15, 25)
      const center = type === 4 ? linePoint : midpoint(first, second)
      const radius = type === 4 ? pointDistance(center, first) : pointDistance(center, first)
      return [{
        ...common,
        dimensionType: type === 4 ? 'radius' : 'diameter',
        dimensionStart: first.slice() as Point,
        dimensionEnd: second.slice() as Point,
        dimensionCenter: center.slice() as Point,
        dimensionRadius: radius,
        dimensionLinePosition: (hasTextPosition ? textPosition : first).slice() as Point,
        text: override || (type === 4 ? `R${round(radius)}` : `Ø${round(radius * 2)}`),
      }]
    }
    if (type === 6) {
      const feature = point(13, 23)
      const offset = has(raw, 14) && has(raw, 24) ? point(14, 24) : textPosition
      const ordinateType = (Math.trunc(num(raw, 70)) & 64) !== 0 ? 'x' : 'y'
      const dimension: Entity = {
        ...common,
        dimensionType: 'ordinate',
        dimensionOrdinateType: ordinateType,
        dimensionOrigin: linePoint.slice() as Point,
        dimensionStart: feature.slice() as Point,
        dimensionEnd: offset.slice() as Point,
        dimensionOffset: offset.slice() as Point,
        dimensionLinePosition: offset.slice() as Point,
        dimensionAngle: has(raw, 51) ? -num(raw, 51) : null,
        text: override,
      }
      dimension.text = override || dimensionMeasurementText(dimension) || ''
      return [dimension]
    }
    if (type === 8 || raw.type === 'ARC_DIMENSION') {
      const start = point(13, 23)
      const end = point(14, 24)
      const center = point(15, 25)
      const radius = pointDistance(center, start)
      const sweep = positiveAngle(Math.atan2(end[1] - center[1], end[0] - center[0]) - Math.atan2(start[1] - center[1], start[0] - center[0]))
      const arcLength = radius * (sweep || Math.PI * 2)
      return [{
        ...common,
        dimensionType: 'arcLength',
        dimensionStart: start.slice() as Point,
        dimensionEnd: end.slice() as Point,
        dimensionCenter: center.slice() as Point,
        dimensionRadius: radius,
        dimensionLinePosition: linePoint.slice() as Point,
        text: override || round(arcLength).toString(),
      }]
    }
    return []
  }
  if ((raw.type === 'INSERT' || raw.type === 'MINSERT') && depth < 8) {
    const definition = blocks.get(str(raw, 2))
    if (!definition) return []
    const insertion = ocsPoint(10, 20)
    const scaleX = num(raw, 41, 1)
    const scaleY = num(raw, 42, 1)
    const rotation = num(raw, 50, 0) * Math.PI / 180
    const insertStyle: InheritedEntityStyle = { layer, color, lineWidth, lineType, dxfLineType, lineDash }
    const columns = Math.max(1, Math.trunc(num(raw, 70, 1)))
    const rows = Math.max(1, Math.trunc(num(raw, 71, 1)))
    const columnSpacing = num(raw, 44)
    const rowSpacing = num(raw, 45)
    const children: Entity[] = []
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const offsetX = column * columnSpacing
        const offsetY = row * rowSpacing
        const instanceInsertion: Point = [
          insertion[0] + offsetX * Math.cos(rotation) - offsetY * Math.sin(rotation),
          insertion[1] + offsetX * Math.sin(rotation) + offsetY * Math.cos(rotation),
        ]
        const instance = definition.entities
          .flatMap((child) => convertEntity(child, layerStyles, patterns, unit, blocks, depth + 1, insertStyle))
          .map((child) => transformBlockEntity(child, definition.base, instanceInsertion, scaleX, scaleY, rotation))
        children.push(...instance)
      }
    }
    if (!children.length) return []
    const groupId = genId('dxf-block')
    for (const child of children) {
      child.groupId = groupId
      clearSourceMetadata(child)
    }
    const groupBase = base()
    groupBase.sourceCanvasStyle ||= children.some((child) => child.sourceCanvasStyle === true)
    return [{ ...groupBase, id: groupId, type: 'group', children, groupId: null, rotation: 0 }]
  }
  return []
}

/** 块子实体的句柄属于块定义，编辑 INSERT 时只替换顶层块引用句柄。 */
function clearSourceMetadata(entity: Entity): void {
  entity.sourceHandle = null
  entity.sourceEdited = false
  for (const child of entity.children || []) clearSourceMetadata(child)
}

/** 对块内实体应用 INSERT 仿射变换；非等比缩放的圆会保真转换为闭合折线。 */
function transformBlockEntity(entity: Entity, base: Point, insertion: Point, scaleX: number, scaleY: number, rotation: number): Entity {
  const cos = Math.cos(rotation), sin = Math.sin(rotation)
  const transformPoint = ([x, y]: Point): Point => {
    const sx = (x - base[0]) * scaleX
    const sy = (y - base[1]) * scaleY
    return [insertion[0] + sx * cos - sy * sin, insertion[1] + sx * sin + sy * cos]
  }
  if (entity.type === 'line') { entity.start = transformPoint(entity.start!); entity.end = transformPoint(entity.end!) }
  else if (entity.type === 'polyline') {
    entity.points = entity.points!.map(transformPoint)
    if (entity.curveGeometry) entity.curveGeometry = transformCurveGeometry(entity.curveGeometry, transformPoint)
  }
  else if (entity.type === 'circle') {
    if (Math.abs(Math.abs(scaleX) - Math.abs(scaleY)) <= 1e-9) {
      entity.center = transformPoint(entity.center!)
      entity.radius = entity.radius! * Math.abs(scaleX)
    } else {
      const center = entity.center!
      const radius = entity.radius!
      const sourceCurve: ParametricCurveGeometry = {
        type: 'arc',
        center: center.slice() as Point,
        axisX: [radius, 0],
        axisY: [0, radius],
        startParameter: 0,
        sweepParameter: Math.PI * 2,
      }
      const curve = transformCurveGeometry(sourceCurve, transformPoint)
      entity.type = 'polyline'
      entity.points = sampleCurve(curve, 96).slice(0, -1)
      entity.closed = true
      entity.curveGeometry = curve
      entity.center = null
      entity.radius = null
      entity.rotation = 0
    }
  } else if (entity.type === 'text') {
    entity.position = transformPoint(entity.position!)
    entity.fontSize = entity.fontSize! * Math.abs(scaleY)
    entity.rotation = (entity.rotation || 0) - rotation * 180 / Math.PI
  } else if (entity.type === 'annotation') {
    entity.leader = entity.leader!.map(transformPoint)
    if (entity.annotationSegments) entity.annotationSegments = entity.annotationSegments.map(([start, end]) => [transformPoint(start), transformPoint(end)])
    entity.position = transformPoint(entity.position!)
  } else if (entity.type === 'dimension') {
    if (entity.dimensionStart) entity.dimensionStart = transformPoint(entity.dimensionStart)
    if (entity.dimensionEnd) entity.dimensionEnd = transformPoint(entity.dimensionEnd)
    if (entity.dimensionCenter) entity.dimensionCenter = transformPoint(entity.dimensionCenter)
    if (entity.dimensionLinePosition) entity.dimensionLinePosition = transformPoint(entity.dimensionLinePosition)
    if (entity.dimensionOrigin) entity.dimensionOrigin = transformPoint(entity.dimensionOrigin)
    if (entity.dimensionOffset) entity.dimensionOffset = transformPoint(entity.dimensionOffset)
    if (entity.dimensionAngularLine1Start) entity.dimensionAngularLine1Start = transformPoint(entity.dimensionAngularLine1Start)
    if (entity.dimensionAngularLine2Start) entity.dimensionAngularLine2Start = transformPoint(entity.dimensionAngularLine2Start)
    if (entity.dimensionCenter && entity.dimensionStart) entity.dimensionRadius = pointDistance(entity.dimensionCenter, entity.dimensionStart)
    if (entity.dimensionDisplaySegments) entity.dimensionDisplaySegments = entity.dimensionDisplaySegments.map(([start, end]) => [transformPoint(start), transformPoint(end)])
    if (entity.position) entity.position = transformPoint(entity.position)
  } else if (entity.type === 'group') {
    entity.children = (entity.children || []).map((child) => transformBlockEntity(child, base, insertion, scaleX, scaleY, rotation))
  }
  return entity
}

function arcPoints(center: Point, radius: number, startDeg: number, sweepDeg: number): Point[] {
  const steps = Math.max(12, Math.ceil(Math.abs(sweepDeg) / 2))
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = (startDeg + sweepDeg * i / steps) * Math.PI / 180
    return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)] as Point
  })
}

/** 提取 DIMENSION 匿名块的线段，使命中与源 DXF 的实际显示位置一致。 */
function dimensionBlockSegments(definition: BlockDefinition): Array<[Point, Point]> {
  const segments: Array<[Point, Point]> = []
  for (const raw of definition.entities) {
    if (raw.type === 'LINE') {
      segments.push([[num(raw, 10), num(raw, 20)], [num(raw, 11), num(raw, 21)]])
      continue
    }
    if (raw.type === 'LWPOLYLINE' || raw.type === 'POLYLINE') {
      const points = expandBulgeVertices(polylineVertices(raw), (num(raw, 70) & 1) === 1)
      const segmentCount = (num(raw, 70) & 1) === 1 ? points.length : points.length - 1
      for (let index = 0; index < segmentCount; index++) {
        segments.push([points[index], points[(index + 1) % points.length]])
      }
      continue
    }
    if (raw.type === 'ARC') {
      const center: Point = [num(raw, 10), num(raw, 20)]
      const radius = Math.abs(num(raw, 40))
      const start = num(raw, 50)
      const end = num(raw, 51)
      const points = arcPoints(center, radius, start, positiveAngle(end - start) || 360)
      for (let index = 1; index < points.length; index++) segments.push([points[index - 1], points[index]])
    }
  }
  return segments
}

/**
 * 提取匿名标注块中的第一条文字实体，保留其原始字高、旋转和对齐方式。
 * @param definition 标注引用的匿名块定义。
 * @returns 标注文字布局；块中没有文字时返回空值。
 * @author snihao
 */
function dimensionBlockTextLayout(definition: BlockDefinition | undefined): DimensionTextLayout | null {
  const raw = definition?.entities.find((entity) => entity.type === 'TEXT' || entity.type === 'MTEXT')
  if (!raw) return null
  if (raw.type === 'MTEXT') {
    const attachment = Math.trunc(num(raw, 71, 1))
    const directionX = num(raw, 11, Number.NaN)
    const directionY = num(raw, 21, Number.NaN)
    const rotation = Number.isFinite(directionX) && Number.isFinite(directionY)
      ? -Math.atan2(directionY, directionX) * 180 / Math.PI
      : -num(raw, 50)
    return {
      fontSize: Math.abs(num(raw, 40, 2.5)),
      rotation,
      textStyle: str(raw, 7) || null,
      dxfTextType: 'MTEXT',
      textAlign: mtextAlign(attachment),
      textBaseline: mtextBaseline(attachment),
      textWidthFactor: null,
    }
  }
  const horizontal = Math.trunc(num(raw, 72))
  const vertical = Math.trunc(num(raw, 73))
  const directionX = num(raw, 11, Number.NaN)
  const directionY = num(raw, 21, Number.NaN)
  const hasAlignmentPoint = (horizontal !== 0 || vertical !== 0) && Number.isFinite(directionX) && Number.isFinite(directionY)
  const insertion = transformOcsPoint(raw, [num(raw, 10), num(raw, 20)], num(raw, 30))
  const alignment = hasAlignmentPoint
    ? transformOcsPoint(raw, [directionX, directionY], num(raw, 31))
    : insertion
  const aligned = (horizontal === 3 || horizontal === 5) && hasAlignmentPoint
  return {
    fontSize: Math.abs(num(raw, 40, 2.5)),
    rotation: aligned ? canvasAngleBetween(insertion, alignment) : textRotation(raw, num(raw, 50)),
    textStyle: str(raw, 7) || null,
    dxfTextType: 'TEXT',
    textAlign: textAlign(horizontal),
    textBaseline: textBaseline(vertical),
    textWidthFactor: has(raw, 41) ? Math.abs(num(raw, 41, 1)) : null,
  }
}

/** 把 OCS 点转换到 WCS 的 XY 平面，兼容 extrusion 为 -Z 或倾斜法向的二维投影。 */
function transformOcsPoint(raw: RawEntity, point: Point, z = 0): Point {
  const [axisX, axisY, normal] = ocsAxes(raw)
  return [
    point[0] * axisX[0] + point[1] * axisY[0] + z * normal[0],
    point[0] * axisX[1] + point[1] * axisY[1] + z * normal[1],
  ]
}

function ocsCurve(
  raw: RawEntity,
  localCenter: Point,
  radius: number,
  startParameter: number,
  sweepParameter: number,
): ParametricCurveGeometry {
  const z = num(raw, 30)
  const center = transformOcsPoint(raw, localCenter, z)
  const xEnd = transformOcsPoint(raw, [localCenter[0] + radius, localCenter[1]], z)
  const yEnd = transformOcsPoint(raw, [localCenter[0], localCenter[1] + radius], z)
  const curve: ParametricCurveGeometry = {
    type: 'arc',
    center,
    axisX: [xEnd[0] - center[0], xEnd[1] - center[1]],
    axisY: [yEnd[0] - center[0], yEnd[1] - center[1]],
    startParameter,
    sweepParameter,
  }
  if (!curveCircle(curve)) curve.type = 'ellipse'
  return curve
}

function ellipseCurve(raw: RawEntity): ParametricCurveGeometry {
  const center: Point = [num(raw, 10), num(raw, 20)]
  const majorVector: [number, number, number] = [num(raw, 11), num(raw, 21), num(raw, 31)]
  const majorLength = Math.max(Math.hypot(...majorVector), 1e-9)
  const majorUnit = normalize3(majorVector)
  const normal = normalize3([num(raw, 210), num(raw, 220), num(raw, 230, 1)])
  const minorUnit = normalize3(cross3(normal, majorUnit))
  const minorLength = majorLength * Math.abs(num(raw, 40, 1))
  const startParameter = num(raw, 41, 0)
  const endParameter = num(raw, 42, Math.PI * 2)
  const sweepParameter = positiveAngle(endParameter - startParameter) || Math.PI * 2
  return {
    type: 'ellipse',
    center,
    axisX: [majorVector[0], majorVector[1]],
    axisY: [minorUnit[0] * minorLength, minorUnit[1] * minorLength],
    startParameter,
    sweepParameter,
  }
}

function curvePolylineEntity(base: Record<string, unknown>, curve: ParametricCurveGeometry, closed: boolean): Entity {
  const points = sampleCurve(curve, Math.max(32, Math.ceil(Math.abs(curve.sweepParameter) * 90 / Math.PI)))
  return {
    ...base,
    type: 'polyline',
    points: closed ? points.slice(0, -1) : points,
    closed,
    rotation: 0,
    curveGeometry: curve,
  } as Entity
}

/** 返回 OCS 的 X/Y 轴和法向量。 */
function ocsAxes(raw: RawEntity): [[number, number, number], [number, number, number], [number, number, number]] {
  const normal = normalize3([num(raw, 210), num(raw, 220), num(raw, 230, 1)])
  const reference: [number, number, number] = Math.abs(normal[0]) < 1 / 64 && Math.abs(normal[1]) < 1 / 64
    ? [0, 1, 0]
    : [0, 0, 1]
  const axisX = normalize3(cross3(reference, normal))
  const axisY = cross3(normal, axisX)
  return [axisX, axisY, normal]
}

/** 顶视平面中的圆在 XY 投影后仍然是圆。 */
function isTopPlane(raw: RawEntity): boolean {
  const [, , normal] = ocsAxes(raw)
  return Math.abs(normal[0]) < 1e-9 && Math.abs(normal[1]) < 1e-9 && Math.abs(Math.abs(normal[2]) - 1) < 1e-9
}

function cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize3(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2])
  return length > 1e-12 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, 1]
}

function positiveAngle(value: number): number {
  return (value % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
}

/** 按 DXF knot/degree/weight 使用 de Boor 算法求值，而不是错误连接控制点。 */
function splinePoints(raw: RawEntity): Point[] {
  const controlPoints = pairedPoints(raw, 10, 20)
  const fitPoints = pairedPoints(raw, 11, 21)
  const degree = Math.max(1, Math.trunc(num(raw, 71, 3)))
  const knots = values(raw, 40)
  if (controlPoints.length < degree + 1 || knots.length < controlPoints.length + degree + 1) {
    return fitPoints.length >= 2 ? fitPoints : controlPoints
  }
  const weights = values(raw, 41)
  const lastControlIndex = controlPoints.length - 1
  const start = knots[degree]
  const end = knots[lastControlIndex + 1]
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return fitPoints.length >= 2 ? fitPoints : controlPoints
  }
  let spanCount = 0
  for (let i = degree; i <= lastControlIndex; i++) {
    if (knots[i + 1] - knots[i] > 1e-12) spanCount++
  }
  const segments = Math.min(MAX_CURVE_SEGMENTS, Math.max(32, controlPoints.length * 12, spanCount * 16))
  const points: Point[] = []
  for (let i = 0; i <= segments; i++) {
    const parameter = i === segments ? end : start + (end - start) * i / segments
    points.push(evaluateNurbs(controlPoints, degree, knots, weights, parameter))
  }
  if ((num(raw, 70) & 1) === 1 && points.length > 1 && pointDistance(points[0], points[points.length - 1]) < 1e-7) {
    points.pop()
  }
  return points
}

function evaluateNurbs(controlPoints: Point[], degree: number, knots: number[], weights: number[], parameter: number): Point {
  const lastControlIndex = controlPoints.length - 1
  let span = lastControlIndex
  if (parameter < knots[lastControlIndex + 1]) {
    let low = degree
    let high = lastControlIndex + 1
    span = Math.floor((low + high) / 2)
    while (parameter < knots[span] || parameter >= knots[span + 1]) {
      if (parameter < knots[span]) high = span
      else low = span
      span = Math.floor((low + high) / 2)
    }
  }
  const work: [number, number, number][] = []
  for (let j = 0; j <= degree; j++) {
    const index = span - degree + j
    const weight = Number.isFinite(weights[index]) ? weights[index] : 1
    work.push([controlPoints[index][0] * weight, controlPoints[index][1] * weight, weight])
  }
  for (let level = 1; level <= degree; level++) {
    for (let j = degree; j >= level; j--) {
      const index = span - degree + j
      const denominator = knots[index + degree - level + 1] - knots[index]
      const alpha = Math.abs(denominator) < 1e-12 ? 0 : (parameter - knots[index]) / denominator
      work[j] = [
        (1 - alpha) * work[j - 1][0] + alpha * work[j][0],
        (1 - alpha) * work[j - 1][1] + alpha * work[j][1],
        (1 - alpha) * work[j - 1][2] + alpha * work[j][2],
      ]
    }
  }
  const result = work[degree]
  return Math.abs(result[2]) < 1e-12 ? [result[0], result[1]] : [result[0] / result[2], result[1] / result[2]]
}

function pairedPoints(raw: RawEntity, xCode: number, yCode: number): Point[] {
  const points: Point[] = []
  let current: Point | null = null
  for (const pair of raw.pairs) {
    if (pair.code === xCode) {
      current = [Number(pair.value) || 0, 0]
      points.push(current)
    } else if (pair.code === yCode && current) {
      current[1] = Number(pair.value) || 0
    }
  }
  return points
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/** 返回两个点的中点。 */
function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

/** 计算两条角度标注参考直线的交点，平行时退回第一条直线起点。 */
function intersectionPoint(a1: Point, a2: Point, b1: Point, b2: Point): Point {
  const ax = a2[0] - a1[0]
  const ay = a2[1] - a1[1]
  const bx = b2[0] - b1[0]
  const by = b2[1] - b1[1]
  const denominator = ax * by - ay * bx
  if (Math.abs(denominator) < 1e-9) return a1.slice() as Point
  const t = ((b1[0] - a1[0]) * by - (b1[1] - a1[1]) * bx) / denominator
  return [a1[0] + ax * t, a1[1] + ay * t]
}

/**
 * 把 DXF 两直线角度标注归一为与编辑器新建工具相同的两条尺寸弧射线。
 * @param center 两条无限直线交点。
 * @param firstStart 第一条直线起点。
 * @param firstEnd 第一条直线终点。
 * @param secondStart 第二条直线起点。
 * @param secondEnd 第二条直线终点。
 * @param location 尺寸弧放置点。
 * @returns 位于尺寸弧半径上的两条射线端点。
 * @author snihao
 */
function angularDimensionRays(
  center: Point,
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
  location: Point,
): [Point, Point] {
  const radius = Math.max(pointDistance(center, location), 1e-6)
  const target: Point = [location[0] - center[0], location[1] - center[1]]
  /**
   * 将参考直线朝向尺寸弧所在象限，并投影到尺寸弧半径。
   * @param lineStart 参考直线起点。
   * @param lineEnd 参考直线终点。
   * @returns 尺寸弧上的射线端点。
   * @author snihao
   */
  const rayPoint = (lineStart: Point, lineEnd: Point): Point => {
    let dx = lineEnd[0] - lineStart[0]
    let dy = lineEnd[1] - lineStart[1]
    const length = Math.max(Math.hypot(dx, dy), 1e-9)
    dx /= length
    dy /= length
    if (dx * target[0] + dy * target[1] < 0) {
      dx *= -1
      dy *= -1
    }
    return [center[0] + dx * radius, center[1] + dy * radius]
  }
  let first = rayPoint(firstStart, firstEnd)
  let second = rayPoint(secondStart, secondEnd)
  if (dimensionAngle(center, first, second) > 180) [first, second] = [second, first]
  return [first, second]
}

/** 计算从圆心到两条参考射线的逆时针角度。 */
function dimensionAngle(center: Point, start: Point, end: Point): number {
  const first = Math.atan2(start[1] - center[1], start[0] - center[0])
  const second = Math.atan2(end[1] - center[1], end[0] - center[0])
  return positiveAngle(second - first) * 180 / Math.PI
}

function polylineVertices(raw: RawEntity): PolylineVertex[] {
  const vertices: PolylineVertex[] = []
  let current: PolylineVertex | null = null
  for (const pair of raw.pairs) {
    if (pair.code === 10) {
      current = { point: [Number(pair.value) || 0, 0], bulge: 0 }
      vertices.push(current)
    } else if (pair.code === 20 && current) {
      current.point[1] = Number(pair.value) || 0
    } else if (pair.code === 42 && current) {
      current.bulge = Number(pair.value) || 0
    }
  }
  return vertices
}

function expandBulgeVertices(vertices: PolylineVertex[], closed: boolean): Point[] {
  if (vertices.length < 2) return vertices.map((vertex) => vertex.point)
  const points: Point[] = [vertices[0].point]
  const segmentCount = closed ? vertices.length : vertices.length - 1
  for (let i = 0; i < segmentCount; i++) {
    const from = vertices[i]
    const to = vertices[(i + 1) % vertices.length]
    if (Math.abs(from.bulge) < 1e-9) {
      points.push(to.point)
      continue
    }
    const dx = to.point[0] - from.point[0]
    const dy = to.point[1] - from.point[1]
    const chord = Math.hypot(dx, dy)
    if (chord < 1e-9) continue
    const midX = (from.point[0] + to.point[0]) / 2
    const midY = (from.point[1] + to.point[1]) / 2
    const offset = chord * (1 - from.bulge * from.bulge) / (4 * from.bulge)
    const center: Point = [midX - dy / chord * offset, midY + dx / chord * offset]
    const radius = Math.hypot(from.point[0] - center[0], from.point[1] - center[1])
    const startAngle = Math.atan2(from.point[1] - center[1], from.point[0] - center[0])
    const sweep = 4 * Math.atan(from.bulge)
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) * 180 / Math.PI / 2))
    for (let step = 1; step <= steps; step++) {
      const angle = startAngle + sweep * step / steps
      points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)])
    }
  }
  if (closed && points.length > 1) points.pop()
  return points
}

/**
 * 将 DXF 的 Y 向上坐标转换为编辑器的 Y 向下坐标。
 * @param entity 待转换实体。
 * @returns 无返回值；实体坐标会原地更新。
 * @author snihao
 */
function flipEntityY(entity: Entity): void {
  if (entity.type === 'line') { entity.start![1] *= -1; entity.end![1] *= -1 }
  else if (entity.type === 'polyline') {
    entity.points = entity.points!.map(([x, y]) => [x, -y])
    if (entity.curveGeometry) flipCurveGeometryY(entity.curveGeometry)
  }
  else if (entity.type === 'circle') entity.center![1] *= -1
  else if (entity.type === 'text') entity.position![1] *= -1
  else if (entity.type === 'annotation') {
    entity.leader = entity.leader!.map(([x, y]) => [x, -y])
    if (entity.annotationSegments) entity.annotationSegments = entity.annotationSegments.map(([[startX, startY], [endX, endY]]) => [[startX, -startY], [endX, -endY]])
    entity.position![1] *= -1
  }
  else if (entity.type === 'dimension') {
    if (entity.dimensionStart) entity.dimensionStart[1] *= -1
    if (entity.dimensionEnd) entity.dimensionEnd[1] *= -1
    if (entity.dimensionCenter) entity.dimensionCenter[1] *= -1
    if (entity.dimensionLinePosition) entity.dimensionLinePosition[1] *= -1
    if (entity.dimensionOrigin) entity.dimensionOrigin[1] *= -1
    if (entity.dimensionOffset) entity.dimensionOffset[1] *= -1
    if (entity.dimensionAngularLine1Start) entity.dimensionAngularLine1Start[1] *= -1
    if (entity.dimensionAngularLine2Start) entity.dimensionAngularLine2Start[1] *= -1
    // 镜像会反转圆弧方向；交换起止参数才能保留 DXF 原有扫角。
    if ((entity.dimensionType === 'angular' || entity.dimensionType === 'arcLength')
      && entity.dimensionStart && entity.dimensionEnd) {
      ;[entity.dimensionStart, entity.dimensionEnd] = [entity.dimensionEnd, entity.dimensionStart]
      ;[entity.dimensionAngularLine1Start, entity.dimensionAngularLine2Start] = [
        entity.dimensionAngularLine2Start,
        entity.dimensionAngularLine1Start,
      ]
    }
    if (entity.dimensionCenter && entity.dimensionStart) entity.dimensionRadius = pointDistance(entity.dimensionCenter, entity.dimensionStart)
    if (entity.dimensionDisplaySegments) entity.dimensionDisplaySegments = entity.dimensionDisplaySegments.map(([start, end]) => [[start[0], -start[1]], [end[0], -end[1]]])
    if (entity.position) entity.position[1] *= -1
  }
  else if (entity.type === 'group') for (const child of entity.children || []) flipEntityY(child)
}

/** 将非 mm/inch 的 DXF 坐标整体换算到编辑器单位，不改变图形比例。 */
function scaleImportedEntity(entity: Entity, scale: number): void {
  const scalePoint = ([x, y]: Point): Point => [x * scale, y * scale]
  if (entity.lineDash) entity.lineDash = entity.lineDash.map((value) => value * scale)
  if (entity.polylineWidth != null) entity.polylineWidth *= scale
  if (entity.textBoxWidth != null) entity.textBoxWidth *= scale
  if (entity.type === 'line') {
    entity.start = scalePoint(entity.start!)
    entity.end = scalePoint(entity.end!)
  } else if (entity.type === 'polyline') {
    entity.points = entity.points!.map(scalePoint)
    if (entity.curveGeometry) scaleCurveGeometry(entity.curveGeometry, scale)
  } else if (entity.type === 'circle') {
    entity.center = scalePoint(entity.center!)
    entity.radius = entity.radius! * scale
  } else if (entity.type === 'text') {
    entity.position = scalePoint(entity.position!)
    if (entity.fontSize != null) entity.fontSize *= scale
  } else if (entity.type === 'annotation') {
    entity.leader = entity.leader!.map(scalePoint)
    if (entity.annotationSegments) entity.annotationSegments = entity.annotationSegments.map(([start, end]) => [scalePoint(start), scalePoint(end)])
    entity.position = scalePoint(entity.position!)
    if (entity.fontSize != null) entity.fontSize *= scale
  } else if (entity.type === 'dimension') {
    if (entity.dimensionStart) entity.dimensionStart = scalePoint(entity.dimensionStart)
    if (entity.dimensionEnd) entity.dimensionEnd = scalePoint(entity.dimensionEnd)
    if (entity.dimensionCenter) entity.dimensionCenter = scalePoint(entity.dimensionCenter)
    if (entity.dimensionLinePosition) entity.dimensionLinePosition = scalePoint(entity.dimensionLinePosition)
    if (entity.dimensionOrigin) entity.dimensionOrigin = scalePoint(entity.dimensionOrigin)
    if (entity.dimensionOffset) entity.dimensionOffset = scalePoint(entity.dimensionOffset)
    if (entity.dimensionAngularLine1Start) entity.dimensionAngularLine1Start = scalePoint(entity.dimensionAngularLine1Start)
    if (entity.dimensionAngularLine2Start) entity.dimensionAngularLine2Start = scalePoint(entity.dimensionAngularLine2Start)
    if (entity.dimensionCenter && entity.dimensionStart) entity.dimensionRadius = pointDistance(entity.dimensionCenter, entity.dimensionStart)
    if (entity.dimensionDisplaySegments) entity.dimensionDisplaySegments = entity.dimensionDisplaySegments.map(([start, end]) => [scalePoint(start), scalePoint(end)])
    if (entity.position) entity.position = scalePoint(entity.position)
    if (entity.fontSize != null) entity.fontSize *= scale
  } else if (entity.type === 'group') {
    for (const child of entity.children || []) scaleImportedEntity(child, scale)
  }
}

function textRotation(raw: RawEntity, degrees: number): number {
  const radians = degrees * Math.PI / 180
  const [axisX, axisY] = ocsAxes(raw)
  const x = Math.cos(radians) * axisX[0] + Math.sin(radians) * axisY[0]
  const y = Math.cos(radians) * axisX[1] + Math.sin(radians) * axisY[1]
  return Math.atan2(-y, x) * 180 / Math.PI
}

function canvasAngleBetween(start: Point, end: Point): number {
  return Math.atan2(-(end[1] - start[1]), end[0] - start[0]) * 180 / Math.PI
}

function textAlign(horizontal: number): 'left' | 'center' | 'right' {
  if (horizontal === 2) return 'right'
  if (horizontal >= 1) return 'center'
  return 'left'
}

function textBaseline(vertical: number): 'alphabetic' | 'bottom' | 'middle' | 'top' {
  if (vertical === 1) return 'bottom'
  if (vertical === 2) return 'middle'
  if (vertical === 3) return 'top'
  return 'alphabetic'
}

function mtextAlign(attachment: number): 'left' | 'center' | 'right' {
  const column = ((Math.max(1, Math.min(9, attachment)) - 1) % 3) + 1
  return column === 2 ? 'center' : column === 3 ? 'right' : 'left'
}

function mtextBaseline(attachment: number): 'top' | 'middle' | 'bottom' {
  const row = Math.ceil(Math.max(1, Math.min(9, attachment)) / 3)
  return row === 2 ? 'middle' : row === 3 ? 'bottom' : 'top'
}

function num(raw: RawEntity, code: number, fallback = 0): number {
  const pair = raw.pairs.find((p) => p.code === code)
  const value = pair ? Number(pair.value) : fallback
  return Number.isFinite(value) ? value : fallback
}
/**
 * 判断 DXF 实体是否被组码 60 标记为不可见，关联 HATCH 边界通常使用该标记。
 * @param raw 原始 DXF 实体。
 * @returns 实体是否不可见。
 * @author snihao
 */
function isInvisibleDxfEntity(raw: RawEntity): boolean { return Math.trunc(num(raw, 60)) === 1 }
function str(raw: RawEntity, code: number): string { return raw.pairs.find((p) => p.code === code)?.value || '' }
function has(raw: RawEntity, code: number): boolean { return raw.pairs.some((p) => p.code === code) }
function values(raw: RawEntity, code: number): number[] { return raw.pairs.filter((p) => p.code === code).map((p) => Number(p.value)).filter(Number.isFinite) }
function trueColorHex(value: number): string { return `#${(value & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase()}` }
function aciColor(value: number): string {
  if (ACI_COLORS[value]) return ACI_COLORS[value]
  if (value >= 250 && value <= 255) {
    const gray = [51, 80, 105, 130, 190, 255][value - 250]
    return rgbHex(gray, gray, gray)
  }
  if (value < 10 || value > 249) return DEFAULTS.color
  const group = Math.floor((value - 10) / 10)
  const shade = (value - 10) % 10
  const hue = group * 15
  const variants = [
    [100, 100], [50, 100], [100, 80], [50, 80], [100, 60],
    [50, 60], [100, 40], [50, 40], [100, 25], [50, 25],
  ]
  const [saturation, brightness] = variants[shade]
  return hsvHex(hue, saturation / 100, brightness / 100)
}
function entityColor(raw: RawEntity, layerColor?: string): string {
  const editorColor = editorSourceStyle(raw).color
  if (editorColor) return editorColor
  const trueColor = raw.pairs.find((p) => p.code === 420)
  if (trueColor) return trueColorHex(Number(trueColor.value))
  const aci = Math.abs(num(raw, 62, 256))
  return aci === 0 || aci === 256 ? (layerColor || DEFAULTS.color) : aciColor(aci)
}

/** 解析实体颜色的 DXF 继承模式。 @param raw 原始实体。 @returns 颜色模式。 @author snihao */
function entityColorMode(raw: RawEntity): EntityStyleMode {
  if (editorSourceStyle(raw).color) return 'explicit'
  if (raw.pairs.some((item) => item.code === 420)) return 'explicit'
  const pair = raw.pairs.find((item) => item.code === 62)
  if (!pair || Math.abs(Number(pair.value)) === 256) return 'byLayer'
  if (Number(pair.value) === 0) return 'byBlock'
  return 'explicit'
}

/** 使用 Canvas 绘制 dxf-render/WebGL 无法可靠还原的原始样式。 */
function needsSourceCanvasStyle(raw: RawEntity, layerStyle?: LayerStyle): boolean {
  const editorStyle = editorSourceStyle(raw)
  if (editorStyle.color || editorStyle.lineWidth !== undefined) return true
  if (raw.pairs.some((item) => item.code === 420)) return true
  const rawWeight = num(raw, 370, -1)
  if (rawWeight >= 0) return true
  return rawWeight === -1 && layerStyle?.lineWidth != null
}

/** 解析实体线型的 DXF 继承模式。 @param value 原始线型名称。 @returns 线型模式。 @author snihao */
function entityLineTypeMode(value: string): EntityStyleMode {
  const normalized = value.trim().toUpperCase()
  if (!normalized || normalized === 'BYLAYER') return 'byLayer'
  if (normalized === 'BYBLOCK') return 'byBlock'
  return 'explicit'
}

/** 解析实体线宽的 DXF 继承模式。 @param raw 原始实体。 @returns 线宽模式。 @author snihao */
function entityLineWidthMode(raw: RawEntity): EntityStyleMode {
  if (editorSourceStyle(raw).lineWidth !== undefined) return 'explicit'
  const pair = raw.pairs.find((item) => item.code === 370)
  if (!pair || Number(pair.value) === -1) return 'byLayer'
  if (Number(pair.value) === -2) return 'byBlock'
  return Number(pair.value) >= 0 ? 'explicit' : 'byLayer'
}

function lineWidthOf(raw: RawEntity, layerWidth: number | null | undefined, unit: DrawingUnit): number {
  const editorLineWidth = editorSourceStyle(raw).lineWidth
  if (editorLineWidth !== undefined) return editorLineWidth
  const value = num(raw, 370, -1)
  if (value >= 0) return normalizeLineWidth(value, unit)
  if ((value === -1 || value === -2) && layerWidth !== null && layerWidth !== undefined) return layerWidth
  return unit === 'inch' ? 0.01 : 0.25
}

/** 读取保存在应用专用 DXF XDATA 中的精确编辑器样式。 */
function editorSourceStyle(raw: RawEntity): EditorSourceStyle {
  const style: EditorSourceStyle = {}
  let active = false
  for (const pair of raw.pairs) {
    if (pair.code === 1001) {
      active = pair.value === EDITOR_STYLE_APPID
      continue
    }
    if (active && pair.code === 1000) applyEditorStyleValue(style, pair.value)
  }
  return style
}

function applyEditorStyleValue(style: EditorSourceStyle, value: string): void {
  if (value.startsWith('COLOR=') && /^#[0-9A-F]{6}$/i.test(value.slice(6))) {
    style.color = value.slice(6).toUpperCase()
  } else if (value.startsWith('LINEWIDTH=')) {
    const lineWidth = Number(value.slice(10))
    if (Number.isFinite(lineWidth) && lineWidth > 0) style.lineWidth = lineWidth
  }
}
function polylineWidthOf(raw: RawEntity): number | null {
  const widths = raw.pairs
    .filter((pair) => pair.code === 43 || pair.code === 40 || pair.code === 41)
    .map((pair) => Math.abs(Number(pair.value)))
    .filter((value) => Number.isFinite(value) && value > 0)
  return widths.length ? Math.max(...widths) : null
}
function normalizeLineType(value: string): LineType {
  const name = value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (name.includes('DASHDOT') || name.includes('CENTER') || name.includes('PHANTOM')) return 'dashdot'
  if (name.includes('DASH') || name.includes('HIDDEN') || name.includes('DOT')) return 'dashed'
  return 'solid'
}
function normalizeLineWidth(hundredthsOfMm: number, unit: DrawingUnit): number {
  const millimeters = hundredthsOfMm === 0 ? 0.05 : hundredthsOfMm / 100
  const value = unit === 'inch' ? millimeters / 25.4 : millimeters
  const max = unit === 'inch' ? 5 / 25.4 : 5
  const min = unit === 'inch' ? 0.05 / 25.4 : 0.05
  return Math.round(Math.min(max, Math.max(min, value)) * 10000) / 10000
}
function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}
function hsvHex(hue: number, saturation: number, value: number): string {
  const c = value * saturation
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1))
  const m = value - c
  let rgb: [number, number, number]
  if (hue < 60) rgb = [c, x, 0]
  else if (hue < 120) rgb = [x, c, 0]
  else if (hue < 180) rgb = [0, c, x]
  else if (hue < 240) rgb = [0, x, c]
  else if (hue < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return rgbHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255)
}
/**
 * 解码 AutoCAD 文字转义；处理 MTEXT 时移除格式控制符并保留可见内容。
 * @param value DXF 中的原始文字。
 * @param mtext 是否按 MTEXT 格式控制规则处理。
 * @returns 可直接显示的文字内容。
 * @author snihao
 */
export function decodeDxfText(value: string, mtext = false): string {
  let text = value
    .replace(/\\U\+([0-9A-F]{8}|[0-9A-F]{4})/gi, (match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16)
      return Number.isFinite(codePoint) && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : match
    })
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%(\d{3})/g, (_match, decimal: string) => String.fromCharCode(Number.parseInt(decimal, 10)))

  if (!mtext) return text.trim()

  const protectedCharacters: string[] = []
  text = text.replace(/\\\\|\\\{|\\\}/g, (escaped) => {
    const literal = escaped === '\\\\' ? '\\' : escaped.slice(1)
    const token = `\uE000${protectedCharacters.length}\uE001`
    protectedCharacters.push(literal)
    return token
  })
  text = text
    .replace(/\\S([^;]*);/gi, (_match, stacked: string) => stacked.replace(/\\(.)/g, '$1').replace(/[\^#/]/, '/'))
    .replace(/\\P/gi, '\n')
    .replace(/\\X/gi, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\^I/g, '\t')
    .replace(/\\[LOK]/gi, '')
    .replace(/\\[ACFHQTW][^;]*;/gi, '')
    .replace(/\\p[^;]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => protectedCharacters[Number(index)] || '')
  return text.trim()
}
