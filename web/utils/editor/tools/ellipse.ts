/** 原生椭圆工具：支持完整椭圆和椭圆弧参数曲线。 */
import { ellipseArcFromAxis, ellipseFromAxis, sampleDrawingCurve } from '#draiq/utils/editor/curveDrawing'
import type { Viewport } from '#draiq/utils/editor/viewport'
import { genId } from '#draiq/utils/editor/geometry'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolPoint } from '#draiq/utils/editor/tools/base'
import type { SnapResult } from '#draiq/utils/editor/snapping/index'

/** 完整椭圆和椭圆弧绘制工具。 @author snihao */
export class EllipseTool extends BaseTool {
  private center: Point | null = null
  private majorEndpoint: Point | null = null
  private minorRadius: number | null = null
  private arcStart: Point | null = null
  private cursor: Point | null = null
  private mode: 'full' | 'arc' = 'full'

  onActivate(): void {
    this.resetSketch()
    this.clearSnap()
    this.requestRender()
    this.status(this.modeStatus())
  }

  onDeactivate(): void {
    this.resetSketch()
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    if (!this.canCreate()) {
      this.status('当前图层已锁定或冻结，无法创建实体')
      return
    }
    const resolved = this.resolvePoint(pt, {
      anchor: this.dynamicAnchor(),
      bypass: event.altKey,
      allowAngleSnap: !this.majorEndpoint,
    })
    const point = resolved.point
    if (!this.center) {
      this.center = point.slice() as Point
      this.status('椭圆：指定长轴端点')
    } else if (!this.majorEndpoint) {
      this.majorEndpoint = point.slice() as Point
      this.status('椭圆：指定短轴半径')
    } else if (this.minorRadius == null) {
      if (!this.setMinorRadius(point)) return
      if (this.mode === 'full') this.completeEllipse(point)
      else this.status('椭圆弧：指定起点')
    } else if (this.mode === 'arc' && !this.arcStart) {
      this.arcStart = point.slice() as Point
      this.status('椭圆弧：指定终点')
    } else {
      this.completeEllipse(point)
      return
    }
    this.cursor = null
    this.requestRender()
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    const resolved = this.resolvePoint(pt, {
      anchor: this.dynamicAnchor(),
      bypass: event.altKey,
      allowAngleSnap: !this.majorEndpoint,
    })
    this.cursor = this.center ? resolved.point.slice() as Point : null
    this.requestRender()
  }

  getDynamicInputAnchor(): Point | null {
    return this.dynamicAnchor()
  }

  onDynamicInputPreview(point: Point): void {
    if (!this.center) return
    this.cursor = point.slice() as Point
    this.requestRender()
  }

