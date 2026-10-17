/** 选择工具：点击单选、Shift 增减选择、空白拖拽框选、整体移动与手柄编辑。 */
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'
import type { Viewport } from '#draiq/utils/editor/viewport'
import type { SnapResolveOptions, SnapResult } from '#draiq/utils/editor/snapping/index'
import type { SelectionMode } from '#draiq/utils/editor/renderer'
import { deformPolylineVertex, distance, entityCenter, isDimensionEntity, moveDimensionPlacement, moveEntity, moveHandle, nearestOnSegment, rotateEntity, round } from '#draiq/utils/editor/geometry'
import { detachDimensionReference, detachDimensionReferences, dimensionSourceEntityIds } from '#draiq/utils/editor/associativeDimensions'

/** 超过该屏幕像素距离才认定为拖拽 */
const DRAG_THRESHOLD_PX = 4

interface DragState {
  kind: 'handle' | 'move' | 'rotate'
  ids: string[]
  index?: number
  role?: string
  prev?: Point
  center?: Point
  previousAngle?: number
  originalPoints?: Point[]
  controlIndices?: number[]
  /** 来源几何同时选中时，标注随几何整体移动。 */
  movingDimensionIds?: Set<string>
}

interface PendingMove {
  ids: string[]
  downClientX: number
  downClientY: number
  downWorld: Point
}

interface MarqueeState {
  start: Point
  current: Point
  downClientX: number
  downClientY: number
  baseIds: string[]
  active: boolean
  mode: SelectionMode
}

export class SelectTool extends BaseTool {
  private drag: DragState | null = null
  private pendingMove: PendingMove | null = null
  private marquee: MarqueeState | null = null

  constructor(ctx: ToolContext) {
    super(ctx)
  }

  onActivate(): void {
    this.resetInteraction()
    this.clearSnap()
    this.status('选择：点击单选，拖拽空白框选，Shift 增减选择，拖动已选图元整体移动')
  }

