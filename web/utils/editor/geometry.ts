import { curveBounds, sampleCurve, transformCurveGeometry, translateCurveGeometry } from '#draiq/utils/editor/curveGeometry'
import { resolveDimensionStyle } from '#draiq/utils/editor/dimensionStyles'

/** 纯数学与坐标工具。无 DOM 依赖，便于复用与测试。 */

/** 将值限制在 [min, max] 范围内 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 四舍五入到指定小数位 */
export function round(value: number, ndigits = 1): number {
  const f = 10 ** ndigits
  return Math.round(value * f) / f
}

/** 两点间距离 */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** 两点中点 */
export function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

/** 接近水平或垂直方向时，将点吸附到锚点对应坐标。 */
export function snapOrthogonal(anchor: Point, point: Point, tolerance: number): Point {
  const dx = Math.abs(point[0] - anchor[0])
  const dy = Math.abs(point[1] - anchor[1])
  if (dx <= tolerance && dx <= dy) return [anchor[0], point[1]]
  if (dy <= tolerance) return [point[0], anchor[1]]
  return point
}

/**
 * 平滑拖拽多段线控制点：位移在相邻可见控制点之间按余弦曲线衰减，
 * 避免密集原始顶点中只移动单点产生三角尖刺。
 */
export function deformPolylineVertex(
  entity: Entity,
  index: number,
  target: Point,
  originalPoints: Point[],
  controlIndices: number[],
): void {
  if (entity.type !== 'polyline' || !originalPoints[index]) return
  entity.curveGeometry = null
  const count = originalPoints.length
  const closed = !!entity.closed
  const controls = Array.from(new Set(controlIndices)).sort((a, b) => a - b)
  const controlPosition = controls.indexOf(index)
  if (controlPosition < 0) {
    entity.points![index] = [round(target[0]), round(target[1])]
    return
  }
  const dx = target[0] - originalPoints[index][0]
  const dy = target[1] - originalPoints[index][1]
  const result = originalPoints.map((point) => point.slice() as Point)
  result[index] = [round(target[0]), round(target[1])]

  const previous = controlPosition > 0
    ? controls[controlPosition - 1]
    : closed ? controls[controls.length - 1] : null
  const next = controlPosition < controls.length - 1
    ? controls[controlPosition + 1]
    : closed ? controls[0] : null

  const applySide = (boundary: number | null, direction: -1 | 1): void => {
    if (boundary === null || boundary === index) return
    const indices: number[] = [index]
    let cursor = index
    while (cursor !== boundary && indices.length <= count) {
      cursor = (cursor + direction + count) % count
      indices.push(cursor)
      if (!closed && (cursor === 0 || cursor === count - 1) && cursor !== boundary) break
    }
    if (indices[indices.length - 1] !== boundary) return
    let total = 0
    const distances: number[] = [0]
    for (let i = 1; i < indices.length; i++) {
      total += distance(originalPoints[indices[i - 1]], originalPoints[indices[i]])
      distances.push(total)
    }
    if (total < 1e-6) return
    for (let i = 1; i < indices.length - 1; i++) {
      const ratio = distances[i] / total
      const weight = (1 + Math.cos(Math.PI * ratio)) / 2
      const point = originalPoints[indices[i]]
      result[indices[i]] = [round(point[0] + dx * weight), round(point[1] + dy * weight)]
    }
  }

  applySide(previous, -1)
  applySide(next, 1)
  entity.points = result
}

/** 判断是否为四控制点的线性尺寸标注。 */
export function isDimensionAnnotation(entity: Entity): boolean {
  return entity.type === 'annotation'
    && entity.annotationKind !== 'surface-roughness'
    && entity.annotationKind !== 'geometric-tolerance'
    && entity.annotationKind !== 'datum-feature'
    && (entity.leader?.length || 0) >= 4
}

/**
 * 返回原生尺寸标注和旧版四点标注共用的可绘制几何。
 * @param entity 待解析的实体。
 * @returns 四个测量/尺寸线端点，无法解析时返回 null。
 * @author snihao
 */
export function dimensionPoints(entity: Entity): [Point, Point, Point, Point] | null {
  if (entity.type === 'annotation' && isDimensionAnnotation(entity)) {
    const leader = entity.leader!
    return [leader[0], leader[1], leader[2], leader[3]]
  }
  if (entity.type !== 'dimension' || !entity.dimensionStart) return null
  const start = entity.dimensionStart
  if (entity.dimensionType === 'radius') {
    const center = entity.dimensionCenter || start
    return [center, start, center, start]
  }
  if (!entity.dimensionEnd) return null
  const end = entity.dimensionEnd
  const linePoint = entity.dimensionLinePosition || entity.position || start
  if (entity.dimensionType === 'diameter') return [start, end, start, end]
  if (entity.dimensionType === 'angular' || entity.dimensionType === 'arcLength') {
    const center = entity.dimensionCenter || linePoint
    return [start, end, center, linePoint]
  }
  if (entity.dimensionType === 'ordinate') return [start, end, start, end]
  if (entity.dimensionType === 'linear') {
    const angle = ((entity.dimensionAngle || 0) * Math.PI) / 180
    const ux = Math.cos(angle)
    const uy = Math.sin(angle)
    // 尺寸界线的垂足是两个测量点在经过保存位置的
    // 尺寸线上的投影。这样在执行旋转变换后，
    // 线性标注仍能保持有效。
    const project = (point: Point): Point => {
      const distanceAlong = (point[0] - linePoint[0]) * ux + (point[1] - linePoint[1]) * uy
      return [round(linePoint[0] + ux * distanceAlong, 9), round(linePoint[1] + uy * distanceAlong, 9)]
    }
    return [start, end, project(start), project(end)]
  }
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) return null
  const nx = -dy / length
  const ny = dx / length
  const offset = (linePoint[0] - start[0]) * nx + (linePoint[1] - start[1]) * ny
  return [
    start,
    end,
    [start[0] + nx * offset, start[1] + ny * offset],
    [end[0] + nx * offset, end[1] + ny * offset],
  ]
}

/** 是否具有尺寸标注语义（原生标注或可迁移的旧版线性标注）。 */
export function isDimensionEntity(entity: Entity): boolean {
  return entity.type === 'dimension' || isDimensionAnnotation(entity)
}

/** 标注显示线段的样式过滤参数。 @author snihao */
export interface DimensionSegmentOptions {
  /** 尺寸界线起点留白。 */
  extensionOffset?: number
  /** 尺寸界线超过尺寸线的长度。 */
  extensionBeyond?: number
  /** 是否隐藏第一条尺寸界线。 */
  suppressFirstExtension?: boolean
  /** 是否隐藏第二条尺寸界线。 */
  suppressSecondExtension?: boolean
  /** 是否隐藏尺寸线。 */
  suppressDimensionLine?: boolean
}

/** 与当前画布显示保持一致的尺寸线段。导入标注优先使用其匿名块线段。
 * @param entity 标注实体。
 * @param options 可选的样式过滤参数。
 * @returns 可绘制线段列表。
 * @author snihao
 */