  onDynamicInput(point: Point): void {
    if (!this.center) return
    if (!this.majorEndpoint) {
      this.majorEndpoint = point.slice() as Point
      this.cursor = null
      this.status('椭圆：指定短轴半径')
      this.requestRender()
      return
    }
    if (this.minorRadius == null) {
      if (!this.setMinorRadius(point)) return
      if (this.mode === 'full') this.completeEllipse(point)
      else this.status('椭圆弧：指定起点')
      this.requestRender()
      return
    }
    if (this.mode === 'arc' && !this.arcStart) {
      this.arcStart = point.slice() as Point
      this.cursor = null
      this.status('椭圆弧：指定终点')
      this.requestRender()
      return
    }
    this.completeEllipse(point)
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.center) return
    this.cursor = result.point.slice() as Point
    this.requestRender()
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() === 'm') {
      this.mode = this.mode === 'full' ? 'arc' : 'full'
      this.resetSketch()
      this.clearSnap()
      this.requestRender()
      this.status(this.modeStatus())
      return
    }
    if (event.key !== 'Escape') return
    this.resetSketch()
    this.clearSnap()
    this.requestRender()
    this.status('已取消椭圆绘制')
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.center) return
    const defaults = this.defaults()
    g.save()
    g.strokeStyle = defaults.color
    g.lineWidth = canvasLineWidth(defaults.lineWidth, viewport.scale)
    g.setLineDash([4, 3])

    if (!this.majorEndpoint && this.cursor) {
      g.beginPath()
      g.moveTo(this.center[0], this.center[1])
      g.lineTo(this.cursor[0], this.cursor[1])
      g.stroke()
    } else if (this.majorEndpoint && this.minorRadius == null && this.cursor) {
      this.drawCurve(g, this.buildRadiusCurve(this.cursor), viewport)
    } else if (this.minorRadius != null && this.mode === 'arc' && !this.arcStart) {
      this.drawCurve(g, this.buildFullCurve(), viewport)
    } else if (this.cursor) {
      this.drawCurve(g, this.buildCurve(this.cursor), viewport)
    }

    g.setLineDash([])
    for (const point of [this.center, this.majorEndpoint, this.arcStart]) {
      if (!point) continue
      g.beginPath()
      g.arc(point[0], point[1], 2 / viewport.scale, 0, Math.PI * 2)
      g.fillStyle = defaults.color
      g.fill()
    }
    g.restore()
  }

  /** 根据当前模式创建最终曲线并提交一个历史记录。 */
  private completeEllipse(point: Point): void {
    const curve = this.buildCurve(point)
    if (!curve) {
      this.status(this.mode === 'arc' ? '椭圆弧起点和终点不能重合' : '短轴半径必须大于零')
      return
    }
    const defaults = this.defaults()
    const entity: Entity = {
      id: genId('ellipse'),
      type: 'polyline',
      layer: defaults.layer,
      color: defaults.color,
      lineWidth: defaults.lineWidth,
      lineType: defaults.lineType,
      curveGeometry: curve,
      points: sampleDrawingCurve(curve, this.viewport.scale),
      closed: this.mode === 'full',
    }
    this.drawing.entities.push(entity)
    this.select(entity.id)
    this.commit()
    this.resetSketch()
    this.clearSnap()
    this.requestRender()
    this.status(this.modeStatus())
  }

  /** 计算当前点相对长轴的垂距，并记录短轴半径。 */
  private setMinorRadius(point: Point): boolean {
    if (!this.center || !this.majorEndpoint) return false
    const axisX: Point = [this.majorEndpoint[0] - this.center[0], this.majorEndpoint[1] - this.center[1]]
    const majorLength = Math.hypot(axisX[0], axisX[1])
    if (majorLength < 1e-8) {
      this.status('长轴长度必须大于零')
      return false
    }
    const vector: Point = [point[0] - this.center[0], point[1] - this.center[1]]
    const radius = Math.abs(axisX[0] * vector[1] - axisX[1] * vector[0]) / majorLength
    if (radius < 1e-8) {
      this.status('短轴半径必须大于零')
      return false
    }
    this.minorRadius = radius
    return true
  }

  private buildRadiusCurve(point: Point): ParametricCurveGeometry | null {
    if (!this.center || !this.majorEndpoint) return null
    const axisX: Point = [this.majorEndpoint[0] - this.center[0], this.majorEndpoint[1] - this.center[1]]
    const majorLength = Math.hypot(axisX[0], axisX[1])
    if (majorLength < 1e-8) return null
    const vector: Point = [point[0] - this.center[0], point[1] - this.center[1]]
    const radius = Math.abs(axisX[0] * vector[1] - axisX[1] * vector[0]) / majorLength
    return ellipseFromAxis(this.center, this.majorEndpoint, radius)
  }

  private buildFullCurve(): ParametricCurveGeometry | null {
    if (!this.center || !this.majorEndpoint || this.minorRadius == null) return null
    return ellipseFromAxis(this.center, this.majorEndpoint, this.minorRadius)
  }

  private buildCurve(point: Point): ParametricCurveGeometry | null {
    const full = this.buildFullCurve()
    if (!full) return null
    if (this.mode === 'full') return full
    if (!this.arcStart) return null
    return ellipseArcFromAxis(this.center!, this.majorEndpoint!, this.minorRadius!, this.arcStart, point)
  }

  private drawCurve(g: CanvasRenderingContext2D, curve: ParametricCurveGeometry | null, viewport: Viewport): void {
    if (!curve) return
    const points = sampleDrawingCurve(curve, viewport.scale)
    g.beginPath()
    g.moveTo(points[0][0], points[0][1])
    for (let index = 1; index < points.length; index++) g.lineTo(points[index][0], points[index][1])
    g.stroke()
  }

  private dynamicAnchor(): Point | null {
    if (this.mode === 'arc' && this.minorRadius != null) return this.center
    return this.majorEndpoint || this.center
  }

  private resetSketch(): void {
    this.center = null
    this.majorEndpoint = null
    this.minorRadius = null
    this.arcStart = null
    this.cursor = null
  }

  private modeStatus(): string {
    return this.mode === 'full'
      ? '椭圆：指定中心、长轴端点和短轴半径（M 切换椭圆弧）'
      : '椭圆弧：指定中心、长轴端点、短轴半径、起点和终点（M 切换完整椭圆）'
  }
}
