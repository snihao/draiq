import { distance, genId, midpoint, round, syncDimensionMeasurementText } from '#draiq/utils/editor/geometry'
import { currentDimensionStyleName } from '#draiq/utils/editor/dimensionStyles'
import { createEntityBase } from '#draiq/utils/editor/factories/entityFactory'
import type { EntityFactoryDefaults } from '#draiq/utils/editor/factories/entityFactory'

/** 标注工厂上下文。 */
export interface DimensionFactoryContext {
  /** 当前图纸；只读取 DIMSTYLE。 */
  drawing: Drawing
  /** 新标注的默认样式。 */
  defaults: EntityFactoryDefaults
}

/** 标注工厂失败错误码。 */
export type DimensionFactoryErrorCode =
  | 'INVALID_POINT'
  | 'DEGENERATE_GEOMETRY'
  | 'INVALID_PLACEMENT'
  | 'INVALID_RADIUS'
  | 'INVALID_SWEEP'
  | 'INVALID_SOURCE'

/** 标注工厂失败错误。 */
export interface DimensionFactoryError {
  /** 稳定错误码。 */
  code: DimensionFactoryErrorCode
  /** 面向调用方的错误说明。 */
  message: string
}

/** 标注工厂统一返回值。 */
export type DimensionFactoryResult =
  | { ok: true; entity: Entity }
  | { ok: false; error: DimensionFactoryError }

/** 可选的线段来源，用于持久化角度标注关联。 */
export interface DimensionSegmentSource {
  /** 来源实体 ID。 */
  entityId?: string
  /** 多段线段索引。 */
  segmentIndex?: number
  /** 来源线段起点。 */
  start: Point
  /** 来源线段终点。 */
  end: Point
  /** 用于确定射线方向的用户拾取点。 */
  pickPoint?: Point
}

/** 圆或圆弧来源，用于持久化径向标注关联。 */
export interface DimensionCircularSource {
  /** 来源实体 ID。 */
  entityId: string
  /** 来源几何语义。 */
  kind: 'circle' | 'curve'
  /** 参数曲线的可选参数范围。 */
  parameterRange?: [number, number]
}

/** 标注文字定位选项。 */
interface DimensionPlacementOptions {
  /** 尺寸线或引线上的放置位置。 */
  placement: Point
  /** 是否把文字视为人工放置。 */
  textPositionManual?: boolean
  /** 可选实体 ID。 */
  id?: string
}

/** 对齐标注规格。 */
export interface AlignedDimensionSpec extends DimensionPlacementOptions {
  /** 起点。 */
  start: Point
  /** 终点。 */
  end: Point
  /** 两条尺寸界线在尺寸线上的落点。 */
  dimensionLinePosition: Point
  /** 起点关联引用。 */
  startReference?: PointReference | null
  /** 终点关联引用。 */
  endReference?: PointReference | null
}

/** 线性标注规格。 */
export interface LinearDimensionSpec extends DimensionPlacementOptions {
  /** 起点。 */
  start: Point
  /** 终点。 */
  end: Point
  /** 尺寸线落点。 */
  dimensionLinePosition: Point
  /** 尺寸线方向角，单位为编辑器坐标系角度。 */
  dimensionAngle?: number | null
  /** 起点关联引用。 */
  startReference?: PointReference | null
  /** 终点关联引用。 */
  endReference?: PointReference | null
}

/** 两直线角度标注规格。 */
export interface AngularDimensionSpec extends DimensionPlacementOptions {
  /** 第一条来源线段。 */
  first: DimensionSegmentSource
  /** 第二条来源线段。 */
  second: DimensionSegmentSource
}

/** 半径标注规格。 */
export interface RadiusDimensionSpec extends DimensionPlacementOptions {
  /** 圆心。 */
  center: Point
  /** 圆周上的测量点；半径从此点重新计算。 */
  measurement: Point
  /** 可选来源。 */
  source?: DimensionCircularSource
}

/** 直径标注规格。 */
export interface DiameterDimensionSpec extends DimensionPlacementOptions {
  /** 圆心。 */
  center: Point
  /** 圆周上的测量点；直径从此点重新计算。 */
  measurement: Point
  /** 可选来源。 */
  source?: DimensionCircularSource
}

/** 圆弧长度标注规格。 */
export interface ArcLengthDimensionSpec extends DimensionPlacementOptions {
  /** 圆心。 */
  center: Point
  /** 圆弧起点。 */
  start: Point
  /** 圆弧终点。 */
  end: Point
  /** 由参数曲线确定的有向弧度。 */
  sweep: number
  /** 可选来源。 */
  source?: DimensionCircularSource
}

