import { distance, midpoint, nearestOnSegment, round } from '#draiq/utils/editor/geometry'
import {
  circleCurveGeometry,
  curveCurveIntersections,
  curveEndPoint,
  curveMidpoint,
  curveQuadrantPoints,
  curveStartPoint,
  curveTangentPoints,
  isFullCurve,
  nearestPointOnCurve,
  segmentCurveIntersections,
} from '#draiq/utils/editor/curveGeometry'
import type { Viewport } from '#draiq/utils/editor/viewport'
import { SnapIndex } from '#draiq/utils/editor/snapping/snapIndex'
import type { SnapCirclePrimitive, SnapCurvePrimitive, SnapSegmentPrimitive } from '#draiq/utils/editor/snapping/snapIndex'
import type {
  DraftingSettings,
  SnapCandidate,
  SnapGuide,
  SnapKind,
  SnapMarker,
  SnapMeasurement,
  SnapResolveOptions,
  SnapResult,
} from '#draiq/utils/editor/snapping/types'

const LABELS: Record<SnapKind, string> = {
  tangent: '切点',
  endpoint: '端点',
  midpoint: '中点',
  center: '圆心',
  quadrant: '象限点',
  intersection: '交点',
  perpendicular: '垂足',
  nearest: '最近点',
  polar: '极轴',
  orthogonal: '正交',
}

const SCORE_BIAS: Record<SnapKind, number> = {
  tangent: 0.9,
  endpoint: 0,
  intersection: 0.35,
  quadrant: 0.6,
  midpoint: 0.75,
  center: 0.75,
  perpendicular: 1,
  nearest: 12,
  polar: 2,
  orthogonal: 2,
}

/** 辅助符号的最小屏幕间距，避免低缩放时不同世界点重叠绘制。 */
const MARKER_MIN_SPACING_PX = 28
/** 单次悬浮最多绘制的辅助符号数，避免密集图纸遮挡光标。 */
const MAX_VISIBLE_MARKERS = 3

/** 统一处理对象捕捉、方向约束和动态量测。 */
export class SnapEngine {
  private readonly index = new SnapIndex()
  private currentResult: SnapResult | null = null
  private cycleCandidates: SnapCandidate[] = []
  private currentViewport: Viewport | null = null

  /** 当前结果由渲染循环读取，用于绘制瞬时辅助层。 */
  get current(): SnapResult | null {
    return this.currentResult
  }

  /** 图元结构或几何变化后重建空间索引。 */
  rebuild(drawing: Drawing): void {
    this.index.rebuild(drawing)
  }

  /** 清除当前悬浮和量测反馈。 */
  clear(): void {
    this.currentResult = null
    this.cycleCandidates = []
    this.currentViewport = null
  }

  /** 在当前捕捉半径内循环切换重合或邻近候选。 */
  cycle(): SnapResult | null {
    if (!this.currentResult || this.cycleCandidates.length < 2 || !this.currentViewport) return null
    const currentIndex = this.currentResult.candidate
      ? this.cycleCandidates.findIndex((item) => sameCandidate(item, this.currentResult!.candidate!))
      : -1
    const candidate = this.cycleCandidates[(currentIndex + 1 + this.cycleCandidates.length) % this.cycleCandidates.length]
    const anchor = this.currentResult.measurement?.anchor || null
    const markerCandidates = dedupeMarkerCandidates(this.cycleCandidates, this.currentViewport, candidate)
    this.currentResult = {
      ...this.currentResult,
      point: candidate.point.slice() as Point,
      candidate,
      guide: null,
      measurement: anchor ? createMeasurement(anchor, candidate.point) : null,
      markers: markerCandidates.map((marker) => ({
        ...marker,
        active: sameCandidate(marker, candidate),
      })),
    }
    return this.currentResult
  }

