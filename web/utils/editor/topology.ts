import {
  curveCircle,
  curveCurveIntersections,
  curveContainsParameter,
  curveEndPoint,
  curveParameterAtPoint,
  curvePoint,
  curveStartPoint,
  isFullCurve,
  sampleCurve,
  segmentCurveIntersections,
} from '#draiq/utils/editor/curveGeometry'
import { clamp, distance, genId, nearestOnSegment, round } from '#draiq/utils/editor/geometry'

/**
 * 拓扑命令的统一结果。
 * @author snihao
 */
export interface TopologyResult<T = Entity> {
  /** 是否生成了有效结果。 */
  ok: boolean
  /** 命令返回的第一个实体。 */
  entity?: T
  /** 命令返回的全部实体，打断命令会使用该字段。 */
  entities?: T[]
  /** 可直接显示给用户的失败原因。 */
  reason?: string
  /** 连接命令消耗的源实体 ID。 */
  consumedIds?: string[]
}

/** 根据光标位置决定偏移侧；为空时使用输入距离的符号。 @author snihao */
export type OffsetSide = Point | null

interface SegmentHit {
  point: Point
  parameter: number
}

const EPSILON = 1e-7

function fail<T>(reason: string): TopologyResult<T> {
  return { ok: false, reason }
}

function success<T>(entity: T, entities?: T[]): TopologyResult<T> {
  return { ok: true, entity, entities: entities || [entity] }
}

function cloneEntity(entity: Entity, id = entity.id): Entity {
  const clone = JSON.parse(JSON.stringify(entity)) as Entity
  clone.id = id
  return clone
}

function lineIntersection(firstStart: Point, firstEnd: Point, secondStart: Point, secondEnd: Point): { point: Point; firstT: number; secondT: number } | null {
  const ax = firstEnd[0] - firstStart[0]
  const ay = firstEnd[1] - firstStart[1]
  const bx = secondEnd[0] - secondStart[0]
  const by = secondEnd[1] - secondStart[1]
  const determinant = ax * by - ay * bx
  if (Math.abs(determinant) <= EPSILON) return null
  const dx = secondStart[0] - firstStart[0]
  const dy = secondStart[1] - firstStart[1]
  const firstT = (dx * by - dy * bx) / determinant
  const secondT = (dx * ay - dy * ax) / determinant
  return {
    point: [round(firstStart[0] + ax * firstT, 9), round(firstStart[1] + ay * firstT, 9)],
    firstT,
    secondT,
  }
}

function segmentDistanceParameter(point: Point, start: Point, end: Point): number {
  return nearestOnSegment(point, start, end).t
}

function curveForEntity(entity: Entity): ParametricCurveGeometry | null {
  if (entity.type === 'circle' && entity.center && entity.radius && entity.radius > EPSILON) {
    return {
      type: 'arc',
      center: entity.center.slice() as Point,
      axisX: [entity.radius, 0],
      axisY: [0, entity.radius],
      startParameter: 0,
      sweepParameter: Math.PI * 2,
    }
  }
  return entity.type === 'polyline' && entity.curveGeometry ? entity.curveGeometry : null
}

function curveSampleCount(curve: ParametricCurveGeometry): number {
  return Math.max(48, Math.ceil(Math.abs(curve.sweepParameter) / (Math.PI / 24)))
}

function lineCurveIntersectionsInfinite(start: Point, end: Point, curve: ParametricCurveGeometry): SegmentHit[] {
  const ax = curve.axisX[0]
  const ay = curve.axisX[1]
  const bx = curve.axisY[0]
  const by = curve.axisY[1]
  const determinant = ax * by - ay * bx
  if (Math.abs(determinant) <= EPSILON) return []
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const sx = start[0] - curve.center[0]
  const sy = start[1] - curve.center[1]
  const x0 = (sx * by - sy * bx) / determinant
  const y0 = (ax * sy - ay * sx) / determinant
  const vx = (dx * by - dy * bx) / determinant
  const vy = (ax * dy - ay * dx) / determinant
  const a = vx * vx + vy * vy
  if (a <= EPSILON) return []
  const bValue = 2 * (x0 * vx + y0 * vy)
  const c = x0 * x0 + y0 * y0 - 1
  const discriminant = bValue * bValue - 4 * a * c
  if (discriminant < -EPSILON) return []
  const root = Math.sqrt(Math.max(0, discriminant))
  const values = discriminant <= EPSILON
    ? [-bValue / (2 * a)]
    : [(-bValue - root) / (2 * a), (-bValue + root) / (2 * a)]
  return values
    .map((parameter) => ({
      parameter,
      point: [round(start[0] + dx * parameter, 9), round(start[1] + dy * parameter, 9)] as Point,
    }))
    .filter((hit) => {
      const curveParameter = curveParameterAtPoint(curve, hit.point)
      return curveParameter != null && curveContainsParameter(curve, curveParameter)
    })
}

