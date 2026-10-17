/** 自由手绘工具：按住拖拽采集点（按最小距离过滤），松开生成多段线。 */
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'
import type { Viewport } from '#draiq/utils/editor/viewport'
import { round, genId, distance } from '#draiq/utils/editor/geometry'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'

/** 相邻采样点在屏幕上的最小距离，避免缩放影响轨迹密度。 */
const SAMPLE_DISTANCE_PX = 1.5

export class FreehandTool extends BaseTool {
  /** 已采集顶点列表 */
  private points: Point[] = []
  /** 当前光标位置（预览末端延伸用） */
  private cursor: Point | null = null
  /** 是否处于拖拽绘制中 */
  private active = false

  constructor(ctx: ToolContext) {
    super(ctx)
    this.points = []
    this.cursor = null
    this.active = false
  }

  onActivate(): void {
    this.points = []
    this.cursor = null
    this.active = false
    this.clearSnap()
    this.requestRender()
    this.status('手绘：按住拖拽自由绘制，松开结束')
  }

  onDeactivate(): void {
    this.points = []
    this.cursor = null
    this.active = false
    this.clearSnap()
    this.requestRender()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    if (!this.canCreate()) {
      this.status('当前图层已锁定或冻结，无法创建实体')
      return
    }
    const resolved = this.resolvePoint(pt, { bypass: event.altKey, allowAngleSnap: false })
    this.points = [resolved.point.slice() as Point]
    this.cursor = resolved.point.slice() as Point
    this.active = true
    this.clearSnap()
    this.canvas.setPointerCapture(event.pointerId)
    this.requestRender()
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint, coalescedPoints: ToolPoint[] = []): void {
    if (!this.active) {
      this.resolvePoint(pt, { bypass: event.altKey, allowAngleSnap: false })
      this.requestRender()
      return
    }
    for (const point of coalescedPoints) this.appendPoint(point)
    this.appendPoint(pt)
    // 始终跟踪最终位置，保证预览线头实时跟随。
    this.cursor = [pt.x, pt.y]
    this.requestRender()
  }

  /** 按屏幕像素间距追加采样点，缩放前后保持一致的轨迹密度。 */
  private appendPoint(pt: ToolPoint): void {
    const last = this.points[this.points.length - 1]
    if (!last || distance(last, [pt.x, pt.y]) * this.viewport.scale < SAMPLE_DISTANCE_PX) return
    this.points.push([round(pt.x, 3), round(pt.y, 3)])
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (this.points.length < 1) return
    const d = this.defaults()
    g.save()
    g.strokeStyle = d.color
    g.lineWidth = canvasLineWidth(d.lineWidth, viewport.scale, 0.8)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.beginPath()
    g.moveTo(this.points[0][0], this.points[0][1])
    for (let i = 1; i < this.points.length; i++) g.lineTo(this.points[i][0], this.points[i][1])
    // 末端实时延伸到当前光标，确保线头跟鼠标走，无延迟感。
    if (this.cursor) g.lineTo(this.cursor[0], this.cursor[1])
    g.stroke()
    g.restore()
  }

  onPointerUp(event: PointerEvent, pt: ToolPoint): void {
    if (!this.active) return
    this.active = false
    const resolved = this.resolvePoint(pt, { bypass: event.altKey, allowAngleSnap: false })
    try {
      this.canvas.releasePointerCapture(event.pointerId)
    } catch (e) {
      // 忽略释放捕获异常
    }
    const last = this.points[this.points.length - 1]
    if (last && distance(last, resolved.point) * this.viewport.scale >= 1) {
      this.points.push(resolved.point.slice() as Point)
    } else if (last) {
      this.points[this.points.length - 1] = resolved.point.slice() as Point
    }
    if (this.points.length >= 2) {
      const d = this.defaults()
      const entity: Entity = {
        id: genId('free'),
        type: 'polyline',
        layer: d.layer,
        color: d.color,
        lineWidth: d.lineWidth,
        lineType: d.lineType,
        points: this.points.slice(),
        closed: false,
      }
      this.drawing.entities.push(entity)
      this.select(entity.id)
      this.commit()
    }
    this.points = []
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }

  /** 系统手势或第二根手指接管时丢弃未完成轨迹。 */
  onPointerCancel(event: PointerEvent): void {
    if (!this.active) return
    this.active = false
    try {
      this.canvas.releasePointerCapture(event.pointerId)
    } catch {
      // 指针捕获可能已由浏览器释放。
    }
    this.points = []
    this.cursor = null
    this.clearSnap()
    this.requestRender()
  }
}
