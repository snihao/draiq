/** 原生圆弧和椭圆绘制所需的几何构造函数。 */
import { sampleCurve } from '#draiq/utils/editor/curveGeometry'

const TAU = Math.PI * 2
const EPSILON = 1e-8

/** 由三点构造通过中间点的圆弧。 @param start 起点。 @param through 必经点。 @param end 终点。 @returns 参数曲线或空值。 @author snihao */
export function arcThroughThreePoints(start: Point, through: Point, end: Point): ParametricCurveGeometry | null {
  const ax = start[0], ay = start[1]
  const bx = through[0], by = through[1]
  const cx = end[0], cy = end[1]
  const denominator = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(denominator) < EPSILON) return null
  const aa = ax * ax + ay * ay
  const bb = bx * bx + by * by
  const cc = cx * cx + cy * cy
  const center: Point = [
    (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / denominator,
    (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / denominator,
  ]
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1])
  if (!Number.isFinite(radius) || radius < EPSILON) return null
  const startParameter = Math.atan2(start[1] - center[1], start[0] - center[0])
  const throughParameter = Math.atan2(through[1] - center[1], through[0] - center[0])
  const endParameter = Math.atan2(end[1] - center[1], end[0] - center[0])
  const positiveSweep = positiveAngle(endParameter - startParameter)
  const throughProgress = positiveAngle(throughParameter - startParameter)
  const sweepParameter = throughProgress <= positiveSweep + 1e-7
    ? positiveSweep
    : -(TAU - positiveSweep)
  if (Math.abs(sweepParameter) < EPSILON) return null
  return {
    type: 'arc',
    center,
    axisX: [radius, 0],
    axisY: [0, radius],
    startParameter,
    sweepParameter,
  }
}

/** 由圆心、起点和终点构造圆弧，默认按逆时针方向保留较短路径。 @param center 圆心。 @param start 起点。 @param end 终点。 @param clockwise 是否顺时针。 @returns 参数曲线或空值。 @author snihao */
export function arcFromCenter(center: Point, start: Point, end: Point, clockwise = false): ParametricCurveGeometry | null {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1])
  const endRadius = Math.hypot(end[0] - center[0], end[1] - center[1])
  if (radius < EPSILON || endRadius < EPSILON) return null
  const startParameter = Math.atan2(start[1] - center[1], start[0] - center[0])
  const endParameter = Math.atan2(end[1] - center[1], end[0] - center[0])
  const positiveSweep = positiveAngle(endParameter - startParameter)
  const sweepParameter = clockwise ? -(TAU - positiveSweep) : positiveSweep
  if (Math.abs(sweepParameter) < EPSILON) return null
  return {
    type: 'arc',
    center: center.slice() as Point,
    axisX: [radius, 0],
    axisY: [0, radius],
    startParameter,
    sweepParameter,
  }
}

/**
 * 由起点、终点和半径构造圆弧。
 *
 * sidePoint 用于选择圆弧鼓出的方向：圆弧中点会尽量落在起点到终点弦线的
 * 同一侧。这样鼠标第三次点击既能预览方向，也能通过动态输入的距离字段
 * 精确指定半径。
 * @param start 圆弧起点。
 * @param end 圆弧终点。
 * @param radius 半径，必须不小于弦长的一半。
 * @param sidePoint 用于选择圆弧方向的第三点。
 * @returns 参数圆弧或空值。
 * @author snihao
 */
export function arcFromStartEndRadius(
  start: Point,
  end: Point,
  radius: number,
  sidePoint: Point | null = null,
): ParametricCurveGeometry | null {
  const chord: Point = [end[0] - start[0], end[1] - start[1]]
  const chordLength = Math.hypot(chord[0], chord[1])
  const absoluteRadius = Math.abs(radius)
  if (chordLength < EPSILON || !Number.isFinite(absoluteRadius) || absoluteRadius < chordLength / 2 - EPSILON) return null

  const midpoint: Point = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
  const halfChord = chordLength / 2
  const height = Math.sqrt(Math.max(0, absoluteRadius * absoluteRadius - halfChord * halfChord))
  const normal: Point = [-chord[1] / chordLength, chord[0] / chordLength]
  const centers: Point[] = [
    [midpoint[0] + normal[0] * height, midpoint[1] + normal[1] * height],
    [midpoint[0] - normal[0] * height, midpoint[1] - normal[1] * height],
  ]

  let center = centers[0]
  const side = sidePoint ? cross(chord, [sidePoint[0] - midpoint[0], sidePoint[1] - midpoint[1]]) : 0
  if (Math.abs(side) > EPSILON && height > EPSILON) {
    const firstCenterSide = cross(chord, [centers[0][0] - midpoint[0], centers[0][1] - midpoint[1]])
    if (firstCenterSide * side >= 0) center = centers[1]
  }

  const startParameter = Math.atan2(start[1] - center[1], start[0] - center[0])
  const endParameter = Math.atan2(end[1] - center[1], end[0] - center[0])
  const positiveSweep = positiveAngle(endParameter - startParameter)
  if (positiveSweep < EPSILON || Math.abs(positiveSweep - TAU) < EPSILON) return null

  let sweepParameter = positiveSweep
  if (side && height >= 0) {
    const candidates = [positiveSweep, -(TAU - positiveSweep)]
    const expectedSign = Math.sign(side)
    const matching = candidates.find((candidate) => {
      const middleParameter = startParameter + candidate / 2
      const middlePoint: Point = [
        center[0] + absoluteRadius * Math.cos(middleParameter),
        center[1] + absoluteRadius * Math.sin(middleParameter),
      ]
      return Math.sign(cross(chord, [middlePoint[0] - midpoint[0], middlePoint[1] - midpoint[1]])) === expectedSign
    })
    if (matching != null) sweepParameter = matching
  }

  return {
    type: 'arc',
    center: center.slice() as Point,
    axisX: [absoluteRadius, 0],
    axisY: [0, absoluteRadius],
    startParameter,
    sweepParameter,
  }
}