  onDeactivate(): void {
    this.resetInteraction()
    this.clearSnap()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    const worldPt: Point = [pt.x, pt.y]
    const selectedIds = this.state.selectedIds

    // 单选时优先检测有限数量的编辑手柄。
    if (selectedIds.length === 1) {
      const entity = this.findEntity(selectedIds[0])
      const handle = entity ? this.ctx.renderer.hitHandle(worldPt, entity, this.viewport) : null
      if (entity && handle) {
        if (!this.ctx.isEntityEditable(entity)) {
          this.status('当前图层已锁定或冻结，无法修改')
          return
        }
        if (isDimensionEntity(entity) && (handle.role === 'rotate' || handle.role === 'resize' || handle.role === 'move')) {
          if (detachDimensionReferences(entity)) this.status('变换标注：已解除源实体关联')
        }
        if (handle.role === 'rotate') {
          const center = entityCenter(entity, this.state.drawing)
          this.drag = {
            kind: 'rotate',
            ids: [entity.id],
            center,
            previousAngle: Math.atan2(pt.y - center[1], pt.x - center[0]),
          }
          this.status('旋转：拖动旋转柄调整角度')
        } else {
          this.drag = { kind: 'handle', ids: [entity.id], index: handle.index, role: handle.role }
          if (entity.type === 'polyline' && handle.role === 'vertex') {
            this.drag.originalPoints = (entity.points || []).map((point) => point.slice() as Point)
            this.drag.controlIndices = this.ctx.renderer.getHandles(entity)
              .filter((item) => item.role === 'vertex')
              .map((item) => item.index)
          }
        }
        this.canvas.setPointerCapture(event.pointerId)
        return
      }
    }

    const hit = this.ctx.renderer.hitTest(worldPt, this.state, this.viewport)
    if (hit) {
      let nextSelection: string[]
      if (event.shiftKey) {
        nextSelection = selectedIds.includes(hit.id)
          ? selectedIds.filter((id) => id !== hit.id)
          : [...selectedIds, hit.id]
      } else {
        // 点击多选集合中的任意图元时保留集合，以便直接整体拖动。
        nextSelection = selectedIds.includes(hit.id) ? selectedIds.slice() : [hit.id]
      }
      this.selectMany(nextSelection)
      this.notify()
      if (nextSelection.includes(hit.id) && nextSelection.every((id) => this.ctx.isEntityEditable(this.findEntity(id)))) {
        this.pendingMove = {
          ids: nextSelection.slice(),
          downClientX: event.clientX,
          downClientY: event.clientY,
          downWorld: worldPt,
        }
        this.canvas.setPointerCapture(event.pointerId)
      } else if (nextSelection.includes(hit.id)) {
        this.status('选择集中包含锁定或冻结图层，无法移动')
      }
      return
    }

    const baseIds = event.shiftKey ? selectedIds.slice() : []
    if (!event.shiftKey) {
      this.selectMany([])
      this.notify()
    }
    this.marquee = {
      start: worldPt,
      current: worldPt,
      downClientX: event.clientX,
      downClientY: event.clientY,
      baseIds,
      active: false,
      mode: 'window',
    }
    this.canvas.setPointerCapture(event.pointerId)
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    if (this.drag?.kind === 'rotate') {
      const entity = this.findEntity(this.drag.ids[0])
      if (!entity || !this.ctx.isEntityEditable(entity) || !this.drag.center || this.drag.previousAngle === undefined) return
      const angle = Math.atan2(pt.y - this.drag.center[1], pt.x - this.drag.center[0])
      let delta = angle - this.drag.previousAngle
      if (delta > Math.PI) delta -= Math.PI * 2
      if (delta < -Math.PI) delta += Math.PI * 2
      rotateEntity(entity, delta, this.drag.center)
      this.drag.previousAngle = angle
      this.liveUpdate()
      return
    }

    if (this.drag?.kind === 'handle') {
      const entity = this.findEntity(this.drag.ids[0])
      if (!entity || !this.ctx.isEntityEditable(entity)) return
      const options = this.handleSnapOptions(entity, event.altKey)
      const resolved = this.resolvePoint(pt, options)
      this.applyHandlePoint(entity, resolved.point)
      return
    }

    if (this.marquee) {
      this.marquee.current = [pt.x, pt.y]
      this.marquee.mode = pt.x >= this.marquee.start[0] ? 'window' : 'crossing'
      this.marquee.active = this.marquee.active || Math.hypot(
        event.clientX - this.marquee.downClientX,
        event.clientY - this.marquee.downClientY,
      ) >= DRAG_THRESHOLD_PX
      this.requestRender()
      return
    }

    if (this.pendingMove && !this.drag) {
      const distancePx = Math.hypot(
        event.clientX - this.pendingMove.downClientX,
        event.clientY - this.pendingMove.downClientY,
      )
      if (distancePx < DRAG_THRESHOLD_PX) return
      this.drag = {
        kind: 'move',
        ids: this.pendingMove.ids.slice(),
        prev: this.pendingMove.downWorld,
        movingDimensionIds: new Set(),
      }
      const movingIds = new Set<string>()
      for (const id of this.drag.ids) {
        const entity = this.findEntity(id)
        if (entity) for (const member of this.entityTreeIds(entity)) movingIds.add(member)
      }
      for (const id of this.drag.ids) {
        const entity = this.findEntity(id)
        if (!entity || !isDimensionEntity(entity)) continue
        const sources = dimensionSourceEntityIds(entity)
        if (sources.length && sources.every((source) => movingIds.has(source))) this.drag.movingDimensionIds!.add(id)
      }
      this.pendingMove = null
    }

    if (this.drag?.kind === 'move') {
      const dx = pt.x - this.drag.prev![0]
      const dy = pt.y - this.drag.prev![1]
      for (const id of this.drag.ids) {
        const entity = this.findEntity(id)
        if (!entity || !this.ctx.isEntityEditable(entity)) continue
        if (isDimensionEntity(entity) && !this.drag.movingDimensionIds?.has(entity.id)) moveDimensionPlacement(entity, dx, dy, this.state.drawing)
        else moveEntity(entity, dx, dy)
      }
      this.drag.prev = [pt.x, pt.y]
      this.liveUpdate()
    }
  }