export function dimensionSegments(entity: Entity, options?: DimensionSegmentOptions): Array<[Point, Point]> {
  if (entity.type === 'annotation' && (entity.annotationKind === 'geometric-tolerance' || entity.annotationKind === 'datum-feature')) {
    const segments: Array<[Point, Point]> = []
    const leader = entity.leader || []
    for (let index = 1; index < leader.length; index++) segments.push([leader[index - 1], leader[index]])
    for (const segment of entity.annotationSegments || []) segments.push(segment)
    return segments
  }
  if (entity.type === 'dimension' && entity.dimensionDisplaySegments?.length) return entity.dimensionDisplaySegments
  if (entity.type === 'dimension' && entity.dimensionType === 'angular') {
    const points = dimensionPoints(entity)
    if (!points || !entity.dimensionCenter) return []
    const [start, end, center, linePoint] = points
    const arcRadius = Math.max(distance(center, linePoint), 1e-6)
    const arcStart = pointOnRay(center, start, arcRadius)
    const arcEnd = pointOnRay(center, end, arcRadius)
    const segments: Array<[Point, Point]> = []
    if (entity.dimensionAngularMode === 'twoLine' && entity.dimensionAngularLine1Start && entity.dimensionAngularLine2Start) {
      if (!options?.suppressFirstExtension) segments.push([entity.dimensionAngularLine1Start, arcStart])
      if (!options?.suppressSecondExtension) segments.push([entity.dimensionAngularLine2Start, arcEnd])
    } else {
      if (!options?.suppressFirstExtension) segments.push([center, arcStart])
      if (!options?.suppressSecondExtension) segments.push([center, arcEnd])
    }
    if (!options?.suppressDimensionLine) segments.push(...arcDimensionSegments(center, start, end, arcRadius))
    return segments
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'arcLength') {
    const points = dimensionPoints(entity)
    if (!points || !entity.dimensionCenter) return []
    const [start, end, center, linePoint] = points
    const radius = Math.max(entity.dimensionRadius || distance(center, start), 1e-6)
    const arcRadius = Math.max(distance(center, linePoint), radius)
    const arcStart = pointOnRay(center, start, arcRadius)
    const arcEnd = pointOnRay(center, end, arcRadius)
    const segments: Array<[Point, Point]> = []
    if (!options?.suppressFirstExtension) segments.push([center, arcStart])
    if (!options?.suppressSecondExtension) segments.push([center, arcEnd])
    if (!options?.suppressDimensionLine) segments.push(...arcDimensionSegments(center, start, end, arcRadius))
    return segments
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'radius') {
    const points = dimensionPoints(entity)
    if (!points) return []
    const [center, mpoint] = points
    if (options?.suppressDimensionLine) return []
    const segments: Array<[Point, Point]> = [[center, mpoint]]
    if (entity.position && entity.textPositionManual && distance(mpoint, entity.position) > 1e-7) {
      segments.push([mpoint, entity.position])
    }
    return segments
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'diameter') {
    const points = dimensionPoints(entity)
    if (!points || options?.suppressDimensionLine) return []
    const segments: Array<[Point, Point]> = [[points[0], points[1]]]
    if (entity.position && entity.textPositionManual && distance(points[0], entity.position) > 1e-7) {
      segments.push([points[0], entity.position])
    }
    return segments
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'ordinate') {
    const points = dimensionPoints(entity)
    return points && !options?.suppressDimensionLine ? [[points[0], points[1]]] : []
  }
  const points = dimensionPoints(entity)
  if (!points) return []
  const firstExtension = dimensionExtensionSegment(points[0], points[2], options)
  const secondExtension = dimensionExtensionSegment(points[1], points[3], options)
  const segments: Array<[Point, Point]> = []
  if (!options?.suppressFirstExtension) segments.push(firstExtension)
  if (!options?.suppressSecondExtension) segments.push(secondExtension)
  if (!options?.suppressDimensionLine) segments.push([points[2], points[3]])
  return segments
}

/** 按 DIMSTYLE 留白计算一条尺寸界线。
 * @param measurePoint 测量点。
 * @param dimensionPoint 尺寸线上的投影点。
 * @param options 标注样式参数。
 * @returns 尺寸界线端点。
 * @author snihao
 */
function dimensionExtensionSegment(measurePoint: Point, dimensionPoint: Point, options?: DimensionSegmentOptions): [Point, Point] {
  const dx = dimensionPoint[0] - measurePoint[0]
  const dy = dimensionPoint[1] - measurePoint[1]
  const length = Math.max(Math.hypot(dx, dy), 1e-9)
  const ux = dx / length
  const uy = dy / length
  const offset = Math.max(0, options?.extensionOffset || 0)
  const beyond = Math.max(0, options?.extensionBeyond || 0)
  return [
    [measurePoint[0] + ux * offset, measurePoint[1] + uy * offset],
    [dimensionPoint[0] + ux * beyond, dimensionPoint[1] + uy * beyond],
  ]
}

/** 生成角度/弧长标注的参数化圆弧显示线。 */
function arcDimensionSegments(center: Point, start: Point, end: Point, radius: number): Array<[Point, Point]> {
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0])
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0])
  const sweep = positiveAngle(endAngle - startAngle) || Math.PI * 2
  const count = Math.max(12, Math.ceil(sweep * 180 / Math.PI / 6))
  const points = Array.from({ length: count + 1 }, (_, index) => {
    const angle = startAngle + sweep * index / count
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius] as Point
  })
  const segments: Array<[Point, Point]> = []
  for (let index = 1; index < points.length; index++) segments.push([points[index - 1], points[index]])
  return segments
}

/**
 * 把射线上的参考点投影到指定半径；参考点与圆心重合时使用水平正方向。
 * @param center 射线起点和圆心。
 * @param reference 射线方向参考点。
 * @param radius 目标半径。
 * @returns 投影后的点。
 * @author snihao
 */
function pointOnRay(center: Point, reference: Point, radius: number): Point {
  const dx = reference[0] - center[0]
  const dy = reference[1] - center[1]
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) return [center[0] + radius, center[1]]
  return [center[0] + dx / length * radius, center[1] + dy / length * radius]
}

/** 圆弧尺寸线端点处的箭头几何。方向向量沿圆弧切线朝向尺寸线内部。 */
export interface ArcDimensionArrowGeometry {
  tip: Point
  direction: Point
}

/**
 * 计算角度/弧长标注在实际尺寸弧上的箭头位置与切线方向。
 * @param entity 角度或弧长原生标注。
 * @returns 起点、终点箭头几何；参数不完整时返回 null。
 * @author snihao
 */
export function arcDimensionArrowGeometry(
  entity: Entity,
): [ArcDimensionArrowGeometry, ArcDimensionArrowGeometry] | null {
  if (entity.type !== 'dimension' || (entity.dimensionType !== 'angular' && entity.dimensionType !== 'arcLength')) return null
  const points = dimensionPoints(entity)
  if (!points || !entity.dimensionCenter) return null
  const [start, end, center, linePoint] = points
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0])
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0])
  const sweep = positiveAngle(endAngle - startAngle) || Math.PI * 2
  const sourceRadius = Math.max(entity.dimensionRadius || distance(center, start), 1e-6)
  const radius = entity.dimensionType === 'arcLength'
    ? Math.max(distance(center, linePoint), sourceRadius)
    : Math.max(distance(center, linePoint), 1e-6)
  const availableLength = Math.max(radius * sweep, 1e-6)
  const startTip: Point = [
    center[0] + Math.cos(startAngle) * radius,
    center[1] + Math.sin(startAngle) * radius,
  ]
  const endTip: Point = [
    center[0] + Math.cos(endAngle) * radius,
    center[1] + Math.sin(endAngle) * radius,
  ]
  return [
    {
      tip: startTip,
      direction: [-Math.sin(startAngle) * availableLength, Math.cos(startAngle) * availableLength],
    },
    {
      tip: endTip,
      direction: [Math.sin(endAngle) * availableLength, -Math.cos(endAngle) * availableLength],
    },
  ]
}