  /** 将原始世界坐标解析为最终绘图点。 */
  resolve(
    rawPoint: Point,
    viewport: Viewport,
    settings: DraftingSettings,
    options: SnapResolveOptions = {},
  ): SnapResult {
    this.currentViewport = viewport
    const anchor = options.anchor || null
    const bypass = options.bypass === true
    const allowObjectSnap = !bypass && settings.snapEnabled && options.allowObjectSnap !== false
    const allowAngleSnap = !bypass && options.allowAngleSnap !== false
    const previousCandidate = this.currentResult?.candidate || null
    const capturePx = Math.max(settings.hoverTolerancePx, settings.tolerancePx * 1.4)
    const captureWorld = capturePx / Math.max(viewport.scale, 1e-9)
    const nearby = allowObjectSnap
      ? this.index.query({
          minX: rawPoint[0] - captureWorld,
          minY: rawPoint[1] - captureWorld,
          maxX: rawPoint[0] + captureWorld,
          maxY: rawPoint[1] + captureWorld,
        })
      : []
    const excluded = options.excludeEntityIds
    const nearbySegments: SnapSegmentPrimitive[] = []
    const nearbyCircles: SnapCirclePrimitive[] = []
    const nearbyCurves: SnapCurvePrimitive[] = []
    const hotSegments: SnapSegmentPrimitive[] = []
    const hotCircles: SnapCirclePrimitive[] = []
    const hotCurves: SnapCurvePrimitive[] = []
    const candidates: SnapCandidate[] = []

    for (const primitive of nearby) {
      if (excluded?.has(primitive.entityId)) continue
      if (primitive.type === 'segment') {
        nearbySegments.push(primitive)
        const nearest = nearestOnSegment(rawPoint, primitive.start, primitive.end)
        const nearestPoint: Point = [nearest.x, nearest.y]
        if (distance(rawPoint, nearestPoint) * viewport.scale > capturePx) continue
        hotSegments.push(primitive)
        if (settings.endpointEnabled) {
          candidates.push(this.candidate(primitive.start, 'endpoint', primitive.entityId, primitive.segmentIndex, 0, rawPoint, viewport))
          candidates.push(this.candidate(primitive.end, 'endpoint', primitive.entityId, primitive.segmentIndex, 1, rawPoint, viewport))
        }
        if (settings.midpointEnabled) {
          candidates.push(this.candidate(midpoint(primitive.start, primitive.end), 'midpoint', primitive.entityId, primitive.segmentIndex, 0.5, rawPoint, viewport))
        }
        if (settings.nearestEnabled) {
          candidates.push(this.candidate(nearestPoint, 'nearest', primitive.entityId, primitive.segmentIndex, nearest.t, rawPoint, viewport))
        }
        if (anchor && settings.perpendicularEnabled) {
          const foot = nearestOnSegment(anchor, primitive.start, primitive.end)
          const footPoint: Point = [foot.x, foot.y]
          if (foot.t > 1e-6 && foot.t < 1 - 1e-6 && distance(rawPoint, footPoint) * viewport.scale <= capturePx) {
            candidates.push(this.candidate(footPoint, 'perpendicular', primitive.entityId, primitive.segmentIndex, foot.t, rawPoint, viewport))
          }
        }
      } else if (primitive.type === 'circle') {
        nearbyCircles.push(primitive)
        const centerDistance = distance(rawPoint, primitive.center)
        const edgeDistance = Math.abs(centerDistance - primitive.radius)
        if (edgeDistance * viewport.scale > capturePx && centerDistance * viewport.scale > capturePx) continue
        hotCircles.push(primitive)
        if (settings.centerEnabled) {
          candidates.push(this.candidate(primitive.center, 'center', primitive.entityId, null, null, rawPoint, viewport))
        }
        if (settings.quadrantEnabled) {
          for (const [index, point] of circleQuadrants(primitive).entries()) {
            candidates.push(this.candidate(point, 'quadrant', primitive.entityId, null, index, rawPoint, viewport))
          }
        }
        if (settings.nearestEnabled && centerDistance > 1e-9) {
          const ratio = primitive.radius / centerDistance
          const point: Point = [
            primitive.center[0] + (rawPoint[0] - primitive.center[0]) * ratio,
            primitive.center[1] + (rawPoint[1] - primitive.center[1]) * ratio,
          ]
          const angle = Math.atan2(point[1] - primitive.center[1], point[0] - primitive.center[0])
          candidates.push(this.candidate(point, 'nearest', primitive.entityId, null, angle, rawPoint, viewport))
        }
        if (anchor && centerDistance > 1e-9) {
          const curve = circleCurveGeometry(primitive.center, primitive.radius)
          if (settings.perpendicularEnabled) {
            const anchorDistance = distance(anchor, primitive.center)
            if (anchorDistance > 1e-9) {
              const ux = (anchor[0] - primitive.center[0]) / anchorDistance
              const uy = (anchor[1] - primitive.center[1]) / anchorDistance
              for (const sign of [-1, 1]) {
                const foot: Point = [
                  primitive.center[0] + ux * primitive.radius * sign,
                  primitive.center[1] + uy * primitive.radius * sign,
                ]
                const parameter = Math.atan2(foot[1] - primitive.center[1], foot[0] - primitive.center[0])
                candidates.push(this.candidate(foot, 'perpendicular', primitive.entityId, null, parameter, rawPoint, viewport))
              }
            }
          }
          if (settings.tangentEnabled) {
            for (const tangent of curveTangentPoints(curve, anchor)) {
              candidates.push(this.candidate(tangent.point, 'tangent', primitive.entityId, null, tangent.parameter, rawPoint, viewport))
            }
          }
        }
      } else {
        nearbyCurves.push(primitive)
        const curve = primitive.curve
        const nearest = nearestPointOnCurve(curve, rawPoint)
        const edgeDistance = distance(rawPoint, nearest.point)
        const centerDistance = distance(rawPoint, curve.center)
        if (edgeDistance * viewport.scale > capturePx && centerDistance * viewport.scale > capturePx) continue
        hotCurves.push(primitive)

        if (!isFullCurve(curve) && settings.endpointEnabled) {
          candidates.push(this.candidate(curveStartPoint(curve), 'endpoint', primitive.entityId, null, curve.startParameter, rawPoint, viewport))
          candidates.push(this.candidate(curveEndPoint(curve), 'endpoint', primitive.entityId, null, curve.startParameter + curve.sweepParameter, rawPoint, viewport))
        }
        if (!isFullCurve(curve) && settings.midpointEnabled) {
          candidates.push(this.candidate(curveMidpoint(curve), 'midpoint', primitive.entityId, null, curve.startParameter + curve.sweepParameter / 2, rawPoint, viewport))
        }
        if (settings.centerEnabled) {
          candidates.push(this.candidate(curve.center, 'center', primitive.entityId, null, null, rawPoint, viewport))
        }
        if (settings.quadrantEnabled) {
          for (const quadrant of curveQuadrantPoints(curve)) {
            candidates.push(this.candidate(quadrant.point, 'quadrant', primitive.entityId, null, quadrant.parameter, rawPoint, viewport))
          }
        }
        if (settings.nearestEnabled) {
          candidates.push(this.candidate(nearest.point, 'nearest', primitive.entityId, null, nearest.parameter, rawPoint, viewport))
        }
        if (anchor && settings.perpendicularEnabled) {
          const foot = nearestPointOnCurve(curve, anchor)
          candidates.push(this.candidate(foot.point, 'perpendicular', primitive.entityId, null, foot.parameter, rawPoint, viewport))
        }
        if (anchor && settings.tangentEnabled) {
          for (const tangent of curveTangentPoints(curve, anchor)) {
            candidates.push(this.candidate(tangent.point, 'tangent', primitive.entityId, null, tangent.parameter, rawPoint, viewport))
          }
        }
      }
    }

    if (allowObjectSnap) {
      for (const extra of options.extraPoints || []) {
        if (distance(rawPoint, extra.point) * viewport.scale > capturePx) continue
        candidates.push(this.candidate(extra.point, extra.kind, null, null, null, rawPoint, viewport, extra.label))
      }
    }

    if (settings.intersectionEnabled) {
      for (let left = 0; left < nearbySegments.length; left++) {
        for (let right = left + 1; right < nearbySegments.length; right++) {
          const first = nearbySegments[left]
          const second = nearbySegments[right]
          if (first.entityId === second.entityId && Math.abs(first.segmentIndex - second.segmentIndex) <= 1) continue
          const point = segmentIntersection(first.start, first.end, second.start, second.end)
          if (!point || distance(rawPoint, point) * viewport.scale > capturePx) continue
          candidates.push(this.candidate(
            point, 'intersection', first.entityId, first.segmentIndex, null, rawPoint, viewport,
            LABELS.intersection, second.entityId, second.segmentIndex,
          ))
        }
      }
      for (const segment of nearbySegments) {
        for (const circle of nearbyCircles) {
          if (segment.entityId === circle.entityId) continue
          for (const point of segmentCircleIntersections(segment.start, segment.end, circle.center, circle.radius)) {
            if (distance(rawPoint, point) * viewport.scale <= capturePx) {
              candidates.push(this.candidate(
                point, 'intersection', segment.entityId, segment.segmentIndex, null, rawPoint, viewport,
                LABELS.intersection, circle.entityId, null,
              ))
            }
          }
        }
      }
      for (const segment of nearbySegments) {
        for (const curve of nearbyCurves) {
          if (segment.entityId === curve.entityId) continue
          for (const intersection of segmentCurveIntersections(segment.start, segment.end, curve.curve)) {
            if (distance(rawPoint, intersection.point) * viewport.scale <= capturePx) {
              candidates.push(this.candidate(
                intersection.point, 'intersection', segment.entityId, segment.segmentIndex, null, rawPoint, viewport,
                LABELS.intersection, curve.entityId, null,
              ))
            }
          }
        }
      }
      for (let left = 0; left < nearbyCircles.length; left++) {
        for (let right = left + 1; right < nearbyCircles.length; right++) {
          for (const point of circleCircleIntersections(nearbyCircles[left], nearbyCircles[right])) {
            if (distance(rawPoint, point) * viewport.scale <= capturePx) {
              candidates.push(this.candidate(
                point, 'intersection', nearbyCircles[left].entityId, null, null, rawPoint, viewport,
                LABELS.intersection, nearbyCircles[right].entityId, null,
              ))
            }
          }
        }
      }
      for (const circle of nearbyCircles) {
        const circleCurve = circleCurveGeometry(circle.center, circle.radius)
        for (const curve of nearbyCurves) {
          if (circle.entityId === curve.entityId) continue
          for (const intersection of curveCurveIntersections(circleCurve, curve.curve)) {
            if (distance(rawPoint, intersection.point) * viewport.scale <= capturePx) {
              candidates.push(this.candidate(
                intersection.point, 'intersection', circle.entityId, null, intersection.firstParameter, rawPoint, viewport,
                LABELS.intersection, curve.entityId, null,
              ))
            }
          }
        }
      }
      for (let left = 0; left < nearbyCurves.length; left++) {
        for (let right = left + 1; right < nearbyCurves.length; right++) {
          const first = nearbyCurves[left]
          const second = nearbyCurves[right]
          if (first.entityId === second.entityId) continue
          for (const intersection of curveCurveIntersections(first.curve, second.curve)) {
            if (distance(rawPoint, intersection.point) * viewport.scale <= capturePx) {
              candidates.push(this.candidate(
                intersection.point, 'intersection', first.entityId, null, intersection.firstParameter, rawPoint, viewport,
                LABELS.intersection, second.entityId, null,
              ))
            }
          }
        }
      }
    }

    // 仅保留捕捉悬浮范围内的候选点。图元本身可能靠近光标，但它的端点、
    // 中点或圆心可能在屏幕上很远；这些点不应出现在辅助层中，也不会参与本次捕捉。
    const visibleCandidates = candidates.filter((candidate) => candidate.distancePx <= capturePx)
    const uniqueCandidates = dedupeCandidates(visibleCandidates)
    const toleranceCandidates = uniqueCandidates
      .filter((candidate) => candidate.distancePx <= settings.tolerancePx)
      .sort((a, b) => candidateScore(a) - candidateScore(b))
    this.cycleCandidates = toleranceCandidates
    const retainedCandidate = previousCandidate && !isDirectionKind(previousCandidate.kind)
      ? uniqueCandidates.find((candidate) => sameCandidate(candidate, previousCandidate)
          && candidate.distancePx <= settings.tolerancePx * 1.4) || null
      : null
    const objectCandidate = retainedCandidate || toleranceCandidates[0] || null
    let point: Point = objectCandidate
      ? objectCandidate.point.slice() as Point
      : [round(rawPoint[0]), round(rawPoint[1])]
    let candidate = objectCandidate
    let guide: SnapGuide | null = null

    if (!candidate && anchor && allowAngleSnap) {
      if (settings.orthoEnabled) {
        const constrained = constrainOrthogonal(anchor, rawPoint)
        point = constrained.point
        candidate = this.candidate(point, 'orthogonal', null, null, null, rawPoint, viewport, constrained.label)
        guide = createGuide(anchor, point, 'orthogonal', viewport.scale)
      } else if (settings.polarEnabled) {
        const constrained = constrainPolar(anchor, rawPoint, settings.polarIncrement, settings.tolerancePx, viewport.scale)
        if (constrained) {
          point = constrained.point
          candidate = this.candidate(point, 'polar', null, null, null, rawPoint, viewport, `极轴 ${formatAngle(constrained.angle)}°`)
          guide = createGuide(anchor, point, 'polar', viewport.scale)
        }
      }
    }

    const measurement = anchor ? createMeasurement(anchor, point) : null
    // 候选集合继续保留完整结果供吸附和 Tab 循环使用；辅助层只在悬浮范围内
    // 聚焦当前最佳图元，并按屏幕距离抑制重叠点。
    const markerCandidates = dedupeMarkerCandidates(uniqueCandidates, viewport, objectCandidate)
    const markers: SnapMarker[] = markerCandidates.map((item) => ({
      ...item,
      active: !!objectCandidate && sameCandidate(item, objectCandidate),
    }))
    const result: SnapResult = {
      rawPoint: rawPoint.slice() as Point,
      point,
      candidate,
      markers,
      hoverSegments: dedupeSegments(hotSegments).map((segment) => ({ start: segment.start, end: segment.end })),
      hoverCircles: dedupeCircles(hotCircles).map((circle) => ({ center: circle.center, radius: circle.radius })),
      hoverCurves: dedupeCurves(hotCurves).map((curve) => ({ curve: curve.curve })),
      guide,
      measurement,
    }
    this.currentResult = result
    return result
  }

