const TAU = Math.PI * 2
const EPSILON = 1e-9

export function curvePoint(curve: ParametricCurveGeometry, parameter: number): Point {
  return [
    precise(curve.center[0] + curve.axisX[0] * Math.cos(parameter) + curve.axisY[0] * Math.sin(parameter)),
    precise(curve.center[1] + curve.axisX[1] * Math.cos(parameter) + curve.axisY[1] * Math.sin(parameter)),
  ]
}

export function curveStartPoint(curve: ParametricCurveGeometry): Point {
  return curvePoint(curve, curve.startParameter)
}

export function curveEndPoint(curve: ParametricCurveGeometry): Point {
  return curvePoint(curve, curve.startParameter + curve.sweepParameter)
}

export function curveMidpoint(curve: ParametricCurveGeometry): Point {
  return curvePoint(curve, curve.startParameter + curve.sweepParameter / 2)
}

export function isFullCurve(curve: ParametricCurveGeometry): boolean {
  return Math.abs(curve.sweepParameter) >= TAU - 1e-7
}

export function curveContainsParameter(curve: ParametricCurveGeometry, parameter: number, tolerance = 1e-7): boolean {
  if (isFullCurve(curve)) return true
  const sweep = curve.sweepParameter
  const progress = sweep >= 0
    ? positiveAngle(parameter - curve.startParameter)
    : positiveAngle(curve.startParameter - parameter)
  return progress <= Math.abs(sweep) + tolerance
}

/** 返回位于可见扫掠范围内的精确圆或椭圆象限点。 */
export function curveQuadrantPoints(curve: ParametricCurveGeometry): Array<{ point: Point; parameter: number }> {
  const candidates: Array<{ point: Point; parameter: number }> = []
  const circle = curveCircle(curve)
  if (circle) {
    const points: Point[] = [
      [circle.center[0] + circle.radius, circle.center[1]],
      [circle.center[0], circle.center[1] + circle.radius],
      [circle.center[0] - circle.radius, circle.center[1]],
      [circle.center[0], circle.center[1] - circle.radius],
    ]
    for (const point of points) {
      const parameter = curveParameterAtPoint(curve, point)
      if (parameter != null && curveContainsParameter(curve, parameter)) candidates.push({ point, parameter })
    }
    return candidates
  }
  for (const parameter of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    if (curveContainsParameter(curve, parameter)) candidates.push({ point: curvePoint(curve, parameter), parameter })
  }
  return candidates
}

/** 查找最近的可见点及其精确曲线参数。 */
export function nearestPointOnCurve(curve: ParametricCurveGeometry, target: Point): { point: Point; parameter: number } {
  const candidates: Array<{ point: Point; parameter: number }> = []
  const inverseParameter = curveParameterAtPoint(curve, target)
  const seeds = Array.from({ length: 24 }, (_, index) => curve.startParameter + TAU * index / 24)
  if (inverseParameter != null) seeds.push(inverseParameter, inverseParameter + Math.PI)

  for (const seed of seeds) {
    let parameter = seed
    for (let iteration = 0; iteration < 14; iteration++) {
      const cos = Math.cos(parameter)
      const sin = Math.sin(parameter)
      const point: Point = [
        curve.center[0] + curve.axisX[0] * cos + curve.axisY[0] * sin,
        curve.center[1] + curve.axisX[1] * cos + curve.axisY[1] * sin,
      ]
      const first: Point = [
        -curve.axisX[0] * sin + curve.axisY[0] * cos,
        -curve.axisX[1] * sin + curve.axisY[1] * cos,
      ]
      const second: Point = [
        -curve.axisX[0] * cos - curve.axisY[0] * sin,
        -curve.axisX[1] * cos - curve.axisY[1] * sin,
      ]
      const delta: Point = [point[0] - target[0], point[1] - target[1]]
      const numerator = delta[0] * first[0] + delta[1] * first[1]
      const denominator = first[0] ** 2 + first[1] ** 2 + delta[0] * second[0] + delta[1] * second[1]
      if (Math.abs(denominator) < 1e-12) break
      const step = numerator / denominator
      parameter -= step
      if (Math.abs(step) < 1e-11) break
    }
    if (curveContainsParameter(curve, parameter)) candidates.push({ point: curvePoint(curve, parameter), parameter })
  }

  if (!isFullCurve(curve)) {
    candidates.push(
      { point: curveStartPoint(curve), parameter: curve.startParameter },
      { point: curveEndPoint(curve), parameter: curve.startParameter + curve.sweepParameter },
    )
  }
  let best = candidates[0] || { point: curveStartPoint(curve), parameter: curve.startParameter }
  let bestDistance = distance(best.point, target)
  for (const candidate of candidates.slice(1)) {
    const candidateDistance = distance(candidate.point, target)
    if (candidateDistance < bestDistance) {
      best = candidate
      bestDistance = candidateDistance
    }
  }
  return best
}

