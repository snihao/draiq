import { distance, genId } from '#draiq/utils/editor/geometry'
import { arcFromCenter, ellipseArcFromAxis, ellipseFromAxis, sampleDrawingCurve } from '#draiq/utils/editor/curveDrawing'
import {
  BASIC_DEGENERATE_TOLERANCE,
  BASIC_GEOMETRY_LIMIT,
  BASIC_POLYLINE_POINT_LIMIT,
  BASIC_TEXT_LENGTH_LIMIT,
} from '#draiq/utils/editor/cad/basicEntityLimits'

/** 创建普通实体时使用的最小样式上下文。 */
export interface EntityFactoryDefaults {
  /** 实体颜色。 */
  color: string
  /** 目标图层。 */
  layer: string
  /** 实体线宽。 */
  lineWidth: number
  /** 实体线型。 */
  lineType: LineType
}

/** 普通实体工厂上下文。 */
export interface EntityFactoryContext {
  /** 当前图纸；实体工厂只读取它。 */
  drawing: Drawing
  /** 新实体的默认样式。 */
  defaults: EntityFactoryDefaults
}

/** 工厂失败时返回的稳定错误。 */
export interface EntityFactoryError {
  /** 稳定错误码。 */
  code: 'INVALID_POINT' | 'DEGENERATE_GEOMETRY' | 'INVALID_RADIUS' | 'INVALID_TEXT'
  /** 面向调用方的说明。 */
  message: string
}

/** 工厂统一返回值。 */
export type EntityFactoryResult<T> =
  | { ok: true; entity: T }
  | { ok: false; error: EntityFactoryError }

/** 创建一个带默认样式的实体骨架。
 * @param type 实体类型。
 * @param context 工厂上下文。
 * @param id 可选实体 ID。
 * @returns 尚未填充几何字段的实体。
 * @author snihao
 */
export function createEntityBase(type: EntityType, context: EntityFactoryContext, id = genId(type)): Entity {
  return {
    id,
    type,
    layer: context.defaults.layer,
    color: context.defaults.color,
    lineWidth: context.defaults.lineWidth,
    lineType: context.defaults.lineType,
  }
}

/** 创建直线实体。
 * @param start 起点。
 * @param end 终点。
 * @param context 工厂上下文。
 * @param id 可选实体 ID。
 * @returns 创建结果；零长度直线会失败。
 * @author snihao
 */
export function createLineEntity(
  start: Point,
  end: Point,
  context: EntityFactoryContext,
  id = genId('line'),
): EntityFactoryResult<Entity> {
  const normalizedStart = copyPoint(start)
  const normalizedEnd = copyPoint(end)
  if (!normalizedStart || !normalizedEnd) return invalidPointResult()
  if (distance(normalizedStart, normalizedEnd) <= 1e-8) {
    return invalidResult('DEGENERATE_GEOMETRY', '直线起点和终点不能重合')
  }
  return {
    ok: true,
    entity: {
      ...createEntityBase('line', context, id),
      start: normalizedStart,
      end: normalizedEnd,
    },
  }
}

/** 创建圆实体。
 * @param center 圆心。
 * @param radius 半径。
 * @param context 工厂上下文。
 * @param id 可选实体 ID。
 * @returns 创建结果。
 * @author snihao
 */
export function createCircleEntity(
  center: Point,
  radius: number,
  context: EntityFactoryContext,
  id = genId('circle'),
): EntityFactoryResult<Entity> {
  const normalizedCenter = copyPoint(center)
  if (!normalizedCenter) return invalidPointResult()
  if (!Number.isFinite(radius)
    || radius <= BASIC_DEGENERATE_TOLERANCE
    || radius > BASIC_GEOMETRY_LIMIT) return invalidResult('INVALID_RADIUS', '圆半径必须为有效正数')
  return {
    ok: true,
    entity: {
      ...createEntityBase('circle', context, id),
      center: normalizedCenter,
      radius,
    },
  }
}

/** 创建精确圆弧，并保存到编辑器兼容曲线的数据模型中。
 * @param center 圆心。
 * @param startPoint 圆弧起点，必须与 endPoint 位于同一圆上。
 * @param endPoint 圆弧终点，必须与 startPoint 位于同一圆上。
 * @param context 实体工厂上下文。
 * @param id 可选的实体 ID。
 * @param clockwise 是否使用负向参数扫掠。
 * @returns 创建结果；半径不匹配或端点退化时失败。
 */