  /** 构造候选并统一计算屏幕距离。 */
  private candidate(
    point: Point,
    kind: SnapKind,
    entityId: string | null,
    segmentIndex: number | null,
    t: number | null,
    rawPoint: Point,
    viewport: Viewport,
    label = LABELS[kind],
    relatedEntityId: string | null = null,
    relatedSegmentIndex: number | null = null,
  ): SnapCandidate {
    return {
      point: point.slice() as Point,
      kind,
      label,
      entityId,
      segmentIndex,
      t,
      relatedEntityId,
      relatedSegmentIndex,
      distancePx: distance(rawPoint, point) * viewport.scale,
    }
  }
}

/** 有限线段交点；共线重叠不返回不唯一的交点。 */
export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r: Point = [b[0] - a[0], b[1] - a[1]]
  const s: Point = [d[0] - c[0], d[1] - c[1]]
  const denominator = cross(r, s)
  if (Math.abs(denominator) < 1e-9) return null
  const delta: Point = [c[0] - a[0], c[1] - a[1]]
  const t = cross(delta, s) / denominator
  const u = cross(delta, r) / denominator
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null
  return [a[0] + t * r[0], a[1] + t * r[1]]
}

/** 有限线段与圆的交点。 */
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
  const parameters = discriminant <= 1e-9
    ? [-b / (2 * a)]
    : [(-b - root) / (2 * a), (-b + root) / (2 * a)]
  return parameters
    .filter((value) => value >= -1e-9 && value <= 1 + 1e-9)
    .map((value) => [start[0] + value * dx, start[1] + value * dy] as Point)
}