/** 由中心、长轴端点和短轴半径构造完整椭圆。 @param center 椭圆中心。 @param majorEndpoint 长轴端点。 @param minorRadius 短轴半径。 @returns 参数曲线或空值。 @author snihao */
export function ellipseFromAxis(center: Point, majorEndpoint: Point, minorRadius: number): ParametricCurveGeometry | null {
  const axisX: Point = [majorEndpoint[0] - center[0], majorEndpoint[1] - center[1]]
  const majorRadius = Math.hypot(axisX[0], axisX[1])
  if (majorRadius < EPSILON || !Number.isFinite(minorRadius) || Math.abs(minorRadius) < EPSILON) return null
  const unitNormal: Point = [-axisX[1] / majorRadius, axisX[0] / majorRadius]
  const axisY: Point = [unitNormal[0] * Math.abs(minorRadius), unitNormal[1] * Math.abs(minorRadius)]
  return {
    type: 'ellipse',
    center: center.slice() as Point,
    axisX,
    axisY,
    startParameter: 0,
    sweepParameter: TAU,
  }
}

/**
 * 由椭圆轴和起止点构造椭圆弧。
 * 起止点不要求精确落在椭圆边界上，函数会按归一化轴坐标投影到对应参数。
 * @param center 椭圆中心。
 * @param majorEndpoint 长轴端点。
 * @param minorRadius 短轴半径。
 * @param startPoint 椭圆弧起点。
 * @param endPoint 椭圆弧终点。
 * @param clockwise 是否使用负向参数扫掠。
 * @returns 参数椭圆弧或空值。
 * @author snihao
 */
export function ellipseArcFromAxis(
  center: Point,
  majorEndpoint: Point,
  minorRadius: number,
  startPoint: Point,
  endPoint: Point,
  clockwise = false,
): ParametricCurveGeometry | null {
  const full = ellipseFromAxis(center, majorEndpoint, minorRadius)
  if (!full) return null
  const startParameter = ellipseParameterAtPoint(full, startPoint)
  const endParameter = ellipseParameterAtPoint(full, endPoint)
  if (startParameter == null || endParameter == null) return null
  const positiveSweep = positiveAngle(endParameter - startParameter)
  if (positiveSweep < EPSILON || Math.abs(positiveSweep - TAU) < EPSILON) return null
  return {
    ...full,
    startParameter,
    sweepParameter: clockwise ? -(TAU - positiveSweep) : positiveSweep,
  }
}

/** 按视图比例采样参数曲线供 Canvas 路径使用。 @param curve 参数曲线。 @param scale 当前视图比例。 @returns 采样点。 @author snihao */
export function sampleDrawingCurve(curve: ParametricCurveGeometry, scale = 1): Point[] {
  const radius = Math.max(Math.hypot(curve.axisX[0], curve.axisX[1]), Math.hypot(curve.axisY[0], curve.axisY[1]))
  const segments = Math.max(24, Math.min(256, Math.ceil(Math.abs(curve.sweepParameter) / TAU * Math.max(32, radius * scale / 3))))
  return sampleCurve(curve, segments)
}

function positiveAngle(value: number): number {
  return ((value % TAU) + TAU) % TAU
}

/** 计算二维向量叉积，用于判断点相对弦线的侧向。 */
function cross(first: Point, second: Point): number {
  return first[0] * second[1] - first[1] * second[0]
}

/** 将点转换为椭圆的归一化轴坐标并返回参数角。 */
function ellipseParameterAtPoint(curve: ParametricCurveGeometry, point: Point): number | null {
  const axisXLengthSquared = curve.axisX[0] ** 2 + curve.axisX[1] ** 2
  const axisYLengthSquared = curve.axisY[0] ** 2 + curve.axisY[1] ** 2
  if (axisXLengthSquared < EPSILON || axisYLengthSquared < EPSILON) return null
  const vector: Point = [point[0] - curve.center[0], point[1] - curve.center[1]]
  const normalizedX = (vector[0] * curve.axisX[0] + vector[1] * curve.axisX[1]) / axisXLengthSquared
  const normalizedY = (vector[0] * curve.axisY[0] + vector[1] * curve.axisY[1]) / axisYLengthSquared
  if (Math.hypot(normalizedX, normalizedY) < EPSILON) return null
  return Math.atan2(normalizedY, normalizedX)
}