  onPointerUp(event: PointerEvent, pt: ToolPoint): void {
    try {
      this.canvas.releasePointerCapture(event.pointerId)
    } catch {
      // 忽略释放捕获异常。
    }

    if (this.marquee) {
      if (this.marquee.active) {
        const bounds: Bounds = {
          minX: Math.min(this.marquee.start[0], this.marquee.current[0]),
          minY: Math.min(this.marquee.start[1], this.marquee.current[1]),
          maxX: Math.max(this.marquee.start[0], this.marquee.current[0]),
          maxY: Math.max(this.marquee.start[1], this.marquee.current[1]),
        }
        const hits = this.ctx.renderer.selectInBounds(bounds, this.state, this.marquee.mode).map((entity) => entity.id)
        this.selectMany([...this.marquee.baseIds, ...hits])
        this.notify()
        this.status(`已选择 ${this.state.selectedIds.length} 个图元`)
      }
      this.marquee = null
      this.requestRender()
      return
    }

    const wasDragging = !!this.drag
    this.drag = null
    this.pendingMove = null
    if (wasDragging) this.commit()
    this.clearSnap()
  }

  /** 系统取消或双指手势接管时结束选择交互，并保留已经发生的实体变换。 */
  onPointerCancel(event: PointerEvent): void {
    try {
      this.canvas.releasePointerCapture(event.pointerId)
    } catch {
      // 浏览器可能已经释放捕获。
    }
    const wasDragging = this.drag !== null
    this.resetInteraction()
    if (wasDragging) this.commit()
    this.clearSnap()
    this.requestRender()
  }

  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {
    if (!this.marquee?.active) return
    const x = Math.min(this.marquee.start[0], this.marquee.current[0])
    const y = Math.min(this.marquee.start[1], this.marquee.current[1])
    const width = Math.abs(this.marquee.current[0] - this.marquee.start[0])
    const height = Math.abs(this.marquee.current[1] - this.marquee.start[1])
    g.save()
    const crossing = this.marquee.mode === 'crossing'
    g.fillStyle = crossing ? 'rgba(180, 74, 66, 0.10)' : 'rgba(39, 100, 175, 0.08)'
    g.strokeStyle = crossing ? '#B44A42' : '#2764AF'
    g.lineWidth = 1.2 / viewport.scale
    g.setLineDash([6 / viewport.scale, 4 / viewport.scale])
    g.fillRect(x, y, width, height)
    g.strokeRect(x, y, width, height)
    g.restore()
  }

  onSnapCycle(result: SnapResult): void {
    if (this.drag?.kind !== 'handle') return
    const entity = this.findEntity(this.drag.ids[0])
    if (!entity) return
    this.applyHandlePoint(entity, result.point)
  }

  onDoubleClick(event: PointerEvent, pt: ToolPoint): void {
    const hit = this.ctx.renderer.hitTest([pt.x, pt.y], this.state, this.viewport)
    if (!hit) return
    this.select(hit.id)
    this.notify()

    if (hit.type === 'text' || hit.type === 'annotation' || hit.type === 'dimension') {
      this.beginTextEdit(hit)
      return
    }

    if (hit.type === 'polyline') {
      if (!this.ctx.isEntityEditable(hit)) {
        this.status('当前图层已锁定或冻结，无法修改')
        return
      }
      const point: Point = [pt.x, pt.y]
      let best = -1
      let bestDistance = Infinity
      const points = hit.points || []
      const segmentCount = hit.closed ? points.length : points.length - 1
      for (let index = 0; index < segmentCount; index++) {
        const nearest = nearestOnSegment(point, points[index], points[(index + 1) % points.length])
        const candidateDistance = distance(point, [nearest.x, nearest.y])
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance
          best = index
        }
      }
      if (best >= 0 && bestDistance < this.viewport.hitTol() * 2) {
        points.splice(best + 1, 0, [round(point[0]), round(point[1])])
        this.commit()
        this.status('已插入顶点')
      }
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Delete' || event.key === 'Backspace') this.ctx.deleteSelected()
  }

