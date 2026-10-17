/** 直线工具：点击起点，再点击终点生成直线；可连续绘制多条，ESC 取消当前。 */
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'
import type { Viewport } from '#draiq/utils/editor/viewport'
import type { SnapResult } from '#draiq/utils/editor/snapping/index'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'
import { createLineEntity } from '#draiq/utils/editor/factories/entityFactory'

export class LineTool extends BaseTool {
  /** 直线起点 */
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
    this.status('直线：点击起点，再点击终点（ESC 取消当前）')
  }

  onDeactivate(): void {
    this.start = null
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    const resolved = this.resolvePoint(pt, { anchor: this.start, bypass: event.altKey })
    if (!this.start) {
      this.start = resolved.point.slice() as Point
      this.cursor = null
      this.requestRender()
      this.status('直线：点击终点')
      return
    }
    this.completeLine(resolved.point)
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
    this.completeLine(point)
  }

  /** 鼠标输入和键盘精确输入使用相同路径创建直线。 */
  private completeLine(point: Point): void {
    if (!this.canCreate()) {
      this.status('当前图层已锁定或冻结，无法创建实体')
      return
    }
    const d = this.defaults()
    const result = createLineEntity(this.start!, point, { drawing: this.drawing, defaults: d })
    if (!result.ok) {
      this.status(result.error.message)
      return
    }
    const entity = result.entity
    this.drawing.entities.push(entity)
    this.select(entity.id)
    this.commit()
    this.start = null
    this.cursor = null
    this.clearSnap()
    this.status('直线：点击起点')
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    const resolved = this.resolvePoint(pt, { anchor: this.start, bypass: event.altKey })
    this.cursor = this.start ? resolved.point.slice() as Point : null
    this.requestRender()
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.start || !this.cursor) return
    const d = this.defaults()
    g.save()
    g.strokeStyle = d.color
    g.lineWidth = canvasLineWidth(d.lineWidth, viewport.scale)
    g.setLineDash([4, 3])
    g.beginPath()
    g.moveTo(this.start[0], this.start[1])
    g.lineTo(this.cursor[0], this.cursor[1])
    g.stroke()
    g.restore()
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.start) return
    this.cursor = result.point.slice() as Point
    this.requestRender()
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.start = null
      this.cursor = null
      this.clearSnap()
      this.requestRender()
      this.status('直线：点击起点')
    }
  }
}
