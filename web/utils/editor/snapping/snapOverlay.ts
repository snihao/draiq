import type { Viewport } from '#draiq/utils/editor/viewport'
import { sampleCurve } from '#draiq/utils/editor/curveGeometry'
import type { SnapKind, SnapMarker, SnapResult } from '#draiq/utils/editor/snapping/types'

const ACCENT = '#2764AF'
const ACTIVE = '#16806A'

/** 在主 Canvas 的最上层绘制固定屏幕尺寸的捕捉反馈。 */
export function drawSnapOverlay(
  g: CanvasRenderingContext2D,
  viewport: Viewport,
  result: SnapResult,
  unit: DrawingUnit,
): void {
  g.save()
  g.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0)
  g.lineCap = 'round'
  g.lineJoin = 'round'

  drawHoverGeometry(g, viewport, result)
  drawDirectionGuide(g, viewport, result)
  // 非激活点先绘制，激活点最后绘制，避免密集图纸中白色候选符号盖住
  // 当前真正会被吸附的绿色端点。
  for (const marker of result.markers) {
    if (!marker.active) drawMarker(g, viewport, marker)
  }
  for (const marker of result.markers) {
    if (marker.active) drawMarker(g, viewport, marker)
  }

  const active = result.markers.find((marker) => marker.active)
  if (active) {
    const [x, y] = viewport.toScreen(active.point[0], active.point[1])
    drawPill(g, x + 12, y - 30, active.label, g.canvas.clientWidth, g.canvas.clientHeight, ACTIVE)
  }
  if (result.measurement && result.measurement.length * viewport.scale >= 18) {
    const measurement = result.measurement
    const [ax, ay] = viewport.toScreen(measurement.anchor[0], measurement.anchor[1])
    const [px, py] = viewport.toScreen(measurement.point[0], measurement.point[1])
    const label = `${formatNumber(measurement.length)} ${unit}  ${formatNumber(measurement.angle)}°`
    drawPill(g, (ax + px) / 2 + 9, (ay + py) / 2 - 27, label, g.canvas.clientWidth, g.canvas.clientHeight, '#253330')
  }
  g.restore()
}

function drawHoverGeometry(g: CanvasRenderingContext2D, viewport: Viewport, result: SnapResult): void {
  g.save()
  g.strokeStyle = 'rgba(39, 100, 175, 0.42)'
  g.lineWidth = 3
  for (const segment of result.hoverSegments) {
    const start = viewport.toScreen(segment.start[0], segment.start[1])
    const end = viewport.toScreen(segment.end[0], segment.end[1])
    g.beginPath()
    g.moveTo(start[0], start[1])
    g.lineTo(end[0], end[1])
    g.stroke()
  }
  for (const circle of result.hoverCircles) {
    const center = viewport.toScreen(circle.center[0], circle.center[1])
    g.beginPath()
    g.arc(center[0], center[1], Math.abs(circle.radius * viewport.scale), 0, Math.PI * 2)
    g.stroke()
  }
  for (const item of result.hoverCurves) {
    const points = sampleCurve(item.curve, Math.max(32, Math.ceil(Math.abs(item.curve.sweepParameter) * 24)))
    if (points.length < 2) continue
    g.beginPath()
    const first = viewport.toScreen(points[0][0], points[0][1])
    g.moveTo(first[0], first[1])
    for (const point of points.slice(1)) {
      const screen = viewport.toScreen(point[0], point[1])
      g.lineTo(screen[0], screen[1])
    }
    g.stroke()
  }
  g.restore()
}

function drawDirectionGuide(g: CanvasRenderingContext2D, viewport: Viewport, result: SnapResult): void {
  if (!result.guide) return
  const start = viewport.toScreen(result.guide.start[0], result.guide.start[1])
  const end = viewport.toScreen(result.guide.end[0], result.guide.end[1])
  g.save()
  g.strokeStyle = result.guide.kind === 'orthogonal' ? 'rgba(22, 128, 106, 0.74)' : 'rgba(39, 100, 175, 0.72)'
  g.lineWidth = 1
  g.setLineDash([7, 5])
  g.beginPath()
  g.moveTo(start[0], start[1])
  g.lineTo(end[0], end[1])
  g.stroke()
  g.restore()
}

