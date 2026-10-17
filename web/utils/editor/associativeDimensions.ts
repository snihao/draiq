import {
  dimensionPoints,
  distance,
  isDimensionEntity,
  releaseDimensionSourceTextPosition,
  round,
  syncDimensionMeasurementText,
} from '#draiq/utils/editor/geometry'
import {
  circleCurveGeometry,
  curveCircle,
  curveCurveIntersections,
  curvePoint,
  curveStartPoint,
  segmentCurveIntersections,
} from '#draiq/utils/editor/curveGeometry'
import { segmentIntersection } from '#draiq/utils/editor/snapping/index'
import type { SnapCandidate } from '#draiq/utils/editor/snapping/index'

type ReferencePrimitive =
  | { type: 'segment'; start: Point; end: Point }
  | { type: 'circle'; center: Point; radius: number }
  | { type: 'curve'; curve: ParametricCurveGeometry }

type AssociationResolution =
  | { type: 'point'; point: Point }
  | { type: 'segment'; start: Point; end: Point }
  | { type: 'circle'; center: Point; radius: number }
  | { type: 'curve'; curve: ParametricCurveGeometry }

/**
 * 将已解析的对象捕捉候选转换为可持久化的图纸关联引用。
 * @param candidate 对象捕捉候选，极坐标和正交捕捉不会创建关联。
 * @param fallback 候选点的回退坐标。
 * @returns 可持久化的关联引用，无法关联时返回 null。
 * @author snihao
 */
export function pointReferenceFromCandidate(candidate: SnapCandidate | null, fallback: Point): PointReference | null {
  if (!candidate?.entityId || candidate.kind === 'polar' || candidate.kind === 'orthogonal') return null
  return {
    kind: candidate.kind,
    entityId: candidate.entityId,
    segmentIndex: candidate.segmentIndex,
    t: candidate.t,
    relatedEntityId: candidate.relatedEntityId || null,
    relatedSegmentIndex: candidate.relatedSegmentIndex ?? null,
    fallback: fallback.slice() as Point,
  }
}

/**
 * 在当前图纸中解析一个关联引用；源实体不可用时返回回退坐标。
 * @param reference 待解析的关联引用。
 * @param drawing 当前图纸。
 * @returns 解析后的世界坐标点。
 * @author snihao
 */
export function resolvePointReference(reference: PointReference, drawing: Drawing): Point {
  const entities = entityMap(drawing)
  return resolveWithLookup(reference, (id) => entities.get(id) || null)
}

/**
 * 重新计算所有关联标注端点，同时保留尺寸线的有符号偏移和方向。
 * @param drawing 当前图纸。
 * @returns 图纸是否发生了关联几何或文字变化。
 * @author snihao
 */
export function syncAssociativeDimensions(drawing: Drawing): boolean {
  const entities = entityMap(drawing)
  const annotations = Array.from(entities.values()).filter((entity) => isDimensionEntity(entity))
  let changed = false

  for (const annotation of annotations) {
    if (annotation.dimensionAssociations?.length) {
      if (syncDimensionAssociations(annotation, entities)) changed = true
    }
    const hasGenericRadialSource = annotation.dimensionAssociations?.some((association) => (
      (association.role === 'center' || association.role === 'curve')
      && (association.source.kind === 'circle' || association.source.kind === 'curve')
    )) === true
    if (annotation.type === 'dimension' && annotation.dimensionSource?.kind === 'circle' && !hasGenericRadialSource) {
      if (syncCircularDimension(annotation, entities)) changed = true
      continue
    }
    const genericPointReferences = pointReferencesFromAssociations(annotation)
    const legacyReferences = annotation.dimensionRefs
    const references: [PointReference | null, PointReference | null] = [
      legacyReferences?.[0] || genericPointReferences[0] || null,
      legacyReferences?.[1] || genericPointReferences[1] || null,
    ]
    const points = dimensionPoints(annotation)
    if (!references || !points || (!references[0] && !references[1])) continue

    const oldStart = points[0].slice() as Point
    const oldEnd = points[1].slice() as Point
    const oldDimStart = points[2].slice() as Point
    const oldDimEnd = points[3].slice() as Point
    let nextStart = oldStart
    let nextEnd = oldEnd
    let hasValidReference = false
    if (references[0]) {
      const resolved = resolvePointReferenceStrict(references[0], (id) => entities.get(id) || null)
      if (resolved) {
        nextStart = resolved
        hasValidReference = true
      } else {
        if (detachPointReference(annotation, 0, references[0])) changed = true
        references[0] = null
      }
    }
    if (references[1]) {
      const resolved = resolvePointReferenceStrict(references[1], (id) => entities.get(id) || null)
      if (resolved) {
        nextEnd = resolved
        hasValidReference = true
      } else {
        if (detachPointReference(annotation, 1, references[1])) changed = true
        references[1] = null
      }
    }
    if (!hasValidReference) continue
    const measuredLength = distance(nextStart, nextEnd)
    if (measuredLength < 1e-9) continue

    let nextDimStart: Point
    let nextDimEnd: Point
    if (annotation.type === 'dimension' && annotation.dimensionType === 'linear') {
      // 线性标注拥有独立的尺寸线方向；源实体变化时保留该方向，避免
      // 意外退化为对齐标注。
      const angle = ((annotation.dimensionAngle || 0) * Math.PI) / 180
      const ux = Math.cos(angle)
      const uy = Math.sin(angle)
      const nx = -uy
      const ny = ux
      const offset = (oldDimStart[0] - oldStart[0]) * nx + (oldDimStart[1] - oldStart[1]) * ny
      nextDimStart = [precise(nextStart[0] + nx * offset), precise(nextStart[1] + ny * offset)]
      const along = (nextEnd[0] - nextStart[0]) * ux + (nextEnd[1] - nextStart[1]) * uy
      nextDimEnd = [precise(nextDimStart[0] + ux * along), precise(nextDimStart[1] + uy * along)]
    } else {
      const offset = signedOffset(oldStart, oldEnd, oldDimStart)
      const dx = nextEnd[0] - nextStart[0]
      const dy = nextEnd[1] - nextStart[1]
      const nx = -dy / measuredLength
      const ny = dx / measuredLength
      nextDimStart = [precise(nextStart[0] + nx * offset), precise(nextStart[1] + ny * offset)]
      nextDimEnd = [precise(nextEnd[0] + nx * offset), precise(nextEnd[1] + ny * offset)]
    }
    const geometryChanged = !samePoint(oldStart, nextStart)
      || !samePoint(oldEnd, nextEnd)
      || !samePoint(oldDimStart, nextDimStart)
      || !samePoint(oldDimEnd, nextDimEnd)

    if (geometryChanged) {
      if (annotation.type === 'dimension') {
        annotation.dimensionStart = nextStart.slice() as Point
        annotation.dimensionEnd = nextEnd.slice() as Point
        annotation.dimensionLinePosition = nextDimStart.slice() as Point
        // 导入源块的显示线段属于旧定义；关联端点跟随源实体后，
        // 从可编辑标注模型重新生成显示几何。
        annotation.dimensionDisplaySegments = null
        releaseDimensionSourceTextPosition(annotation)
      } else {
        annotation.leader![0] = nextStart.slice() as Point
        annotation.leader![1] = nextEnd.slice() as Point
        annotation.leader![2] = nextDimStart
        annotation.leader![3] = nextDimEnd
      }
      const oldMidpoint = midpoint(oldDimStart, oldDimEnd)
      const nextMidpoint = midpoint(nextDimStart, nextDimEnd)
      if (annotation.position && annotation.textPositionManual) {
        annotation.position = [
          precise(annotation.position[0] + nextMidpoint[0] - oldMidpoint[0]),
          precise(annotation.position[1] + nextMidpoint[1] - oldMidpoint[1]),
        ]
      } else {
        annotation.position = nextMidpoint
      }
      changed = true
    }

    if (annotation.type === 'dimension') {
      // 原生线性标注测量的是沿 dimensionAngle 方向的投影，
      // 而非两个来源捕捉点之间的距离，后者可能为斜向距离。
      if (syncDimensionMeasurementText(annotation)) changed = true
    } else if (!annotation.dimensionTextManual) {
      const nextText = `${round(measuredLength)}`
      if (annotation.text !== nextText) {
        annotation.text = nextText
        changed = true
      }
    }

    for (let index = 0; index < 2; index++) {
      const reference = references[index]
      if (!reference) continue
      const fallback = index === 0 ? nextStart : nextEnd
      if (!samePoint(reference.fallback, fallback)) {
        reference.fallback = fallback.slice() as Point
        changed = true
      }
    }
  }

  return changed
}

