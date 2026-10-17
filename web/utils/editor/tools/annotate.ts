/** 线性标注工具：依次指定两个测量点和尺寸线位置。 */
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'
import type { Viewport } from '#draiq/utils/editor/viewport'
import type { SnapResult } from '#draiq/utils/editor/snapping/index'
import { pointReferenceFromCandidate } from '#draiq/utils/editor/associativeDimensions'
import { genId } from '#draiq/utils/editor/geometry'
import { createAlignedDimension } from '#draiq/utils/editor/factories/dimensionFactory'

export class AnnotateTool extends BaseTool {
  /** 第一个测量点 */
  private start: Point | null = null
  /** 第二个测量点 */
  private end: Point | null = null
  /** 当前光标位置（预览用） */
  private cursor: Point | null = null
  private startReference: PointReference | null = null
  private endReference: PointReference | null = null

  constructor(ctx: ToolContext) {
    super(ctx)
    this.reset()
  }

  onActivate(): void {
    this.reset()
    this.clearSnap()
    this.requestRender()
    this.status('标注：点击第一个测量点')
  }

  onDeactivate(): void {
    this.reset()
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    if (!this.canCreate()) {
      this.status('当前图层已锁定或冻结，无法创建实体')
      return
    }
    if (!this.start) {
      const resolved = this.resolvePoint(pt, { bypass: event.altKey })
      this.start = resolved.point.slice() as Point
      this.startReference = pointReferenceFromCandidate(resolved.candidate, resolved.point)
      this.cursor = null
      this.requestRender()
      this.status('标注：点击第二个测量点')
      return
    }
    if (!this.end) {
      const resolved = this.resolvePoint(pt, { anchor: this.start, bypass: event.altKey })
      this.acceptMeasurementEnd(resolved.point, pointReferenceFromCandidate(resolved.candidate, resolved.point))
      return
    }

    const resolved = this.resolvePoint(pt, { bypass: true, allowObjectSnap: false, allowAngleSnap: false })
    const { dimStart } = this.dimensionAt(resolved.point)
    const result = createAlignedDimension({
      id: genId('dim'),
      placement: dimStart,
      start: this.start,
      end: this.end,
      dimensionLinePosition: dimStart,
      textPositionManual: false,
      startReference: this.startReference,
      endReference: this.endReference,
    }, { drawing: this.drawing, defaults: this.defaults() })
    if (!result.ok) {
      this.status(result.error.message)
      return
    }
    const entity = result.entity
    this.drawing.entities.push(entity)
    this.select(entity.id)
    this.commit()
    this.reset()
    this.clearSnap()
    this.requestRender()
    this.finish()
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    if (!this.start) {
      this.resolvePoint(pt, { bypass: event.altKey })
      this.requestRender()
      return
    }
    const resolved = !this.end
      ? this.resolvePoint(pt, { anchor: this.start, bypass: event.altKey })
      : this.resolvePoint(pt, { bypass: true, allowObjectSnap: false, allowAngleSnap: false })
    this.cursor = resolved.point.slice() as Point
    this.requestRender()
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.start || !this.cursor) return
    const d = this.defaults()
    g.save()
    g.strokeStyle = d.color
    g.lineWidth = 1 / viewport.scale
    g.setLineDash([4 / viewport.scale, 3 / viewport.scale])
    g.beginPath()
    if (!this.end) {
      g.moveTo(this.start[0], this.start[1])
      g.lineTo(this.cursor[0], this.cursor[1])
    } else {
      const { dimStart, dimEnd } = this.dimensionAt(this.cursor)
      g.moveTo(this.start[0], this.start[1])
      g.lineTo(dimStart[0], dimStart[1])
      g.moveTo(this.end[0], this.end[1])
      g.lineTo(dimEnd[0], dimEnd[1])
      g.moveTo(dimStart[0], dimStart[1])
      g.lineTo(dimEnd[0], dimEnd[1])
    }
    g.stroke()
    g.restore()
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.start) return
    this.cursor = result.point.slice() as Point
    this.requestRender()
  }

  getDynamicInputAnchor(): Point | null {
    return this.start && !this.end ? this.start : null
  }

  onDynamicInputPreview(point: Point): void {
    if (!this.start || this.end) return
    this.cursor = point.slice() as Point
    this.requestRender()
  }

  onDynamicInput(point: Point): void {
    if (!this.start || this.end) return
    this.acceptMeasurementEnd(point)
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    this.reset()
    this.clearSnap()
    this.requestRender()
    this.status('标注：点击第一个测量点')
  }

  /** 根据光标位置计算平行于测量方向的尺寸线。 */
  private dimensionAt(point: Point): { dimStart: Point; dimEnd: Point; length: number } {
    const dx = this.end![0] - this.start![0]
    const dy = this.end![1] - this.start![1]
    const length = Math.max(Math.hypot(dx, dy), 1e-6)
    const nx = -dy / length
    const ny = dx / length
    const offset = (point[0] - this.start![0]) * nx + (point[1] - this.start![1]) * ny
    return {
      dimStart: [this.start![0] + nx * offset, this.start![1] + ny * offset],
      dimEnd: [this.end![0] + nx * offset, this.end![1] + ny * offset],
      length,
    }
  }

  /** 接收鼠标或键盘精确输入的第二个测量点。 */
  private acceptMeasurementEnd(point: Point, reference: PointReference | null = null): void {
    this.end = point.slice() as Point
    this.endReference = reference
    this.cursor = null
    this.requestRender()
    this.status('标注：点击尺寸线放置位置')
  }

  /** 清理本轮标注交互状态。 */
  private reset(): void {
    this.start = null
    this.end = null
    this.cursor = null
    this.startReference = null
    this.endReference = null
  }
}