/** 将角度归一化到 [0, 2π)。 */
function positiveAngle(value: number): number {
  return (value % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
}

/** 对原生标注的全部参数点执行同一个几何变换。 */
function mapDimensionPoints(entity: Entity, mapper: (point: Point) => Point): void {
  if (entity.dimensionStart) entity.dimensionStart = mapper(entity.dimensionStart)
  if (entity.dimensionEnd) entity.dimensionEnd = mapper(entity.dimensionEnd)
  if (entity.dimensionCenter) entity.dimensionCenter = mapper(entity.dimensionCenter)
  if (entity.dimensionLinePosition) entity.dimensionLinePosition = mapper(entity.dimensionLinePosition)
  if (entity.dimensionOrigin) entity.dimensionOrigin = mapper(entity.dimensionOrigin)
  if (entity.dimensionOffset) entity.dimensionOffset = mapper(entity.dimensionOffset)
  if (entity.dimensionAngularLine1Start) entity.dimensionAngularLine1Start = mapper(entity.dimensionAngularLine1Start)
  if (entity.dimensionAngularLine2Start) entity.dimensionAngularLine2Start = mapper(entity.dimensionAngularLine2Start)
  if (entity.position) entity.position = mapper(entity.position)
}

/**
 * 标注文字布局参数。
 * @author snihao
 */
export interface AnnotationTextPositionOptions {
  /** 实际绘制的文字内容。 */
  text?: string | null
  /** 实际绘制的文字高度。 */
  fontSize?: number | null
  /** 文字与尺寸线之间的间隙。 */
  textGap?: number | null
  /** 文字水平方向缩放比例。 */
  textWidthFactor?: number | null
}

/** 标注文字在画布中的完整布局，供渲染、命中与包围盒共同使用。 @author snihao */
export interface AnnotationTextLayout {
  /** 文字锚点。 */
  position: Point
  /** 应显示的文字内容。 */
  text: string
  /** 模型空间字高。 */
  fontSize: number
  /** 顺时针画布旋转角度，单位为度。 */
  rotation: number
  /** 水平锚点。 */
  textAlign: 'left' | 'center' | 'right'
  /** 垂直锚点。 */
  textBaseline: 'alphabetic' | 'top' | 'middle' | 'bottom'
  /** 水平字形缩放比例。 */
  textWidthFactor: number
  /** 旋转与宽度缩放前的局部文字范围。 */
  localBounds: Bounds
  /** 旋转与宽度缩放后的世界坐标包围盒。 */
  bounds: Bounds
}

/** 标注文字的有效显示参数。 @author snihao */
interface AnnotationTextPresentation {
  /** 应显示的文字内容。 */
  text: string
  /** 模型空间字高。 */
  fontSize: number
  /** 文字与尺寸线间隙。 */
  textGap: number
}

/**
 * 计算线性标注的自动文字位置；空间不足时放到尺寸线右端。
 * @param entity 待计算的标注实体。
 * @param options 实际渲染文字的布局参数。
 * @param drawing 当前图纸；提供后会解析实体引用的 DIMSTYLE。
 * @returns 文字基线左端位置。
 * @author snihao
 */
export function annotationTextPosition(entity: Entity, options?: AnnotationTextPositionOptions, drawing?: Drawing): Point {
  if (entity.position && (entity.textPositionManual || entity.dimensionTextSourcePosition)) return entity.position
  const points = dimensionPoints(entity)
  if (!points) return entity.position || [0, 0]
  const presentation = annotationTextPresentation(entity, drawing)
  const dimStart = points[2]
  const dimEnd = points[3]
  const dx = dimEnd[0] - dimStart[0]
  const dy = dimEnd[1] - dimStart[1]
  const length = Math.max(Math.hypot(dx, dy), 1e-6)
  const ux = dx / length
  const uy = dy / length
  let nx = -uy
  let ny = ux
  // 文字以基线定位，始终放在尺寸线视觉上方，而不是以文字中心压在线上。
  if (ny > 0 || (Math.abs(ny) < 1e-6 && nx > 0)) {
    nx = -nx
    ny = -ny
  }
  const defaultFontSize = entity.type === 'dimension' ? 2.5 : 14
  const requestedFontSize = options?.fontSize ?? presentation.fontSize
  const fs = requestedFontSize != null && Number.isFinite(requestedFontSize) && requestedFontSize > 0
    ? requestedFontSize
    : defaultFontSize
  const text = options?.text ?? presentation.text
  const requestedWidthFactor = options?.textWidthFactor ?? entity.textWidthFactor
  const widthFactor = requestedWidthFactor != null && Number.isFinite(requestedWidthFactor) && requestedWidthFactor > 0
    ? requestedWidthFactor
    : 1
  const textWidth = Math.max(...text.split('\n').map((line) => estimatedTextWidth(line, fs) * widthFactor), fs)
  const defaultGap = entity.type === 'dimension' ? 0.625 : Math.max(3, fs * 0.25)
  const requestedGap = options?.textGap ?? presentation.textGap
  const clearance = requestedGap != null && Number.isFinite(requestedGap) && requestedGap >= 0
    ? requestedGap
    : defaultGap
  if (textWidth + fs <= length) {
    return [round((dimStart[0] + dimEnd[0]) / 2 - ux * textWidth / 2 + nx * clearance), round((dimStart[1] + dimEnd[1]) / 2 - uy * textWidth / 2 + ny * clearance)]
  }
  return [round(dimEnd[0] + ux * fs * 0.7 + nx * clearance), round(dimEnd[1] + uy * fs * 0.7 + ny * clearance)]
}

/**
 * 解析标注文字的完整画布布局。
 * @param entity 文字、引线标注或原生尺寸标注。
 * @param drawing 当前图纸；原生标注需要它来解析 DIMSTYLE。
 * @returns 可直接用于绘制和命中的文字布局。
 * @author snihao
 */
export function annotationTextLayout(entity: Entity, drawing?: Drawing): AnnotationTextLayout {
  const presentation = annotationTextPresentation(entity, drawing)
  const fontSize = Math.max(presentation.fontSize, 1e-6)
  const textAlign = entity.textAlign || 'left'
  const textBaseline = entity.textBaseline || 'alphabetic'
  const textWidthFactor = entity.textWidthFactor != null
    && Number.isFinite(entity.textWidthFactor)
    && entity.textWidthFactor > 0
    ? entity.textWidthFactor
    : 1
  const position = entity.type === 'text'
    ? entity.position || [0, 0]
    : annotationTextPosition(entity, {
        text: presentation.text,
        fontSize,
        textGap: presentation.textGap,
        textWidthFactor,
      }, drawing)
  const localBounds = localTextBounds(presentation.text, fontSize, textAlign, textBaseline)
  const rotation = Number.isFinite(entity.rotation) ? entity.rotation || 0 : 0
  const localCorners: Point[] = [
    [localBounds.minX, localBounds.minY],
    [localBounds.maxX, localBounds.minY],
    [localBounds.maxX, localBounds.maxY],
    [localBounds.minX, localBounds.maxY],
  ]
  const corners = localCorners.map((point) => textLocalToWorld(point, position, rotation, textWidthFactor))
  return {
    position,
    text: presentation.text,
    fontSize,
    rotation,
    textAlign,
    textBaseline,
    textWidthFactor,
    localBounds,
    bounds: pointsBounds(corners),
  }
}

/**
 * 判断世界坐标点是否落在文字字框内。
 * @param point 待检测世界坐标。
 * @param layout 已解析的文字布局。
 * @param tolerance 世界坐标容差。
 * @returns 是否命中文字。
 * @author snihao
 */
export function hitAnnotationText(point: Point, layout: AnnotationTextLayout, tolerance: number): boolean {
  if (!layout.text) return false
  const radians = layout.rotation * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point[0] - layout.position[0]
  const dy = point[1] - layout.position[1]
  const localX = (dx * cos + dy * sin) / layout.textWidthFactor
  const localY = -dx * sin + dy * cos
  const horizontalTolerance = tolerance / layout.textWidthFactor
  return localX >= layout.localBounds.minX - horizontalTolerance
    && localX <= layout.localBounds.maxX + horizontalTolerance
    && localY >= layout.localBounds.minY - tolerance
    && localY <= layout.localBounds.maxY + tolerance
}

/**
 * 解析标注正文、DIMSTYLE 字高和文字间隙。
 * @param entity 待解析实体。
 * @param drawing 当前图纸。
 * @returns 有效文字显示参数。
 * @author snihao
 */
function annotationTextPresentation(entity: Entity, drawing?: Drawing): AnnotationTextPresentation {
  if (entity.type === 'text') {
    return {
      text: entity.content || '',
      fontSize: positiveTextValue(entity.fontSize, 14),
      textGap: 0,
    }
  }
  if (entity.type !== 'dimension') {
    const fontSize = positiveTextValue(entity.fontSize, 14)
    return {
      text: entity.text || '',
      fontSize,
      textGap: Math.max(3, fontSize * 0.25),
    }
  }
  const style = drawing ? resolveDimensionStyle(entity, drawing) : null
  const overrides = entity.dimensionStyleOverrides || {}
  const fontSize = style?.textHeight
    ?? (entity.dimensionTextHeightManual ? positiveTextValue(entity.fontSize, 2.5) : null)
    ?? (entity.dimensionTextSourceHeight ? positiveTextValue(entity.fontSize, 2.5) : null)
    ?? positiveTextValue(overrides.textHeight, positiveTextValue(entity.fontSize, 2.5))
  const sourceText = entity.text || entity.dimensionTextOverride || ''
  const text = entity.dimensionTextManual || entity.dimensionTextOverride
    ? sourceText
    : `${style?.textPrefix ?? overrides.textPrefix ?? ''}${sourceText}${style?.textSuffix ?? overrides.textSuffix ?? ''}`
  return {
    text,
    fontSize,
    textGap: style?.textGap ?? nonNegativeTextValue(overrides.textGap, 0.625),
  }
}

/**
 * 估算系统字体的一行宽度；CJK 与全角字符按一个字高计算。
 * @param text 单行文字。
 * @param fontSize 字高。
 * @returns 估算宽度。
 * @author snihao
 */
function estimatedTextWidth(text: string, fontSize: number): number {
  let units = 0
  for (const character of text) units += /[\u0000-\u00FF]/.test(character) ? 0.6 : 1
  return units * fontSize
}

/**
 * 计算未旋转文字在自身坐标系内的字框。
 * @param text 文字内容。
 * @param fontSize 字高。
 * @param textAlign 水平锚点。
 * @param textBaseline 垂直锚点。
 * @returns 局部坐标包围盒。
 * @author snihao
 */
function localTextBounds(
  text: string,
  fontSize: number,
  textAlign: AnnotationTextLayout['textAlign'],
  textBaseline: AnnotationTextLayout['textBaseline'],
): Bounds {
  if (!text) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const lines = text.split('\n')
  const width = Math.max(...lines.map((line) => estimatedTextWidth(line, fontSize)), fontSize * 0.6)
  const lineHeight = fontSize * 1.25
  const minX = textAlign === 'center' ? -width / 2 : textAlign === 'right' ? -width : 0
  const firstBaseline = textBaseline === 'middle'
    ? -(lines.length - 1) * lineHeight / 2
    : textBaseline === 'bottom'
    ? -(lines.length - 1) * lineHeight
    : 0
  const glyphTop = textBaseline === 'top' ? 0 : textBaseline === 'middle' ? -fontSize / 2 : -fontSize
  const minY = firstBaseline + glyphTop
  return {
    minX,
    minY,
    maxX: minX + width,
    maxY: minY + (lines.length - 1) * lineHeight + fontSize,
  }
}

/**
 * 把文字局部坐标应用宽度因子和旋转后转换到世界坐标。
 * @param point 文字局部坐标。
 * @param position 世界坐标锚点。
 * @param rotation 旋转角度。
 * @param widthFactor 水平宽度因子。
 * @returns 世界坐标。
 * @author snihao
 */
function textLocalToWorld(point: Point, position: Point, rotation: number, widthFactor: number): Point {
  const radians = rotation * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const x = point[0] * widthFactor
  return [position[0] + x * cos - point[1] * sin, position[1] + x * sin + point[1] * cos]
}

/**
 * 合并有限点列表为包围盒。
 * @param points 待合并坐标点。
 * @returns 世界坐标包围盒。
 * @author snihao
 */
function pointsBounds(points: Point[]): Bounds {
  return {
    minX: Math.min(...points.map((point) => point[0])),
    minY: Math.min(...points.map((point) => point[1])),
    maxX: Math.max(...points.map((point) => point[0])),
    maxY: Math.max(...points.map((point) => point[1])),
  }
}

/**
 * 读取正数字高。
 * @param value 待检查数值。
 * @param fallback 无效数值的后备值。
 * @returns 正数字高。
 * @author snihao
 */
function positiveTextValue(value: number | null | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 读取非负文字间隙。
 * @param value 待检查数值。
 * @param fallback 无效数值的后备值。
 * @returns 非负间隙。
 * @author snihao
 */
function nonNegativeTextValue(value: number | null | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * 根据原生标注的当前几何参数生成自动测量文字。
 * @param entity 待测量的原生标注实体。
 * @returns 自动测量文字；参数不完整时返回空值。
 * @author snihao
 */
export function dimensionMeasurementText(entity: Entity, precision = 1): string | null {
  if (entity.type !== 'dimension') return null
  const start = entity.dimensionStart
  const end = entity.dimensionEnd
  const center = entity.dimensionCenter
  if (entity.dimensionType === 'radius' && center && start) {
    return `R${round(distance(center, start), precision)}`
  }
  if (entity.dimensionType === 'diameter' && center && start) {
    return `Ø${round(distance(center, start) * 2, precision)}`
  }
  if ((entity.dimensionType === 'angular' || entity.dimensionType === 'arcLength') && center && start && end) {
    const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0])
    const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0])
    const sweep = positiveAngle(endAngle - startAngle) || Math.PI * 2
    if (entity.dimensionType === 'angular') return `${round(sweep * 180 / Math.PI, precision)}°`
    return `${round(distance(center, start) * sweep, precision)}`
  }
  if (entity.dimensionType === 'ordinate' && start) {
    const origin = entity.dimensionOrigin || [0, 0]
    const value = entity.dimensionOrdinateType === 'y'
      ? start[1] - origin[1]
      : start[0] - origin[0]
    return `${round(value, precision)}`
  }
  if (entity.dimensionType === 'linear' && start && end) {
    const angle = (entity.dimensionAngle || 0) * Math.PI / 180
    const projected = Math.abs((end[0] - start[0]) * Math.cos(angle) + (end[1] - start[1]) * Math.sin(angle))
    return `${round(projected, precision)}`
  }
  if (start && end) return `${round(distance(start, end), precision)}`
  return null
}