/**
 * 同步新协议中的通用标注来源引用。
 *
 * `dimensionRefs`/`dimensionSource` 是历史格式，角度、曲线来源则使用
 * `dimensionAssociations`。来源一旦失效会从关联列表中移除，保留当前
 * 标注几何作为静态结果，避免悄悄退回到旧的 fallback 坐标。
 * @param annotation 待同步的标注实体。
 * @param entities 当前图纸实体索引。
 * @returns 是否修改了标注或关联元数据。
 * @author snihao
 */
function syncDimensionAssociations(annotation: Entity, entities: Map<string, Entity>): boolean {
  const associations = annotation.dimensionAssociations
  if (!associations?.length) return false

  const valid: DimensionAssociation[] = []
  const resolved = new Map<DimensionAssociation, AssociationResolution>()
  let changed = false

  for (const association of associations) {
    const resolution = resolveDimensionAssociation(association, entities)
    if (!resolution || !isAssociationCompatible(annotation, association, resolution)) {
      const sourceId = associationSourceEntityId(association)
      if (sourceId && annotation.dimensionSource?.entityId === sourceId) {
        annotation.dimensionSource = null
      }
      changed = true
      continue
    }
    if (updateAssociationFallback(association, resolution)) changed = true
    valid.push(association)
    resolved.set(association, resolution)
  }

  if (valid.length !== associations.length) {
    annotation.dimensionAssociations = valid.length ? valid : null
  }
  if (!valid.length) return changed

  if (annotation.type !== 'dimension') return changed
  if (annotation.dimensionType === 'angular') {
    const first = findAssociation(valid, resolved, 'line1')
    const second = findAssociation(valid, resolved, 'line2')
    if (first?.type === 'segment' && second?.type === 'segment') {
      if (syncAngularAssociation(annotation, first, second)) changed = true
    }
  } else if (annotation.dimensionType === 'radius' || annotation.dimensionType === 'diameter') {
    const source = valid.find((association) => association.role === 'center' || association.role === 'curve')
    const resolution = source ? resolved.get(source) : undefined
    if (source && resolution) {
      if (syncRadialAssociation(annotation, resolution)) changed = true
    }
  } else if (annotation.dimensionType === 'arcLength') {
    const source = valid.find((association) => association.role === 'curve')
    const resolution = source ? resolved.get(source) : undefined
    if (source && resolution?.type === 'curve') {
      if (syncArcLengthAssociation(annotation, resolution.curve, source)) changed = true
    }
  }
  return changed
}

/** 解析通用关联，不将回退坐标作为实时来源。 */
function resolveDimensionAssociation(
  association: DimensionAssociation,
  entities: Map<string, Entity>,
): AssociationResolution | null {
  if (!association || !association.source) return null
  const source = association.source
  if (source.kind === 'point') {
    const point = resolvePointReferenceStrict(source.ref, (id) => entities.get(id) || null)
    return point ? { type: 'point', point } : null
  }
  const entity = entities.get(source.entityId)
  if (!entity) return null

  if (source.kind === 'segment') {
    if (!Number.isInteger(source.segmentIndex) || source.segmentIndex < 0) return null
    const primitive = primitiveFor(entity, source.segmentIndex)
    if (!primitive || primitive.type !== 'segment' || distance(primitive.start, primitive.end) < 1e-9) return null
    return { type: 'segment', start: primitive.start.slice() as Point, end: primitive.end.slice() as Point }
  }
  if (source.kind === 'circle') {
    const radius = entity.radius
    if (entity.type !== 'circle' || !entity.center || radius == null || !Number.isFinite(radius) || radius <= 1e-9) return null
    return { type: 'circle', center: entity.center.slice() as Point, radius }
  }
  if (entity.type !== 'polyline' || !entity.curveGeometry) return null
  const curve = entity.curveGeometry
  if (!Number.isFinite(curve.startParameter)
    || !Number.isFinite(curve.sweepParameter)
    || Math.abs(curve.sweepParameter) < 1e-9) return null
  return { type: 'curve', curve }
}