/** 计算外部锚点到仿射圆或椭圆的切点参数。 */
export function curveTangentPoints(curve: ParametricCurveGeometry, anchor: Point): Array<{ point: Point; parameter: number }> {
  const coordinates = curveCoordinates(curve, anchor)
  if (!coordinates) return []
  const radius = Math.hypot(coordinates[0], coordinates[1])
  if (radius <= 1 + 1e-9) return []
  const angle = Math.atan2(coordinates[1], coordinates[0])
  const delta = Math.acos(1 / radius)
  return [angle - delta, angle + delta]
    .filter((parameter) => curveContainsParameter(curve, parameter))
    .map((parameter) => ({ point: curvePoint(curve, parameter), parameter }))
}

/** 计算有限线段与仿射圆或椭圆的精确交点。 */
export function segmentCurveIntersections(
  start: Point,
  end: Point,
  curve: ParametricCurveGeometry,
): Array<{ point: Point; parameter: number; segmentParameter: number }> {
  const from = curveCoordinates(curve, start)
  const to = curveCoordinates(curve, end)
  if (!from || !to) return []
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const a = dx * dx + dy * dy
  if (a < 1e-12) return []
  const b = 2 * (from[0] * dx + from[1] * dy)
  const c = from[0] ** 2 + from[1] ** 2 - 1
  const discriminant = b * b - 4 * a * c
  if (discriminant < -1e-9) return []
  const root = Math.sqrt(Math.max(0, discriminant))
  const values = discriminant <= 1e-9 ? [-b / (2 * a)] : [(-b - root) / (2 * a), (-b + root) / (2 * a)]
  const result: Array<{ point: Point; parameter: number; segmentParameter: number }> = []
  for (const value of values) {
    if (value < -1e-9 || value > 1 + 1e-9) continue
    const point: Point = [precise(start[0] + (end[0] - start[0]) * value), precise(start[1] + (end[1] - start[1]) * value)]
    const parameter = curveParameterAtPoint(curve, point)
    if (parameter != null && curveContainsParameter(curve, parameter)) {
      result.push({ point, parameter, segmentParameter: value })
    }
  }
  return result
}

export function curveParameterAtPoint(curve: ParametricCurveGeometry, point: Point): number | null {
  const coordinates = curveCoordinates(curve, point)
  return coordinates ? Math.atan2(coordinates[1], coordinates[0]) : null
}

export function curveCircle(curve: ParametricCurveGeometry): { center: Point; radius: number } | null {
  const xLength = Math.hypot(curve.axisX[0], curve.axisX[1])
  const yLength = Math.hypot(curve.axisY[0], curve.axisY[1])
  const dot = curve.axisX[0] * curve.axisY[0] + curve.axisX[1] * curve.axisY[1]
  const scale = Math.max(xLength * yLength, 1e-12)
  if (Math.abs(xLength - yLength) > Math.max(xLength, yLength, 1) * 1e-7 || Math.abs(dot) > scale * 1e-7) return null
  return { center: curve.center.slice() as Point, radius: (xLength + yLength) / 2 }
}

export function circleCurveGeometry(center: Point, radius: number): ParametricCurveGeometry {
  return {
    type: 'arc',
    center: center.slice() as Point,
    axisX: [radius, 0],
    axisY: [0, radius],
    startParameter: 0,
    sweepParameter: TAU,
  }
}