/**
 * 在未手动覆写文字时，同步原生标注的自动测量结果。
 * @param entity 待同步实体。
 * @returns 文字是否发生变化。
 * @author snihao
 */
export function syncDimensionMeasurementText(entity: Entity): boolean {
  if (entity.type !== 'dimension' || entity.dimensionTextManual || entity.dimensionTextOverride) return false
  const text = dimensionMeasurementText(entity)
  if (text === null || text === entity.text) return false
  entity.text = text
  return true
}

/**
 * 在首次几何编辑后释放 DXF 计算文字位置，并切换到编辑器原生定位语义。
 * 线性标注使用自动排版；其他专业标注与左侧工具一致，保留可跟随的手动锚点。
 * @param entity 待迁移的原生标注。
 * @returns 无返回值；文字定位标记会原地更新。
 * @author snihao
 */
export function releaseDimensionSourceTextPosition(entity: Entity): void {
  if (entity.type !== 'dimension' || !entity.dimensionTextSourcePosition) return
  entity.dimensionTextSourcePosition = false
  if (entity.dimensionType !== 'linear' && entity.dimensionType !== 'aligned' && entity.position) {
    entity.textPositionManual = true
  }
}

/** 生成短随机 ID，prefix 区分实体来源 */
export function genId(prefix = 'e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 点 P 到线段 AB 的最近点及参数 t（用于插点命中检测） */
export function nearestOnSegment(p: Point, a: Point, b: Point): { x: number; y: number; t: number } {
  const apx = p[0] - a[0]
  const apy = p[1] - a[1]
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const ab2 = abx * abx + aby * aby || 1
  let t = (apx * abx + apy * aby) / ab2
  t = clamp(t, 0, 1)
  return { x: a[0] + abx * t, y: a[1] + aby * t, t }
}

/** 点 P 到线段 AB 的距离 */
export function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const r = nearestOnSegment(p, a, b)
  return Math.hypot(p[0] - r.x, p[1] - r.y)
}

/**
 * 判断点是否命中实体。
 * @param p 待检测世界坐标。
 * @param entity 待检测实体。
 * @param tol 世界坐标命中容差。
 * @param drawing 当前图纸；用于解析标注 DIMSTYLE。
 * @returns 是否命中。
 * @author snihao
 */
export function hitEntity(p: Point, entity: Entity, tol: number, drawing?: Drawing): boolean {
  switch (entity.type) {
    case 'line':
      return pointToSegmentDistance(p, entity.start!, entity.end!) <= tol
    case 'polyline': {
      const pts = entity.points!
      const n = pts.length
      const segs = entity.closed ? n : n - 1
      for (let i = 0; i < segs; i++) {
        if (pointToSegmentDistance(p, pts[i], pts[(i + 1) % n]) <= tol) return true
      }
      return false
    }
    case 'circle':
      return Math.abs(distance(p, entity.center!) - entity.radius!) <= tol
    case 'text':
      return hitAnnotationText(p, annotationTextLayout(entity, drawing), tol)
    case 'annotation':
    case 'dimension': {
      const leader = entity.leader || []
      const segments = dimensionSegments(entity)
      if (!segments.length) {
        for (let index = 0; index + 1 < leader.length; index++) segments.push([leader[index], leader[index + 1]])
      }
      if (segments.some(([start, end]) => pointToSegmentDistance(p, start, end) <= tol)) return true
      return hitAnnotationText(p, annotationTextLayout(entity, drawing), tol)
    }
    case 'group': {
      // 命中任一子图元即视为命中组合
      for (const child of entity.children || []) {
        if (hitEntity(p, child, tol, drawing)) return true
      }
      return false
    }
    default:
      return false
  }
}