function entityIntersections(target: Entity, boundary: Entity): SegmentHit[] {
  const targetCurve = curveForEntity(target)
  const boundaryCurve = curveForEntity(boundary)
  if (target.type === 'line' && target.start && target.end) {
    if (boundary.type === 'line' && boundary.start && boundary.end) {
      const hit = lineIntersection(target.start, target.end, boundary.start, boundary.end)
      return hit && hit.firstT >= -EPSILON && hit.firstT <= 1 + EPSILON && hit.secondT >= -EPSILON && hit.secondT <= 1 + EPSILON
        ? [{ point: hit.point, parameter: clamp(hit.firstT, 0, 1) }]
        : []
    }
    if (boundary.type === 'polyline' && boundary.points) {
      const hits: SegmentHit[] = []
      const count = boundary.closed ? boundary.points.length : boundary.points.length - 1
      for (let index = 0; index < count; index++) {
        const hit = lineIntersection(target.start, target.end, boundary.points[index], boundary.points[(index + 1) % boundary.points.length])
        if (hit && hit.firstT >= -EPSILON && hit.firstT <= 1 + EPSILON && hit.secondT >= -EPSILON && hit.secondT <= 1 + EPSILON) hits.push({ point: hit.point, parameter: clamp(hit.firstT, 0, 1) })
      }
      return dedupeHits(hits)
    }
    return boundaryCurve ? segmentCurveIntersections(target.start, target.end, boundaryCurve).map((item) => ({ point: item.point, parameter: segmentDistanceParameter(item.point, target.start!, target.end!) })) : []
  }

  if (targetCurve) {
    if (boundary.type === 'line' && boundary.start && boundary.end) {
      return lineCurveIntersectionsInfinite(boundary.start, boundary.end, targetCurve)
        .filter((hit) => hit.parameter >= -EPSILON && hit.parameter <= 1 + EPSILON)
        .map((hit) => {
          const parameter = curveParameterAtPoint(targetCurve, hit.point) || targetCurve.startParameter
          return { point: hit.point, parameter: parameterProgress(targetCurve, parameter) }
        })
    }
    if (boundaryCurve) {
      return curveCurveIntersections(targetCurve, boundaryCurve)
        .map((item) => ({ point: item.point, parameter: parameterProgress(targetCurve, item.firstParameter) }))
    }
    if (boundary.type === 'polyline' && boundary.points) {
      const hits: SegmentHit[] = []
      const count = boundary.closed ? boundary.points.length : boundary.points.length - 1
      const samples = sampleCurve(targetCurve, curveSampleCount(targetCurve))
      for (let index = 0; index < count; index++) {
        for (let sampleIndex = 0; sampleIndex < samples.length - 1; sampleIndex++) {
          const hit = lineIntersection(samples[sampleIndex], samples[sampleIndex + 1], boundary.points[index], boundary.points[(index + 1) % boundary.points.length])
          if (hit && hit.firstT >= -EPSILON && hit.firstT <= 1 + EPSILON && hit.secondT >= -EPSILON && hit.secondT <= 1 + EPSILON) {
            hits.push({ point: hit.point, parameter: (sampleIndex + clamp(hit.firstT, 0, 1)) / (samples.length - 1) })
          }
        }
      }
      return dedupeHits(hits)
    }
  }

  const targetPoints = target.type === 'polyline' ? target.points || [] : []
  const boundaryPoints = boundary.type === 'polyline' ? boundary.points || [] : []
  if (targetPoints.length >= 2 && boundary.type === 'line' && boundary.start && boundary.end) {
    const hits: SegmentHit[] = []
    const count = target.closed ? targetPoints.length : targetPoints.length - 1
    let length = 0
    const lengths: number[] = [0]
    for (let index = 0; index < count; index++) {
      const segmentLength = distance(targetPoints[index], targetPoints[(index + 1) % targetPoints.length])
      length += segmentLength
      lengths.push(length)
    }
    for (let index = 0; index < count; index++) {
      const startPoint = targetPoints[index]
      const endPoint = targetPoints[(index + 1) % targetPoints.length]
      const hit = lineIntersection(startPoint, endPoint, boundary.start, boundary.end)
      if (hit && hit.firstT >= -EPSILON && hit.firstT <= 1 + EPSILON && hit.secondT >= -EPSILON && hit.secondT <= 1 + EPSILON) hits.push({ point: hit.point, parameter: length > EPSILON ? (lengths[index] + distance(startPoint, hit.point)) / length : 0 })
    }
    return dedupeHits(hits)
  }
  if (targetPoints.length >= 2 && boundaryPoints.length >= 2) {
    const hits: SegmentHit[] = []
    const targetCount = target.closed ? targetPoints.length : targetPoints.length - 1
    const boundaryCount = boundary.closed ? boundaryPoints.length : boundaryPoints.length - 1
    let targetLength = 0
    const lengths: number[] = [0]
    for (let index = 0; index < targetCount; index++) {
      targetLength += distance(targetPoints[index], targetPoints[(index + 1) % targetPoints.length])
      lengths.push(targetLength)
    }
    for (let index = 0; index < targetCount; index++) {
      for (let boundaryIndex = 0; boundaryIndex < boundaryCount; boundaryIndex++) {
        const hit = lineIntersection(targetPoints[index], targetPoints[(index + 1) % targetPoints.length], boundaryPoints[boundaryIndex], boundaryPoints[(boundaryIndex + 1) % boundaryPoints.length])
        if (hit && hit.firstT >= -EPSILON && hit.firstT <= 1 + EPSILON && hit.secondT >= -EPSILON && hit.secondT <= 1 + EPSILON) hits.push({ point: hit.point, parameter: targetLength > EPSILON ? (lengths[index] + distance(targetPoints[index], hit.point)) / targetLength : 0 })
      }
    }
    return dedupeHits(hits)
  }
  return []
}

function dedupeHits(hits: SegmentHit[]): SegmentHit[] {
  const result: SegmentHit[] = []
  for (const hit of hits) if (!result.some((item) => distance(item.point, hit.point) <= 1e-5)) result.push(hit)
  return result.sort((first, second) => first.parameter - second.parameter)
}

function parameterProgress(curve: ParametricCurveGeometry, parameter: number): number {
  if (Math.abs(curve.sweepParameter) <= EPSILON) return 0
  let delta = parameter - curve.startParameter
  if (curve.sweepParameter < 0) delta = -delta
  while (delta < 0) delta += Math.PI * 2
  while (delta > Math.PI * 2) delta -= Math.PI * 2
  return clamp(delta / Math.abs(curve.sweepParameter), 0, 1)
}