/** 计算完整或裁剪后仿射椭圆的精确轴对齐包围盒。 */
export function curveBounds(curve: ParametricCurveGeometry): Bounds {
  const parameters = [curve.startParameter, curve.startParameter + curve.sweepParameter]
  const xExtremum = Math.atan2(curve.axisY[0], curve.axisX[0])
  const yExtremum = Math.atan2(curve.axisY[1], curve.axisX[1])
  for (const parameter of [xExtremum, xExtremum + Math.PI, yExtremum, yExtremum + Math.PI]) {
    if (curveContainsParameter(curve, parameter)) parameters.push(parameter)
  }
  const points = parameters.map((parameter) => curvePoint(curve, parameter))
  return {
    minX: Math.min(...points.map((point) => point[0])),
    minY: Math.min(...points.map((point) => point[1])),
    maxX: Math.max(...points.map((point) => point[0])),
    maxY: Math.max(...points.map((point) => point[1])),
  }
}

/** 计算两条裁剪后的仿射圆或椭圆曲线的交点。 */
export function curveCurveIntersections(
  first: ParametricCurveGeometry,
  second: ParametricCurveGeometry,
): Array<{ point: Point; firstParameter: number; secondParameter: number }> {
  if (curvesCoincident(first, second)) return []

  const firstCircle = curveCircle(first)
  const secondCircle = curveCircle(second)
  if (firstCircle && secondCircle) {
    return circleIntersections(firstCircle.center, firstCircle.radius, secondCircle.center, secondCircle.radius)
      .map((point) => ({
        point,
        firstParameter: curveParameterAtPoint(first, point),
        secondParameter: curveParameterAtPoint(second, point),
      }))
      .filter((item): item is { point: Point; firstParameter: number; secondParameter: number } => (
        item.firstParameter != null
        && item.secondParameter != null
        && curveContainsParameter(first, item.firstParameter)
        && curveContainsParameter(second, item.secondParameter)
      ))
  }

  const result: Array<{ point: Point; firstParameter: number; secondParameter: number }> = []
  const steps = Math.max(96, Math.ceil(Math.abs(first.sweepParameter) / TAU * 192))
  const parameters = Array.from({ length: steps + 1 }, (_, index) => (
    first.startParameter + first.sweepParameter * index / steps
  ))
  const values = parameters.map((parameter) => curveImplicitValue(second, curvePoint(first, parameter)))

  const resultPointTolerance = Math.max(curveScale(first), curveScale(second), 1) * 1e-6
  const tangentPointTolerance = resultPointTolerance * 8
  const append = (
    parameter: number,
    valueTolerance = 1e-6,
    dedupeTolerance = resultPointTolerance,
    preferCandidate = false,
  ): void => {
    const point = curvePoint(first, parameter)
    const secondParameter = curveParameterAtPoint(second, point)
    if (secondParameter == null || !curveContainsParameter(first, parameter) || !curveContainsParameter(second, secondParameter)) return
    if (Math.abs(curveImplicitValue(second, point)) > valueTolerance) return
    const duplicate = result
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => distance(item.point, point) <= dedupeTolerance)
      .sort((left, right) => distance(left.item.point, point) - distance(right.item.point, point))[0]
    if (duplicate) {
      if (preferCandidate) {
        result[duplicate.index] = { point, firstParameter: parameter, secondParameter }
      }
      return
    }
    result.push({ point, firstParameter: parameter, secondParameter })
  }

  for (let index = 0; index < parameters.length; index++) {
    let parameter = parameters[index]
    for (let iteration = 0; iteration < 20; iteration++) {
      const point = curvePoint(first, parameter)
      const value = curveImplicitValue(second, point)
      const derivative = curveImplicitDerivative(second, point, curveDerivative(first, parameter))
      if (Math.abs(value) <= 1e-11 || Math.abs(derivative) <= 1e-12) break
      const next = parameter - value / derivative
      if (!Number.isFinite(next) || Math.abs(next - parameter) > Math.PI) break
      parameter = next
    }
    // 牛顿迭代可能停在根附近的平坦区域。仅当残差
    // 显著小于宽松的候选容差时才保留其结果；
    // 下方的驻点搜索负责处理真正的相切根。
    append(parameter, 1e-12, tangentPointTolerance)

    if (index === 0 || values[index - 1] * values[index] >= 0) continue
    let low = parameters[index - 1]
    let high = parameters[index]
    let lowValue = values[index - 1]
    for (let iteration = 0; iteration < 48; iteration++) {
      const middle = (low + high) / 2
      const middleValue = curveImplicitValue(second, curvePoint(first, middle))
      if (Math.abs(middleValue) <= 1e-12) {
        low = middle
        high = middle
        break
      }
      if (lowValue * middleValue <= 0) high = middle
      else {
        low = middle
        lowValue = middleValue
      }
    }
    append((low + high) / 2)
  }

  // 相切接触点处的隐式曲线函数值不会变号。
  // 通过有界的第二轮搜索寻找该函数的驻点，
  // 避免漏掉椭圆与椭圆、椭圆与圆之间的相切点。
  const derivatives = parameters.map((parameter) => (
    curveImplicitDerivative(second, curvePoint(first, parameter), curveDerivative(first, parameter))
  ))
  /** 对导数变号区间进行有限次二分细化。 */
  const refineStationaryParameter = (
    left: number,
    right: number,
    leftDerivative: number,
    rightDerivative: number,
  ): number | null => {
    if (!Number.isFinite(leftDerivative) || !Number.isFinite(rightDerivative)) return null
    if (Math.abs(leftDerivative) <= 1e-12) return left
    if (Math.abs(rightDerivative) <= 1e-12) return right
    if (leftDerivative * rightDerivative > 0) return null
    let low = left
    let high = right
    let lowDerivative = leftDerivative
    for (let iteration = 0; iteration < 48; iteration++) {
      const middle = (low + high) / 2
      const middleDerivative = curveImplicitDerivative(
        second,
        curvePoint(first, middle),
        curveDerivative(first, middle),
      )
      if (!Number.isFinite(middleDerivative)) return null
      if (Math.abs(middleDerivative) <= 1e-12) return middle
      if (lowDerivative * middleDerivative <= 0) high = middle
      else {
        low = middle
        lowDerivative = middleDerivative
      }
    }
    return (low + high) / 2
  }

  for (let index = 0; index < derivatives.length; index++) {
    const derivative = derivatives[index]
    if (Number.isFinite(derivative) && Math.abs(derivative) <= 1e-12) {
      append(parameters[index], 1e-6, tangentPointTolerance, true)
    }
    if (index === 0) continue
    const previousDerivative = derivatives[index - 1]
    if (!Number.isFinite(previousDerivative)
      || !Number.isFinite(derivative)
      || previousDerivative * derivative >= 0) continue
    const stationary = refineStationaryParameter(
      parameters[index - 1],
      parameters[index],
      previousDerivative,
      derivative,
    )
    if (stationary != null) append(stationary, 1e-6, tangentPointTolerance, true)
  }
  return result
}