/**
 * 返回实体的世界坐标包围盒。
 * @param entity 待测量实体。
 * @param drawing 当前图纸；用于解析标注 DIMSTYLE。
 * @returns 世界坐标包围盒。
 * @author snihao
 */
export function entityBounds(entity: Entity, drawing?: Drawing): Bounds {
  switch (entity.type) {
    case 'line':
      return {
        minX: Math.min(entity.start![0], entity.end![0]),
        minY: Math.min(entity.start![1], entity.end![1]),
        maxX: Math.max(entity.start![0], entity.end![0]),
        maxY: Math.max(entity.start![1], entity.end![1]),
      }
    case 'polyline': {
      if (entity.curveGeometry) return curveBounds(entity.curveGeometry)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of entity.points!) {
        if (p[0] < minX) minX = p[0]
        if (p[1] < minY) minY = p[1]
        if (p[0] > maxX) maxX = p[0]
        if (p[1] > maxY) maxY = p[1]
      }
      return { minX, minY, maxX, maxY }
    }
    case 'circle':
      return {
        minX: entity.center![0] - entity.radius!,
        minY: entity.center![1] - entity.radius!,
        maxX: entity.center![0] + entity.radius!,
        maxY: entity.center![1] + entity.radius!,
      }
    case 'text':
      return annotationTextLayout(entity, drawing).bounds
    case 'annotation':
    case 'dimension': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      const dimension = dimensionPoints(entity)
      const segments = dimensionSegments(entity)
      const points = segments.length ? segments.flat() : dimension || entity.leader || []
      for (const p of points) {
        if (p[0] < minX) minX = p[0]
        if (p[1] < minY) minY = p[1]
        if (p[0] > maxX) maxX = p[0]
        if (p[1] > maxY) maxY = p[1]
      }
      const textBounds = annotationTextLayout(entity, drawing).bounds
      minX = Math.min(minX, textBounds.minX)
      minY = Math.min(minY, textBounds.minY)
      maxX = Math.max(maxX, textBounds.maxX)
      maxY = Math.max(maxY, textBounds.maxY)
      return { minX, minY, maxX, maxY }
    }
    case 'group': {
      // 合并所有子图元的包围盒
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const child of entity.children || []) {
        const b = entityBounds(child, drawing)
        if (b.minX < minX) minX = b.minX
        if (b.minY < minY) minY = b.minY
        if (b.maxX > maxX) maxX = b.maxX
        if (b.maxY > maxY) maxY = b.maxY
      }
      if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      return { minX, minY, maxX, maxY }
    }
    default:
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
}

/** 所有实体的总包围盒（用于 fit-to-view） */
export function drawingBounds(drawing: Drawing): Bounds {
  if (!drawing.entities.length) {
    return { minX: 0, minY: 0, maxX: drawing.width, maxY: drawing.height }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const e of drawing.entities) {
    const b = entityBounds(e, drawing)
    if (b.minX < minX) minX = b.minX
    if (b.minY < minY) minY = b.minY
    if (b.maxX > maxX) maxX = b.maxX
    if (b.maxY > maxY) maxY = b.maxY
  }
  return { minX, minY, maxX, maxY }
}

/** 整体平移一个实体 */
export function moveEntity(ent: Entity, dx: number, dy: number): void {
  if (ent.type === 'line') {
    ent.start = [ent.start![0] + dx, ent.start![1] + dy]
    ent.end = [ent.end![0] + dx, ent.end![1] + dy]
  } else if (ent.type === 'polyline') {
    ent.points = ent.points!.map((p) => [p[0] + dx, p[1] + dy])
    if (ent.curveGeometry) translateCurveGeometry(ent.curveGeometry, dx, dy)
  } else if (ent.type === 'circle') {
    ent.center = [ent.center![0] + dx, ent.center![1] + dy]
  } else if (ent.type === 'text') {
    ent.position = [ent.position![0] + dx, ent.position![1] + dy]
  } else if (ent.type === 'annotation') {
    ent.leader = ent.leader!.map((p) => [p[0] + dx, p[1] + dy])
    if (ent.annotationSegments) ent.annotationSegments = ent.annotationSegments.map(([start, end]) => [
      [start[0] + dx, start[1] + dy],
      [end[0] + dx, end[1] + dy],
    ])
    ent.position = [ent.position![0] + dx, ent.position![1] + dy]
  } else if (ent.type === 'dimension') {
    mapDimensionPoints(ent, ([x, y]) => [x + dx, y + dy])
    if (ent.dimensionDisplaySegments) ent.dimensionDisplaySegments = ent.dimensionDisplaySegments.map(([start, end]) => [
      [start[0] + dx, start[1] + dy],
      [end[0] + dx, end[1] + dy],
    ])
  } else if (ent.type === 'group') {
    // 整体平移所有子图元
    for (const child of ent.children || []) moveEntity(child, dx, dy)
  }
}

/**
 * 返回图元包围盒中心。
 * @param ent 待测量实体。
 * @param drawing 当前图纸；用于解析标注 DIMSTYLE。
 * @returns 世界坐标中心点。
 * @author snihao
 */
export function entityCenter(ent: Entity, drawing?: Drawing): Point {
  const bounds = entityBounds(ent, drawing)
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2]
}

/** 判断闭合四点 polyline 是否为矩形（允许整体旋转） */
export function isRectanglePolyline(ent: Entity): boolean {
  if (ent.type !== 'polyline' || !ent.closed || ent.points?.length !== 4) return false
  const points = ent.points
  for (let i = 0; i < 4; i++) {
    const prev = points[(i + 3) % 4]
    const current = points[i]
    const next = points[(i + 1) % 4]
    const ax = prev[0] - current[0]
    const ay = prev[1] - current[1]
    const bx = next[0] - current[0]
    const by = next[1] - current[1]
    const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by)
    if (lengths < 1e-6 || Math.abs(ax * bx + ay * by) / lengths > 0.03) return false
  }
  return true
}

/**
 * 绕指定中心旋转图元，角度使用弧度。
 * @param ent 待旋转的实体。
 * @param angle 旋转角度，单位为弧度。
 * @param center 旋转中心。
 * @returns 无返回值；实体会在原地更新。
 * @author snihao
 */
export function rotateEntity(ent: Entity, angle: number, center: Point): void {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rotatePoint = (point: Point): Point => {
    const dx = point[0] - center[0]
    const dy = point[1] - center[1]
    return [round(center[0] + dx * cos - dy * sin, 9), round(center[1] + dx * sin + dy * cos, 9)]
  }
  if (ent.type === 'line') {
    ent.start = rotatePoint(ent.start!)
    ent.end = rotatePoint(ent.end!)
    ent.rotation = round((ent.rotation || 0) + (angle * 180) / Math.PI, 6)
  } else if (ent.type === 'polyline') {
    ent.points = ent.points!.map(rotatePoint)
    if (ent.curveGeometry) ent.curveGeometry = transformCurveGeometry(ent.curveGeometry, rotatePoint)
    ent.rotation = round((ent.rotation || 0) + (angle * 180) / Math.PI, 6)
  } else if (ent.type === 'circle') {
    ent.center = rotatePoint(ent.center!)
  } else if (ent.type === 'text') {
    ent.position = rotatePoint(ent.position!)
    ent.rotation = round((ent.rotation || 0) + (angle * 180) / Math.PI, 6)
  } else if (ent.type === 'annotation') {
    ent.leader = ent.leader!.map(rotatePoint)
    if (ent.annotationSegments) ent.annotationSegments = ent.annotationSegments.map(([start, end]) => [rotatePoint(start), rotatePoint(end)])
    ent.position = rotatePoint(ent.position!)
    ent.rotation = round((ent.rotation || 0) + (angle * 180) / Math.PI, 6)
  } else if (ent.type === 'dimension') {
    mapDimensionPoints(ent, rotatePoint)
    if (ent.dimensionDisplaySegments) ent.dimensionDisplaySegments = ent.dimensionDisplaySegments.map(([start, end]) => [rotatePoint(start), rotatePoint(end)])
    if (ent.dimensionType === 'linear') ent.dimensionAngle = round((ent.dimensionAngle || 0) + (angle * 180) / Math.PI, 6)
    if (ent.dimensionCenter && ent.dimensionStart) ent.dimensionRadius = round(distance(ent.dimensionCenter, ent.dimensionStart), 9)
  } else if (ent.type === 'group') {
    for (const child of ent.children || []) rotateEntity(child, angle, center)
    ent.rotation = round((ent.rotation || 0) + (angle * 180) / Math.PI, 6)
  }
}

