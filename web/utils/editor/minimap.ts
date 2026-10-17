/** 小屏导航图：在画布左上角显示整个图纸的概览 + 当前视口矩形。
 * 为避免大文件卡顿，只画简化几何，统一灰色，几千图元也能 60fps。
 */
import { dimensionSegments, drawingBounds } from '#draiq/utils/editor/geometry'
import { isLayerFrozen } from '#draiq/utils/editor/layers'
import type { Viewport } from '#draiq/utils/editor/viewport'

/** 小屏 CSS 宽度 */
const MINI_W = 180
/** 小屏 CSS 高度 */
const MINI_H = 140
/** 小屏内边距 */
const PADDING = 8
/** 背景色 */
const BG_COLOR = 'rgba(255, 255, 255, 0.92)'
/** 边框色 */
const BORDER_COLOR = '#9aa8b7'
/** 简化图元颜色 */
const ENTITY_COLOR = '#7e8a9a'
/** 选中图元高亮色 */
const SELECTED_COLOR = '#f2b84b'
/** 当前视口矩形颜色 */
const VIEWPORT_COLOR = '#2764AF'
/** 视口矩形填充色 */
const VIEWPORT_FILL = 'rgba(39, 100, 175, 0.10)'

export class Minimap {
  /** 小屏 canvas */
  canvas: HTMLCanvasElement
  /** 小屏上下文 */
  private gctx: CanvasRenderingContext2D
  /** 上次的拟合参数 {scale, offX, offY} */
  _fit: { scale: number; offX: number; offY: number } | null = null
  /** 实体层离屏缓存 */
  private eLayer: HTMLCanvasElement
  private eLayerG: CanvasRenderingContext2D
  /** 实体层是否需要重绘 */
  private eDirty = true
  /** 上次实体层渲染签名 */
  private eFitKey = ''
  /** 图纸包围盒缓存 */
  private _bounds: Bounds | null = null
  /** 实体 ID 索引，避免多选覆盖层重复递归查找 */
  private entityById = new Map<string, Entity>()
  /** 主画布 CSS 尺寸 */
  private _mainW = 0
  private _mainH = 0
  /** 当前图纸，用于过滤冻结图层。 */
  private currentDrawing: Drawing | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.gctx = canvas.getContext('2d')!
    this.eLayer = document.createElement('canvas')
    this.eLayerG = this.eLayer.getContext('2d')!
  }

  /** 实体发生变化时调用，使实体层缓存失效 */
  markDirty(): void {
    this.eDirty = true
  }

  /** 主渲染入口 */
  render(state: EditorState, viewport: Viewport): void {
    this.currentDrawing = state.drawing
    const g = this.gctx
    const dpr = window.devicePixelRatio || 1
    const cssW = this.canvas.clientWidth || MINI_W
    const cssH = this.canvas.clientHeight || MINI_H
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr)
      this.canvas.height = Math.round(cssH * dpr)
    }

    if (this.eDirty || !this._bounds) {
      this._bounds = drawingBounds(state.drawing)
    }
    const bounds = this._bounds
    const bw = Math.max(bounds.maxX - bounds.minX, 1)
    const bh = Math.max(bounds.maxY - bounds.minY, 1)
    const availW = cssW - PADDING * 2
    const availH = cssH - PADDING * 2
    const ms = Math.min(availW / bw, availH / bh)
    const offX = PADDING + (availW - bw * ms) / 2 - bounds.minX * ms
    const offY = PADDING + (availH - bh * ms) / 2 - bounds.minY * ms
    this._fit = { scale: ms, offX, offY }
    const mx = (x: number) => x * ms + offX
    const my = (y: number) => y * ms + offY

    const fitKey = ms + '|' + offX + '|' + offY + '|' + cssW + '|' + cssH
    if (this.eDirty || fitKey !== this.eFitKey) {
      this._renderEntityLayer(state, cssW, cssH, dpr, ms, offX, offY)
      this.eDirty = false
      this.eFitKey = fitKey
    }

    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, cssW, cssH)
    g.fillStyle = BG_COLOR
    g.fillRect(0, 0, cssW, cssH)
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.drawImage(this.eLayer, 0, 0)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    // 选中图元单独覆盖绘制，选择变化不再使静态小地图缓存失效。
    for (const selectedId of state.selectedIds) {
      const selected = this.entityById.get(selectedId)
      if (!selected || isLayerFrozen(state.drawing, selected.layer)) continue
      g.strokeStyle = SELECTED_COLOR
      g.fillStyle = SELECTED_COLOR
      g.lineWidth = 1.4
      this._strokeEntity(g, selected, mx, my)
    }

    const mainW = this._mainW
    const mainH = this._mainH
    if (mainW > 0 && mainH > 0) {
      const [wx0, wy0] = viewport.toWorld(0, 0)
      const [wx1, wy1] = viewport.toWorld(mainW, mainH)
      const x0 = mx(wx0), y0 = my(wy0)
      const x1 = mx(wx1), y1 = my(wy1)
      g.strokeStyle = VIEWPORT_COLOR
      g.fillStyle = VIEWPORT_FILL
      g.lineWidth = 1.2
      g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
    }

    g.strokeStyle = BORDER_COLOR
    g.lineWidth = 1
    g.strokeRect(0.5, 0.5, cssW - 1, cssH - 1)
  }

  /** 把所有图元简化绘制到离屏缓存 */
  private _renderEntityLayer(state: EditorState, cssW: number, cssH: number, dpr: number, ms: number, offX: number, offY: number): void {
    const cw = Math.round(cssW * dpr)
    const ch = Math.round(cssH * dpr)
    if (this.eLayer.width !== cw) this.eLayer.width = cw
    if (this.eLayer.height !== ch) this.eLayer.height = ch
    const g = this.eLayerG
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, cw, ch)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const mx = (x: number) => x * ms + offX
    const my = (y: number) => y * ms + offY
    g.lineCap = 'round'
    g.lineJoin = 'round'
    this.entityById.clear()
    const indexEntity = (entity: Entity): void => {
      this.entityById.set(entity.id, entity)
      for (const child of entity.children || []) indexEntity(child)
    }
    for (const e of state.drawing.entities) {
      indexEntity(e)
      if (isLayerFrozen(state.drawing, e.layer)) continue
      g.strokeStyle = ENTITY_COLOR
      g.fillStyle = ENTITY_COLOR
      g.lineWidth = 0.8
      this._strokeEntity(g, e, mx, my)
    }
  }

  /** 设置主画布 CSS 尺寸（供视口矩形反算用） */
  setMainSize(w: number, h: number): void {
    this._mainW = w
    this._mainH = h
  }

  private _strokeEntity(g: CanvasRenderingContext2D, e: Entity, mx: (x: number) => number, my: (y: number) => number): void {
    if (e.type === 'group') {
      for (const child of e.children || []) {
        if (!this.currentDrawing || !isLayerFrozen(this.currentDrawing, child.layer)) this._strokeEntity(g, child, mx, my)
      }
      return
    }
    g.beginPath()
    if (e.type === 'line') {
      g.moveTo(mx(e.start![0]), my(e.start![1]))
      g.lineTo(mx(e.end![0]), my(e.end![1]))
      g.stroke()
    } else if (e.type === 'polyline') {
      const pts = e.points!
      if (!pts.length) return
      g.moveTo(mx(pts[0][0]), my(pts[0][1]))
      for (let i = 1; i < pts.length; i++) g.lineTo(mx(pts[i][0]), my(pts[i][1]))
      if (e.closed) g.closePath()
      g.stroke()
    } else if (e.type === 'circle') {
      g.arc(mx(e.center![0]), my(e.center![1]), Math.max(e.radius! * this._fit!.scale, 1), 0, Math.PI * 2)
      g.stroke()
    } else if (e.type === 'annotation' || e.type === 'dimension') {
      const dimension = dimensionSegments(e)
      const ld = e.leader || []
      const points = dimension.length ? dimension.flat() : ld
      if (points.length) {
        if (dimension.length) {
          for (const [start, end] of dimension) {
            g.moveTo(mx(start[0]), my(start[1]))
            g.lineTo(mx(end[0]), my(end[1]))
          }
        } else {
          g.moveTo(mx(ld[0][0]), my(ld[0][1]))
          for (let i = 1; i < ld.length; i++) g.lineTo(mx(ld[i][0]), my(ld[i][1]))
        }
        g.stroke()
      }
      g.beginPath()
      g.arc(mx(e.position![0]), my(e.position![1]), 1.5, 0, Math.PI * 2)
      g.fill()
    } else if (e.type === 'text') {
      g.beginPath()
      g.arc(mx(e.position![0]), my(e.position![1]), 1.5, 0, Math.PI * 2)
      g.fill()
    }
  }

}