/** 坐标标注规格。 */
export interface OrdinateDimensionSpec extends DimensionPlacementOptions {
  /** 被标注的特征点。 */
  feature: Point
  /** 坐标原点；缺省为图纸坐标原点。 */
  origin?: Point
  /** 标注 X 或 Y 坐标。 */
  ordinateType: OrdinateDimensionType
  /** 特征点关联引用。 */
  featureReference?: PointReference | null
}

/** 所有受支持的标注规格。 */
export type DimensionSpec =
  | AlignedDimensionSpec & { dimensionType: 'aligned' }
  | LinearDimensionSpec & { dimensionType: 'linear' }
  | AngularDimensionSpec & { dimensionType: 'angular' }
  | RadiusDimensionSpec & { dimensionType: 'radius' }
  | DiameterDimensionSpec & { dimensionType: 'diameter' }
  | ArcLengthDimensionSpec & { dimensionType: 'arcLength' }
  | OrdinateDimensionSpec & { dimensionType: 'ordinate' }

const EPSILON = 1e-7
const TAU = Math.PI * 2

/** 根据标注规格创建对应的原生 dimension 实体。
 * @param spec 标注规格。
 * @param context 工厂上下文。
 * @returns 标注实体或稳定错误。
 * @author snihao
 */
export function createDimension(spec: DimensionSpec, context: DimensionFactoryContext): DimensionFactoryResult {
  switch (spec.dimensionType) {
    case 'aligned': return createAlignedDimension(spec, context)
    case 'linear': return createLinearDimension(spec, context)
    case 'angular': return createAngularDimension(spec, context)
    case 'radius': return createRadiusDimension(spec, context)
    case 'diameter': return createDiameterDimension(spec, context)
    case 'arcLength': return createArcLengthDimension(spec, context)
    case 'ordinate': return createOrdinateDimension(spec, context)
  }
}

/** 创建对齐标注。
 * @param spec 对齐标注规格。
 * @param context 工厂上下文。
 * @returns 标注实体或错误。
 * @author snihao
 */
export function createAlignedDimension(spec: AlignedDimensionSpec, context: DimensionFactoryContext): DimensionFactoryResult {
  const points = validateMeasuredPoints(spec.start, spec.end, spec.dimensionLinePosition)
  if (!points.ok) return points
  const textPlacement = copyPoint(spec.placement)
  if (!textPlacement) return invalid('INVALID_POINT', '标注文字位置必须是有限坐标')
  const { start, end, placement } = points
  const entity = dimensionBase(context, spec.id || genId('dim-aligned'))
  Object.assign(entity, {
    dimensionType: 'aligned' as const,
    dimensionStart: start,
    dimensionEnd: end,
    dimensionLinePosition: placement,
    dimensionAngle: null,
    position: textPlacement,
    text: `${round(distance(start, end))}`,
    textPositionManual: spec.textPositionManual === true,
    dimensionRefs: [spec.startReference || null, spec.endReference || null],
  })
  return { ok: true, entity }
}

/** 创建线性标注。
 * @param spec 线性标注规格。
 * @param context 工厂上下文。
 * @returns 标注实体或错误。
 * @author snihao
 */
export function createLinearDimension(spec: LinearDimensionSpec, context: DimensionFactoryContext): DimensionFactoryResult {
  const points = validateMeasuredPoints(spec.start, spec.end, spec.dimensionLinePosition)
  if (!points.ok) return points
  const textPlacement = copyPoint(spec.placement)
  if (!textPlacement) return invalid('INVALID_POINT', '标注文字位置必须是有限坐标')
  if (spec.dimensionAngle != null && !Number.isFinite(spec.dimensionAngle)) {
    return invalid('INVALID_PLACEMENT', '线性标注方向角必须是有限数值')
  }
  const { start, end, placement } = points
  const entity = dimensionBase(context, spec.id || genId('dim-linear'))
  Object.assign(entity, {
    dimensionType: 'linear' as const,
    dimensionStart: start,
    dimensionEnd: end,
    dimensionLinePosition: placement,
    dimensionAngle: spec.dimensionAngle ?? null,
    position: textPlacement,
    text: `${round(distance(start, end))}`,
    textPositionManual: spec.textPositionManual === true,
    dimensionRefs: [spec.startReference || null, spec.endReference || null],
  })
  syncDimensionMeasurementText(entity)
  return { ok: true, entity }
}