/**
 * 相对指定锚点缩放图元；非等比缩放圆时升级为原生椭圆曲线语义。
 * @param ent 待缩放的实体。
 * @param scaleX X 方向缩放比例。
 * @param scaleY Y 方向缩放比例。
 * @param origin 缩放基点。
 * @returns 无返回值；实体会在原地更新。
 * @author snihao
 */
export function scaleEntity(ent: Entity, scaleX: number, scaleY: number, origin: Point): void {
  const scalePoint = (point: Point): Point => [
    round(origin[0] + (point[0] - origin[0]) * scaleX, 9),
    round(origin[1] + (point[1] - origin[1]) * scaleY, 9),
  ]
  if (ent.type === 'line') {
    ent.start = scalePoint(ent.start!)
    ent.end = scalePoint(ent.end!)
  } else if (ent.type === 'polyline') {
    ent.points = ent.points!.map(scalePoint)
    if (ent.curveGeometry) ent.curveGeometry = transformCurveGeometry(ent.curveGeometry, scalePoint)
  } else if (ent.type === 'circle') {
    const center = scalePoint(ent.center!)
    if (Math.abs(Math.abs(scaleX) - Math.abs(scaleY)) <= 1e-9) {
      ent.center = center
      ent.radius = Math.max(0.1, round(ent.radius! * Math.abs(scaleX), 9))
    } else {
      const radius = Math.max(0.1, ent.radius || 0.1)
      const curve: ParametricCurveGeometry = {
        type: 'ellipse',
        center,
        axisX: [radius * scaleX, 0],
        axisY: [0, radius * scaleY],
        startParameter: 0,
        sweepParameter: Math.PI * 2,
      }
      Object.assign(ent, {
        type: 'polyline',
        points: sampleCurve(curve, 96).slice(0, -1),
        closed: true,
        curveGeometry: curve,
        center: null,
        radius: null,
        rotation: 0,
      })
    }
  } else if (ent.type === 'text') {
    ent.position = scalePoint(ent.position!)
    ent.fontSize = Math.max(1, round((ent.fontSize || 14) * Math.sqrt(Math.abs(scaleX * scaleY))))
  } else if (ent.type === 'annotation') {
    ent.leader = ent.leader!.map(scalePoint)
    if (ent.annotationSegments) ent.annotationSegments = ent.annotationSegments.map(([start, end]) => [scalePoint(start), scalePoint(end)])
    ent.position = scalePoint(ent.position!)
    ent.fontSize = Math.max(1, round((ent.fontSize || 14) * Math.sqrt(Math.abs(scaleX * scaleY))))
  } else if (ent.type === 'dimension') {
    const oldAngle = ((ent.dimensionAngle || 0) * Math.PI) / 180
    mapDimensionPoints(ent, scalePoint)
    if (ent.dimensionDisplaySegments) ent.dimensionDisplaySegments = ent.dimensionDisplaySegments.map(([start, end]) => [scalePoint(start), scalePoint(end)])
    ent.fontSize = Math.max(1, round((ent.fontSize || 14) * Math.sqrt(Math.abs(scaleX * scaleY))))
    if (ent.dimensionType === 'linear') {
      const direction: Point = [scaleX * Math.cos(oldAngle), scaleY * Math.sin(oldAngle)]
      if (Math.hypot(direction[0], direction[1]) > 1e-12) ent.dimensionAngle = round(Math.atan2(direction[1], direction[0]) * 180 / Math.PI, 6)
    }
    if (ent.dimensionCenter && ent.dimensionStart) ent.dimensionRadius = round(distance(ent.dimensionCenter, ent.dimensionStart), 9)
  } else if (ent.type === 'group') {
    for (const child of ent.children || []) scaleEntity(child, scaleX, scaleY, origin)
  }
}

/**
 * 绕任意两点定义的轴镜像实体；文字默认修正为可读方向。
 * @param ent 待镜像的实体。
 * @param axisStart 镜像轴起点。
 * @param axisEnd 镜像轴终点。
 * @param mirrorText 是否保留文字的镜像方向。
 * @returns 无返回值；实体会在原地更新。
 * @author snihao
 */
export function mirrorEntity(ent: Entity, axisStart: Point, axisEnd: Point, mirrorText = false): void {
  const axisX = axisEnd[0] - axisStart[0]
  const axisY = axisEnd[1] - axisStart[1]
  const lengthSquared = axisX * axisX + axisY * axisY
  if (lengthSquared < 1e-12) return
  const axisAngle = Math.atan2(axisY, axisX)
  const reflectPoint = (point: Point): Point => {
    const dx = point[0] - axisStart[0]
    const dy = point[1] - axisStart[1]
    const projection = (dx * axisX + dy * axisY) / lengthSquared
    const onAxisX = axisStart[0] + projection * axisX
    const onAxisY = axisStart[1] + projection * axisY
    return [round(2 * onAxisX - point[0], 9), round(2 * onAxisY - point[1], 9)]
  }
  const reflectedAngle = (angle: number): number => round((2 * axisAngle - angle) * 180 / Math.PI, 6)
  const readableAngle = (angle: number): number => {
    let value = ((angle + 180) % 360 + 360) % 360 - 180
    if (value > 90) value -= 180
    if (value < -90) value += 180
    return round(value, 6)
  }
  const transformPoints = (points: Point[] | null | undefined): void => {
    if (points) {
      for (let index = 0; index < points.length; index++) points[index] = reflectPoint(points[index])
    }
  }
  if (ent.type === 'line') {
    ent.start = reflectPoint(ent.start!)
    ent.end = reflectPoint(ent.end!)
  } else if (ent.type === 'polyline') {
    transformPoints(ent.points)
    if (ent.curveGeometry) {
      ent.curveGeometry = transformCurveGeometry(ent.curveGeometry, reflectPoint)
      ent.curveGeometry.sweepParameter *= -1
    }
  } else if (ent.type === 'circle') {
    ent.center = reflectPoint(ent.center!)
  } else if (ent.type === 'text') {
    ent.position = reflectPoint(ent.position!)
    const angle = reflectedAngle((ent.rotation || 0) * Math.PI / 180)
    ent.rotation = mirrorText ? angle : readableAngle(angle)
  } else if (ent.type === 'annotation') {
    transformPoints(ent.leader)
    if (ent.annotationSegments) {
      for (const segment of ent.annotationSegments) transformPoints(segment)
    }
    if (ent.position) ent.position = reflectPoint(ent.position)
    const angle = reflectedAngle((ent.rotation || 0) * Math.PI / 180)
    ent.rotation = mirrorText ? angle : readableAngle(angle)
  } else if (ent.type === 'dimension') {
    mapDimensionPoints(ent, reflectPoint)
    if (ent.dimensionDisplaySegments) {
      ent.dimensionDisplaySegments = ent.dimensionDisplaySegments.map(([start, end]) => [reflectPoint(start), reflectPoint(end)])
    }
    if (ent.dimensionType === 'linear') ent.dimensionAngle = reflectedAngle((ent.dimensionAngle || 0) * Math.PI / 180)
    if (ent.dimensionCenter && ent.dimensionStart) ent.dimensionRadius = round(distance(ent.dimensionCenter, ent.dimensionStart), 9)
  } else if (ent.type === 'group') {
    for (const child of ent.children || []) mirrorEntity(child, axisStart, axisEnd, mirrorText)
  }
}

