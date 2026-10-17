import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'
import type { Viewport } from '#draiq/utils/editor/viewport'
import type { SnapCandidate, SnapResult } from '#draiq/utils/editor/snapping/index'
import {
  curveCircle,
  curveEndPoint,
  curveStartPoint,
  isFullCurve,
  nearestPointOnCurve,
  sampleCurve,
} from '#draiq/utils/editor/curveGeometry'
import { dimensionSegments, distance, genId, nearestOnSegment, round } from '#draiq/utils/editor/geometry'
import { isLayerFrozen } from '#draiq/utils/editor/layers'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'
import {
  createAngularDimension,
  createArcLengthDimension,
  createDiameterDimension,
  createOrdinateDimension,
  createRadiusDimension,
} from '#draiq/utils/editor/factories/dimensionFactory'

type ProfessionalDimensionMode = 'angular' | 'radius' | 'diameter' | 'arcLength' | 'ordinate'

interface SegmentPick {
  entity: Entity
  start: Point
  end: Point
  point: Point
  segmentIndex: number
}

interface CircularPick {
  entity: Entity
  center: Point
  radius: number
  measurement: Point
  curve: ParametricCurveGeometry | null
}

interface ArcPick extends CircularPick {
  curve: ParametricCurveGeometry
  start: Point
  end: Point
  sweep: number
}

interface FeaturePick {
  entity: Entity
  point: Point
}

interface AngularSelection {
  first: SegmentPick
  second: SegmentPick
  center: Point
}

const EPSILON = 1e-7
const TAU = Math.PI * 2

/** 原生专业标注工具：先选择可测量图元，再指定标注放置位置。 */
abstract class ProfessionalDimensionTool extends BaseTool {
  private readonly mode: ProfessionalDimensionMode
  private firstLine: SegmentPick | null = null
  private angularSelection: AngularSelection | null = null
  private circularSelection: CircularPick | null = null
  private arcSelection: ArcPick | null = null
  private featureSelection: FeaturePick | null = null
  private cursor: Point | null = null
  private ordinateType: OrdinateDimensionType = 'x'
  private ordinateTypeManual = false

  protected constructor(ctx: ToolContext, mode: ProfessionalDimensionMode) {
    super(ctx)
    this.mode = mode
  }

  onActivate(): void {
    this.reset()
    this.clearSnap()
    this.requestRender()
    this.status(this.statusText())
  }

  onDeactivate(): void {
    this.reset()
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, point: ToolPoint): void {
    if (!this.canCreate()) {
      this.status('当前图层已锁定或冻结，无法创建实体')
      return
    }

    if (this.isReadyForPlacement()) {
      const resolved = this.resolvePlacementPoint(event, point)
      this.inferOrdinateType(resolved.point)
      this.createEntity(resolved.point)
      return
    }

    const resolved = this.resolvePoint(point, {
      bypass: event.altKey,
      allowAngleSnap: false,
    })
    const rawPoint: Point = [point.x, point.y]
    if (this.mode === 'angular') this.selectAngularLine(rawPoint)
    else if (this.mode === 'radius' || this.mode === 'diameter') this.selectCircularEntity(rawPoint)
    else if (this.mode === 'arcLength') this.selectArcEntity(rawPoint)
    else this.selectFeature(rawPoint, resolved.candidate)
    this.cursor = null
    this.requestRender()
  }