function offsetSign(entity: Entity, amount: number, side: OffsetSide): number {
  if (!side || Math.abs(amount) <= EPSILON) return amount
  if (entity.type === 'line' && entity.start && entity.end) {
    const dx = entity.end[0] - entity.start[0]
    const dy = entity.end[1] - entity.start[1]
    const cross = dx * (side[1] - entity.start[1]) - dy * (side[0] - entity.start[0])
    return Math.abs(amount) * (cross >= 0 ? 1 : -1)
  }
  if (entity.center) return Math.abs(amount) * (distance(entity.center, side) >= (entity.radius || 0) ? 1 : -1)
  if (entity.type === 'polyline' && entity.curveGeometry) {
    const curve = entity.curveGeometry
    const averageRadius = (Math.hypot(...curve.axisX) + Math.hypot(...curve.axisY)) / 2
    return Math.abs(amount) * (distance(curve.center, side) >= averageRadius ? 1 : -1)
  }
  return amount
}

function offsetLine(entity: Entity, amount: number): TopologyResult<Entity> {
  if (!entity.start || !entity.end) return fail('Line endpoints are missing')
  const dx = entity.end[0] - entity.start[0]
  const dy = entity.end[1] - entity.start[1]
  const length = Math.hypot(dx, dy)
  if (length <= EPSILON) return fail('Cannot offset a zero-length line')
  const normal: Point = [-dy / length, dx / length]
  const result = cloneEntity(entity, genId('offset-line'))
  result.start = [round(entity.start[0] + normal[0] * amount, 9), round(entity.start[1] + normal[1] * amount, 9)]
  result.end = [round(entity.end[0] + normal[0] * amount, 9), round(entity.end[1] + normal[1] * amount, 9)]
  result.sourceHandle = null
  result.sourceEdited = false
  return success(result)
}

function offsetPolyline(entity: Entity, amount: number): TopologyResult<Entity> {
  const source = entity.points || []
  if (source.length < 2) return fail('Polyline needs at least two vertices')
  const count = entity.closed ? source.length : source.length - 1
  const normals: Point[] = []
  for (let index = 0; index < count; index++) {
    const start = source[index]
    const end = source[(index + 1) % source.length]
    const length = distance(start, end)
    if (length <= EPSILON) return fail('Cannot offset a zero-length segment')
    normals.push([-(end[1] - start[1]) / length, (end[0] - start[0]) / length])
  }
  const points: Point[] = []
  if (!entity.closed) {
    points.push([source[0][0] + normals[0][0] * amount, source[0][1] + normals[0][1] * amount])
  }
  const vertexCount = entity.closed ? source.length : source.length - 2
  for (let index = 0; index < vertexCount; index++) {
    const vertexIndex = entity.closed ? index : index + 1
    const previousSegment = (vertexIndex - 1 + count) % count
    const nextSegment = vertexIndex % count
    const previousStart = source[vertexIndex]
    const nextStart = source[vertexIndex]
    const previousEnd: Point = [previousStart[0] + normals[previousSegment][0] * amount, previousStart[1] + normals[previousSegment][1] * amount]
    const nextEnd: Point = [nextStart[0] + normals[nextSegment][0] * amount, nextStart[1] + normals[nextSegment][1] * amount]
    const previousDirection = [source[vertexIndex][0] - source[(vertexIndex - 1 + source.length) % source.length][0], source[vertexIndex][1] - source[(vertexIndex - 1 + source.length) % source.length][1]] as Point
    const nextDirection = [source[(vertexIndex + 1) % source.length][0] - source[vertexIndex][0], source[(vertexIndex + 1) % source.length][1] - source[vertexIndex][1]] as Point
    const intersection = lineIntersection(previousEnd, [previousEnd[0] + previousDirection[0], previousEnd[1] + previousDirection[1]], nextEnd, [nextEnd[0] + nextDirection[0], nextEnd[1] + nextDirection[1]])
    points.push(intersection ? intersection.point : [(previousEnd[0] + nextEnd[0]) / 2, (previousEnd[1] + nextEnd[1]) / 2])
  }
  if (!entity.closed) {
    const last = source.length - 1
    points.push([source[last][0] + normals[count - 1][0] * amount, source[last][1] + normals[count - 1][1] * amount])
  }
  const result = cloneEntity(entity, genId('offset-polyline'))
  result.points = points.map((point) => [round(point[0], 9), round(point[1], 9)])
  result.curveGeometry = null
  result.sourceHandle = null
  result.sourceEdited = false
  if (hasSelfIntersection(points, !!entity.closed)) return fail('Offset result self-intersects')
  return success(result)
}

function hasSelfIntersection(points: Point[], closed: boolean): boolean {
  const segmentCount = closed ? points.length : points.length - 1
  if (segmentCount < 3) return false
  for (let first = 0; first < segmentCount; first++) {
    const firstEnd = (first + 1) % points.length
    for (let second = first + 1; second < segmentCount; second++) {
      const secondEnd = (second + 1) % points.length
      if (first === second || firstEnd === second || secondEnd === first) continue
      if (!closed && secondEnd === first) continue
      const hit = lineIntersection(points[first], points[firstEnd], points[second], points[secondEnd])
      if (hit && hit.firstT > EPSILON && hit.firstT < 1 - EPSILON && hit.secondT > EPSILON && hit.secondT < 1 - EPSILON) return true
    }
  }
  return false
}