export function createArcEntity(
  center: Point,
  startPoint: Point,
  endPoint: Point,
  context: EntityFactoryContext,
  id = genId('arc'),
  clockwise = false,
): EntityFactoryResult<Entity> {
  const normalizedCenter = copyPoint(center)
  const normalizedStartPoint = copyPoint(startPoint)
  const normalizedEndPoint = copyPoint(endPoint)
  if (!normalizedCenter || !normalizedStartPoint || !normalizedEndPoint) return invalidPointResult()
  const radius = distance(normalizedCenter, normalizedStartPoint)
  const endRadius = distance(normalizedCenter, normalizedEndPoint)
  const radiusTolerance = Math.max(BASIC_DEGENERATE_TOLERANCE, Math.max(radius, endRadius) * 1e-7)
  if (!Number.isFinite(radius)
    || !Number.isFinite(endRadius)
    || radius <= BASIC_DEGENERATE_TOLERANCE
    || endRadius <= BASIC_DEGENERATE_TOLERANCE
    || radius > BASIC_GEOMETRY_LIMIT
    || endRadius > BASIC_GEOMETRY_LIMIT) {
    return invalidResult('INVALID_RADIUS', '圆弧端点必须位于有效半径范围内')
  }
  if (Math.abs(radius - endRadius) > radiusTolerance) {
    return invalidResult('DEGENERATE_GEOMETRY', '圆弧起点和终点必须位于同一圆上')
  }
  if (distance(normalizedStartPoint, normalizedEndPoint) <= BASIC_DEGENERATE_TOLERANCE) {
    return invalidResult('DEGENERATE_GEOMETRY', '圆弧起点和终点不能重合')
  }
  const curve = arcFromCenter(normalizedCenter, normalizedStartPoint, normalizedEndPoint, clockwise)
  if (!curve) return invalidResult('DEGENERATE_GEOMETRY', '圆弧参数退化')
  return {
    ok: true,
    entity: {
      ...createEntityBase('polyline', context, id),
      points: sampleDrawingCurve(curve),
      closed: false,
      curveGeometry: curve,
    },
  }
}

/** 创建完整参数椭圆，并保存到编辑器兼容多段线的数据模型中。
 * @param center 椭圆中心。
 * @param majorEndpoint 长轴端点；长轴方向由中心指向该点。
 * @param minorRadius 短轴半径。
 * @param context 工厂上下文。
 * @param id 可选实体 ID。
 * @returns 创建结果；退化长轴或短轴会失败。
 * @author snihao
 */
export function createEllipseEntity(
  center: Point,
  majorEndpoint: Point,
  minorRadius: number,
  context: EntityFactoryContext,
  id = genId('ellipse'),
  startPoint?: Point,
  endPoint?: Point,
  clockwise = false,
): EntityFactoryResult<Entity> {
  const normalizedCenter = copyPoint(center)
  const normalizedMajorEndpoint = copyPoint(majorEndpoint)
  if (!normalizedCenter || !normalizedMajorEndpoint) return invalidPointResult()
  if (!Number.isFinite(minorRadius)
    || minorRadius <= BASIC_DEGENERATE_TOLERANCE
    || minorRadius > BASIC_GEOMETRY_LIMIT) {
    return invalidResult('INVALID_RADIUS', '椭圆短轴半径必须为有效正数')
  }
  const hasStartPoint = startPoint !== undefined
  const hasEndPoint = endPoint !== undefined
  if (hasStartPoint !== hasEndPoint) {
    return invalidResult('INVALID_POINT', '椭圆弧必须提供成对的起点和终点')
  }
  const normalizedStartPoint = hasStartPoint ? copyPoint(startPoint) : null
  const normalizedEndPoint = hasEndPoint ? copyPoint(endPoint) : null
  if ((hasStartPoint && !normalizedStartPoint) || (hasEndPoint && !normalizedEndPoint)) return invalidPointResult()
  const curve = normalizedStartPoint && normalizedEndPoint
    ? ellipseArcFromAxis(
        normalizedCenter,
        normalizedMajorEndpoint,
        minorRadius,
        normalizedStartPoint,
        normalizedEndPoint,
        clockwise,
      )
    : ellipseFromAxis(normalizedCenter, normalizedMajorEndpoint, minorRadius)
  if (!curve) return invalidResult('DEGENERATE_GEOMETRY', '椭圆长轴或弧段参数退化')
  return {
    ok: true,
    entity: {
      ...createEntityBase('polyline', context, id),
      points: sampleDrawingCurve(curve),
      closed: !normalizedStartPoint,
      curveGeometry: curve,
    },
  }
}

