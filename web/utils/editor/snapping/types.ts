/** 绘图辅助的捕捉类型。 */
export type SnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'quadrant'
  | 'intersection'
  | 'perpendicular'
  | 'nearest'
  | 'tangent'
  | 'polar'
  | 'orthogonal'

/** 可持久化的绘图辅助设置；不参与图纸撤销历史。 */
export interface DraftingSettings {
  /** 是否启用对象捕捉。 */
  snapEnabled: boolean
  /** 是否启用正交约束。 */
  orthoEnabled: boolean
  /** 是否启用极轴追踪。 */
  polarEnabled: boolean
  /** 是否捕捉端点和多段线顶点。 */
  endpointEnabled: boolean
  /** 是否捕捉线段中点。 */
  midpointEnabled: boolean
  /** 是否捕捉圆心。 */
  centerEnabled: boolean
  /** 是否捕捉圆的四个象限点。 */
  quadrantEnabled: boolean
  /** 是否捕捉线段交点。 */
  intersectionEnabled: boolean
  /** 是否从当前锚点捕捉到线段垂足。 */
  perpendicularEnabled: boolean
  /** 是否捕捉图元上的任意最近点。 */
  nearestEnabled: boolean
  /** 是否从当前锚点捕捉到曲线切点。 */
  tangentEnabled: boolean
  /** 极轴角度增量，单位为度。 */
  polarIncrement: number
  /** 捕捉半径，单位为屏幕 CSS 像素。 */
  tolerancePx: number
  /** 显示辅助点的悬浮半径，单位为屏幕 CSS 像素。 */
  hoverTolerancePx: number
}

/** 默认绘图辅助设置。 */
export const DEFAULT_DRAFTING_SETTINGS: Readonly<DraftingSettings> = Object.freeze({
  snapEnabled: true,
  orthoEnabled: false,
  polarEnabled: true,
  endpointEnabled: true,
  midpointEnabled: true,
  centerEnabled: true,
  quadrantEnabled: true,
  intersectionEnabled: true,
  perpendicularEnabled: true,
  nearestEnabled: false,
  tangentEnabled: true,
  polarIncrement: 15,
  tolerancePx: 10,
  hoverTolerancePx: 12,
})

/** 捕捉候选点以及后续关联标注所需的来源信息。 */
export interface SnapCandidate {
  point: Point
  kind: SnapKind
  label: string
  entityId: string | null
  segmentIndex: number | null
  /** 在线段上的参数，端点为 0/1、中点为 0.5。 */
  t: number | null
  /** 交点候选的第二个来源图元。 */
  relatedEntityId?: string | null
  relatedSegmentIndex?: number | null
  distancePx: number
}

/** 画布中显示的辅助点。 */
export interface SnapMarker extends SnapCandidate {
  active: boolean
}

/** 悬浮图元的线段提示。 */
export interface SnapHoverSegment {
  start: Point
  end: Point
}

/** 悬浮圆形的提示。 */
export interface SnapHoverCircle {
  center: Point
  radius: number
}

/** 鼠标悬浮时使用的精确圆弧或椭圆几何。 */
export interface SnapHoverCurve {
  curve: ParametricCurveGeometry
}

/** 正交或极轴辅助射线。 */
export interface SnapGuide {
  start: Point
  end: Point
  kind: 'polar' | 'orthogonal'
}

/** 从当前锚点到捕捉结果的动态量测。 */
export interface SnapMeasurement {
  anchor: Point
  point: Point
  length: number
  /** CAD 角度：向右为 0 度，逆时针为正。 */
  angle: number
}

/** 单次指针解析结果。 */
export interface SnapResult {
  rawPoint: Point
  point: Point
  candidate: SnapCandidate | null
  markers: SnapMarker[]
  hoverSegments: SnapHoverSegment[]
  hoverCircles: SnapHoverCircle[]
  hoverCurves: SnapHoverCurve[]
  guide: SnapGuide | null
  measurement: SnapMeasurement | null
}

/** 工具请求捕捉时提供的交互上下文。 */
export interface SnapResolveOptions {
  /** 当前线段或量测的起始锚点。 */
  anchor?: Point | null
  /** 临时绕过所有捕捉，例如按住 Alt。 */
  bypass?: boolean
  /** 是否允许对象捕捉。 */
  allowObjectSnap?: boolean
  /** 是否允许角度约束。 */
  allowAngleSnap?: boolean
  /** 不参与本次捕捉的实体 ID。 */
  excludeEntityIds?: ReadonlySet<string>
  /** 工具自己的瞬时捕捉点，例如多段线闭合点。 */
  extraPoints?: ReadonlyArray<{
    point: Point
    kind: SnapKind
    label: string
  }>
}
