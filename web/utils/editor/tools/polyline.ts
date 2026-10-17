/** 多段线工具：连续点击添加顶点，双击、回车或空格结束，ESC 取消。 @author snihao */
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'
import type { Viewport } from '#draiq/utils/editor/viewport'
import type { SnapResolveOptions, SnapResult } from '#draiq/utils/editor/snapping/index'
import { genId, distance } from '#draiq/utils/editor/geometry'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'

export class PolylineTool extends BaseTool {
  /** 已确认顶点列表 */
  private points: Point[] = []
  /** 当前光标位置（预览用） */
  private cursor: Point | null = null

  constructor(ctx: ToolContext) {
    super(ctx)
    this.points = []
    this.cursor = null
  }

  onActivate(): void {
    this.points = []
    this.cursor = null
    this.clearSnap()
    this.requestRender()
    this.status('多段线：点击添加顶点，双击、回车或空格结束，ESC 取消')
  }

  onDeactivate(): void {
    this.points = []
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    const last = this.points[this.points.length - 1] || null
    const resolved = this.resolvePoint(pt, {
      anchor: last,
      bypass: event.altKey,
      extraPoints: this.closingCandidate(),
    })
    this.appendPoint(resolved.point)
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

  /** 鼠标和键盘输入使用相同路径追加已解析的顶点。 */
  private appendPoint(point: Point): void {
    const p = point.slice() as Point
    const last = this.points[this.points.length - 1] || null
    if (this.points.length >= 3 && distance(p, this.points[0]) < 1e-7) {
      this.finishPolyline(true)
      return
    }
    // 与上一点过近则忽略，避免双击的第二次点击产生重复顶点。
    if (last && distance(last, p) * this.viewport.scale < 2) return
    this.points.push(p)
    this.cursor = null
    this.requestRender()
    this.status(`多段线：已添加 ${this.points.length} 个顶点（双击/回车/空格结束）`)
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    const last = this.points[this.points.length - 1] || null
    const resolved = this.resolvePoint(pt, {
      anchor: last,
      bypass: event.altKey,
      extraPoints: this.closingCandidate(),
    })
    this.cursor = last ? resolved.point.slice() as Point : null
    this.requestRender()
  }

  onDoubleClick(event: PointerEvent, pt: ToolPoint): void {
    this.finishPolyline()
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.code === 'Space') {
      event.preventDefault()
      this.finishPolyline()
    } else if (event.key === 'Escape') {
      this.points = []
      this.cursor = null
      this.clearSnap()
      this.requestRender()
      this.status('已取消多段线')
    }
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (this.points.length === 0) return
    const d = this.defaults()
    g.save()
    g.strokeStyle = d.color
    g.lineWidth = canvasLineWidth(d.lineWidth, viewport.scale)
    g.setLineDash([4, 3])
    g.beginPath()
    g.moveTo(this.points[0][0], this.points[0][1])
    for (let i = 1; i < this.points.length; i++) g.lineTo(this.points[i][0], this.points[i][1])
    if (this.cursor) g.lineTo(this.cursor[0], this.cursor[1])
    g.stroke()
    // 已确认顶点画小圆点
    g.setLineDash([])
    g.fillStyle = d.color
    for (const p of this.points) {
      g.beginPath()
      g.arc(p[0], p[1], 2 / viewport.scale, 0, Math.PI * 2)
      g.fill()
    }
    g.restore()
  }

  onSnapCycle(result: SnapResult): void {
    if (!this.points.length) return
    this.cursor = result.point.slice() as Point
    this.requestRender()
  }

  /** 结束当前多段线绘制，提交实体 */
  private finishPolyline(closed = false): void {
    if (this.points.length >= 2) {
      if (!this.canCreate()) {
        this.status('当前图层已锁定或冻结，无法创建实体')
        return
      }
      const d = this.defaults()
      const entity: Entity = {
        id: genId('polyline'),
        type: 'polyline',
        layer: d.layer,
        color: d.color,
        lineWidth: d.lineWidth,
        lineType: d.lineType,
        points: this.points.slice(),
        closed,
      }
      this.drawing.entities.push(entity)
      this.select(entity.id)
      this.commit()
    }
    this.points = []
    this.cursor = null
    this.clearSnap()
    this.requestRender()
    this.status('多段线：点击添加顶点')
  }

  /** 三个顶点后将首点加入瞬时候选，用于单击闭合。 */
  private closingCandidate(): SnapResolveOptions['extraPoints'] {
    if (this.points.length < 3) return []
    return [{ point: this.points[0], kind: 'endpoint', label: '闭合' }]
  }
}