/** 创建多段线实体。
 * @param points 顶点列表。
 * @param closed 是否闭合。
 * @param context 工厂上下文。
 * @param id 可选实体 ID。
 * @returns 创建结果。
 * @author snihao
 */
export function createPolylineEntity(
  points: Point[],
  closed: boolean,
  context: EntityFactoryContext,
  id = genId('polyline'),
): EntityFactoryResult<Entity> {
  if (!Array.isArray(points)
    || points.length < 2
    || points.length > BASIC_POLYLINE_POINT_LIMIT) {
    return invalidResult('DEGENERATE_GEOMETRY', '多段线必须包含有效数量的顶点')
  }
  const normalized = points.map(copyPoint)
  if (normalized.some((point): point is null => point === null)) return invalidPointResult()
  const validPoints = normalized as Point[]
  if (validPoints.length < 2) return invalidResult('DEGENERATE_GEOMETRY', '多段线至少需要两个顶点')
  const segmentCount = closed ? validPoints.length : validPoints.length - 1
  const hasLength = Array.from({ length: segmentCount }, (_, index) => {
    return distance(validPoints[index], validPoints[(index + 1) % validPoints.length]) > 1e-8
  }).some(Boolean)
  if (!hasLength) return invalidResult('DEGENERATE_GEOMETRY', '多段线不能由重合顶点组成')
  return {
    ok: true,
    entity: {
      ...createEntityBase('polyline', context, id),
      points: validPoints,
      closed,
    },
  }
}

/** 创建普通文字实体。
 * @param position 文字位置。
 * @param content 文字内容。
 * @param fontSize 字高。
 * @param context 工厂上下文。
 * @param id 可选实体 ID。
 * @returns 创建结果。
 * @author snihao
 */
export function createTextEntity(
  position: Point,
  content: string,
  fontSize: number,
  context: EntityFactoryContext,
  id = genId('text'),
): EntityFactoryResult<Entity> {
  const normalizedPosition = copyPoint(position)
  if (!normalizedPosition) return invalidPointResult()
  if (typeof content !== 'string'
    || !content.trim()
    || content.length > BASIC_TEXT_LENGTH_LIMIT
    || /[\u0000-\u001f\u007f]/.test(content)) {
    return invalidResult('INVALID_TEXT', '文字内容必须非空、有界且不得包含控制字符')
  }
  if (!Number.isFinite(fontSize)
    || fontSize <= BASIC_DEGENERATE_TOLERANCE
    || fontSize > BASIC_GEOMETRY_LIMIT) return invalidResult('INVALID_TEXT', '文字高度必须为有效正数')
  return {
    ok: true,
    entity: {
      ...createEntityBase('text', context, id),
      position: normalizedPosition,
      content,
      fontSize,
      rotation: 0,
    },
  }
}

/** 复制并验证坐标点。
 * @param point 待验证点。
 * @returns 有限坐标点或空值。
 * @author snihao
 */
function copyPoint(point: Point): Point | null {
  if (!Array.isArray(point)
    || point.length !== 2
    || !Number.isFinite(point[0])
    || !Number.isFinite(point[1])
    || Math.abs(point[0]) > BASIC_GEOMETRY_LIMIT
    || Math.abs(point[1]) > BASIC_GEOMETRY_LIMIT) return null
  return [point[0], point[1]]
}

/** 创建非法坐标错误结果。
 * @returns 工厂失败结果。
 * @author snihao
 */
function invalidPointResult(): { ok: false; error: EntityFactoryError } {
  return invalidResult('INVALID_POINT', '实体坐标必须是有限数值')
}

/** 创建工厂失败结果。
 * @param code 稳定错误码。
 * @param message 错误说明。
 * @returns 工厂失败结果。
 * @author snihao
 */
function invalidResult(code: EntityFactoryError['code'], message: string): { ok: false; error: EntityFactoryError } {
  return { ok: false, error: { code, message } }
}