/** 两个圆的交点；同心重合圆不返回不唯一结果。 */
function circleCircleIntersections(first: SnapCirclePrimitive, second: SnapCirclePrimitive): Point[] {
  const dx = second.center[0] - first.center[0]
  const dy = second.center[1] - first.center[1]
  const centerDistance = Math.hypot(dx, dy)
  if (centerDistance < 1e-9) return []
  if (centerDistance > first.radius + second.radius + 1e-9) return []
  if (centerDistance < Math.abs(first.radius - second.radius) - 1e-9) return []
  const along = (first.radius * first.radius - second.radius * second.radius + centerDistance * centerDistance) / (2 * centerDistance)
  const heightSquared = first.radius * first.radius - along * along
  if (heightSquared < -1e-9) return []
  const height = Math.sqrt(Math.max(0, heightSquared))
  const ux = dx / centerDistance
  const uy = dy / centerDistance
  const base: Point = [first.center[0] + along * ux, first.center[1] + along * uy]
  if (height <= 1e-9) return [base]
  return [
    [base[0] - uy * height, base[1] + ux * height],
    [base[0] + uy * height, base[1] - ux * height],
  ]
}

function circleQuadrants(circle: SnapCirclePrimitive): Point[] {
  const [x, y] = circle.center
  const radius = circle.radius
  return [[x + radius, y], [x, y + radius], [x - radius, y], [x, y - radius]]
}