  onPointerMove(event: PointerEvent, point: ToolPoint): void {
    if (!this.isReadyForPlacement()) {
      this.resolvePoint(point, { bypass: event.altKey, allowAngleSnap: false })
      this.cursor = null
      this.requestRender()
      return
    }
    const resolved = this.resolvePlacementPoint(event, point)
    this.cursor = resolved.point.slice() as Point
    if (this.inferOrdinateType(this.cursor)) this.status(this.statusText())
    this.requestRender()
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.isReadyForPlacement()) return
    this.cursor = result.point.slice() as Point
    if (this.inferOrdinateType(this.cursor)) this.status(this.statusText())
    this.requestRender()
  }

  /** 动态输入只用于最后的尺寸线或引线放置，不能替代图元选择。 */
  getDynamicInputAnchor(): Point | null {
    if (this.angularSelection) return this.angularSelection.center
    if (this.circularSelection) return this.circularSelection.measurement
    if (this.arcSelection) return this.arcSelection.center
    if (this.featureSelection) return this.featureSelection.point
    return null
  }

  onDynamicInputPreview(point: Point): void {
    if (!this.isReadyForPlacement()) return
    this.cursor = point.slice() as Point
    if (this.inferOrdinateType(this.cursor)) this.status(this.statusText())
    this.requestRender()
  }

  onDynamicInput(point: Point): void {
    if (!this.isReadyForPlacement()) return
    this.inferOrdinateType(point)
    this.createEntity(point)
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() === 'm' && this.mode === 'ordinate') {
      this.ordinateType = this.ordinateType === 'x' ? 'y' : 'x'
      this.ordinateTypeManual = true
      this.status(this.statusText())
      this.requestRender()
      return
    }
    if (event.key !== 'Escape') return
    this.reset()
    this.clearSnap()
    this.requestRender()
    this.status(this.statusText())
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    const defaults = this.defaults()
    g.save()
    g.strokeStyle = defaults.color
    g.fillStyle = defaults.color
    g.lineWidth = canvasLineWidth(defaults.lineWidth, viewport.scale, 1)
    g.setLineDash([5 / viewport.scale, 3 / viewport.scale])

    if (this.firstLine) this.strokeSegment(g, this.firstLine.start, this.firstLine.end)
    if (this.angularSelection) this.strokeSegment(g, this.angularSelection.second.start, this.angularSelection.second.end)
    if (this.circularSelection) this.strokeCircularPick(g, this.circularSelection)
    if (this.arcSelection) this.strokeCircularPick(g, this.arcSelection)
    if (this.featureSelection) this.drawPoint(g, this.featureSelection.point, viewport)

    if (this.cursor) {
      const preview = this.buildEntity(this.cursor, 'dimension-preview')
      if (preview) {
        for (const [start, end] of dimensionSegments(preview)) this.strokeSegment(g, start, end)
      }
      this.drawPoint(g, this.cursor, viewport)
    }
    g.restore()
  }

  private resolvePlacementPoint(event: PointerEvent, point: ToolPoint): SnapResult {
    return this.resolvePoint(point, {
      anchor: this.getDynamicInputAnchor(),
      bypass: event.altKey,
      allowObjectSnap: false,
      allowAngleSnap: true,
    })
  }

  private selectAngularLine(point: Point): void {
    const picked = this.pickSegment(point)
    if (!picked) {
      this.status(this.firstLine
        ? '未选中第二条直线，请在线段上单击'
        : '未选中直线，角度标注必须基于两条直线')
      return
    }
    if (!this.firstLine) {
      this.firstLine = picked
      this.status(this.statusText())
      return
    }
    if (sameSegment(this.firstLine, picked)) {
      this.status('请选择另一条直线')
      return
    }
    const center = infiniteLineIntersection(this.firstLine.start, this.firstLine.end, picked.start, picked.end)
    if (!center) {
      this.status('所选直线平行或重合，无法创建角度标注')
      return
    }
    this.angularSelection = { first: this.firstLine, second: picked, center }
    this.status(this.statusText())
  }

  private selectCircularEntity(point: Point): void {
    const picked = this.pickCircular(point, false)
    if (!picked) {
      this.status(`${this.mode === 'radius' ? '半径' : '直径'}标注只支持圆或圆弧，请在有效曲线上单击`)
      return
    }
    this.circularSelection = picked
    this.status(this.statusText())
  }

  private selectArcEntity(point: Point): void {
    const picked = this.pickCircular(point, true)
    if (!picked || !picked.curve || isFullCurve(picked.curve)) {
      this.status('弧长标注只支持非闭合圆弧，请在有效圆弧上单击')
      return
    }
    const endpoints = orientedArcEndpoints(picked.curve)
    if (!endpoints) {
      this.status('所选圆弧过短或参数无效，无法创建弧长标注')
      return
    }
    this.arcSelection = {
      ...picked,
      curve: picked.curve,
      start: endpoints.start,
      end: endpoints.end,
      sweep: endpoints.sweep,
    }
    this.status(this.statusText())
  }

  private selectFeature(point: Point, candidate: SnapCandidate | null): void {
    const picked = this.pickFeature(point, candidate)
    if (!picked) {
      this.status('坐标标注必须基于现有图元，请在直线、曲线或圆上单击')
      return
    }
    this.featureSelection = picked
    this.ordinateTypeManual = false
    this.status(this.statusText())
  }

  private createEntity(location: Point): void {
    const entity = this.buildEntity(location, genId(`dim-${this.mode}`))
    if (!entity) {
      this.status(this.invalidPlacementText())
      this.cursor = location.slice() as Point
      this.requestRender()
      return
    }
    this.drawing.entities.push(entity)
    this.select(entity.id)
    this.commit()
    this.reset()
    this.clearSnap()
    this.requestRender()
    this.status(this.statusText())
  }

  private buildEntity(location: Point, id: string): Entity | null {
    const context = { drawing: this.drawing, defaults: this.defaults() }
    if (this.mode === 'angular' && this.angularSelection) {
      const { first, second } = this.angularSelection
      const result = createAngularDimension({
        id,
        placement: location,
        first,
        second,
      }, context)
      return result.ok ? result.entity : null
    }

    if ((this.mode === 'radius' || this.mode === 'diameter') && this.circularSelection) {
      const { center, measurement } = this.circularSelection
      const source = {
        entityId: this.circularSelection.entity.id,
        kind: this.circularSelection.entity.type === 'circle' ? 'circle' as const : 'curve' as const,
      }
      const result = this.mode === 'radius'
        ? createRadiusDimension({ id, placement: location, center, measurement, source }, context)
        : createDiameterDimension({ id, placement: location, center, measurement, source }, context)
      return result.ok ? result.entity : null
    }

    if (this.mode === 'arcLength' && this.arcSelection) {
      const { center, start, end, sweep } = this.arcSelection
      const result = createArcLengthDimension({
        id,
        placement: location,
        center,
        start,
        end,
        sweep,
        source: {
          entityId: this.arcSelection.entity.id,
          kind: 'curve',
        },
      }, context)
      return result.ok ? result.entity : null
    }

    if (this.mode === 'ordinate' && this.featureSelection) {
      const feature = this.featureSelection.point
      const result = createOrdinateDimension({
        id,
        placement: location,
        feature,
        ordinateType: this.ordinateType,
      }, context)
      return result.ok ? result.entity : null
    }
    return null
  }

  private pickSegment(point: Point): SegmentPick | null {
    const tolerance = this.viewport.hitTol()
    return this.findPickedEntity((entity) => {
      const segments = straightSegments(entity)
      let best: SegmentPick | null = null
      let bestDistance = Infinity
      for (const segment of segments) {
        const nearest = nearestOnSegment(point, segment.start, segment.end)
        const candidatePoint: Point = [nearest.x, nearest.y]
        const candidateDistance = distance(point, candidatePoint)
        if (candidateDistance > tolerance || candidateDistance >= bestDistance) continue
        bestDistance = candidateDistance
        best = { entity, ...segment, point: candidatePoint }
      }
      return best
    })
  }

  private pickCircular(point: Point, arcOnly: boolean): CircularPick | null {
    const tolerance = this.viewport.hitTol()
    return this.findPickedEntity((entity) => {
      if (entity.type === 'circle' && !arcOnly && entity.center && entity.radius && entity.radius > EPSILON) {
        const measurement = nearestPointOnCircle(entity.center, entity.radius, point)
        if (distance(measurement, point) > tolerance) return null
        return {
          entity,
          center: entity.center.slice() as Point,
          radius: entity.radius,
          measurement,
          curve: null,
        }
      }
      if (entity.type !== 'polyline' || !entity.curveGeometry) return null
      const circle = curveCircle(entity.curveGeometry)
      if (!circle || circle.radius <= EPSILON) return null
      if (arcOnly && isFullCurve(entity.curveGeometry)) return null
      const nearest = nearestPointOnCurve(entity.curveGeometry, point)
      if (distance(nearest.point, point) > tolerance) return null
      return {
        entity,
        center: circle.center,
        radius: circle.radius,
        measurement: nearest.point,
        curve: entity.curveGeometry,
      }
    })
  }

  private pickFeature(point: Point, candidate: SnapCandidate | null): FeaturePick | null {
    const tolerance = this.viewport.hitTol()
    return this.findPickedEntity((entity) => {
      const candidateBelongsToEntity = candidate?.entityId === entity.id || candidate?.relatedEntityId === entity.id
      if (candidateBelongsToEntity) {
        return { entity, point: candidate!.point.slice() as Point }
      }
      const nearest = nearestPointOnEntity(entity, point)
      if (!nearest || distance(nearest, point) > tolerance) return null
      return { entity, point: nearest }
    })
  }

  private findPickedEntity<T>(pick: (entity: Entity) => T | null): T | null {
    const visit = (entities: Entity[]): T | null => {
      for (let index = entities.length - 1; index >= 0; index--) {
        const entity = entities[index]
        if (isLayerFrozen(this.drawing, entity.layer)) continue
        if (entity.type === 'group') {
          const nested = visit(entity.children || [])
          if (nested) return nested
          continue
        }
        const result = pick(entity)
        if (result) return result
      }
      return null
    }
    return visit(this.drawing.entities)
  }

  private inferOrdinateType(location: Point): boolean {
    if (this.mode !== 'ordinate' || !this.featureSelection || this.ordinateTypeManual) return false
    const dx = Math.abs(location[0] - this.featureSelection.point[0])
    const dy = Math.abs(location[1] - this.featureSelection.point[1])
    const nextType: OrdinateDimensionType = dy >= dx ? 'x' : 'y'
    if (nextType === this.ordinateType) return false
    this.ordinateType = nextType
    return true
  }

  private isReadyForPlacement(): boolean {
    if (this.mode === 'angular') return !!this.angularSelection
    if (this.mode === 'radius' || this.mode === 'diameter') return !!this.circularSelection
    if (this.mode === 'arcLength') return !!this.arcSelection
    return !!this.featureSelection
  }

  private statusText(): string {
    if (this.mode === 'angular') {
      if (this.angularSelection) return '角度标注：指定尺寸弧位置'
      return this.firstLine ? '角度标注：请选择第二条非平行直线' : '角度标注：请选择第一条直线'
    }
    if (this.mode === 'radius') return this.circularSelection ? '半径标注：指定标注文字位置' : '半径标注：请选择圆或圆弧'
    if (this.mode === 'diameter') return this.circularSelection ? '直径标注：指定标注文字位置' : '直径标注：请选择圆或圆弧'
    if (this.mode === 'arcLength') return this.arcSelection ? '弧长标注：指定尺寸弧位置' : '弧长标注：请选择非闭合圆弧'
    return this.featureSelection
      ? `坐标标注（${this.ordinateType.toUpperCase()}）：指定引线终点，M 切换方向`
      : '坐标标注：请选择现有图元上的坐标点'
  }

  private invalidPlacementText(): string {
    if (this.mode === 'angular') return '尺寸弧位置不能与两直线交点重合，请重新指定'
    if (this.mode === 'arcLength') return '尺寸弧位置不能与圆心重合，请重新指定'
    if (this.mode === 'ordinate') return '引线终点不能与坐标点重合，请重新指定'
    return '标注位置无效，请重新指定'
  }

  private strokeSegment(g: CanvasRenderingContext2D, start: Point, end: Point): void {
    g.beginPath()
    g.moveTo(start[0], start[1])
    g.lineTo(end[0], end[1])
    g.stroke()
  }

  private strokeCircularPick(g: CanvasRenderingContext2D, picked: CircularPick): void {
    if (!picked.curve) {
      g.beginPath()
      g.arc(picked.center[0], picked.center[1], picked.radius, 0, TAU)
      g.stroke()
      return
    }
    const points = sampleCurve(picked.curve, 64)
    g.beginPath()
    points.forEach((point, index) => index ? g.lineTo(point[0], point[1]) : g.moveTo(point[0], point[1]))
    g.stroke()
  }

  private drawPoint(g: CanvasRenderingContext2D, point: Point, viewport: Viewport): void {
    g.beginPath()
    g.arc(point[0], point[1], 2.5 / viewport.scale, 0, TAU)
    g.fill()
  }

  private reset(): void {
    this.firstLine = null
    this.angularSelection = null
    this.circularSelection = null
    this.arcSelection = null
    this.featureSelection = null
    this.cursor = null
    this.ordinateType = 'x'
    this.ordinateTypeManual = false
  }
}