  private resetInteraction(): void {
    this.drag = null
    this.pendingMove = null
    this.marquee = null
  }

  /** 对当前手柄应用已经解析完成的捕捉点。 */
  private applyHandlePoint(entity: Entity, target: Point): void {
    if (!this.ctx.isEntityEditable(entity)) return
    const radialDimension = entity.type === 'dimension' && (entity.dimensionType === 'radius' || entity.dimensionType === 'diameter')
    if (!radialDimension && (entity.type === 'annotation' || entity.type === 'dimension') && this.drag?.role === 'leader' && this.drag.index != null) {
      detachDimensionReference(entity, this.drag.index)
    }
    if (entity.type === 'polyline' && this.drag?.role === 'vertex' && this.drag.originalPoints && this.drag.controlIndices) {
      deformPolylineVertex(entity, this.drag.index!, target, this.drag.originalPoints, this.drag.controlIndices)
    } else {
      moveHandle(entity, this.drag!.index!, this.drag!.role!, { x: target[0], y: target[1] }, 0, this.state.drawing)
    }
    this.liveUpdate()
  }

  /** 根据手柄角色确定方向锚点，并排除正在编辑的实体树。 */
  private handleSnapOptions(entity: Entity, bypass: boolean): SnapResolveOptions {
    const role = this.drag?.role || ''
    const index = this.drag?.index ?? -1
    let anchor: Point | null = null
    let allowAngleSnap = false
    if (entity.type === 'line' && (role === 'start' || role === 'end')) {
      anchor = index === 0 ? entity.end! : entity.start!
      allowAngleSnap = true
    } else if (entity.type === 'polyline' && role === 'vertex') {
      const points = this.drag?.originalPoints || entity.points || []
      anchor = points[index - 1] || (entity.closed ? points[(index - 1 + points.length) % points.length] : null)
      allowAngleSnap = !!anchor
    } else if (entity.type === 'circle' && role === 'radius') {
      anchor = entity.center || null
    } else if ((entity.type === 'annotation' || entity.type === 'dimension') && role === 'leader') {
      if (entity.type === 'dimension') {
        if (entity.dimensionType === 'radius' || entity.dimensionType === 'diameter') {
          anchor = entity.dimensionCenter || null
        } else {
          const points = [entity.dimensionStart, entity.dimensionEnd, entity.dimensionLinePosition, entity.dimensionLinePosition]
          anchor = index === 0 ? points[1] || null : index === 1 ? points[0] || null : points[2] || null
        }
      } else {
        if (index === 0) anchor = entity.leader?.[1] || null
        else if (index === 1) anchor = entity.leader?.[0] || null
        else if (index === 2) anchor = entity.leader?.[3] || null
        else if (index === 3) anchor = entity.leader?.[2] || null
      }
      allowAngleSnap = !!anchor
    }
    return {
      anchor,
      bypass,
      allowAngleSnap,
      excludeEntityIds: this.entityTreeIds(entity),
    }
  }

  /** 收集组合及其子图元 ID，避免手柄吸回正在修改的自身几何。 */
  private entityTreeIds(entity: Entity): Set<string> {
    const ids = new Set<string>()
    const visit = (item: Entity): void => {
      ids.add(item.id)
      for (const child of item.children || []) visit(child)
    }
    visit(entity)
    return ids
  }
}