/** CAD 角度：画布 Y 轴向下，因此显示角度需要反转 dy。 */
export function cadAngle(anchor: Point, point: Point): number {
  const degrees = Math.atan2(anchor[1] - point[1], point[0] - anchor[0]) * 180 / Math.PI
  return (degrees % 360 + 360) % 360
}

/** 根据 CAD 距离和角度计算画布世界坐标点，零度向右、逆时针为正。 */
export function pointFromCadPolar(anchor: Point, length: number, angle: number): Point {
  const radians = angle * Math.PI / 180
  return [
    roundCoordinate(anchor[0] + length * Math.cos(radians)),
    roundCoordinate(anchor[1] - length * Math.sin(radians)),
  ]
}

function createMeasurement(anchor: Point, point: Point): SnapMeasurement {
  return { anchor, point, length: distance(anchor, point), angle: cadAngle(anchor, point) }
}

function constrainOrthogonal(anchor: Point, rawPoint: Point): { point: Point; label: string } {
  const dx = rawPoint[0] - anchor[0]
  const dy = rawPoint[1] - anchor[1]
  if (Math.abs(dx) >= Math.abs(dy)) {
    const angle = dx >= 0 ? 0 : 180
    return { point: [roundCoordinate(rawPoint[0]), anchor[1]], label: `正交 ${angle}°` }
  }
  const angle = dy <= 0 ? 90 : 270
  return { point: [anchor[0], roundCoordinate(rawPoint[1])], label: `正交 ${angle}°` }
}