/** 两直线角度标注工具。 */
export class AngularDimensionTool extends ProfessionalDimensionTool {
  constructor(ctx: ToolContext) { super(ctx, 'angular') }
}

/** 圆或圆弧半径标注工具。 */
export class RadiusDimensionTool extends ProfessionalDimensionTool {
  constructor(ctx: ToolContext) { super(ctx, 'radius') }
}

/** 圆或圆弧直径标注工具。 */
export class DiameterDimensionTool extends ProfessionalDimensionTool {
  constructor(ctx: ToolContext) { super(ctx, 'diameter') }
}

/** 圆弧长度标注工具。 */
export class ArcLengthDimensionTool extends ProfessionalDimensionTool {
  constructor(ctx: ToolContext) { super(ctx, 'arcLength') }
}

/** 基于现有几何特征点的坐标标注工具。 */
export class OrdinateDimensionTool extends ProfessionalDimensionTool {
  constructor(ctx: ToolContext) { super(ctx, 'ordinate') }
}

function straightSegments(entity: Entity): Array<{ start: Point; end: Point; segmentIndex: number }> {
  if (entity.type === 'line' && entity.start && entity.end && distance(entity.start, entity.end) > EPSILON) {
    return [{ start: entity.start, end: entity.end, segmentIndex: 0 }]
  }
  if (entity.type !== 'polyline' || entity.curveGeometry || !entity.points || entity.points.length < 2) return []
  const result: Array<{ start: Point; end: Point; segmentIndex: number }> = []
  const count = entity.closed ? entity.points.length : entity.points.length - 1
  for (let index = 0; index < count; index++) {
    const start = entity.points[index]
    const end = entity.points[(index + 1) % entity.points.length]
    if (distance(start, end) > EPSILON) result.push({ start, end, segmentIndex: index })
  }
  return result
}