function offsetCurveEntity(entity: Entity, amount: number): TopologyResult<Entity> {
  const curve = curveForEntity(entity)
  if (!curve) return fail('Entity does not contain a supported curve')
  const result = cloneEntity(entity, genId('offset-curve'))
  const circle = curveCircle(curve)
  if (circle) {
    const radius = circle.radius + amount
    if (radius <= EPSILON) return fail('Offset distance is larger than the curve radius')
    const next = { ...curve, axisX: [radius, 0] as Point, axisY: [0, radius] as Point }
    if (entity.type === 'circle') {
      result.type = 'circle'
      result.center = next.center
      result.radius = radius
    } else {
      result.curveGeometry = next
      result.points = sampleCurve(next, curveSampleCount(next))
      result.closed = isFullCurve(next)
    }
  } else {
    const xLength = Math.max(Math.hypot(...curve.axisX), EPSILON)
    const yLength = Math.max(Math.hypot(...curve.axisY), EPSILON)
    const next = {
      ...curve,
      axisX: [curve.axisX[0] * (xLength + amount) / xLength, curve.axisX[1] * (xLength + amount) / xLength] as Point,
      axisY: [curve.axisY[0] * (yLength + amount) / yLength, curve.axisY[1] * (yLength + amount) / yLength] as Point,
    }
    if (xLength + amount <= EPSILON || yLength + amount <= EPSILON) return fail('Offset distance collapses the ellipse')
    result.type = 'polyline'
    result.curveGeometry = next
    result.points = sampleCurve(next, curveSampleCount(next))
    result.closed = isFullCurve(next)
  }
  result.sourceHandle = null
  result.sourceEdited = false
  return success(result)
}

/**
 * 创建直线、多段线、圆、圆弧或椭圆的平行副本。
 * @param entity 源实体。
 * @param amount 偏移距离，支持正负值。
 * @param side 可选的光标位置，用于决定偏移侧。
 * @returns 新实体或失败原因。
 * @author snihao
 */
export function offsetEntity(entity: Entity, amount: number, side: OffsetSide = null): TopologyResult<Entity> {
  if (!Number.isFinite(amount) || Math.abs(amount) <= EPSILON) return fail('Offset distance must be non-zero')
  const signedAmount = offsetSign(entity, amount, side)
  if (entity.type === 'line') return offsetLine(entity, signedAmount)
  if (entity.type === 'polyline') return entity.curveGeometry ? offsetCurveEntity(entity, signedAmount) : offsetPolyline(entity, signedAmount)
  if (entity.type === 'circle') return offsetCurveEntity(entity, signedAmount)
  return fail('Only lines, polylines, circles, arcs, and ellipses can be offset')
}

function replaceLinePart(entity: Entity, start: Point, end: Point): Entity {
  const result = cloneEntity(entity, entity.id)
  result.start = start
  result.end = end
  result.sourceHandle = null
  result.sourceEdited = false
  return result
}

function trimLine(entity: Entity, boundary: Entity, pickPoint: Point): TopologyResult<Entity> {
  if (!entity.start || !entity.end) return fail('Line endpoints are missing')
  const hits = entityIntersections(entity, boundary)
  if (!hits.length) return fail('No intersection with the boundary')
  const pickT = segmentDistanceParameter(pickPoint, entity.start, entity.end)
  const nearest = hits.slice().sort((a, b) => Math.abs(a.parameter - pickT) - Math.abs(b.parameter - pickT))[0]
  if (pickT <= nearest.parameter + EPSILON) {
    if (nearest.parameter <= EPSILON) return fail('The picked segment is already at the endpoint')
    return success(replaceLinePart(entity, nearest.point, entity.end))
  }
  if (nearest.parameter >= 1 - EPSILON) return fail('The picked segment is already at the endpoint')
  return success(replaceLinePart(entity, entity.start, nearest.point))
}

function curvePart(entity: Entity, curve: ParametricCurveGeometry, startProgress: number, endProgress: number): Entity | null {
  const sweep = curve.sweepParameter * (endProgress - startProgress)
  if (Math.abs(sweep) <= EPSILON) return null
  const next: ParametricCurveGeometry = {
    ...curve,
    startParameter: curve.startParameter + curve.sweepParameter * startProgress,
    sweepParameter: sweep,
  }
  const result = cloneEntity(entity, entity.id)
  result.type = 'polyline'
  result.curveGeometry = next
  result.points = sampleCurve(next, curveSampleCount(next))
  result.closed = isFullCurve(next)
  result.sourceHandle = null
  result.sourceEdited = false
  return result
}

function trimCurve(entity: Entity, boundary: Entity, pickPoint: Point): TopologyResult<Entity> {
  const curve = curveForEntity(entity)
  if (!curve) return fail('Entity does not contain a supported curve')
  const hits = dedupeHits(entityIntersections(entity, boundary))
  if (!hits.length) return fail('No intersection with the boundary')
  const picked = nearestPointOnCurveProgress(curve, pickPoint)
  if (hits.length === 1) {
    const progress = hits[0].parameter
    const result = picked <= progress ? curvePart(entity, curve, progress, 1) : curvePart(entity, curve, 0, progress)
    return result ? success(result) : fail('The trim would remove the entire curve')
  }
  const sorted = hits.map((hit) => hit.parameter).sort((a, b) => a - b)
  let start = sorted[0]
  let end = sorted[sorted.length - 1]
  if (picked < start || picked > end) {
    return picked < start
      ? curvePart(entity, curve, end, 1) ? success(curvePart(entity, curve, end, 1)!) : fail('The trim would remove the entire curve')
      : curvePart(entity, curve, 0, start) ? success(curvePart(entity, curve, 0, start)!) : fail('The trim would remove the entire curve')
  }
  const result = curvePart(entity, curve, start, end)
  return result ? success(result) : fail('The trim would remove the entire curve')
}