function constrainPolar(
  anchor: Point,
  rawPoint: Point,
  incrementDegrees: number,
  tolerancePx: number,
  scale: number,
): { point: Point; angle: number } | null {
  const dx = rawPoint[0] - anchor[0]
  const dy = rawPoint[1] - anchor[1]
  const lengthPx = Math.hypot(dx, dy) * scale
  if (lengthPx < 12) return null
  const increment = Math.max(1, Math.min(180, incrementDegrees)) * Math.PI / 180
  const rawAngle = Math.atan2(dy, dx)
  const snappedAngle = Math.round(rawAngle / increment) * increment
  const ux = Math.cos(snappedAngle)
  const uy = Math.sin(snappedAngle)
  const projectedLength = dx * ux + dy * uy
  if (projectedLength <= 0) return null
  const point: Point = [
    roundCoordinate(anchor[0] + ux * projectedLength),
    roundCoordinate(anchor[1] + uy * projectedLength),
  ]
  if (distance(rawPoint, point) * scale > tolerancePx) return null
  return { point, angle: cadAngle(anchor, point) }
}

function createGuide(anchor: Point, point: Point, kind: SnapGuide['kind'], scale: number): SnapGuide {
  const dx = point[0] - anchor[0]
  const dy = point[1] - anchor[1]
  const length = Math.max(Math.hypot(dx, dy), 1e-9)
  const extension = 30 / Math.max(scale, 1e-9)
  return {
    start: anchor.slice() as Point,
    end: [point[0] + dx / length * extension, point[1] + dy / length * extension],
    kind,
  }
}

function candidateScore(candidate: SnapCandidate): number {
  return candidate.distancePx + SCORE_BIAS[candidate.kind]
}