/** 检查解析后的来源能否驱动所属尺寸类型。 */
function isAssociationCompatible(
  annotation: Entity,
  association: DimensionAssociation,
  resolution: AssociationResolution,
): boolean {
  if (annotation.type !== 'dimension') return true
  if (annotation.dimensionType === 'angular' && (association.role === 'line1' || association.role === 'line2')) {
    return resolution.type === 'segment'
  }
  if ((annotation.dimensionType === 'radius' || annotation.dimensionType === 'diameter')
    && (association.role === 'center' || association.role === 'curve')) {
    if (association.source.kind === 'circle') return resolution.type === 'circle'
    if (association.source.kind !== 'curve' || resolution.type !== 'curve') return false
    const circle = curveCircle(resolution.curve)
    return !!circle && circle.radius > 1e-9
  }
  if (annotation.dimensionType === 'arcLength' && association.role === 'curve') {
    if (resolution.type !== 'curve' || association.source.kind !== 'curve') return false
    return !!arcLengthGeometry(resolution.curve, association.source.parameterRange)
  }
  return true
}

/** 通用来源仍有效时更新存档回退值。 */
function updateAssociationFallback(
  association: DimensionAssociation,
  resolution: AssociationResolution,
): boolean {
  if (association.source.kind === 'segment' && resolution.type === 'segment') {
    const nextFallback: [Point, Point] = [resolution.start.slice() as Point, resolution.end.slice() as Point]
    const previous = association.source.fallback
    if (!samePoint(previous[0], nextFallback[0]) || !samePoint(previous[1], nextFallback[1])) {
      association.source.fallback = nextFallback
      return true
    }
  }
  if (association.source.kind === 'circle' && resolution.type === 'circle') {
    const nextCenter = resolution.center
    if (!samePoint(association.source.fallbackCenter, nextCenter)
      || Math.abs(association.source.fallbackRadius - resolution.radius) > 1e-9) {
      association.source.fallbackCenter = nextCenter.slice() as Point
      association.source.fallbackRadius = resolution.radius
      return true
    }
  }
  return false
}

/** 按语义角色查找已解析的关联。 */
function findAssociation(
  associations: DimensionAssociation[],
  resolved: Map<DimensionAssociation, AssociationResolution>,
  role: DimensionAssociation['role'],
): AssociationResolution | null {
  const association = associations.find((item) => item.role === role)
  if (!association) return null
  return resolved.get(association) || null
}

/** 返回通用关联列表中保存的点引用。 */
function pointReferencesFromAssociations(annotation: Entity): [PointReference | null, PointReference | null] {
  const result: [PointReference | null, PointReference | null] = [null, null]
  for (const association of annotation.dimensionAssociations || []) {
    if (association.source.kind !== 'point') continue
    if (association.role === 'start') result[0] = association.source.ref
    else if (association.role === 'end') result[1] = association.source.ref
  }
  return result
}

/** 根据两条持久化来源线段同步角度标注。 */
function syncAngularAssociation(
  annotation: Entity,
  first: AssociationResolution,
  second: AssociationResolution,
): boolean {
  if (annotation.type !== 'dimension' || first.type !== 'segment' || second.type !== 'segment') return false
  const center = infiniteLineIntersection(first.start, first.end, second.start, second.end)
  if (!center) {
    return removeDimensionAssociations(annotation, (association) => association.role === 'line1' || association.role === 'line2')
  }

  const oldCenter = annotation.dimensionCenter?.slice() as Point | undefined
  const oldLinePosition = annotation.dimensionLinePosition?.slice() as Point | undefined
  const previousCenter = oldCenter || center
  const previousLinePosition = oldLinePosition || annotation.position?.slice() as Point | undefined || [
    previousCenter[0] + Math.max(annotation.dimensionRadius || 1, 1),
    previousCenter[1],
  ]
  const centerDelta: Point = [center[0] - previousCenter[0], center[1] - previousCenter[1]]
  let linePosition: Point = [
    previousLinePosition[0] + centerDelta[0],
    previousLinePosition[1] + centerDelta[1],
  ]
  let radius = distance(center, linePosition)
  if (radius < 1e-9) {
    const direction = radialDirection(previousCenter, annotation.dimensionStart || previousLinePosition, previousLinePosition)
    radius = Math.max(annotation.dimensionRadius || 1, 1e-9)
    linePosition = [center[0] + direction[0] * radius, center[1] + direction[1] * radius]
  }
  const rays = angularRaysFromSegments(first, second, center, linePosition, radius)
  if (!rays) {
    return removeDimensionAssociations(annotation, (association) => association.role === 'line1' || association.role === 'line2')
  }

  const previousStart = annotation.dimensionStart
  const previousEnd = annotation.dimensionEnd
  const geometryChanged = !oldCenter || !samePoint(previousCenter, center)
    || !previousStart || !samePoint(previousStart, rays.start)
    || !previousEnd || !samePoint(previousEnd, rays.end)
    || !oldLinePosition || !samePoint(oldLinePosition, linePosition)
    || annotation.dimensionRadius !== round(radius, 9)
  if (!geometryChanged) return syncDimensionMeasurementText(annotation)

  annotation.dimensionCenter = center.slice() as Point
  annotation.dimensionStart = rays.start
  annotation.dimensionEnd = rays.end
  annotation.dimensionAngularLine1Start = center.slice() as Point
  annotation.dimensionAngularLine2Start = center.slice() as Point
  annotation.dimensionLinePosition = linePosition
  annotation.dimensionRadius = round(radius, 9)
  annotation.dimensionDisplaySegments = null
  releaseDimensionSourceTextPosition(annotation)
  if (annotation.position) {
    if (annotation.textPositionManual) {
      annotation.position = [
        precise(annotation.position[0] + linePosition[0] - previousLinePosition[0]),
        precise(annotation.position[1] + linePosition[1] - previousLinePosition[1]),
      ]
    } else {
      annotation.position = midpoint(center, linePosition)
    }
  }
  const textChanged = syncDimensionMeasurementText(annotation)
  return geometryChanged || textChanged
}