/**
 * 在距离拾取点最近的边界交点处修剪目标实体。
 * @param target 待修改实体。
 * @param boundary 修剪边界。
 * @param pickPoint 待删除部分上的拾取点。
 * @returns 替换实体或失败原因。
 * @author snihao
 */
export function trimEntity(target: Entity, boundary: Entity, pickPoint?: Point): TopologyResult<Entity> {
  if (target.id === boundary.id) return fail('Target and boundary must be different entities')
  const point = pickPoint || midpointOfEntity(target)
  if (target.type === 'line') return trimLine(target, boundary, point)
  if (curveForEntity(target)) return trimCurve(target, boundary, point)
  if (target.type === 'polyline') {
    const points = target.points || []
    const hits = entityIntersections(target, boundary)
    if (!hits.length) return fail('No intersection with the boundary')
    const hit = hits.slice().sort((a, b) => Math.abs(a.parameter - pathProgress(target, point)) - Math.abs(b.parameter - pathProgress(target, point)))[0]
    const result = cloneEntity(target, target.id)
    const segmentCount = target.closed ? points.length : points.length - 1
    const index = Math.min(segmentCount - 1, Math.max(0, Math.floor(hit.parameter * segmentCount)))
    const local = hit.parameter * segmentCount - index
    const pathPoints = target.closed ? [...points, points[0]] : points
    const split = [
      round(pathPoints[index][0] + (pathPoints[index + 1][0] - pathPoints[index][0]) * local, 9),
      round(pathPoints[index][1] + (pathPoints[index + 1][1] - pathPoints[index][1]) * local, 9),
    ] as Point
    if (pathProgress(target, point) <= hit.parameter) result.points = [split, ...pathPoints.slice(index + 1)]
    else result.points = [...pathPoints.slice(0, index + 1), split]
    result.closed = false
    result.curveGeometry = null
    result.sourceHandle = null
    result.sourceEdited = false
    return result.points.length >= 2 ? success(result) : fail('The trim would remove the entire polyline')
  }
  return fail('Entity type is not supported by trim')
}

function midpointOfEntity(entity: Entity): Point {
  if (entity.type === 'line' && entity.start && entity.end) return [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2]
  const curve = curveForEntity(entity)
  if (curve) return curvePoint(curve, curve.startParameter + curve.sweepParameter / 2)
  const points = entity.points || []
  return points[Math.floor(points.length / 2)] || [0, 0]
}

function pathProgress(entity: Entity, point: Point): number {
  if (entity.type === 'line' && entity.start && entity.end) return segmentDistanceParameter(point, entity.start, entity.end)
  const points = entity.points || []
  if (points.length < 2) return 0
  let total = 0
  const lengths: number[] = [0]
  for (let index = 0; index < points.length - 1; index++) {
    total += distance(points[index], points[index + 1])
    lengths.push(total)
  }
  if (total <= EPSILON) return 0
  let best = 0
  let bestDistance = Infinity
  for (let index = 0; index < points.length - 1; index++) {
    const nearest = nearestOnSegment(point, points[index], points[index + 1])
    const candidate = distance(point, [nearest.x, nearest.y])
    if (candidate < bestDistance) {
      bestDistance = candidate
      best = (lengths[index] + nearest.t * distance(points[index], points[index + 1])) / total
    }
  }
  return best
}

function nearestPointOnCurveProgress(curve: ParametricCurveGeometry, point: Point): number {
  const samples = sampleCurve(curve, curveSampleCount(curve))
  let best = 0
  let bestDistance = Infinity
  for (let index = 0; index < samples.length - 1; index++) {
    const nearest = nearestOnSegment(point, samples[index], samples[index + 1])
    const candidate = distance(point, [nearest.x, nearest.y])
    if (candidate < bestDistance) {
      bestDistance = candidate
      best = (index + nearest.t) / (samples.length - 1)
    }
  }
  return best
}

function infiniteLineBoundaryIntersection(entity: Entity, boundary: Entity, endpoint: Point): Point | null {
  if (!entity.start || !entity.end) return null
  const fromStart = endpoint === entity.start
  const beyondEndpoint = (parameter: number): boolean => fromStart
    ? parameter < -EPSILON
    : parameter > 1 + EPSILON
  if (boundary.type === 'line' && boundary.start && boundary.end) {
    const hit = lineIntersection(entity.start, entity.end, boundary.start, boundary.end)
    if (!hit || hit.secondT < -EPSILON || hit.secondT > 1 + EPSILON) return null
    return beyondEndpoint(hit.firstT) ? hit.point : null
  }
  if (boundary.type === 'polyline' && boundary.points && boundary.points.length >= 2) {
    const count = boundary.closed ? boundary.points.length : boundary.points.length - 1
    const hits: Array<{ point: Point; parameter: number }> = []
    for (let index = 0; index < count; index++) {
      const hit = lineIntersection(entity.start, entity.end, boundary.points[index], boundary.points[(index + 1) % boundary.points.length])
      if (!hit || hit.secondT < -EPSILON || hit.secondT > 1 + EPSILON) continue
      if (beyondEndpoint(hit.firstT)) hits.push({ point: hit.point, parameter: hit.firstT })
    }
    return hits.sort((first, second) => Math.abs(first.parameter - (fromStart ? 0 : 1)) - Math.abs(second.parameter - (fromStart ? 0 : 1)))[0]?.point || null
  }
  const curve = curveForEntity(boundary)
  if (curve) {
    const hits = lineCurveIntersectionsInfinite(entity.start, entity.end, curve)
      .filter((hit) => beyondEndpoint(hit.parameter))
    return hits.sort((first, second) => Math.abs(first.parameter - (fromStart ? 0 : 1)) - Math.abs(second.parameter - (fromStart ? 0 : 1)))[0]?.point || null
  }
  return null
}