function dedupeCandidates(candidates: SnapCandidate[]): SnapCandidate[] {
  const sorted = candidates.slice().sort((a, b) => candidateScore(a) - candidateScore(b))
  const result: SnapCandidate[] = []
  for (const candidate of sorted) {
    if (result.some((item) => samePoint(item.point, candidate.point))) continue
    result.push(candidate)
  }
  return result
}

/** 按屏幕像素去重仅用于绘制，优先保留当前激活点和候选评分更高的点。 */
function dedupeMarkerCandidates(
  candidates: SnapCandidate[],
  viewport: Viewport,
  activeCandidate: SnapCandidate | null,
): SnapCandidate[] {
  // 端点是最明确的建点语义。一旦当前结果已经吸附到端点，只显示
  // 当前激活端点，避免大悬浮半径或低缩放把其它语义符号堆到光标周围。
  if (activeCandidate?.kind === 'endpoint') return [activeCandidate]
  const focus = activeCandidate || candidates.slice().sort((a, b) => candidateScore(a) - candidateScore(b))[0] || null
  if (!focus) return []
  const focusedCandidates = candidates.filter((candidate) => markerSharesFocus(candidate, focus))
  const sorted = focusedCandidates.sort((a, b) => {
    const aActive = !!activeCandidate && sameCandidate(a, activeCandidate)
    const bActive = !!activeCandidate && sameCandidate(b, activeCandidate)
    if (aActive !== bActive) return aActive ? -1 : 1
    return candidateScore(a) - candidateScore(b)
  })
  const result: SnapCandidate[] = []
  for (const candidate of sorted) {
    const [x, y] = viewport.toScreen(candidate.point[0], candidate.point[1])
    const overlaps = result.some((item) => {
      const [otherX, otherY] = viewport.toScreen(item.point[0], item.point[1])
      return Math.hypot(x - otherX, y - otherY) < MARKER_MIN_SPACING_PX
    })
    if (!overlaps) result.push(candidate)
    if (result.length >= MAX_VISIBLE_MARKERS) break
  }
  return result
}

/** 将辅助显示聚焦到当前最佳候选所属的线段或图元，避免邻近图元同时铺满屏幕。 */
function markerSharesFocus(candidate: SnapCandidate, focus: SnapCandidate): boolean {
  if (sameCandidate(candidate, focus)) return true
  if (focus.kind === 'intersection' || isDirectionKind(focus.kind)) return false
  if (focus.entityId == null) return candidate.entityId == null && candidate.kind === focus.kind
  return candidate.entityId === focus.entityId && candidate.segmentIndex === focus.segmentIndex
}

function dedupeSegments(segments: SnapSegmentPrimitive[]): SnapSegmentPrimitive[] {
  const keys = new Set<string>()
  return segments.filter((segment) => {
    const key = `${segment.entityId}:${segment.segmentIndex}`
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

function dedupeCircles(circles: SnapCirclePrimitive[]): SnapCirclePrimitive[] {
  const ids = new Set<string>()
  return circles.filter((circle) => {
    if (ids.has(circle.entityId)) return false
    ids.add(circle.entityId)
    return true
  })
}

function dedupeCurves(curves: SnapCurvePrimitive[]): SnapCurvePrimitive[] {
  const ids = new Set<string>()
  return curves.filter((curve) => {
    if (ids.has(curve.entityId)) return false
    ids.add(curve.entityId)
    return true
  })
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) <= 1e-7 && Math.abs(a[1] - b[1]) <= 1e-7
}

function sameCandidate(a: SnapCandidate, b: SnapCandidate): boolean {
  return a.kind === b.kind
    && a.entityId === b.entityId
    && a.segmentIndex === b.segmentIndex
    && a.relatedEntityId === b.relatedEntityId
    && a.relatedSegmentIndex === b.relatedSegmentIndex
    && a.label === b.label
    && samePoint(a.point, b.point)
}

function isDirectionKind(kind: SnapKind): boolean {
  return kind === 'polar' || kind === 'orthogonal'
}

function cross(a: Point, b: Point): number {
  return a[0] * b[1] - a[1] * b[0]
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function formatAngle(angle: number): string {
  const rounded = Math.round(angle * 10) / 10
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)
}