/** 保持矩形正交结构，拖动角点并固定对角点 */
function resizeRectangle(ent: Entity, index: number, point: Point): void {
  if (!isRectanglePolyline(ent)) return
  const points = ent.points!
  const oppositeIndex = (index + 2) % 4
  const nextIndex = (oppositeIndex + 1) % 4
  const prevIndex = (oppositeIndex + 3) % 4
  const anchor = points[oppositeIndex]
  const nextVector: Point = [points[nextIndex][0] - anchor[0], points[nextIndex][1] - anchor[1]]
  const prevVector: Point = [points[prevIndex][0] - anchor[0], points[prevIndex][1] - anchor[1]]
  const nextLength = Math.max(Math.hypot(nextVector[0], nextVector[1]), 1e-6)
  const prevLength = Math.max(Math.hypot(prevVector[0], prevVector[1]), 1e-6)
  const nextUnit: Point = [nextVector[0] / nextLength, nextVector[1] / nextLength]
  const prevUnit: Point = [prevVector[0] / prevLength, prevVector[1] / prevLength]
  const target: Point = [point[0] - anchor[0], point[1] - anchor[1]]
  const nextProjection = Math.max(0.1, target[0] * nextUnit[0] + target[1] * nextUnit[1])
  const prevProjection = Math.max(0.1, target[0] * prevUnit[0] + target[1] * prevUnit[1])
  points[nextIndex] = [round(anchor[0] + nextUnit[0] * nextProjection), round(anchor[1] + nextUnit[1] * nextProjection)]
  points[prevIndex] = [round(anchor[0] + prevUnit[0] * prevProjection), round(anchor[1] + prevUnit[1] * prevProjection)]
  points[index] = [
    round(points[nextIndex][0] + points[prevIndex][0] - anchor[0]),
    round(points[nextIndex][1] + points[prevIndex][1] - anchor[1]),
  ]
}

/**
 * 使用包围盒角点缩放组合或其他复合图元。
 * @param ent 待缩放实体。
 * @param index 当前角点索引。
 * @param point 目标角点。
 * @param drawing 当前图纸；用于解析标注 DIMSTYLE。
 * @returns 无返回值；实体会原地更新。
 * @author snihao
 */
function resizeFromBounds(ent: Entity, index: number, point: Point, drawing?: Drawing): void {
  const bounds = entityBounds(ent, drawing)
  const corners: Point[] = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ]
  const handle = corners[index]
  const anchor = corners[(index + 2) % 4]
  const width = handle[0] - anchor[0]
  const height = handle[1] - anchor[1]
  if (Math.abs(width) < 1e-6 || Math.abs(height) < 1e-6) return
  const scaleX = Math.max(0.02, (point[0] - anchor[0]) / width)
  const scaleY = Math.max(0.02, (point[1] - anchor[1]) / height)
  scaleEntity(ent, scaleX, scaleY, anchor)
}

/**
 * 拖拽单个手柄：根据类型与 role 修改对应几何。
 * @param ent 被编辑的实体。
 * @param index 手柄或顶点索引。
 * @param role 手柄角色，例如 move、resize 或 vertex。
 * @param pt 当前鼠标世界坐标。
 * @param snapTolerance 正交捕捉容差。
 * @param drawing 当前图纸；用于解析标注 DIMSTYLE 包围盒。
 * @returns 无返回值；实体会在原地更新。
 * @author snihao
 */
export function moveHandle(
  ent: Entity,
  index: number,
  role: string,
  pt: { x: number; y: number },
  snapTolerance = 0,
  drawing?: Drawing,
): void {
  let x = round(pt.x, 6)
  let y = round(pt.y, 6)
  if (role === 'move') {
    const center = entityCenter(ent, drawing)
    moveEntity(ent, x - center[0], y - center[1])
    return
  }
  if (role === 'resize') {
    if (isRectanglePolyline(ent)) resizeRectangle(ent, index, [x, y])
    else resizeFromBounds(ent, index, [x, y], drawing)
    return
  }
  if (ent.type === 'line') {
    const anchor = index === 0 ? ent.end! : ent.start!
    ;[x, y] = snapOrthogonal(anchor, [x, y], snapTolerance)
    if (index === 0) ent.start = [x, y]
    else ent.end = [x, y]
  } else if (ent.type === 'polyline') {
    if (role === 'vertex') ent.curveGeometry = null
    const points = ent.points!
    const previous = points[index - 1]
    const next = points[index + 1]
    if (previous) [x, y] = snapOrthogonal(previous, [x, y], snapTolerance)
    if (next) [x, y] = snapOrthogonal(next, [x, y], snapTolerance)
    ent.points![index] = [x, y]
  } else if (ent.type === 'circle') {
    if (role === 'radius') {
      ent.radius = Math.max(0.1, round(distance(ent.center!, [x, y]), 6))
    } else {
      ent.center = [x, y]
    }
  } else if (ent.type === 'text') {
    ent.position = [x, y]
  } else if (ent.type === 'annotation') {
    if (index < ent.leader!.length) ent.leader![index] = [x, y]
    else {
      ent.position = [x, y]
      ent.textPositionManual = true
    }
  } else if (ent.type === 'dimension') {
    const previousPoints = dimensionPoints(ent)
    const previousTextPosition = ent.position?.slice() as Point | undefined
    if (role === 'position' || index === 4) {
      ent.position = [x, y]
      ent.textPositionManual = true
      ent.dimensionTextSourcePosition = false
      return
    }
    // 修改定义点后，源匿名块线段已不再对应当前参数化尺寸。
    ent.dimensionDisplaySegments = null
    releaseDimensionSourceTextPosition(ent)
    if ((ent.dimensionType === 'angular' || ent.dimensionType === 'arcLength')
      && index === 2 && ent.dimensionCenter) {
      const dx = x - ent.dimensionCenter[0]
      const dy = y - ent.dimensionCenter[1]
      mapDimensionPoints(ent, ([pointX, pointY]) => [round(pointX + dx, 9), round(pointY + dy, 9)])
    } else if (ent.dimensionType === 'radius') {
      if (index === 1 && ent.dimensionCenter && ent.dimensionStart) {
        const center = ent.dimensionCenter
        const previous = ent.dimensionStart
        const radius = Math.max(ent.dimensionRadius || distance(center, previous), 1e-6)
        const next = pointOnStoredCircle(center, radius, [x, y], previous)
        ent.dimensionStart = next
        ent.dimensionLinePosition = next.slice() as Point
        rotateManualDimensionText(ent, center, previous, next)
      }
    } else if (ent.dimensionType === 'diameter') {
      const center = ent.dimensionCenter
      const start = ent.dimensionStart
      const end = ent.dimensionEnd
      if ((index === 0 || index === 1) && center && start && end) {
        const previous = index === 0 ? start : end
        const radius = Math.max(ent.dimensionRadius || distance(center, start), 1e-6)
        const next = pointOnStoredCircle(center, radius, [x, y], previous)
        const opposite: Point = [round(center[0] * 2 - next[0], 9), round(center[1] * 2 - next[1], 9)]
        if (index === 0) {
          ent.dimensionStart = next
          ent.dimensionEnd = opposite
        } else {
          ent.dimensionEnd = next
          ent.dimensionStart = opposite
        }
        ent.dimensionLinePosition = ent.dimensionStart.slice() as Point
        rotateManualDimensionText(ent, center, previous, next)
      }
    } else if (ent.dimensionType === 'ordinate') {
      if (index === 0) ent.dimensionStart = [x, y]
      else if (index === 1) {
        ent.dimensionEnd = [x, y]
        ent.dimensionOffset = [x, y]
      } else if (index === 2) ent.dimensionOrigin = [x, y]
    } else if (ent.dimensionType === 'angular' || ent.dimensionType === 'arcLength') {
      const target = ent.dimensionType === 'arcLength' && ent.dimensionCenter && ent.dimensionStart
        ? pointOnStoredCircle(ent.dimensionCenter, ent.dimensionRadius || distance(ent.dimensionCenter, ent.dimensionStart), [x, y], index === 1 ? ent.dimensionEnd || ent.dimensionStart : ent.dimensionStart)
        : [x, y] as Point
      if (index === 0) ent.dimensionStart = target
      else if (index === 1) ent.dimensionEnd = target
      else if (index === 3) ent.dimensionLinePosition = [x, y]
    } else if (index === 0) {
      ent.dimensionStart = [x, y]
    } else if (index === 1) {
      ent.dimensionEnd = [x, y]
    } else if (index === 2 || index === 3) {
      moveLinearDimensionLine(ent, index, [x, y])
    }
    if (ent.dimensionType === 'angular' && ent.dimensionCenter && ent.dimensionLinePosition) {
      ent.dimensionRadius = round(distance(ent.dimensionCenter, ent.dimensionLinePosition), 9)
    } else if (ent.dimensionType === 'arcLength' && ent.dimensionCenter && ent.dimensionStart) {
      ent.dimensionRadius = round(distance(ent.dimensionCenter, ent.dimensionStart), 9)
    } else if (ent.dimensionCenter && ent.dimensionStart) {
      ent.dimensionRadius = round(distance(ent.dimensionCenter, ent.dimensionStart), 9)
    }
    const nextPoints = dimensionPoints(ent)
    const centerMoved = (ent.dimensionType === 'angular' || ent.dimensionType === 'arcLength') && index === 2
    if (!centerMoved && previousPoints && nextPoints && previousTextPosition) {
      syncManualDimensionTextFrame(ent, previousPoints, nextPoints, previousTextPosition)
    }
    syncDimensionMeasurementText(ent)
  }
}