/** 根据圆或圆弧同步半径或直径标注。 */
function syncRadialAssociation(annotation: Entity, resolution: AssociationResolution): boolean {
  if (resolution.type === 'circle') return syncRadialGeometry(annotation, resolution.center, resolution.radius)
  if (resolution.type === 'curve') {
    const circle = curveCircle(resolution.curve)
    if (!circle) return false
    return syncRadialGeometry(annotation, circle.center, circle.radius)
  }
  return false
}

/** 根据精确参数曲线同步弧长标注。 */
function syncArcLengthAssociation(
  annotation: Entity,
  curve: ParametricCurveGeometry,
  association: DimensionAssociation,
): boolean {
  if (annotation.type !== 'dimension') return false
  const geometry = arcLengthGeometry(
    curve,
    association.source.kind === 'curve' ? association.source.parameterRange : undefined,
  )
  if (!geometry) return false
  const oldCenter = annotation.dimensionCenter?.slice() as Point | undefined
  const previousCenter = oldCenter || geometry.center
  const previousLinePosition = annotation.dimensionLinePosition?.slice() as Point | undefined
    || annotation.position?.slice() as Point | undefined
    || geometry.start
  const centerDelta: Point = [geometry.center[0] - previousCenter[0], geometry.center[1] - previousCenter[1]]
  const linePosition: Point = [
    previousLinePosition[0] + centerDelta[0],
    previousLinePosition[1] + centerDelta[1],
  ]
  const geometryChanged = !oldCenter || !samePoint(previousCenter, geometry.center)
    || !annotation.dimensionStart || !samePoint(annotation.dimensionStart, geometry.start)
    || !annotation.dimensionEnd || !samePoint(annotation.dimensionEnd, geometry.end)
    || !annotation.dimensionLinePosition || !samePoint(annotation.dimensionLinePosition, linePosition)
    || annotation.dimensionRadius !== round(geometry.radius, 9)
  if (!geometryChanged) return syncDimensionMeasurementText(annotation)

  annotation.dimensionCenter = geometry.center.slice() as Point
  annotation.dimensionStart = geometry.start
  annotation.dimensionEnd = geometry.end
  annotation.dimensionRadius = round(geometry.radius, 9)
  annotation.dimensionLinePosition = linePosition
  annotation.dimensionDisplaySegments = null
  releaseDimensionSourceTextPosition(annotation)
  if (annotation.position) {
    if (annotation.textPositionManual) {
      annotation.position = [
        precise(annotation.position[0] + linePosition[0] - previousLinePosition[0]),
        precise(annotation.position[1] + linePosition[1] - previousLinePosition[1]),
      ]
    } else {
      annotation.position = midpoint(geometry.center, linePosition)
    }
  }
  const textChanged = syncDimensionMeasurementText(annotation)
  return geometryChanged || textChanged
}

/** 计算两条来源线段所表示的、供用户查看的正角度。 */
function angularRaysFromSegments(
  first: AssociationResolution,
  second: AssociationResolution,
  center: Point,
  location: Point,
  radius: number,
): { start: Point; end: Point; sweep: number } | null {
  if (first.type !== 'segment' || second.type !== 'segment') return null
  const target: Point = [location[0] - center[0], location[1] - center[1]]
  let firstDirection = orientedSegmentDirection(first, center, target)
  let secondDirection = orientedSegmentDirection(second, center, target)
  if (!firstDirection || !secondDirection) return null
  let sweep = positiveAngle(Math.atan2(secondDirection[1], secondDirection[0]) - Math.atan2(firstDirection[1], firstDirection[0]))
  if (sweep > Math.PI) {
    ;[firstDirection, secondDirection] = [secondDirection, firstDirection]
    sweep = Math.PI * 2 - sweep
  }
  if (sweep < 1e-9 || Math.abs(Math.PI - sweep) < 1e-9) return null
  return {
    start: [precise(center[0] + firstDirection[0] * radius), precise(center[1] + firstDirection[1] * radius)],
    end: [precise(center[0] + secondDirection[0] * radius), precise(center[1] + secondDirection[1] * radius)],
    sweep,
  }
}

/** 将来源线段方向调整到当前角度标注放置位置。 */
function orientedSegmentDirection(
  segment: AssociationResolution,
  center: Point,
  target: Point,
): Point | null {
  if (segment.type !== 'segment') return null
  const dx = segment.end[0] - segment.start[0]
  const dy = segment.end[1] - segment.start[1]
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) return null
  let ux = dx / length
  let uy = dy / length
  let projection = ux * target[0] + uy * target[1]
  if (Math.abs(projection) < 1e-9) {
    projection = ux * (midpoint(segment.start, segment.end)[0] - center[0])
      + uy * (midpoint(segment.start, segment.end)[1] - center[1])
  }
  if (projection < 0) {
    ux *= -1
    uy *= -1
  }
  return [ux, uy]
}

