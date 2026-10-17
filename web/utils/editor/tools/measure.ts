/** 测量工具：查询实体几何或连续测量两点，不创建图纸实体。 */
import type { SnapResult } from '#draiq/utils/editor/snapping/index'
import type { Viewport } from '#draiq/utils/editor/viewport'
import { measureBetweenPoints, measureCoordinate, measureEntity } from '#draiq/utils/editor/measurement'
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolPoint } from '#draiq/utils/editor/tools/base'

/** 实体测量、两点距离和坐标查询工具。 @author snihao */
export class MeasureTool extends BaseTool {
  private start: Point | null = null
  private cursor: Point | null = null
  private mode: 'distance' | 'coordinate' = 'distance'

  onActivate(): void {
    this.start = null
    this.cursor = null
    this.setMeasurement(null)
    this.clearSnap()
    this.requestRender()
    this.status(this.modeStatus())
  }

  onDeactivate(): void {
    this.start = null
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    const worldPoint: Point = [pt.x, pt.y]
    const resolved = this.resolvePoint(pt, {
      anchor: this.start,
      bypass: event.altKey,
      allowAngleSnap: !!this.start,
    })
    if (this.mode === 'coordinate') {
      this.setMeasurement(measureCoordinate(resolved.point, this.state.drawing.unit))
      this.status('已查询坐标；继续点击查询，K 切换两点测量')
      return
    }

    const hit = !this.start && !event.shiftKey
      ? this.ctx.renderer.hitTest(worldPoint, this.state, this.viewport)
      : null
    if (hit) {
      const result = measureEntity(hit, this.state.drawing.unit)
      if (result) {
        this.setMeasurement(result)
        this.status(`${result.title}：已更新测量结果，Shift+点击可改为两点测量`)
        return
      }
    }

    if (!this.start) {
      this.start = resolved.point.slice() as Point
      this.cursor = null
      this.status('测量：指定第二个点')
      this.requestRender()
      return
    }
    this.acceptSecondPoint(resolved.point)
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    const resolved = this.resolvePoint(pt, {
      anchor: this.start,
      bypass: event.altKey,
      allowAngleSnap: !!this.start,
    })
    this.cursor = resolved.point.slice() as Point
    this.requestRender()
  }

  getDynamicInputAnchor(): Point | null {
    return this.start
  }

  onDynamicInputPreview(point: Point): void {
    if (!this.start) return
    this.cursor = point.slice() as Point
    this.requestRender()
  }

  onDynamicInput(point: Point): void {
    if (!this.start) return
    this.acceptSecondPoint(point)
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.start) return
    this.cursor = result.point.slice() as Point
    this.requestRender()
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() === 'k') {
      this.mode = this.mode === 'distance' ? 'coordinate' : 'distance'
      this.start = null
      this.cursor = null
      this.setMeasurement(null)
      this.clearSnap()
      this.requestRender()
      this.status(this.modeStatus())
      return
    }
    if (event.key !== 'Escape') return
    this.start = null
    this.cursor = null
    this.setMeasurement(null)
    this.clearSnap()
    this.requestRender()
    this.status('已清除测量结果')
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.start || !this.cursor || this.mode !== 'distance') return
    g.save()
    g.strokeStyle = '#B23B3B'
    g.fillStyle = '#B23B3B'
    g.lineWidth = 1.2 / viewport.scale
    g.setLineDash([5 / viewport.scale, 3 / viewport.scale])
    g.beginPath()
    g.moveTo(this.start[0], this.start[1])
    g.lineTo(this.cursor[0], this.cursor[1])
    g.stroke()
    g.setLineDash([])
    for (const point of [this.start, this.cursor]) {
      g.beginPath()
      g.arc(point[0], point[1], 2.5 / viewport.scale, 0, Math.PI * 2)
      g.fill()
    }
    g.restore()
  }

  private acceptSecondPoint(point: Point): void {
    if (!this.start) return
    const result = measureBetweenPoints(this.start, point, this.state.drawing.unit)
    this.setMeasurement(result)
    this.start = point.slice() as Point
    this.cursor = null
    this.status('两点测量已更新；继续点击下一点，K 切换坐标查询')
    this.requestRender()
  }

  private modeStatus(): string {
    return this.mode === 'distance'
      ? '测量：点击实体查询几何，空白处连续点击测距离（K 切换坐标）'
      : '坐标查询：点击捕捉点读取坐标（K 切换两点测量）'
  }
}