function nearestPointOnEntity(entity: Entity, point: Point): Point | null {
  if (entity.type === 'circle' && entity.center && entity.radius && entity.radius > EPSILON) {
    return nearestPointOnCircle(entity.center, entity.radius, point)
  }
  if (entity.type === 'polyline' && entity.curveGeometry) {
    return nearestPointOnCurve(entity.curveGeometry, point).point
  }
  let best: Point | null = null
  let bestDistance = Infinity
  for (const segment of straightSegments(entity)) {
    const nearest = nearestOnSegment(point, segment.start, segment.end)
    const candidate: Point = [nearest.x, nearest.y]
    const candidateDistance = distance(point, candidate)
    if (candidateDistance >= bestDistance) continue
    best = candidate
    bestDistance = candidateDistance
  }
  return best
}

function nearestPointOnCircle(center: Point, radius: number, point: Point): Point {
  const dx = point[0] - center[0]
  const dy = point[1] - center[1]
  const length = Math.hypot(dx, dy)
  if (length < EPSILON) return [center[0] + radius, center[1]]
  return [center[0] + dx / length * radius, center[1] + dy / length * radius]
}

function sameSegment(first: SegmentPick, second: SegmentPick): boolean {
  return first.entity.id === second.entity.id && first.segmentIndex === second.segmentIndex
}

