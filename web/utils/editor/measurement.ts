/** 精确测量工具：只依赖图纸数据和几何算法，不创建编辑实体。 */
import {
  curveCircle,
  curveEndPoint,
  curveStartPoint,
  isFullCurve,
} from '#draiq/utils/editor/curveGeometry'
import { distance as pointDistance } from '#draiq/utils/editor/geometry'

/** 测量值的显示类别。 */
export type MeasurementValueKind = 'length' | 'area' | 'angle' | 'coordinate'

/** 单项测量结果。 */
export interface MeasurementValue {
  /** 显示名称。 */
  label: string
  /** 未舍入的模型值。 */
  value: number
  /** 值的单位类别。 */
  kind: MeasurementValueKind
}

/** 一次测量操作的结果快照。 */
export interface MeasurementResult {
  /** 结果标题。 */
  title: string
  /** 结果明细。 */
  values: MeasurementValue[]
  /** 参与测量的关键点。 */
  points: Point[]
  /** 被测实体 ID；两点测量和坐标查询为空。 */
  entityId: string | null
  /** 当前图纸单位。 */
  unit: DrawingUnit
}

/** 根据两点生成距离、坐标差和 CAD 角度测量结果。 */
export function measureBetweenPoints(start: Point, end: Point, unit: DrawingUnit = 'mm'): MeasurementResult {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const length = Math.hypot(dx, dy)
  const angle = normalizeAngle(Math.atan2(-dy, dx) * 180 / Math.PI)
  return {
    title: '两点测量',
    values: [
      { label: '距离', value: length, kind: 'length' },
      { label: 'ΔX', value: dx, kind: 'length' },
      { label: 'ΔY', value: dy, kind: 'length' },
      { label: '角度', value: angle, kind: 'angle' },
    ],
    points: [start.slice() as Point, end.slice() as Point],
    entityId: null,
    unit,
  }
}

/** 根据三个点生成夹角测量结果，角度范围为 [0, 360)。 */
export function measureAngle(vertex: Point, start: Point, end: Point, unit: DrawingUnit = 'mm'): MeasurementResult | null {
  const first = [start[0] - vertex[0], start[1] - vertex[1]] as Point
  const second = [end[0] - vertex[0], end[1] - vertex[1]] as Point
  if (Math.hypot(...first) < 1e-9 || Math.hypot(...second) < 1e-9) return null
  const firstAngle = Math.atan2(-first[1], first[0])
  const secondAngle = Math.atan2(-second[1], second[0])
  const angle = normalizeAngle((secondAngle - firstAngle) * 180 / Math.PI)
  return {
    title: '角度测量',
    values: [{ label: '角度', value: angle, kind: 'angle' }],
    points: [start.slice() as Point, vertex.slice() as Point, end.slice() as Point],
    entityId: null,
    unit,
  }
}

/** 查询单点坐标。 */
export function measureCoordinate(point: Point, unit: DrawingUnit = 'mm'): MeasurementResult {
  return {
    title: '坐标查询',
    values: [
      { label: 'X', value: point[0], kind: 'coordinate' },
      { label: 'Y', value: point[1], kind: 'coordinate' },
    ],
    points: [point.slice() as Point],
    entityId: null,
    unit,
  }
}