/** 计算弧长标注使用的圆弧范围。 */
function arcLengthGeometry(
  curve: ParametricCurveGeometry,
  parameterRange?: [number, number],
): { center: Point; start: Point; end: Point; radius: number; sweep: number } | null {
  const circle = curveCircle(curve)
  if (!circle || circle.radius <= 1e-9) return null
  const startParameter = parameterRange?.[0] ?? curve.startParameter
  const endParameter = parameterRange?.[1] ?? (curve.startParameter + curve.sweepParameter)
  if (!Number.isFinite(startParameter) || !Number.isFinite(endParameter)) return null
  const requestedSweep = Math.abs(endParameter - startParameter)
  if (requestedSweep < 1e-9 || requestedSweep >= Math.PI * 2 - 1e-9) return null
  const start = curvePoint(curve, startParameter)
  const end = curvePoint(curve, endParameter)
  const startAngle = Math.atan2(start[1] - circle.center[1], start[0] - circle.center[0])
  const endAngle = Math.atan2(end[1] - circle.center[1], end[0] - circle.center[0])
  let sweep = positiveAngle(endAngle - startAngle)
  let orientedStart = start
  let orientedEnd = end
  if (Math.abs(sweep - requestedSweep) > Math.abs((Math.PI * 2 - sweep) - requestedSweep)) {
    ;[orientedStart, orientedEnd] = [orientedEnd, orientedStart]
    sweep = Math.PI * 2 - sweep
  }
  if (Math.abs(sweep - requestedSweep) > 1e-5) return null
  return {
    center: circle.center.slice() as Point,
    start: orientedStart,
    end: orientedEnd,
    radius: circle.radius,
    sweep,
  }
}

/** 计算关联角度标注使用的无限直线交点。 */
function infiniteLineIntersection(firstStart: Point, firstEnd: Point, secondStart: Point, secondEnd: Point): Point | null {
  const firstDirection: Point = [firstEnd[0] - firstStart[0], firstEnd[1] - firstStart[1]]
  const secondDirection: Point = [secondEnd[0] - secondStart[0], secondEnd[1] - secondStart[1]]
  const denominator = firstDirection[0] * secondDirection[1] - firstDirection[1] * secondDirection[0]
  const scale = Math.max(distance(firstStart, firstEnd) * distance(secondStart, secondEnd), 1e-9)
  if (Math.abs(denominator) / scale < 1e-7) return null
  const delta: Point = [secondStart[0] - firstStart[0], secondStart[1] - firstStart[1]]
  const parameter = (delta[0] * secondDirection[1] - delta[1] * secondDirection[0]) / denominator
  return [
    precise(firstStart[0] + firstDirection[0] * parameter),
    precise(firstStart[1] + firstDirection[1] * parameter),
  ]
}

/** 为原生半径或直径标注应用通用的径向更新。 */
function syncRadialGeometry(annotation: Entity, nextCenter: Point, nextRadius: number): boolean {
  if (annotation.type !== 'dimension'
    || (annotation.dimensionType !== 'radius' && annotation.dimensionType !== 'diameter')) return false
  const oldCenter = annotation.dimensionCenter
  const oldStart = annotation.dimensionStart
  if (!oldCenter || !oldStart) return syncDimensionMeasurementText(annotation)
  const direction = radialDirection(
    oldCenter,
    oldStart,
    annotation.dimensionLinePosition || annotation.position || [oldCenter[0] + 1, oldCenter[1]],
  )
  const radius = Math.max(nextRadius, 1e-9)
  const nextStart: Point = [
    precise(nextCenter[0] + direction[0] * radius),
    precise(nextCenter[1] + direction[1] * radius),
  ]
  const nextEnd: Point | null = annotation.dimensionType === 'diameter'
    ? [
        precise(nextCenter[0] - direction[0] * radius),
        precise(nextCenter[1] - direction[1] * radius),
      ]
    : null
  const centerDelta: Point = [nextCenter[0] - oldCenter[0], nextCenter[1] - oldCenter[1]]
  const geometryChanged = !samePoint(oldCenter, nextCenter)
    || !samePoint(oldStart, nextStart)
    || (nextEnd != null && (!annotation.dimensionEnd || !samePoint(annotation.dimensionEnd, nextEnd)))
    || annotation.dimensionRadius !== round(radius, 9)
  if (!geometryChanged) return syncDimensionMeasurementText(annotation)

  annotation.dimensionCenter = nextCenter.slice() as Point
  annotation.dimensionStart = nextStart
  if (nextEnd) annotation.dimensionEnd = nextEnd
  annotation.dimensionLinePosition = nextStart.slice() as Point
  annotation.dimensionRadius = round(radius, 9)
  if (annotation.position) {
    annotation.position = [
      precise(annotation.position[0] + centerDelta[0]),
      precise(annotation.position[1] + centerDelta[1]),
    ]
  }
  annotation.dimensionDisplaySegments = null
  releaseDimensionSourceTextPosition(annotation)
  const textChanged = syncDimensionMeasurementText(annotation)
  return geometryChanged || textChanged
}

/** 将半径或直径标注与其来源圆同步。
 * @param annotation 待更新的半径或直径标注。
 * @param entities 按 ID 建立索引的所有图纸实体。
 * @returns 标注几何或来源引用是否发生变化。
 * @author snihao
 */
function syncCircularDimension(annotation: Entity, entities: Map<string, Entity>): boolean {
  if (annotation.type !== 'dimension'
    || (annotation.dimensionType !== 'radius' && annotation.dimensionType !== 'diameter')) return false

  const source = entities.get(annotation.dimensionSource?.entityId || '')
  if (!source || source.type !== 'circle' || !source.center || source.radius == null || source.radius <= 1e-9) {
    if (!annotation.dimensionSource) return false
    annotation.dimensionSource = null
    return true
  }
  return syncRadialGeometry(annotation, source.center, source.radius)
}

/** 返回径向测量的单位方向，并提供稳定的回退方向。
 * @param center 当前标注圆心。
 * @param point 当前径向测量点。
 * @param fallback 测量点与圆心重合时使用的回退点。
 * @returns 归一化的径向方向。
 * @author snihao
 */
function radialDirection(center: Point, point: Point, fallback: Point): Point {
  let dx = point[0] - center[0]
  let dy = point[1] - center[1]
  let length = Math.hypot(dx, dy)
  if (length < 1e-9) {
    dx = fallback[0] - center[0]
    dy = fallback[1] - center[1]
    length = Math.max(Math.hypot(dx, dy), 1e-9)
  }
  return [dx / length, dy / length]
}