/** 创建两直线角度标注。
 * @param spec 两直线角度规格。
 * @param context 工厂上下文。
 * @returns 标注实体或错误。
 * @author snihao
 */
export function createAngularDimension(spec: AngularDimensionSpec, context: DimensionFactoryContext): DimensionFactoryResult {
  const first = normalizeSegmentSource(spec.first)
  const second = normalizeSegmentSource(spec.second)
  if (!first || !second) return invalid('INVALID_SOURCE', '角度标注必须提供两条有效来源线段')
  const center = infiniteLineIntersection(first.start, first.end, second.start, second.end)
  if (!center) return invalid('DEGENERATE_GEOMETRY', '所选直线平行或重合，无法创建角度标注')
  const placement = copyPoint(spec.placement)
  if (!placement) return invalid('INVALID_POINT', '角度标注放置点必须是有限坐标')
  const radius = distance(center, placement)
  if (radius <= EPSILON) return invalid('INVALID_PLACEMENT', '尺寸弧位置不能与两直线交点重合')
  const rays = angularRays(first, second, center, placement, radius)
  if (!rays) return invalid('DEGENERATE_GEOMETRY', '角度不能是零度、平角或无效角度')
  const entity = dimensionBase(context, spec.id || genId('dim-angular'))
  Object.assign(entity, {
    dimensionType: 'angular' as const,
    dimensionAngularMode: 'twoLine' as const,
    dimensionCenter: center,
    dimensionStart: rays.start,
    dimensionEnd: rays.end,
    dimensionAngularLine1Start: center.slice() as Point,
    dimensionAngularLine2Start: center.slice() as Point,
    dimensionRadius: radius,
    dimensionLinePosition: placement,
    position: copyPoint(spec.placement),
    text: `${round(rays.sweep * 180 / Math.PI)}°`,
    textPositionManual: spec.textPositionManual !== false,
    dimensionAssociations: [
      segmentAssociation('line1', first),
      segmentAssociation('line2', second),
    ].filter((association): association is DimensionAssociation => association !== null),
  })
  return { ok: true, entity }
}

/** 创建半径标注。
 * @param spec 半径标注规格。
 * @param context 工厂上下文。
 * @returns 标注实体或错误。
 * @author snihao
 */
export function createRadiusDimension(spec: RadiusDimensionSpec, context: DimensionFactoryContext): DimensionFactoryResult {
  const geometry = radialGeometry(spec.center, spec.measurement)
  if (!geometry.ok) return geometry
  const textPlacement = copyPoint(spec.placement)
  if (!textPlacement) return invalid('INVALID_POINT', '标注文字位置必须是有限坐标')
  const entity = dimensionBase(context, spec.id || genId('dim-radius'))
  Object.assign(entity, {
    dimensionType: 'radius' as const,
    dimensionCenter: geometry.center,
    dimensionStart: geometry.measurement,
    dimensionEnd: null,
    dimensionRadius: geometry.radius,
    dimensionLinePosition: geometry.measurement.slice() as Point,
    position: textPlacement,
    text: `R${round(geometry.radius)}`,
    textPositionManual: spec.textPositionManual !== false,
    dimensionSource: dimensionSource(spec.source),
    dimensionAssociations: circularAssociations(spec.source, geometry),
  })
  return { ok: true, entity }
}

/** 创建直径标注。
 * @param spec 直径标注规格。
 * @param context 工厂上下文。
 * @returns 标注实体或错误。
 * @author snihao
 */
export function createDiameterDimension(spec: DiameterDimensionSpec, context: DimensionFactoryContext): DimensionFactoryResult {
  const geometry = radialGeometry(spec.center, spec.measurement)
  if (!geometry.ok) return geometry
  const textPlacement = copyPoint(spec.placement)
  if (!textPlacement) return invalid('INVALID_POINT', '标注文字位置必须是有限坐标')
  const end: Point = [
    geometry.center[0] * 2 - geometry.measurement[0],
    geometry.center[1] * 2 - geometry.measurement[1],
  ]
  const entity = dimensionBase(context, spec.id || genId('dim-diameter'))
  Object.assign(entity, {
    dimensionType: 'diameter' as const,
    dimensionCenter: geometry.center,
    dimensionStart: geometry.measurement,
    dimensionEnd: end,
    dimensionRadius: geometry.radius,
    dimensionLinePosition: geometry.measurement.slice() as Point,
    position: textPlacement,
    text: `Ø${round(geometry.radius * 2)}`,
    textPositionManual: spec.textPositionManual !== false,
    dimensionSource: dimensionSource(spec.source),
    dimensionAssociations: circularAssociations(spec.source, geometry),
  })
  return { ok: true, entity }
}