export function sampleCurve(curve: ParametricCurveGeometry, segments = 64): Point[] {
  const count = Math.max(2, segments)
  return Array.from({ length: count + 1 }, (_, index) => (
    curvePoint(curve, curve.startParameter + curve.sweepParameter * index / count)
  ))
}

/** 应用任意仿射点变换，同时保留精确参数语义。 */
export function transformCurveGeometry(
  curve: ParametricCurveGeometry,
  transformPoint: (point: Point) => Point,
): ParametricCurveGeometry {
  const center = transformPoint(curve.center)
  const axisXEnd = transformPoint([curve.center[0] + curve.axisX[0], curve.center[1] + curve.axisX[1]])
  const axisYEnd = transformPoint([curve.center[0] + curve.axisY[0], curve.center[1] + curve.axisY[1]])
  const result: ParametricCurveGeometry = {
    ...curve,
    center,
    axisX: [axisXEnd[0] - center[0], axisXEnd[1] - center[1]],
    axisY: [axisYEnd[0] - center[0], axisYEnd[1] - center[1]],
  }
  if (result.type === 'arc' && !curveCircle(result)) result.type = 'ellipse'
  return result
}

export function translateCurveGeometry(curve: ParametricCurveGeometry, dx: number, dy: number): void {
  curve.center = [curve.center[0] + dx, curve.center[1] + dy]
}

export function scaleCurveGeometry(curve: ParametricCurveGeometry, scale: number): void {
  curve.center = [curve.center[0] * scale, curve.center[1] * scale]
  curve.axisX = [curve.axisX[0] * scale, curve.axisX[1] * scale]
  curve.axisY = [curve.axisY[0] * scale, curve.axisY[1] * scale]
}