/** 返回通用关联引用的主要实体 ID。 */
function associationSourceEntityId(association: DimensionAssociation): string | null {
  if (!association?.source) return null
  return association.source.kind === 'point'
    ? association.source.ref?.entityId || null
    : association.source.entityId || null
}

/** 移除指定的通用关联，保留其余元数据。 */
function removeDimensionAssociations(entity: Entity, predicate: (association: DimensionAssociation) => boolean): boolean {
  const associations = entity.dimensionAssociations
  if (!associations?.length) return false
  const kept = associations.filter((association) => !predicate(association))
  if (kept.length === associations.length) return false
  entity.dimensionAssociations = kept.length ? kept : null
  return true
}

/** 从旧版或通用存储中移除点关联。 */
function detachPointReference(entity: Entity, index: number, reference: PointReference): boolean {
  let changed = false
  if (entity.dimensionRefs?.[index] === reference || entity.dimensionRefs?.[index]) {
    if (entity.dimensionRefs?.[index]) {
      entity.dimensionRefs[index] = null
      changed = true
    }
  }
  const role = index === 0 ? 'start' : 'end'
  if (removeDimensionAssociations(entity, (association) => (
    association.role === role
    && association.source.kind === 'point'
    && association.source.ref === reference
  ))) changed = true
  return changed
}

/** 严格解析点引用；来源缺失或无效时返回 null，不使用回退坐标。 */
export function resolvePointReferenceStrict(
  reference: PointReference,
  findEntity: (id: string) => Entity | null,
): Point | null {
  if (!reference || !reference.entityId) return null
  const entity = findEntity(reference.entityId)
  if (!entity) return null
  if (reference.relatedEntityId && !findEntity(reference.relatedEntityId)) return null

  if (reference.kind === 'center') {
    if (entity.type === 'circle' && entity.center) return entity.center.slice() as Point
    if (entity.type === 'polyline' && entity.curveGeometry) return entity.curveGeometry.center.slice() as Point
    return null
  }
  if (reference.kind === 'quadrant' && entity.type === 'circle'
    && entity.center && entity.radius != null && Number.isFinite(entity.radius) && entity.radius > 1e-9
    && Number.isFinite(reference.t)) {
    const index = Math.max(0, Math.min(3, Math.round(reference.t as number)))
    return circleQuadrants(entity.center, entity.radius)[index]
  }
  if ((reference.kind === 'nearest' || reference.kind === 'tangent' || reference.kind === 'perpendicular')
    && entity.type === 'circle'
    && entity.center && entity.radius != null && Number.isFinite(entity.radius) && entity.radius > 1e-9
    && Number.isFinite(reference.t)) {
    return [
      precise(entity.center[0] + Math.cos(reference.t as number) * entity.radius),
      precise(entity.center[1] + Math.sin(reference.t as number) * entity.radius),
    ]
  }
  if (entity.type === 'polyline' && entity.curveGeometry) {
    if (reference.kind === 'endpoint' && reference.t == null) return curveStartPoint(entity.curveGeometry)
    if (reference.t != null && ['endpoint', 'midpoint', 'quadrant', 'nearest', 'perpendicular', 'tangent'].includes(reference.kind)) {
      return curvePoint(entity.curveGeometry, reference.t)
    }
    return null
  }

  const primitive = primitiveFor(entity, reference.segmentIndex)
  if (reference.kind === 'intersection') {
    const related = reference.relatedEntityId ? findEntity(reference.relatedEntityId) : null
    const relatedPrimitive = related ? primitiveFor(related, reference.relatedSegmentIndex ?? null) : null
    if (!primitive || !relatedPrimitive) return null
    return nearestPoint(primitiveIntersections(primitive, relatedPrimitive), reference.fallback)
  }
  if (primitive?.type === 'segment') {
    const t = Math.max(0, Math.min(1, reference.t ?? (reference.kind === 'midpoint' ? 0.5 : 0)))
    return [
      precise(primitive.start[0] + (primitive.end[0] - primitive.start[0]) * t),
      precise(primitive.start[1] + (primitive.end[1] - primitive.start[1]) * t),
    ]
  }
  if (primitive?.type === 'curve' && reference.t != null) return curvePoint(primitive.curve, reference.t)
  return null
}

/** 移除来源受拓扑操作影响的关联。 */
export function detachDimensionAssociationsForEntities(entity: Entity, entityIds: Set<string>): number {
  if (!isDimensionEntity(entity) || !entityIds.size) return 0
  let detached = 0
  if (entity.dimensionRefs) {
    for (let index = 0; index < entity.dimensionRefs.length; index++) {
      const reference = entity.dimensionRefs[index]
      if (reference && (entityIds.has(reference.entityId)
        || !!reference.relatedEntityId && entityIds.has(reference.relatedEntityId))) {
        entity.dimensionRefs[index] = null
        detached++
      }
    }
  }
  if (entity.dimensionSource && entityIds.has(entity.dimensionSource.entityId)) {
    entity.dimensionSource = null
    detached++
  }
  if (entity.dimensionAssociations?.length) {
    const kept: DimensionAssociation[] = []
    for (const association of entity.dimensionAssociations) {
      const sourceIds = associationEntityIds(association)
      if (sourceIds.some((id) => entityIds.has(id))) detached++
      else kept.push(association)
    }
    if (kept.length !== entity.dimensionAssociations.length) entity.dimensionAssociations = kept.length ? kept : null
  }
  return detached
}

/** 返回通用关联涉及的所有实体 ID，包括交点的来源实体。 */
function associationEntityIds(association: DimensionAssociation): string[] {
  if (!association?.source) return []
  if (association.source.kind === 'point') {
    return [
      association.source.ref.entityId,
      ...(association.source.ref.relatedEntityId ? [association.source.ref.relatedEntityId] : []),
    ]
  }
  return [association.source.entityId]
}

