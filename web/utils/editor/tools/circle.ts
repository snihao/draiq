/** 圆形工具：从中心拖拽到边缘确定半径。 */
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'
import type { Viewport } from '#draiq/utils/editor/viewport'
import type { SnapResult } from '#draiq/utils/editor/snapping/index'
import { round, distance } from '#draiq/utils/editor/geometry'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'
import { createCircleEntity } from '#draiq/utils/editor/factories/entityFactory'

export class CircleTool extends BaseTool {
  /** 圆心 */
  private center: Point | null = null
  /** 当前光标位置（预览用） */
  private cursor: Point | null = null

  constructor(ctx: ToolContext) {
    super(ctx)
    this.center = null
    this.cursor = null
  }

  onActivate(): void {
    this.center = null
    this.cursor = null
    this.clearSnap()
    this.requestRender()
    this.status('圆形：按住从中心拖拽到边缘')
  }

  onDeactivate(): void {
    this.center = null
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
    this.center = resolved.point.slice() as Point
    this.cursor = null
    this.canvas.setPointerCapture(event.pointerId)
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    const resolved = this.resolvePoint(pt, {
      anchor: this.center,
      bypass: event.altKey,
      allowAngleSnap: false,
    })
    this.cursor = this.center ? resolved.point.slice() as Point : null
    this.requestRender()
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.center || !this.cursor) return
    const d = this.defaults()
    const r = distance(this.center, this.cursor)
    g.save()
    g.strokeStyle = d.color
    g.lineWidth = canvasLineWidth(d.lineWidth, viewport.scale)
    g.setLineDash([4, 3])
    g.beginPath()
    g.arc(this.center[0], this.center[1], r, 0, Math.PI * 2)
    g.stroke()
    g.restore()
  }

  onPointerUp(event: PointerEvent, pt: ToolPoint): void {
    if (!this.center) return
    const resolved = this.resolvePoint(pt, {
      anchor: this.center,
      bypass: event.altKey,
      allowAngleSnap: false,
    })
    const radius = distance(this.center, resolved.point)
    const r = resolved.candidate ? radius : round(radius)
    try {
      this.canvas.releasePointerCapture(event.pointerId)
    } catch (e) {
      // 忽略释放捕获异常
    }
    if (r > 0.5) {
      const d = this.defaults()
    // resolvePoint 已对自由点进行舍入，并保留对象捕捉的精确坐标。
      const result = createCircleEntity(this.center, r, { drawing: this.drawing, defaults: d })
      if (result.ok) {
        const entity = result.entity
        this.drawing.entities.push(entity)
        this.select(entity.id)
        this.commit()
      } else {
        this.status(result.error.message)
      }
    }
    this.center = null
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.center) return
    this.cursor = result.point.slice() as Point
    this.requestRender()
  }
}