/** 构建参数曲线的完整一周视图，用于计算延伸交点。 */
function fullTurnCurve(curve: ParametricCurveGeometry): ParametricCurveGeometry {
  return {
    ...curve,
    sweepParameter: curve.sweepParameter < 0 ? -Math.PI * 2 : Math.PI * 2,
  }
}

/** 在完整的底层圆弧或椭圆上查找与有限边界的交点。 */
function curveBoundaryIntersections(curve: ParametricCurveGeometry, boundary: Entity): SegmentHit[] {
  const fullCurve = fullTurnCurve(curve)
  const boundaryCurve = curveForEntity(boundary)
  if (boundary.type === 'line' && boundary.start && boundary.end) {
    return lineCurveIntersectionsInfinite(boundary.start, boundary.end, fullCurve)
      .map((hit) => {
        const parameter = curveParameterAtPoint(fullCurve, hit.point)
        return parameter == null ? null : { point: hit.point, parameter }
      })
      .filter((hit): hit is SegmentHit => hit !== null)
  }
  if (boundaryCurve) {
    return curveCurveIntersections(fullCurve, boundaryCurve)
      .map((hit) => ({ point: hit.point, parameter: hit.firstParameter }))
  }
  if (boundary.type === 'polyline' && boundary.points && boundary.points.length >= 2) {
    const count = boundary.closed ? boundary.points.length : boundary.points.length - 1
    const hits: SegmentHit[] = []
    for (let index = 0; index < count; index++) {
      const start = boundary.points[index]
      const end = boundary.points[(index + 1) % boundary.points.length]
      hits.push(...segmentCurveIntersections(start, end, fullCurve).map((hit) => ({
        point: hit.point,
        parameter: hit.parameter,
      })))
    }
    return dedupeHits(hits)
  }
  return []
}

/** 将原始曲线参数转换为沿曲线方向的前进量。 */
function fullCurveProgress(curve: ParametricCurveGeometry, parameter: number): number {
  let delta = (parameter - curve.startParameter) * (curve.sweepParameter < 0 ? -1 : 1)
  const turn = Math.PI * 2
  delta = ((delta % turn) + turn) % turn
  return delta / turn
}

/** 选择指定开放曲线端点之外最近的边界交点。 */
function extensionProgress(
  curve: ParametricCurveGeometry,
  boundary: Entity,
  fromStart: boolean,
): number | null {
  if (isFullCurve(curve)) return null
  const visibleProgress = Math.abs(curve.sweepParameter) / (Math.PI * 2)
  const progresses = dedupeHits(curveBoundaryIntersections(curve, boundary))
    .map((hit) => fullCurveProgress(curve, hit.parameter))
  if (fromStart) {
    const beforeStart = progresses
      .filter((progress) => progress > EPSILON && progress < 1 - EPSILON)
      .map((progress) => (progress - 1) / visibleProgress)
    return beforeStart.length ? Math.max(...beforeStart) : null
  }
  const afterEnd = progresses.filter((progress) => progress > visibleProgress + EPSILON && progress < 1 - EPSILON)
  return afterEnd.length ? Math.min(...afterEnd) / visibleProgress : null
}

/**
 * 将开放直线或多段线延伸至最近的边界交点。
 * @param target 待延伸实体。
 * @param boundary 限定边界。
 * @param pickPoint 靠近待延伸端点的可选拾取点。
 * @returns 替换实体或失败原因。
 * @author snihao
 */
export function extendEntity(target: Entity, boundary: Entity, pickPoint?: Point): TopologyResult<Entity> {
  if (target.type === 'line' && target.start && target.end) {
    const point = pickPoint || midpointOfEntity(target)
    const startDistance = distance(point, target.start)
    const endDistance = distance(point, target.end)
    const endpoint = startDistance <= endDistance ? target.start : target.end
    const extension = infiniteLineBoundaryIntersection(target, boundary, endpoint)
    if (!extension) return fail('No boundary intersection beyond the endpoint')
    return success(endpoint === target.start ? replaceLinePart(target, extension, target.end) : replaceLinePart(target, target.start, extension))
  }
  const curve = curveForEntity(target)
  if (curve) {
    if (target.closed || isFullCurve(curve)) return fail('Only open curves can be extended')
    const point = pickPoint || midpointOfEntity(target)
    const start = curveStartPoint(curve)
    const end = curveEndPoint(curve)
    const fromStart = distance(point, start) <= distance(point, end)
    const progress = extensionProgress(curve, boundary, fromStart)
    if (progress == null) return fail('No boundary intersection beyond the endpoint')
    const result = fromStart
      ? curvePart(target, curve, progress, 1)
      : curvePart(target, curve, 0, progress)
    return result ? success(result) : fail('Curve extension would collapse the entity')
  }
  if (target.type === 'polyline' && !target.closed && (target.points || []).length >= 2) {
    const points = target.points!
    const point = pickPoint || midpointOfEntity(target)
    const first = distance(point, points[0]) <= distance(point, points[points.length - 1])
    const endpoint = first ? points[0] : points[points.length - 1]
    const neighbor = first ? points[1] : points[points.length - 2]
    const probe: Entity = { ...target, type: 'line', start: endpoint, end: [endpoint[0] + endpoint[0] - neighbor[0], endpoint[1] + endpoint[1] - neighbor[1]] }
    const extension = infiniteLineBoundaryIntersection(probe, boundary, endpoint)
    if (!extension) return fail('No boundary intersection beyond the endpoint')
    const result = cloneEntity(target, target.id)
    result.points = first ? [extension, ...points.slice(1)] : [...points.slice(0, -1), extension]
    result.curveGeometry = null
    result.sourceHandle = null
    result.sourceEdited = false
    return success(result)
  }
  return fail('Only open lines and polylines can be extended')
}

