/** CAD 线宽显示换算工具。 */

/**
 * 把 CAD 线宽换算为已应用视口变换后的 Canvas 世界坐标线宽。
 * @param lineWidth CAD 线宽，显示时按屏幕像素理解。
 * @param viewportScale 当前视口缩放比例。
 * @param minimumScreenWidth 最小屏幕显示宽度。
 * @returns 可直接赋给 CanvasRenderingContext2D.lineWidth 的世界坐标线宽。
 * @author snihao
 */
export function canvasLineWidth(lineWidth: number, viewportScale: number, minimumScreenWidth = 0.75): number {
  const safeWidth = Number.isFinite(lineWidth) ? Math.max(0, lineWidth) : 0
  const safeScale = Number.isFinite(viewportScale) && viewportScale > 0 ? viewportScale : 1
  return Math.max(safeWidth, minimumScreenWidth) / safeScale
}