/** 创建圆弧长度标注。
 * @param spec 圆弧长度规格。
 * @param context 工厂上下文。
 * @returns 标注实体或错误。
 * @author snihao
 */
export function createArcLengthDimension(spec: ArcLengthDimensionSpec, context: DimensionFactoryContext): DimensionFactoryResult {
  const center = copyPoint(spec.center)
  const start = copyPoint(spec.start)
  const end = copyPoint(spec.end)
  const placement = copyPoint(spec.placement)
  if (!center || !start || !end || !placement) return invalid('INVALID_POINT', '弧长标注坐标必须是有限数值')
  const radiusStart = distance(center, start)
  const radiusEnd = distance(center, end)
  if (radiusStart <= EPSILON || Math.abs(radiusStart - radiusEnd) > Math.max(1e-6, radiusStart * 1e-7)) {
    return invalid('DEGENERATE_GEOMETRY', '弧长标注的起点和终点必须位于同一有效圆弧上')
  }
  if (!Number.isFinite(spec.sweep) || spec.sweep <= EPSILON || spec.sweep >= TAU - EPSILON) {
    return invalid('INVALID_SWEEP', '弧长扫掠角必须位于 0 和 2π 之间')
  }
  if (distance(center, placement) <= EPSILON) return invalid('INVALID_PLACEMENT', '弧长尺寸位置不能与圆心重合')
  const entity = dimensionBase(context, spec.id || genId('dim-arc-length'))
  Object.assign(entity, {
    dimensionType: 'arcLength' as const,
    dimensionCenter: center,
    dimensionStart: start,
    dimensionEnd: end,
    dimensionRadius: radiusStart,
    dimensionLinePosition: placement,
    position: placement.slice() as Point,
    text: `${round(radiusStart * spec.sweep)}`,
    textPositionManual: spec.textPositionManual !== false,
    dimensionSource: null,
    dimensionAssociations: spec.source?.entityId
      ? [{
          role: 'curve' as const,
          source: {
            kind: 'curve' as const,
            entityId: spec.source.entityId,
            ...(spec.source.parameterRange ? { parameterRange: spec.source.parameterRange.slice() as [number, number] } : {}),
          },
        }]
      : null,
  })
  return { ok: true, entity }
}

/** 创建坐标标注。
 * @param spec 坐标标注规格。
 * @param context 工厂上下文。
 * @returns 标注实体或错误。
 * @author snihao
 */
export function createOrdinateDimension(spec: OrdinateDimensionSpec, context: DimensionFactoryContext): DimensionFactoryResult {
  const feature = copyPoint(spec.feature)
  const origin = copyPoint(spec.origin || [0, 0])
  const placement = copyPoint(spec.placement)
  if (!feature || !origin || !placement) return invalid('INVALID_POINT', '坐标标注坐标必须是有限数值')
  if (distance(feature, placement) <= EPSILON) return invalid('INVALID_PLACEMENT', '坐标标注引线终点不能与特征点重合')
  const value = spec.ordinateType === 'x' ? feature[0] - origin[0] : feature[1] - origin[1]
  const entity = dimensionBase(context, spec.id || genId('dim-ordinate'))
  Object.assign(entity, {
    dimensionType: 'ordinate' as const,
    dimensionOrdinateType: spec.ordinateType,
    dimensionOrigin: origin,
    dimensionStart: feature,
    dimensionEnd: placement.slice() as Point,
    dimensionOffset: placement.slice() as Point,
    dimensionLinePosition: placement.slice() as Point,
    position: placement.slice() as Point,
    text: `${round(value)}`,
    textPositionManual: spec.textPositionManual !== false,
    dimensionRefs: [spec.featureReference || null, null],
  })
  return { ok: true, entity }
}

/** 创建标注共有字段。
 * @param context 工厂上下文。
 * @param id 实体 ID。
 * @returns 标注实体骨架。
 * @author snihao
 */
function dimensionBase(context: DimensionFactoryContext, id: string): Entity {
  return {
    ...createEntityBase('dimension', context, id),
    dimensionStyle: currentDimensionStyleName(context.drawing),
    dimensionStyleOverrides: null,
    dimensionTextOverride: null,
    fontSize: null,
    rotation: 0,
    textPositionManual: false,
    dimensionRefs: [null, null],
    dimensionSource: null,
    dimensionAssociations: null,
    dimensionTextManual: false,
    dimensionTextHeightManual: false,
  }
}