function breakLine(entity: Entity, firstPoint: Point, secondPoint?: Point): TopologyResult<Entity> {
  if (!entity.start || !entity.end) return fail('Line endpoints are missing')
  const first = clamp(segmentDistanceParameter(firstPoint, entity.start, entity.end), 0, 1)
  const second = secondPoint ? clamp(segmentDistanceParameter(secondPoint, entity.start, entity.end), 0, 1) : null
  const values = second == null ? [first] : [first, second].sort((a, b) => a - b)
  if (values[0] <= EPSILON || values[values.length - 1] >= 1 - EPSILON) return fail('Break point must lie inside the entity')
  const at = (value: number): Point => [round(entity.start![0] + (entity.end![0] - entity.start![0]) * value, 9), round(entity.start![1] + (entity.end![1] - entity.start![1]) * value, 9)]
  const points = values.map(at)
  const result = second == null
    ? [replaceLinePart(entity, entity.start, points[0]), replaceLinePart(entity, points[0], entity.end)]
    : [replaceLinePart(entity, entity.start, points[0]), replaceLinePart(entity, points[1], entity.end)]
  result[1].id = genId('break-line')
  return { ok: true, entities: result, entity: result[0] }
}

/** 将开放圆弧、椭圆弧或完整圆拆分为两段精确曲线。 */
function breakCurve(entity: Entity, firstPoint: Point, secondPoint?: Point): TopologyResult<Entity> {
  const curve = curveForEntity(entity)
  if (!curve) return fail('Entity does not contain a supported curve')
  const first = nearestPointOnCurveProgress(curve, firstPoint)
  const second = secondPoint == null ? null : nearestPointOnCurveProgress(curve, secondPoint)
  const values = second == null ? [first] : [first, second].sort((a, b) => a - b)
  if (values[0] <= EPSILON || values[values.length - 1] >= 1 - EPSILON) {
    return fail('Break point must lie inside the curve')
  }
  const left = curvePart(entity, curve, 0, values[0])
  const right = curvePart(entity, curve, values[values.length - 1], 1)
  if (!left || !right) return fail('Break point must lie inside the curve')
  right.id = genId('break-curve')
  return { ok: true, entities: [left, right], entity: left }
}

/**
 * 在一个点处打断直线或多段线，或删除两个点之间的中间段。
 * @param entity 源实体。
 * @param firstPoint 第一个打断点。
 * @param secondPoint 可选的第二个打断点。
 * @returns 替换实体集合或失败原因。
 * @author snihao
 */
export function breakEntity(entity: Entity, firstPoint: Point, secondPoint?: Point): TopologyResult<Entity> {
  if (curveForEntity(entity)) return breakCurve(entity, firstPoint, secondPoint)
  if (entity.type === 'line') return breakLine(entity, firstPoint, secondPoint)
  if (entity.type !== 'polyline' || entity.curveGeometry || (entity.points || []).length < 2) return fail('Only straight lines and polylines can be broken')
  const points = entity.points!
  const progress = (point: Point): { index: number; value: number; point: Point } => {
    let best = { index: 0, value: 0, point: points[0] }
    let bestDistance = Infinity
    for (let index = 0; index < points.length - 1; index++) {
      const nearest = nearestOnSegment(point, points[index], points[index + 1])
      const candidate = distance(point, [nearest.x, nearest.y])
      if (candidate < bestDistance) {
        bestDistance = candidate
        best = { index, value: nearest.t, point: [nearest.x, nearest.y] }
      }
    }
    return best
  }
  const first = progress(firstPoint)
  const second = secondPoint ? progress(secondPoint) : null
  if (second && (first.index > second.index || first.index === second.index && first.value > second.value)) return breakEntity(entity, secondPoint!, firstPoint)
  const split = (item: { index: number; value: number; point: Point }): Point[] => [
    ...points.slice(0, item.index + 1),
    item.point,
    ...points.slice(item.index + 1),
  ]
  const firstPoints = split(first)
  const firstIndex = first.index + 1
  const secondPoints = second ? split(second).slice(second.index + 1 + (second.index >= first.index ? 1 : 0)) : firstPoints.slice(firstIndex)
  const left = cloneEntity(entity, entity.id)
  left.points = firstPoints.slice(0, firstIndex + 1)
  left.closed = false
  left.curveGeometry = null
  const right = cloneEntity(entity, genId('break-polyline'))
  right.points = second ? [second.point, ...points.slice(second.index + 1)] : secondPoints
  right.closed = false
  right.curveGeometry = null
  if (left.points.length < 2 || right.points.length < 2) return fail('Break point must lie inside the polyline')
  left.sourceHandle = null
  left.sourceEdited = false
  right.sourceHandle = null
  right.sourceEdited = false
  return { ok: true, entities: [left, right], entity: left }
}

function endpoint(entity: Entity, end: 'start' | 'end'): Point | null {
  if (entity.type === 'line') return end === 'start' ? entity.start || null : entity.end || null
  if (entity.type === 'polyline' && entity.points?.length) return end === 'start' ? entity.points[0] : entity.points[entity.points.length - 1]
  const curve = curveForEntity(entity)
  return curve ? (end === 'start' ? curveStartPoint(curve) : curveEndPoint(curve)) : null
}

function reverseEntity(entity: Entity): Entity {
  const result = cloneEntity(entity, entity.id)
  if (result.type === 'line') {
    const start = result.start
    result.start = result.end
    result.end = start
  } else if (result.type === 'polyline' && result.points) {
    result.points = result.points.slice().reverse()
    if (result.curveGeometry) {
      const curve = result.curveGeometry
      curve.startParameter += curve.sweepParameter
      curve.sweepParameter *= -1
    }
  }
  return result
}

