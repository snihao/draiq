/** 视口：管理画布缩放与平移，负责屏幕坐标与世界坐标互转。
 * Canvas 坐标系原点在左上、Y 向下，与 drawing 用的 SVG 坐标系一致，无需翻转。
 */
import { clamp } from '#draiq/utils/editor/geometry'

/** 实体命中屏幕像素容差 */
export const HIT_TOL_PX = 5
/** 手柄命中屏幕像素容差 */
export const HANDLE_HIT_PX = 8
/** 允许极小缩放，确保大尺寸 SVG 也能完整适配到画布 */
export const MIN_SCALE = 1e-5
/** DXF 可能使用非常小的坐标单位，需要允许自动适配微小模型。 */
export const MAX_SCALE = 1_000_000

export class Viewport {
  /** 缩放比例 */
  scale = 1
  /** X 偏移（屏幕像素） */
  offsetX = 0
  /** Y 偏移（屏幕像素） */
  offsetY = 0
  /** 设备像素比，由 resizeCanvas 设置 */
  dpr = 1

  /** 设置设备像素比（resizeCanvas 时调用） */
  setDpr(dpr: number): void {
    this.dpr = dpr || 1
  }

  /** world → screen（CSS 像素，不含 dpr） */
  toScreen(x: number, y: number): Point {
    return [x * this.scale + this.offsetX, y * this.scale + this.offsetY]
  }

  /** screen (CSS 像素) → world */
  toWorld(sx: number, sy: number): Point {
    return [(sx - this.offsetX) / this.scale, (sy - this.offsetY) / this.scale]
  }

  /** 以某屏幕点为中心缩放（CAD 标准行为：鼠标位置为锚点） */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const newScale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE)
    const wx = (screenX - this.offsetX) / this.scale
    const wy = (screenY - this.offsetY) / this.scale
    this.scale = newScale
    this.offsetX = screenX - wx * newScale
    this.offsetY = screenY - wy * newScale
  }

  /** 屏幕像素平移 */
  pan(dx: number, dy: number): void {
    this.offsetX += dx
    this.offsetY += dy
  }

  /** 适配包围盒到画布尺寸 */
  fit(bounds: Bounds, canvasW: number, canvasH: number, padding = 40): void {
    const w = Math.max(bounds.maxX - bounds.minX, 1e-6)
    const h = Math.max(bounds.maxY - bounds.minY, 1e-6)
    const sx = (canvasW - padding * 2) / w
    const sy = (canvasH - padding * 2) / h
    this.scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE)
    const cx = (bounds.minX + bounds.maxX) / 2
    const cy = (bounds.minY + bounds.maxY) / 2
    this.offsetX = canvasW / 2 - cx * this.scale
    this.offsetY = canvasH / 2 - cy * this.scale
  }

  /** 按画布占比适配包围盒，并将其中心对齐到画布中心。 */
  fitToRatio(bounds: Bounds, canvasW: number, canvasH: number, ratio = 0.8): void {
    const w = Math.max(bounds.maxX - bounds.minX, Number.EPSILON)
    const h = Math.max(bounds.maxY - bounds.minY, Number.EPSILON)
    const targetRatio = clamp(ratio, 0.01, 1)
    const sx = canvasW * targetRatio / w
    const sy = canvasH * targetRatio / h
    this.scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE)
    const cx = (bounds.minX + bounds.maxX) / 2
    const cy = (bounds.minY + bounds.maxY) / 2
    this.offsetX = canvasW / 2 - cx * this.scale
    this.offsetY = canvasH / 2 - cy * this.scale
  }

  /** 当前缩放下的实体命中容差（world 距离） */
  hitTol(): number {
    return HIT_TOL_PX / this.scale
  }

  /** 当前缩放下的手柄命中容差（world 距离） */
  handleTol(): number {
    return HANDLE_HIT_PX / this.scale
  }

  /** 应用变换到 canvas 上下文（包含 dpr，world 坐标直接画即可） */
  apply(gctx: CanvasRenderingContext2D): void {
    const d = this.dpr
    gctx.setTransform(d * this.scale, 0, 0, d * this.scale, d * this.offsetX, d * this.offsetY)
  }
}