function drawMarker(g: CanvasRenderingContext2D, viewport: Viewport, marker: SnapMarker): void {
  const [x, y] = viewport.toScreen(marker.point[0], marker.point[1])
  const size = marker.active ? 6 : 5
  g.save()
  g.strokeStyle = marker.active ? ACTIVE : ACCENT
  g.fillStyle = marker.active ? 'rgba(22, 128, 106, 0.14)' : 'rgba(255, 255, 255, 0.88)'
  g.lineWidth = marker.active ? 2 : 1.4
  g.beginPath()
  drawMarkerPath(g, marker.kind, x, y, size)
  g.fill()
  g.stroke()
  g.restore()
}

function drawMarkerPath(g: CanvasRenderingContext2D, kind: SnapKind, x: number, y: number, size: number): void {
  if (kind === 'endpoint') {
    g.rect(x - size, y - size, size * 2, size * 2)
    return
  }
  if (kind === 'midpoint') {
    g.moveTo(x, y - size - 1)
    g.lineTo(x + size + 1, y + size)
    g.lineTo(x - size - 1, y + size)
    g.closePath()
    return
  }
  if (kind === 'center') {
    g.arc(x, y, size, 0, Math.PI * 2)
    g.moveTo(x - size - 3, y)
    g.lineTo(x + size + 3, y)
    g.moveTo(x, y - size - 3)
    g.lineTo(x, y + size + 3)
    return
  }
  if (kind === 'quadrant') {
    g.moveTo(x, y - size - 1)
    g.lineTo(x + size + 1, y)
    g.lineTo(x, y + size + 1)
    g.lineTo(x - size - 1, y)
    g.closePath()
    return
  }
  if (kind === 'perpendicular') {
    g.moveTo(x - size, y + size)
    g.lineTo(x - size, y - size)
    g.lineTo(x + size, y - size)
    g.moveTo(x - 1, y - size)
    g.lineTo(x - 1, y)
    g.lineTo(x + size, y)
    return
  }
  if (kind === 'nearest') {
    g.arc(x, y, size - 1, 0, Math.PI * 2)
    return
  }
  if (kind === 'tangent') {
    g.moveTo(x - size, y + size)
    g.lineTo(x + size, y - size)
    g.moveTo(x - size, y - size)
    g.lineTo(x + size, y + size)
    g.arc(x, y, size + 2, 0, Math.PI * 2)
    return
  }
  g.moveTo(x - size, y - size)
  g.lineTo(x + size, y + size)
  g.moveTo(x + size, y - size)
  g.lineTo(x - size, y + size)
}

function drawPill(
  g: CanvasRenderingContext2D,
  requestedX: number,
  requestedY: number,
  text: string,
  canvasWidth: number,
  canvasHeight: number,
  background: string,
): void {
  g.save()
  g.font = '500 11px "SFMono-Regular", Consolas, monospace'
  g.textBaseline = 'middle'
  const width = Math.ceil(g.measureText(text).width) + 14
  const height = 23
  const x = Math.min(Math.max(6, requestedX), Math.max(6, canvasWidth - width - 6))
  const y = Math.min(Math.max(6, requestedY), Math.max(6, canvasHeight - height - 6))
  g.fillStyle = background
  g.beginPath()
  g.roundRect(x, y, width, height, 5)
  g.fill()
  g.fillStyle = '#ffffff'
  g.fillText(text, x + 7, y + height / 2 + 0.5)
  g.restore()
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1000) return value.toFixed(1)
  if (Math.abs(value) >= 100) return value.toFixed(1)
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}