function sameCurveBasis(first: ParametricCurveGeometry, second: ParametricCurveGeometry, tolerance: number): boolean {
  return distance(first.center, second.center) <= tolerance
    && distance(first.axisX, second.axisX) <= tolerance
    && distance(first.axisY, second.axisY) <= tolerance
}

function curveJoin(first: Entity, second: Entity, tolerance: number): TopologyResult<Entity> | null {
  if (first.type !== 'polyline' || second.type !== 'polyline' || !first.curveGeometry || !second.curveGeometry) return null
  const candidates: Array<[Entity, Entity]> = [
    [first, second],
    [first, reverseEntity(second)],
    [reverseEntity(first), second],
    [reverseEntity(first), reverseEntity(second)],
  ]
  for (const [left, right] of candidates) {
    const leftCurve = left.curveGeometry
    const rightCurve = right.curveGeometry
    if (!leftCurve || !rightCurve || !sameCurveBasis(leftCurve, rightCurve, tolerance)) continue
    if (distance(curveEndPoint(leftCurve), curveStartPoint(rightCurve)) > tolerance) continue
    const result = cloneEntity(left, genId('join-arc'))
    result.type = 'polyline'
    result.curveGeometry = {
      ...leftCurve,
      sweepParameter: leftCurve.sweepParameter + rightCurve.sweepParameter,
    }
    result.points = sampleCurve(result.curveGeometry, curveSampleCount(result.curveGeometry))
    result.closed = isFullCurve(result.curveGeometry)
    result.sourceHandle = null
    result.sourceEdited = false
    return { ok: true, entity: result, entities: [result], consumedIds: [first.id, second.id] }
  }
  return fail('圆弧的中心、轴向或方向不兼容')
}

function lineJoin(first: Entity, second: Entity, tolerance: number): TopologyResult<Entity> {
  const firstParameterized = first.type === 'polyline' && !!first.curveGeometry
  const secondParameterized = second.type === 'polyline' && !!second.curveGeometry
  if (firstParameterized !== secondParameterized) {
    return fail('Parameterized arcs or ellipses cannot be joined with straight lines or polylines')
  }
  if (firstParameterized) return curveJoin(first, second, tolerance) || fail('Parameterized curves cannot be joined')
  const firstStart = endpoint(first, 'start')
  const firstEnd = endpoint(first, 'end')
  const secondStart = endpoint(second, 'start')
  const secondEnd = endpoint(second, 'end')
  if (!firstStart || !firstEnd || !secondStart || !secondEnd) return fail('Entities do not have joinable endpoints')
  const candidates: Array<[Entity, Entity]> = [
    [first, second],
    [first, reverseEntity(second)],
    [reverseEntity(first), second],
    [reverseEntity(first), reverseEntity(second)],
  ]
  for (const [left, right] of candidates) {
    const leftEnd = endpoint(left, 'end')!
    const rightStart = endpoint(right, 'start')!
    if (distance(leftEnd, rightStart) > tolerance) continue
    const leftStart = endpoint(left, 'start')!
    const rightEnd = endpoint(right, 'end')!
    const cross = (leftEnd[0] - leftStart[0]) * (rightEnd[1] - rightStart[1]) - (leftEnd[1] - leftStart[1]) * (rightEnd[0] - rightStart[0])
    if (Math.abs(cross) > tolerance * Math.max(distance(leftStart, leftEnd), distance(rightStart, rightEnd), 1)) return fail('Lines are not collinear')
    if (left.type === 'line' && right.type === 'line') {
      const result = cloneEntity(left, genId('join-line'))
      result.end = rightEnd
      result.sourceHandle = null
      result.sourceEdited = false
      return { ok: true, entity: result, entities: [result], consumedIds: [first.id, second.id] }
    }
    const leftPoints = left.type === 'line' ? [leftStart, leftEnd] : left.points || []
    const rightPoints = right.type === 'line' ? [rightStart, rightEnd] : right.points || []
    const result = cloneEntity(left, genId('join-polyline'))
    result.type = 'polyline'
    result.points = [...leftPoints, ...rightPoints.slice(1)]
    result.closed = false
    result.curveGeometry = null
    result.sourceHandle = null
    result.sourceEdited = false
    return { ok: true, entity: result, entities: [result], consumedIds: [first.id, second.id] }
  }
  return fail('Endpoints are not within the join tolerance')
}

/**
 * 将共线且端点相接的直线或多段线连接为一个实体。
 * @param entities 待连接实体。
 * @param tolerance 允许的最大端点间隙。
 * @returns 合并实体或失败原因。
 * @author snihao
 */
export function joinEntities(entities: Entity[], tolerance = 1e-4): TopologyResult<Entity> {
  if (entities.length < 2) return fail('Select at least two entities to join')
  let merged = entities[0]
  for (let index = 1; index < entities.length; index++) {
    const result = lineJoin(merged, entities[index], Math.max(tolerance, 1e-7))
    if (!result.ok || !result.entity) return result
    merged = result.entity
  }
  return { ok: true, entity: merged, entities: [merged], consumedIds: entities.map((entity) => entity.id) }
}

/**
 * 在不改变顶点的情况下切换多段线的闭合状态。
 * @param entity 待修改多段线。
 * @param closed 目标闭合状态。
 * @returns 替换多段线或失败原因。
 * @author snihao
 */
export function setPolylineClosed(entity: Entity, closed: boolean): TopologyResult<Entity> {
  if (entity.type !== 'polyline' || (entity.points || []).length < 2) return fail('Only polylines with two or more vertices can be closed')
  const result = cloneEntity(entity, entity.id)
  result.closed = closed
  result.sourceHandle = null
  result.sourceEdited = false
  return success(result)
}
