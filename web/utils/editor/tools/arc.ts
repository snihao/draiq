/** 原生圆弧工具：支持三点、圆心和起点-终点-半径三种参数曲线方式。 */
import { arcFromCenter, arcFromStartEndRadius, arcThroughThreePoints } from '#draiq/utils/editor/curveDrawing'
import { sampleDrawingCurve } from '#draiq/utils/editor/curveDrawing'
import type { Viewport } from '#draiq/utils/editor/viewport'
import { genId } from '#draiq/utils/editor/geometry'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolPoint } from '#draiq/utils/editor/tools/base'
import type { SnapResult } from '#draiq/utils/editor/snapping/index'

/** 三点圆弧绘制工具。 @author snihao */
export class ArcTool extends BaseTool {
  private points: Point[] = []
  private cursor: Point | null = null
  private mode: 'threePoint' | 'center' | 'radius' = 'threePoint'

  onActivate(): void {
    this.points = []
    this.cursor = null
    this.clearSnap()
    this.requestRender()
    this.status(this.modeStatus())
  }

  onDeactivate(): void {
    this.points = []
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    if (!this.canCreate()) {
      this.status('当前图层已锁定或冻结，无法创建实体')
      return
    }
    const anchor = this.points[this.points.length - 1] || null
    const resolved = this.resolvePoint(pt, { anchor, bypass: event.altKey, allowAngleSnap: true })
    this.appendPoint(resolved.point)
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    const anchor = this.points[this.points.length - 1] || null
    const resolved = this.resolvePoint(pt, { anchor, bypass: event.altKey, allowAngleSnap: true })
    this.cursor = this.points.length ? resolved.point.slice() as Point : null
    this.requestRender()
  }

  getDynamicInputAnchor(): Point | null {
    return this.points[this.points.length - 1] || null
  }

  onDynamicInputPreview(point: Point): void {
    if (!this.points.length) return
    this.cursor = point.slice() as Point
    this.requestRender()
  }

  onDynamicInput(point: Point): void {
    if (!this.points.length) return
    this.appendPoint(point)
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.points.length) return
    this.cursor = result.point.slice() as Point
    this.requestRender()
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() === 'm') {
      this.mode = this.mode === 'threePoint'
        ? 'center'
        : this.mode === 'center'
          ? 'radius'
          : 'threePoint'
      this.points = []
      this.cursor = null
      this.clearSnap()
      this.requestRender()
      this.status(this.modeStatus())
      return
    }
    if (event.key !== 'Escape') return
    this.points = []
    this.cursor = null
    this.clearSnap()
    this.requestRender()
    this.status('已取消圆弧绘制')
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.points.length) return
    const defaults = this.defaults()
    g.save()
    g.strokeStyle = defaults.color
    g.lineWidth = canvasLineWidth(defaults.lineWidth, viewport.scale)
    g.setLineDash([4, 3])
    if (this.points.length < 2 || !this.cursor) {
      const last = this.points[this.points.length - 1]
      if (this.cursor) {
        g.beginPath()
        g.moveTo(last[0], last[1])
        g.lineTo(this.cursor[0], this.cursor[1])
        g.stroke()
      }
    } else if (this.cursor) {
      const curve = this.previewCurve(this.cursor)
      if (curve) {
        const points = sampleDrawingCurve(curve, viewport.scale)
        g.beginPath()
        g.moveTo(points[0][0], points[0][1])
        for (let index = 1; index < points.length; index++) g.lineTo(points[index][0], points[index][1])
        g.stroke()
      }
    }
    g.setLineDash([])
    for (const point of this.points) {
      g.beginPath()
      g.arc(point[0], point[1], 2 / viewport.scale, 0, Math.PI * 2)
      g.fillStyle = defaults.color
      g.fill()
    }
    g.restore()
  }

  private appendPoint(point: Point): void {
    this.points.push(point.slice() as Point)
    this.cursor = null
    if (this.points.length < 3) {
      this.requestRender()
      const next = this.mode === 'threePoint'
        ? (this.points.length === 1 ? '圆弧：指定必经点' : '圆弧：指定终点')
        : this.mode === 'center'
          ? (this.points.length === 1 ? '圆弧：指定起点' : '圆弧：指定终点')
          : (this.points.length === 1 ? '圆弧：指定终点' : '圆弧：指定半径方向')
      this.status(next)
      return
    }
    const curve = this.previewCurve(this.points[2])
    if (!curve) {
      this.points = this.points.slice(0, 2)
      this.status(this.mode === 'radius' ? '半径必须不小于起点到终点弦长的一半' : '三点接近共线，无法构造圆弧')
      this.requestRender()
      return
    }
    const defaults = this.defaults()
    const entity: Entity = {
      id: genId('arc'),
      type: 'polyline',
      layer: defaults.layer,
      color: defaults.color,
      lineWidth: defaults.lineWidth,
      lineType: defaults.lineType,
      curveGeometry: curve,
      points: sampleDrawingCurve(curve, this.viewport.scale),
      closed: false,
    }
    this.drawing.entities.push(entity)
    this.select(entity.id)
    this.commit()
    this.points = []
    this.clearSnap()
    this.requestRender()
    this.status(this.modeStatus())
  }

  /** 根据当前模式构造预览或最终曲线。 @param point 当前终点。 @returns 参数曲线或空值。 @author snihao */
  private previewCurve(point: Point): ParametricCurveGeometry | null {
    if (this.mode === 'threePoint') return arcThroughThreePoints(this.points[0], this.points[1], point)
    if (this.mode === 'center') return arcFromCenter(this.points[0], this.points[1], point)
    const radius = Math.hypot(point[0] - this.points[1][0], point[1] - this.points[1][1])
    return arcFromStartEndRadius(this.points[0], this.points[1], radius, point)
  }

  /** 返回当前圆弧模式的状态提示。 */
  private modeStatus(): string {
    if (this.mode === 'threePoint') return '圆弧：指定起点、必经点和终点（M 切换模式）'
    if (this.mode === 'center') return '圆弧：指定圆心、起点和终点（M 切换模式）'
    return '圆弧：指定起点、终点和半径方向（长度字段可精确输入半径）'
  }
}