/** 按实体类型返回精确测量结果；无法计算时返回空值。 */
export function measureEntity(entity: Entity, unit: DrawingUnit = 'mm'): MeasurementResult | null {
  if (entity.type === 'line' && entity.start && entity.end) {
    const result = measureBetweenPoints(entity.start, entity.end, unit)
    return { ...result, title: '直线测量', entityId: entity.id }
  }
  if (entity.type === 'circle' && entity.center && entity.radius != null && entity.radius > 0) {
    return {
      title: '圆测量',
      values: [
        { label: '半径', value: entity.radius, kind: 'length' },
        { label: '直径', value: entity.radius * 2, kind: 'length' },
        { label: '周长', value: Math.PI * entity.radius * 2, kind: 'length' },
        { label: '面积', value: Math.PI * entity.radius ** 2, kind: 'area' },
      ],
      points: [entity.center.slice() as Point],
      entityId: entity.id,
      unit,
    }
  }
  if (entity.type === 'polyline' && entity.curveGeometry) {
    return measureCurveEntity(entity, entity.curveGeometry, unit)
  }
  if (entity.type === 'polyline' && entity.points && entity.points.length >= 2) {
    const perimeter = polylineLength(entity.points, !!entity.closed)
    const values: MeasurementValue[] = [{ label: entity.closed ? '周长' : '长度', value: perimeter, kind: 'length' }]
    if (entity.closed) values.push({ label: '面积', value: polygonArea(entity.points), kind: 'area' })
    return {
      title: entity.closed ? '闭合轮廓测量' : '多段线测量',
      values,
      points: [entity.points[0].slice() as Point],
      entityId: entity.id,
      unit,
    }
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'radius' && entity.dimensionCenter && entity.dimensionStart) {
    const radius = entity.dimensionRadius || pointDistance(entity.dimensionCenter, entity.dimensionStart)
    return {
      title: '半径标注测量',
      values: [{ label: '半径', value: radius, kind: 'length' }],
      points: [entity.dimensionCenter.slice() as Point, entity.dimensionStart.slice() as Point],
      entityId: entity.id,
      unit,
    }
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'diameter' && entity.dimensionCenter && entity.dimensionStart) {
    const radius = entity.dimensionRadius || pointDistance(entity.dimensionCenter, entity.dimensionStart)
    return {
      title: '直径标注测量',
      values: [{ label: '直径', value: radius * 2, kind: 'length' }],
      points: [entity.dimensionCenter.slice() as Point, entity.dimensionStart.slice() as Point],
      entityId: entity.id,
      unit,
    }
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'angular' && entity.dimensionCenter && entity.dimensionStart && entity.dimensionEnd) {
    const result = measureAngle(entity.dimensionCenter, entity.dimensionStart, entity.dimensionEnd, unit)
    return result ? { ...result, title: '角度标注测量', entityId: entity.id } : null
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'arcLength' && entity.dimensionCenter && entity.dimensionStart && entity.dimensionEnd) {
    const radius = entity.dimensionRadius || pointDistance(entity.dimensionCenter, entity.dimensionStart)
    const startAngle = Math.atan2(entity.dimensionStart[1] - entity.dimensionCenter[1], entity.dimensionStart[0] - entity.dimensionCenter[0])
    const endAngle = Math.atan2(entity.dimensionEnd[1] - entity.dimensionCenter[1], entity.dimensionEnd[0] - entity.dimensionCenter[0])
    const sweep = ((endAngle - startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2
    return {
      title: '弧长标注测量',
      values: [{ label: '弧长', value: radius * sweep, kind: 'length' }],
      points: [entity.dimensionCenter.slice() as Point, entity.dimensionStart.slice() as Point, entity.dimensionEnd.slice() as Point],
      entityId: entity.id,
      unit,
    }
  }
  if (entity.type === 'dimension' && entity.dimensionType === 'ordinate' && entity.dimensionStart) {
    const value = entity.dimensionOrdinateType === 'y' ? entity.dimensionStart[1] : entity.dimensionStart[0]
    return {
      title: '坐标标注测量',
      values: [{ label: entity.dimensionOrdinateType === 'y' ? 'Y' : 'X', value, kind: 'coordinate' }],
      points: [entity.dimensionStart.slice() as Point],
      entityId: entity.id,
      unit,
    }
  }
  if (entity.type === 'dimension' && entity.dimensionStart && entity.dimensionEnd) {
    const result = measureBetweenPoints(entity.dimensionStart, entity.dimensionEnd, unit)
    return { ...result, title: '标注测量', entityId: entity.id }
  }
  return null
}

/** 计算参数圆弧或椭圆弧的精确弧长。 */
export function curveLength(curve: ParametricCurveGeometry): number {
  const circle = curveCircle(curve)
  if (circle) return circle.radius * Math.abs(curve.sweepParameter)
  const start = curve.startParameter
  const end = curve.startParameter + curve.sweepParameter
  const length = adaptiveSimpson((parameter) => {
    const sine = Math.sin(parameter)
    const cosine = Math.cos(parameter)
    const dx = -curve.axisX[0] * sine + curve.axisY[0] * cosine
    const dy = -curve.axisX[1] * sine + curve.axisY[1] * cosine
    return Math.hypot(dx, dy)
  }, start, end, 1e-8, 14)
  return Math.abs(length)
}

/** 计算参数曲线面积；partial 曲线可选择是否补齐首尾连线。 */
export function curveArea(curve: ParametricCurveGeometry, closePath = false): number {
  const start = curveStartPoint(curve)
  const end = curveEndPoint(curve)
  const sweep = curve.sweepParameter
  const delta: Point = [end[0] - start[0], end[1] - start[1]]
  const centerTerm = curve.center[0] * delta[1] - curve.center[1] * delta[0]
  const axisTerm = (curve.axisX[0] * curve.axisY[1] - curve.axisX[1] * curve.axisY[0]) * sweep
  const closingTerm = closePath && !isFullCurve(curve) ? end[0] * start[1] - end[1] * start[0] : 0
  return Math.abs((centerTerm + axisTerm + closingTerm) / 2)
}

/** 根据曲线实体生成半径、弧长、周长和面积等结果。 */
function measureCurveEntity(entity: Entity, curve: ParametricCurveGeometry, unit: DrawingUnit): MeasurementResult {
  const circle = curveCircle(curve)
  const full = isFullCurve(curve)
  const closingLength = entity.closed && !full ? pointDistance(curveEndPoint(curve), curveStartPoint(curve)) : 0
  if (circle) {
    const values: MeasurementValue[] = [
      { label: '半径', value: circle.radius, kind: 'length' },
      { label: entity.closed || full ? '周长' : '弧长', value: curveLength(curve) + closingLength, kind: 'length' },
    ]
    if (full) {
      values.splice(1, 0, { label: '直径', value: circle.radius * 2, kind: 'length' })
      values.push({ label: '面积', value: Math.PI * circle.radius ** 2, kind: 'area' })
    } else if (entity.closed) {
      values.push({ label: '面积', value: curveArea(curve, true), kind: 'area' })
    }
    return { title: full ? '参数圆测量' : entity.closed ? '闭合圆弧轮廓测量' : '圆弧测量', values, points: [curve.center.slice() as Point], entityId: entity.id, unit }
  }

  const majorRadius = Math.hypot(...curve.axisX)
  const minorRadius = Math.hypot(...curve.axisY)
  const values: MeasurementValue[] = [
    { label: entity.closed || full ? '周长' : '弧长', value: curveLength(curve) + closingLength, kind: 'length' },
    { label: '长轴半径', value: majorRadius, kind: 'length' },
    { label: '短轴半径', value: minorRadius, kind: 'length' },
  ]
  if (full) values.push({ label: '面积', value: curveArea(curve), kind: 'area' })
  else if (entity.closed) values.push({ label: '面积', value: curveArea(curve, true), kind: 'area' })
  return { title: full ? '参数椭圆测量' : entity.closed ? '闭合椭圆弧轮廓测量' : '椭圆弧测量', values, points: [curve.center.slice() as Point], entityId: entity.id, unit }
}

/** 计算折线长度，闭合折线会补上末点到首点。 */
function polylineLength(points: Point[], closed: boolean): number {
  let total = 0
  for (let index = 1; index < points.length; index++) total += pointDistance(points[index - 1], points[index])
  if (closed) total += pointDistance(points[points.length - 1], points[0])
  return total
}

/** 使用鞋带公式计算折线面积。 */
function polygonArea(points: Point[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length]
    twiceArea += points[index][0] * next[1] - points[index][1] * next[0]
  }
  return Math.abs(twiceArea / 2)
}

/** 自适应 Simpson 积分，保证椭圆弧长不依赖显示采样点数量。 */
function adaptiveSimpson(
  fn: (value: number) => number,
  start: number,
  end: number,
  tolerance: number,
  maxDepth: number,
): number {
  const midpoint = (start + end) / 2
  const whole = simpson(fn, start, end)
  return adaptiveSimpsonStep(fn, start, end, tolerance, whole, simpson(fn, start, midpoint) + simpson(fn, midpoint, end), maxDepth)
}

function adaptiveSimpsonStep(
  fn: (value: number) => number,
  start: number,
  end: number,
  tolerance: number,
  whole: number,
  halves: number,
  depth: number,
): number {
  const midpoint = (start + end) / 2
  const leftMidpoint = (start + midpoint) / 2
  const rightMidpoint = (midpoint + end) / 2
  const left = simpson(fn, start, midpoint)
  const right = simpson(fn, midpoint, end)
  const correction = (left + right - whole) / 15
  if (depth <= 0 || Math.abs(left + right - halves) <= 1e-14) return halves + correction
  if (Math.abs(left + right - whole) <= 15 * tolerance) return left + right + correction
  return adaptiveSimpsonStep(fn, start, midpoint, tolerance / 2, left, simpson(fn, start, leftMidpoint) + simpson(fn, leftMidpoint, midpoint), depth - 1)
    + adaptiveSimpsonStep(fn, midpoint, end, tolerance / 2, right, simpson(fn, midpoint, rightMidpoint) + simpson(fn, rightMidpoint, end), depth - 1)
}

function simpson(fn: (value: number) => number, start: number, end: number): number {
  const midpoint = (start + end) / 2
  return (end - start) * (fn(start) + 4 * fn(midpoint) + fn(end)) / 6
}

function normalizeAngle(value: number): number {
  const normalized = ((value % 360) + 360) % 360
  return normalized >= 360 - 1e-9 ? 0 : normalized
}