export function flipCurveGeometryY(curve: ParametricCurveGeometry): void {
  curve.center[1] *= -1
  curve.axisX[1] *= -1
  curve.axisY[1] *= -1
}

function curveCoordinates(curve: ParametricCurveGeometry, point: Point): Point | null {
  const determinant = curve.axisX[0] * curve.axisY[1] - curve.axisX[1] * curve.axisY[0]
  if (Math.abs(determinant) < 1e-12) return null
  const dx = point[0] - curve.center[0]
  const dy = point[1] - curve.center[1]
  return [
    (dx * curve.axisY[1] - dy * curve.axisY[0]) / determinant,
    (curve.axisX[0] * dy - curve.axisX[1] * dx) / determinant,
  ]
}

function curveCoordinatesVector(curve: ParametricCurveGeometry, vector: Point): Point | null {
  const determinant = curve.axisX[0] * curve.axisY[1] - curve.axisX[1] * curve.axisY[0]
  if (Math.abs(determinant) < 1e-12) return null
  return [
    (vector[0] * curve.axisY[1] - vector[1] * curve.axisY[0]) / determinant,
    (curve.axisX[0] * vector[1] - curve.axisX[1] * vector[0]) / determinant,
  ]
}

function curveDerivative(curve: ParametricCurveGeometry, parameter: number): Point {
  return [
    -curve.axisX[0] * Math.sin(parameter) + curve.axisY[0] * Math.cos(parameter),
    -curve.axisX[1] * Math.sin(parameter) + curve.axisY[1] * Math.cos(parameter),
  ]
}

function curveImplicitValue(curve: ParametricCurveGeometry, point: Point): number {
  const coordinates = curveCoordinates(curve, point)
  return coordinates ? coordinates[0] ** 2 + coordinates[1] ** 2 - 1 : Infinity
}

function curveImplicitDerivative(curve: ParametricCurveGeometry, point: Point, direction: Point): number {
  const coordinates = curveCoordinates(curve, point)
  const vector = curveCoordinatesVector(curve, direction)
  if (!coordinates || !vector) return 0
  return 2 * (coordinates[0] * vector[0] + coordinates[1] * vector[1])
}

function curvesCoincident(first: ParametricCurveGeometry, second: ParametricCurveGeometry): boolean {
  const fractions = [0, 0.2, 0.4, 0.6, 0.8, 1]
  return fractions.every((fraction) => (
    Math.abs(curveImplicitValue(second, curvePoint(first, first.startParameter + first.sweepParameter * fraction))) <= 1e-7
  )) && fractions.every((fraction) => (
    Math.abs(curveImplicitValue(first, curvePoint(second, second.startParameter + second.sweepParameter * fraction))) <= 1e-7
  ))
}

function circleIntersections(firstCenter: Point, firstRadius: number, secondCenter: Point, secondRadius: number): Point[] {
  const dx = secondCenter[0] - firstCenter[0]
  const dy = secondCenter[1] - firstCenter[1]
  const centerDistance = Math.hypot(dx, dy)
  if (centerDistance < EPSILON) return []
  if (centerDistance > firstRadius + secondRadius + EPSILON) return []
  if (centerDistance < Math.abs(firstRadius - secondRadius) - EPSILON) return []
  const along = (firstRadius ** 2 - secondRadius ** 2 + centerDistance ** 2) / (2 * centerDistance)
  const heightSquared = firstRadius ** 2 - along ** 2
  if (heightSquared < -EPSILON) return []
  const height = Math.sqrt(Math.max(0, heightSquared))
  const ux = dx / centerDistance
  const uy = dy / centerDistance
  const base: Point = [firstCenter[0] + along * ux, firstCenter[1] + along * uy]
  if (height <= EPSILON) return [[precise(base[0]), precise(base[1])]]
  return [
    [precise(base[0] - uy * height), precise(base[1] + ux * height)],
    [precise(base[0] + uy * height), precise(base[1] - ux * height)],
  ]
}

function curveScale(curve: ParametricCurveGeometry): number {
  return Math.max(Math.hypot(...curve.axisX), Math.hypot(...curve.axisY))
}

function distance(first: Point, second: Point): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1])
}

function positiveAngle(value: number): number {
  return (value % TAU + TAU) % TAU
}

function precise(value: number): number {
  return Math.round(value * 1e9) / 1e9
}