/** 返回标注引用的全部来源实体，供联合选择和拖动判断使用。 */
export function dimensionSourceEntityIds(entity: Entity): string[] {
  const ids = new Set<string>()
  if (entity.dimensionSource) ids.add(entity.dimensionSource.entityId)
  for (const ref of entity.dimensionRefs || []) {
    if (ref) {
      ids.add(ref.entityId)
      if (ref.relatedEntityId) ids.add(ref.relatedEntityId)
    }
  }
  for (const association of entity.dimensionAssociations || []) {
    for (const id of associationEntityIds(association)) ids.add(id)
  }
  return [...ids]
}

/**
 * 用户显式重定义标注时解除一个测量端点关联。
 * @param entity 待解除关联的标注实体。
 * @param index 测量端点索引，只允许 0 或 1。
 * @returns 是否成功解除关联。
 */
export function detachDimensionReference(entity: Entity, index: number): boolean {
  if (!isDimensionEntity(entity) || (index !== 0 && index !== 1)) return false
  let changed = false
  if (entity.dimensionRefs?.[index]) {
    entity.dimensionRefs[index] = null
    changed = true
  }
  if (entity.dimensionSource) {
    entity.dimensionSource = null
    changed = true
  }
  const roles = entity.type === 'dimension' && entity.dimensionType === 'angular'
    ? new Set<DimensionAssociation['role']>([index === 0 ? 'line1' : 'line2'])
    : entity.type === 'dimension' && entity.dimensionType === 'arcLength'
      ? new Set<DimensionAssociation['role']>(['curve'])
      : entity.type === 'dimension' && (entity.dimensionType === 'radius' || entity.dimensionType === 'diameter')
        ? new Set<DimensionAssociation['role']>(['center', 'curve'])
        : new Set<DimensionAssociation['role']>([index === 0 ? 'start' : 'end'])
  if (removeDimensionAssociations(entity, (association) => roles.has(association.role))) changed = true
  return changed
}

/**
 * 用户整体变换标注时解除两个测量端点关联。
 * @param entity 待解除关联的标注实体。
 * @returns 是否至少解除了一条关联。
 * @author snihao
 */
export function detachDimensionReferences(entity: Entity): boolean {
  if (!isDimensionEntity(entity)) return false
  const changed = !!entity.dimensionRefs?.[0]
    || !!entity.dimensionRefs?.[1]
    || !!entity.dimensionSource
    || !!entity.dimensionAssociations?.length
  if (entity.dimensionRefs) entity.dimensionRefs = [null, null]
  entity.dimensionSource = null
  entity.dimensionAssociations = null
  return changed
}

function resolveWithLookup(reference: PointReference, findEntity: (id: string) => Entity | null): Point {
  const entity = findEntity(reference.entityId)
  if (!entity) return reference.fallback.slice() as Point

  if (reference.kind === 'center' && entity.type === 'circle' && entity.center) {
    return entity.center.slice() as Point
  }
  if (reference.kind === 'quadrant' && entity.type === 'circle' && entity.center && entity.radius != null) {
    const index = Math.max(0, Math.min(3, Math.round(reference.t || 0)))
    return circleQuadrants(entity.center, entity.radius)[index]
  }
  if (reference.kind === 'nearest' && entity.type === 'circle' && entity.center && entity.radius != null && reference.t != null) {
    return [
      precise(entity.center[0] + Math.cos(reference.t) * entity.radius),
      precise(entity.center[1] + Math.sin(reference.t) * entity.radius),
    ]
  }
  if ((reference.kind === 'tangent' || reference.kind === 'perpendicular')
    && entity.type === 'circle' && entity.center && entity.radius != null && reference.t != null) {
    return [
      precise(entity.center[0] + Math.cos(reference.t) * entity.radius),
      precise(entity.center[1] + Math.sin(reference.t) * entity.radius),
    ]
  }

  if (entity.type === 'polyline' && entity.curveGeometry) {
    const curve = entity.curveGeometry
    if (reference.kind === 'center') return curve.center.slice() as Point
    if (reference.t != null && ['endpoint', 'midpoint', 'quadrant', 'nearest', 'perpendicular', 'tangent'].includes(reference.kind)) {
      return curvePoint(curve, reference.t)
    }
    if (reference.kind === 'endpoint') return curveStartPoint(curve)
  }

  const primitive = primitiveFor(entity, reference.segmentIndex)
  if (reference.kind === 'intersection') {
    const related = reference.relatedEntityId ? findEntity(reference.relatedEntityId) : null
    const relatedPrimitive = related ? primitiveFor(related, reference.relatedSegmentIndex ?? null) : null
    if (!primitive || !relatedPrimitive) return reference.fallback.slice() as Point
    const points = primitiveIntersections(primitive, relatedPrimitive)
    return nearestPoint(points, reference.fallback) || reference.fallback.slice() as Point
  }

  if (primitive?.type === 'segment') {
    const t = Math.max(0, Math.min(1, reference.t ?? (reference.kind === 'midpoint' ? 0.5 : 0)))
    return [
      precise(primitive.start[0] + (primitive.end[0] - primitive.start[0]) * t),
      precise(primitive.start[1] + (primitive.end[1] - primitive.start[1]) * t),
    ]
  }
  if (primitive?.type === 'curve' && reference.t != null) {
    return curvePoint(primitive.curve, reference.t)
  }
  return reference.fallback.slice() as Point
}

function entityMap(drawing: Drawing): Map<string, Entity> {
  const result = new Map<string, Entity>()
  const visit = (entities: Entity[]): void => {
    for (const entity of entities) {
      result.set(entity.id, entity)
      if (entity.children) visit(entity.children)
    }
  }
  visit(drawing.entities)
  return result
}