function infiniteLineIntersection(firstStart: Point, firstEnd: Point, secondStart: Point, secondEnd: Point): Point | null {
  const firstDirection: Point = [firstEnd[0] - firstStart[0], firstEnd[1] - firstStart[1]]
  const secondDirection: Point = [secondEnd[0] - secondStart[0], secondEnd[1] - secondStart[1]]
  const denominator = cross(firstDirection, secondDirection)
  const scale = Math.max(distance(firstStart, firstEnd) * distance(secondStart, secondEnd), EPSILON)
  if (Math.abs(denominator) / scale < 1e-7) return null
  const delta: Point = [secondStart[0] - firstStart[0], secondStart[1] - firstStart[1]]
  const parameter = cross(delta, secondDirection) / denominator
  const result: Point = [
    round(firstStart[0] + firstDirection[0] * parameter, 9),
    round(firstStart[1] + firstDirection[1] * parameter, 9),
  ]
  return Number.isFinite(result[0]) && Number.isFinite(result[1]) ? result : null
}

function orientedArcEndpoints(curve: ParametricCurveGeometry): { start: Point; end: Point; sweep: number } | null {
  const requestedSweep = Math.abs(curve.sweepParameter)
  if (requestedSweep < EPSILON || requestedSweep >= TAU - EPSILON) return null
  let start = curveStartPoint(curve)
  let end = curveEndPoint(curve)
  const center = curve.center
  let sweep = positiveAngle(
    Math.atan2(end[1] - center[1], end[0] - center[0])
      - Math.atan2(start[1] - center[1], start[0] - center[0]),
  )
  if (Math.abs(sweep - requestedSweep) > Math.abs((TAU - sweep) - requestedSweep)) {
    ;[start, end] = [end, start]
    sweep = TAU - sweep
  }
  if (Math.abs(sweep - requestedSweep) > 1e-5) return null
  return { start, end, sweep: requestedSweep }
}

function cross(first: Point, second: Point): number {
  return first[0] * second[1] - first[1] * second[0]
}

function positiveAngle(value: number): number {
  return (value % TAU + TAU) % TAU
}
