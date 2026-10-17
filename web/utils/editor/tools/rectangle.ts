/** 矩形工具：拖拽确定对角线，生成闭合多段线（4 顶点）。 */
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'
import type { Viewport } from '#draiq/utils/editor/viewport'
import type { SnapResult } from '#draiq/utils/editor/snapping/index'
import { genId, distance } from '#draiq/utils/editor/geometry'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'
import { rectanglePoints } from '#draiq/utils/editor/operations/shapeGeometry'

export class RectangleTool extends BaseTool {
  /** 矩形起点 */
  private start: Point | null = null
  /** 当前光标位置（预览用） */
  private cursor: Point | null = null

  constructor(ctx: ToolContext) {
    super(ctx)
    this.start = null
    this.cursor = null
  }

  onActivate(): void {
    this.start = null
    this.cursor = null
    this.clearSnap()
    this.requestRender()
    this.status('矩形：按住拖拽绘制对角线')
  }

  onDeactivate(): void {
    this.start = null
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    if (!this.canCreate()) {
      this.status('当前图层已锁定或冻结，无法创建实体')
      return
    }
    const resolved = this.resolvePoint(pt, { bypass: event.altKey, allowAngleSnap: false })
    this.start = resolved.point.slice() as Point
    this.cursor = null
    this.canvas.setPointerCapture(event.pointerId)
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    const resolved = this.resolvePoint(pt, {
      anchor: this.start,
      bypass: event.altKey,
      allowAngleSnap: false,
    })
    this.cursor = this.start ? resolved.point.slice() as Point : null
    this.requestRender()
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.start || !this.cursor) return
    const d = this.defaults()
    const x1 = this.start[0]
    const y1 = this.start[1]
    const x2 = this.cursor[0]
    const y2 = this.cursor[1]
    g.save()
    g.strokeStyle = d.color
    g.lineWidth = canvasLineWidth(d.lineWidth, viewport.scale)
    g.setLineDash([4, 3])
    g.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
    g.restore()
  }

  onPointerUp(event: PointerEvent, pt: ToolPoint): void {
    if (!this.start) return
    const resolved = this.resolvePoint(pt, {
      anchor: this.start,
      bypass: event.altKey,
      allowAngleSnap: false,
    })
    const x1 = this.start[0]
    const y1 = this.start[1]
    const x2 = resolved.point[0]
    const y2 = resolved.point[1]
    try {
      this.canvas.releasePointerCapture(event.pointerId)
    } catch (e) {
      // 忽略释放捕获异常
    }
    if (distance([x1, y1], [x2, y2]) > 1) {
      const d = this.defaults()
      const entity: Entity = {
        id: genId('rect'),
        type: 'polyline',
        layer: d.layer,
        color: d.color,
        lineWidth: d.lineWidth,
        lineType: d.lineType,
        closed: true,
        points: rectanglePoints([x1, y1], [x2, y2]),
      }
      this.drawing.entities.push(entity)
      this.select(entity.id)
      this.commit()
    }
    this.start = null
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.start) return
    this.cursor = result.point.slice() as Point
    this.requestRender()
  }
}