function primitiveFor(entity: Entity, segmentIndex: number | null): ReferencePrimitive | null {
  if (entity.type === 'line' && entity.start && entity.end) {
    return { type: 'segment', start: entity.start, end: entity.end }
  }
  if (entity.type === 'polyline' && entity.curveGeometry) {
    return { type: 'curve', curve: entity.curveGeometry }
  }
  if (entity.type === 'polyline' && entity.points?.length) {
    const index = segmentIndex ?? 0
    const segmentCount = entity.closed ? entity.points.length : entity.points.length - 1
    if (index < 0 || index >= segmentCount) return null
    return { type: 'segment', start: entity.points[index], end: entity.points[(index + 1) % entity.points.length] }
  }
  if (entity.type === 'circle' && entity.center && entity.radius != null) {
    return { type: 'circle', center: entity.center, radius: entity.radius }
  }
  if ((entity.type === 'annotation' || entity.type === 'dimension')) {
    const points = dimensionPoints(entity)
    const index = segmentIndex ?? 0
    if (points) {
      const segments: [Point, Point][] = [[points[0], points[2]], [points[1], points[3]], [points[2], points[3]]]
      const segment = segments[index]
      return segment ? { type: 'segment', start: segment[0], end: segment[1] } : null
    }
    const leader = entity.leader || []
    if (index < 0 || index + 1 >= leader.length) return null
    return { type: 'segment', start: leader[index], end: leader[index + 1] }
  }
  return null
}

function primitiveIntersections(first: ReferencePrimitive, second: ReferencePrimitive): Point[] {
  if (first.type === 'segment' && second.type === 'segment') {
    const point = segmentIntersection(first.start, first.end, second.start, second.end)
    return point ? [point] : []
  }
  if (first.type === 'segment' && second.type === 'circle') {
    return segmentCircleIntersections(first.start, first.end, second.center, second.radius)
  }
  if (first.type === 'circle' && second.type === 'segment') {
    return segmentCircleIntersections(second.start, second.end, first.center, first.radius)
  }
  if (first.type === 'circle' && second.type === 'circle') {
    return circleCircleIntersections(first.center, first.radius, second.center, second.radius)
  }
  if (first.type === 'segment' && second.type === 'curve') {
    return segmentCurveIntersections(first.start, first.end, second.curve).map((item) => item.point)
  }
  if (first.type === 'curve' && second.type === 'segment') {
    return segmentCurveIntersections(second.start, second.end, first.curve).map((item) => item.point)
  }
  if (first.type === 'circle' && second.type === 'curve') {
    return curveCurveIntersections(circleCurveGeometry(first.center, first.radius), second.curve).map((item) => item.point)
  }
  if (first.type === 'curve' && second.type === 'circle') {
    return curveCurveIntersections(first.curve, circleCurveGeometry(second.center, second.radius)).map((item) => item.point)
  }
  if (first.type === 'curve' && second.type === 'curve') {
    return curveCurveIntersections(first.curve, second.curve).map((item) => item.point)
  }
  return []
}

function segmentCircleIntersections(start: Point, end: Point, center: Point, radius: number): Point[] {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const fx = start[0] - center[0]
  const fy = start[1] - center[1]
  const a = dx * dx + dy * dy
  if (a < 1e-12) return []
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - radius * radius
  const discriminant = b * b - 4 * a * c
  if (discriminant < -1e-9) return []
  const root = Math.sqrt(Math.max(0, discriminant))
  const values = discriminant <= 1e-9 ? [-b / (2 * a)] : [(-b - root) / (2 * a), (-b + root) / (2 * a)]
  return values
    .filter((value) => value >= -1e-9 && value <= 1 + 1e-9)
    .map((value) => [precise(start[0] + value * dx), precise(start[1] + value * dy)] as Point)
}

function circleCircleIntersections(firstCenter: Point, firstRadius: number, secondCenter: Point, secondRadius: number): Point[] {
  const dx = secondCenter[0] - firstCenter[0]
  const dy = secondCenter[1] - firstCenter[1]
  const centerDistance = Math.hypot(dx, dy)
  if (centerDistance < 1e-9) return []
  if (centerDistance > firstRadius + secondRadius + 1e-9) return []
  if (centerDistance < Math.abs(firstRadius - secondRadius) - 1e-9) return []
  const along = (firstRadius ** 2 - secondRadius ** 2 + centerDistance ** 2) / (2 * centerDistance)
  const heightSquared = firstRadius ** 2 - along ** 2
  if (heightSquared < -1e-9) return []
  const height = Math.sqrt(Math.max(0, heightSquared))
  const ux = dx / centerDistance
  const uy = dy / centerDistance
  const base: Point = [firstCenter[0] + along * ux, firstCenter[1] + along * uy]
  if (height <= 1e-9) return [[precise(base[0]), precise(base[1])]]
  return [
    [precise(base[0] - uy * height), precise(base[1] + ux * height)],
    [precise(base[0] + uy * height), precise(base[1] - ux * height)],
  ]
}

function circleQuadrants(center: Point, radius: number): Point[] {
  return [
    [center[0] + radius, center[1]],
    [center[0], center[1] + radius],
    [center[0] - radius, center[1]],
    [center[0], center[1] - radius],
  ]
}

function nearestPoint(points: Point[], target: Point): Point | null {
  let best: Point | null = null
  let bestDistance = Infinity
  for (const point of points) {
    const candidateDistance = distance(point, target)
    if (candidateDistance < bestDistance) {
      best = point
      bestDistance = candidateDistance
    }
  }
  return best ? best.slice() as Point : null
}

function signedOffset(start: Point, end: Point, dimensionStart: Point): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const length = Math.max(Math.hypot(dx, dy), 1e-9)
  return (dimensionStart[0] - start[0]) * (-dy / length)
    + (dimensionStart[1] - start[1]) * (dx / length)
}

function midpoint(first: Point, second: Point): Point {
  return [precise((first[0] + second[0]) / 2), precise((first[1] + second[1]) / 2)]
}

function samePoint(first: Point, second: Point): boolean {
  return Math.abs(first[0] - second[0]) <= 1e-7 && Math.abs(first[1] - second[1]) <= 1e-7
}

function precise(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function positiveAngle(value: number): number {
  return (value % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
}