/** 验证两个测量点和尺寸线位置。
 * @param start 起点。
 * @param end 终点。
 * @param placement 尺寸线位置。
 * @returns 复制后的几何点。
 * @author snihao
 */
function validateMeasuredPoints(start: Point, end: Point, placement: Point):
  | { ok: true; start: Point; end: Point; placement: Point }
  | { ok: false; error: DimensionFactoryError } {
  const normalizedStart = copyPoint(start)
  const normalizedEnd = copyPoint(end)
  const normalizedPlacement = copyPoint(placement)
  if (!normalizedStart || !normalizedEnd || !normalizedPlacement) return invalid('INVALID_POINT', '标注坐标必须是有限数值')
  if (distance(normalizedStart, normalizedEnd) <= EPSILON) return invalid('DEGENERATE_GEOMETRY', '标注测量点不能重合')
  return { ok: true, start: normalizedStart, end: normalizedEnd, placement: normalizedPlacement }
}

/** 验证并规范化线段来源。
 * @param source 原始来源线段。
 * @returns 规范化线段或空值。
 * @author snihao
 */
function normalizeSegmentSource(source: DimensionSegmentSource): DimensionSegmentSource | null {
  const start = copyPoint(source.start)
  const end = copyPoint(source.end)
  if (!start || !end || distance(start, end) <= EPSILON) return null
  const pickPoint = source.pickPoint ? copyPoint(source.pickPoint) : undefined
  if (source.pickPoint && !pickPoint) return null
  return {
    ...source,
    start,
    end,
    ...(pickPoint ? { pickPoint } : {}),
  }
}

/** 计算两条无限直线的交点。
 * @param firstStart 第一条线起点。
 * @param firstEnd 第一条线终点。
 * @param secondStart 第二条线起点。
 * @param secondEnd 第二条线终点。
 * @returns 交点或空值。
 * @author snihao
 */
function infiniteLineIntersection(firstStart: Point, firstEnd: Point, secondStart: Point, secondEnd: Point): Point | null {
  const firstDirection: Point = [firstEnd[0] - firstStart[0], firstEnd[1] - firstStart[1]]
  const secondDirection: Point = [secondEnd[0] - secondStart[0], secondEnd[1] - secondStart[1]]
  const denominator = cross(firstDirection, secondDirection)
  const scale = Math.max(distance(firstStart, firstEnd) * distance(secondStart, secondEnd), EPSILON)
  if (Math.abs(denominator) / scale < 1e-7) return null
  const delta: Point = [secondStart[0] - firstStart[0], secondStart[1] - firstStart[1]]
  const parameter = cross(delta, secondDirection) / denominator
  const result: Point = [firstStart[0] + firstDirection[0] * parameter, firstStart[1] + firstDirection[1] * parameter]
  return copyPoint(result)
}

/** 根据放置点选择两条线的最小夹角方向。
 * @param first 第一条线。
 * @param second 第二条线。
 * @param center 交点。
 * @param location 放置点。
 * @param radius 尺寸弧半径。
 * @returns 角度尺寸的两端和扫掠角。
 * @author snihao
 */
function angularRays(
  first: DimensionSegmentSource,
  second: DimensionSegmentSource,
  center: Point,
  location: Point,
  radius: number,
): { start: Point; end: Point; sweep: number } | null {
  const locationVector: Point = [location[0] - center[0], location[1] - center[1]]
  let firstDirection = orientedLineDirection(first, center, locationVector)
  let secondDirection = orientedLineDirection(second, center, locationVector)
  if (!firstDirection || !secondDirection) return null
  let sweep = positiveAngle(Math.atan2(secondDirection[1], secondDirection[0]) - Math.atan2(firstDirection[1], firstDirection[0]))
  if (sweep > Math.PI) {
    ;[firstDirection, secondDirection] = [secondDirection, firstDirection]
    sweep = TAU - sweep
  }
  if (sweep < EPSILON || Math.abs(Math.PI - sweep) < EPSILON) return null
  return {
    start: [center[0] + firstDirection[0] * radius, center[1] + firstDirection[1] * radius],
    end: [center[0] + secondDirection[0] * radius, center[1] + secondDirection[1] * radius],
    sweep,
  }
}