/**
 * 拖动标注时只调整尺寸线或文字位置，保留测量定义点与来源关联。
 * @param entity 待移动的尺寸标注。
 * @param dx 水平位移。
 * @param dy 垂直位移。
 * @param drawing 当前图纸，用于计算自动文字位置。
 */
export function moveDimensionPlacement(entity: Entity, dx: number, dy: number, drawing?: Drawing): void {
  if (!isDimensionEntity(entity)) return
  const points = dimensionPoints(entity)
  if (!points) return
  if (entity.type === 'annotation') {
    const start = points[0], end = points[1]
    const length = distance(start, end)
    if (length < 1e-9) return
    const nx = -(end[1] - start[1]) / length
    const ny = (end[0] - start[0]) / length
    const offset = dx * nx + dy * ny
    entity.leader![2] = [points[2][0] + nx * offset, points[2][1] + ny * offset]
    entity.leader![3] = [points[3][0] + nx * offset, points[3][1] + ny * offset]
    if (entity.position) entity.position = [entity.position[0] + nx * offset, entity.position[1] + ny * offset]
    return
  }
  if (entity.dimensionType === 'radius' || entity.dimensionType === 'diameter') {
    const position = annotationTextPosition(entity, undefined, drawing)
    moveHandle(entity, 4, 'position', { x: position[0] + dx, y: position[1] + dy }, 0, drawing)
  } else if (entity.dimensionType === 'linear' || entity.dimensionType === 'aligned') {
    moveHandle(entity, 2, 'leader', { x: points[2][0] + dx, y: points[2][1] + dy }, 0, drawing)
  } else if (entity.dimensionType === 'angular' || entity.dimensionType === 'arcLength') {
    moveHandle(entity, 3, 'leader', { x: points[3][0] + dx, y: points[3][1] + dy }, 0, drawing)
  } else if (entity.dimensionType === 'ordinate' && entity.dimensionEnd) {
    moveHandle(entity, 1, 'leader', { x: entity.dimensionEnd[0] + dx, y: entity.dimensionEnd[1] + dy }, 0, drawing)
  }
}

/**
 * 按尺寸线法向移动线性标注，忽略鼠标沿尺寸线方向的无效位移。
 * @param entity 线性或对齐标注。
 * @param index 当前拖动的尺寸线端点索引。
 * @param target 鼠标目标点。
 * @returns 无返回值；尺寸线放置点会原地更新。
 * @author snihao
 */
function moveLinearDimensionLine(entity: Entity, index: number, target: Point): void {
  const start = entity.dimensionStart
  const end = entity.dimensionEnd
  if (!start || !end) return
  let ux: number
  let uy: number
  if (entity.dimensionType === 'linear') {
    const angle = (entity.dimensionAngle || 0) * Math.PI / 180
    ux = Math.cos(angle)
    uy = Math.sin(angle)
  } else {
    const length = Math.hypot(end[0] - start[0], end[1] - start[1])
    if (length < 1e-9) return
    ux = (end[0] - start[0]) / length
    uy = (end[1] - start[1]) / length
  }
  const nx = -uy
  const ny = ux
  const base = index === 3 ? end : start
  const offset = (target[0] - base[0]) * nx + (target[1] - base[1]) * ny
  entity.dimensionLinePosition = [
    round(start[0] + nx * offset, 9),
    round(start[1] + ny * offset, 9),
  ]
}

/** 标注文字随参数化尺寸线变化时使用的局部坐标系。 @author snihao */
interface DimensionTextFrame {
  /** 文字跟随的几何锚点。 */
  origin: Point
  /** 局部 X 轴方向角，单位为弧度。 */
  angle: number
}

/**
 * 让手动文字在尺寸几何变化后保留相对尺寸线的位置。
 * @param entity 当前标注实体。
 * @param previousPoints 修改前的四个参数点。
 * @param nextPoints 修改后的四个参数点。
 * @param previousPosition 修改前文字位置。
 * @returns 无返回值；文字位置会原地更新。
 * @author snihao
 */
function syncManualDimensionTextFrame(
  entity: Entity,
  previousPoints: [Point, Point, Point, Point],
  nextPoints: [Point, Point, Point, Point],
  previousPosition: Point,
): void {
  if (!entity.textPositionManual || entity.dimensionType === 'radius' || entity.dimensionType === 'diameter') return
  const previousFrame = dimensionTextFrame(entity.dimensionType, previousPoints)
  const nextFrame = dimensionTextFrame(entity.dimensionType, nextPoints)
  const angle = nextFrame.angle - previousFrame.angle
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = previousPosition[0] - previousFrame.origin[0]
  const dy = previousPosition[1] - previousFrame.origin[1]
  entity.position = [
    round(nextFrame.origin[0] + dx * cos - dy * sin, 9),
    round(nextFrame.origin[1] + dx * sin + dy * cos, 9),
  ]
}

/**
 * 计算线性尺寸线中点或角度尺寸弧中点坐标系。
 * @param type 标注类型。
 * @param points 标注四参数点。
 * @returns 文字跟随坐标系。
 * @author snihao
 */
function dimensionTextFrame(type: DimensionType | null | undefined, points: [Point, Point, Point, Point]): DimensionTextFrame {
  if (type === 'angular' || type === 'arcLength') {
    const [start, end, center, linePoint] = points
    const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0])
    const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0])
    const sweep = positiveAngle(endAngle - startAngle) || Math.PI * 2
    const angle = startAngle + sweep / 2
    const radius = Math.max(distance(center, linePoint), 1e-6)
    return {
      origin: [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius],
      angle: angle + Math.PI / 2,
    }
  }
  const start = points[2]
  const end = points[3]
  return {
    origin: midpoint(start, end),
    angle: Math.atan2(end[1] - start[1], end[0] - start[0]),
  }
}

/**
 * 把拖拽点限制到标注保存的圆周上。
 * @param center 标注圆心。
 * @param radius 标注保存的圆半径。
 * @param target 当前拖拽点。
 * @param fallback 拖拽点与圆心重合时使用的方向参考点。
 * @returns 圆周上的约束点。
 * @author snihao
 */
function pointOnStoredCircle(center: Point, radius: number, target: Point, fallback: Point): Point {
  let dx = target[0] - center[0]
  let dy = target[1] - center[1]
  let length = Math.hypot(dx, dy)
  if (length < 1e-9) {
    dx = fallback[0] - center[0]
    dy = fallback[1] - center[1]
    length = Math.max(Math.hypot(dx, dy), 1e-9)
  }
  return [round(center[0] + dx / length * radius, 9), round(center[1] + dy / length * radius, 9)]
}

/**
 * 箭头沿圆周转动时，让手动放置的文字保持相同的圆心相对位置。
 * @param entity 待更新的标注实体。
 * @param center 标注圆心。
 * @param previous 拖动前的箭头位置。
 * @param next 拖动后的箭头位置。
 * @returns 无返回值。
 * @author snihao
 */
function rotateManualDimensionText(entity: Entity, center: Point, previous: Point, next: Point): void {
  if (!entity.position || !entity.textPositionManual) return
  const previousAngle = Math.atan2(previous[1] - center[1], previous[0] - center[0])
  const nextAngle = Math.atan2(next[1] - center[1], next[0] - center[0])
  const angle = nextAngle - previousAngle
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = entity.position[0] - center[0]
  const dy = entity.position[1] - center[1]
  entity.position = [
    round(center[0] + dx * cos - dy * sin, 9),
    round(center[1] + dx * sin + dy * cos, 9),
  ]
}