/** 将来源线段方向朝向放置点。
 * @param source 来源线段。
 * @param center 交点。
 * @param target 从交点指向放置点的向量。
 * @returns 单位方向或空值。
 * @author snihao
 */
function orientedLineDirection(source: DimensionSegmentSource, center: Point, target: Point): Point | null {
  const dx = source.end[0] - source.start[0]
  const dy = source.end[1] - source.start[1]
  const length = Math.hypot(dx, dy)
  if (length < EPSILON) return null
  let ux = dx / length
  let uy = dy / length
  const point = source.pickPoint || midpoint(source.start, source.end)
  let projection = ux * target[0] + uy * target[1]
  if (Math.abs(projection) < EPSILON) projection = ux * (point[0] - center[0]) + uy * (point[1] - center[1])
  if (projection < 0) {
    ux *= -1
    uy *= -1
  }
  return [ux, uy]
}

/** 验证径向标注几何并重新计算半径。
 * @param center 圆心。
 * @param measurement 测量点。
 * @returns 规范化圆心、测量点和半径。
 * @author snihao
 */
function radialGeometry(center: Point, measurement: Point):
  | { ok: true; center: Point; measurement: Point; radius: number }
  | { ok: false; error: DimensionFactoryError } {
  const normalizedCenter = copyPoint(center)
  const normalizedMeasurement = copyPoint(measurement)
  if (!normalizedCenter || !normalizedMeasurement) return invalid('INVALID_POINT', '径向标注坐标必须是有限数值')
  const radius = distance(normalizedCenter, normalizedMeasurement)
  if (radius <= EPSILON) return invalid('INVALID_RADIUS', '径向标注测量点不能与圆心重合')
  return { ok: true, center: normalizedCenter, measurement: normalizedMeasurement, radius }
}

/** 构造旧字段中的圆来源引用。
 * @param source 新标注来源。
 * @returns 圆来源或空值。
 * @author snihao
 */
function dimensionSource(source: DimensionCircularSource | undefined): DimensionSourceReference | null {
  return source?.kind === 'circle' ? { kind: 'circle', entityId: source.entityId } : null
}

/** 构造通用径向来源引用。
 * @param source 新标注来源。
 * @param geometry 已验证几何。
 * @returns 来源关联列表。
 * @author snihao
 */
function circularAssociations(
  source: DimensionCircularSource | undefined,
  geometry: { center: Point; measurement: Point; radius: number },
): DimensionAssociation[] | null {
  if (!source) return null
  if (source.kind === 'circle') {
    return [{
      role: 'center',
      source: {
        kind: 'circle',
        entityId: source.entityId,
        fallbackCenter: geometry.center.slice() as Point,
        fallbackRadius: geometry.radius,
      },
    }]
  }
  return [{
    role: 'curve',
    source: {
      kind: 'curve',
      entityId: source.entityId,
      ...(source.parameterRange ? { parameterRange: source.parameterRange.slice() as [number, number] } : {}),
    },
  }]
}

/** 构造线段通用关联引用。
 * @param role 角度来源角色。
 * @param source 线段来源。
 * @returns 关联或空值。
 * @author snihao
 */
function segmentAssociation(role: 'line1' | 'line2', source: DimensionSegmentSource): DimensionAssociation | null {
  if (!source.entityId || source.segmentIndex == null) return null
  return {
    role,
    source: {
      kind: 'segment',
      entityId: source.entityId,
      segmentIndex: source.segmentIndex,
      fallback: [source.start.slice() as Point, source.end.slice() as Point],
    },
  }
}

/** 复制有限点。
 * @param point 待验证点。
 * @returns 点副本或空值。
 * @author snihao
 */
function copyPoint(point: Point | null | undefined): Point | null {
  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null
  return [point[0], point[1]]
}

/** 创建标注工厂失败结果。
 * @param code 错误码。
 * @param message 错误说明。
 * @returns 失败结果。
 * @author snihao
 */
function invalid(code: DimensionFactoryErrorCode, message: string): { ok: false; error: DimensionFactoryError } {
  return { ok: false, error: { code, message } }
}

/** 计算二维向量叉积。
 * @param first 第一个向量。
 * @param second 第二个向量。
 * @returns 叉积值。
 * @author snihao
 */
function cross(first: Point, second: Point): number {
  return first[0] * second[1] - first[1] * second[0]
}

/** 将角度规范化为 [0, 2π)。
 * @param value 角度值。
 * @returns 规范化角度。
 * @author snihao
 */
function positiveAngle(value: number): number {
  return (value % TAU + TAU) % TAU
}
