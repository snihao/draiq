// ============================================
// SVG · DXF 编辑器类型定义
// ============================================

/** 二维坐标点 [x, y] */
type Point = [number, number]

/** 实体类型 */
type EntityType = 'line' | 'polyline' | 'circle' | 'text' | 'annotation' | 'dimension' | 'group'
type LineType = 'solid' | 'dashed' | 'dashdot'
type DimensionType = 'linear' | 'aligned' | 'angular' | 'radius' | 'diameter' | 'arcLength' | 'ordinate'
type AngularDimensionMode = 'twoLine' | 'threePoint'
type OrdinateDimensionType = 'x' | 'y'
type EntityStyleMode = 'byLayer' | 'byBlock' | 'explicit'

/** DIMSTYLE 中可覆盖的颜色字段。空值表示沿用实体颜色。 @author snihao */
type DimensionStyleColor = string | null

/** DXF DIMSTYLE 的编辑器可视化子集，数值均以图纸单位保存。 @author snihao */
interface DimensionStyleDefinition {
  /** 样式名称。 */
  name: string
  /** DIMSTYLE 的整体比例。 */
  scale: number
  /** 标注文字高度。 */
  textHeight: number
  /** 箭头长度。 */
  arrowSize: number
  /** 尺寸界线起点留白。 */
  extensionOffset: number
  /** 尺寸界线超过尺寸线的长度。 */
  extensionBeyond: number
  /** 尺寸线与文字之间的间隙。 */
  textGap: number
  /** 圆心标记尺寸。 */
  centerMarkSize: number
  /** 尺寸线颜色。 */
  dimensionLineColor: DimensionStyleColor
  /** 尺寸界线颜色。 */
  extensionLineColor: DimensionStyleColor
  /** 标注文字颜色。 */
  textColor: DimensionStyleColor
  /** 是否隐藏第一条尺寸界线。 */
  suppressFirstExtension: boolean
  /** 是否隐藏第二条尺寸界线。 */
  suppressSecondExtension: boolean
  /** 是否隐藏尺寸线。 */
  suppressDimensionLine: boolean
  /** 文字样式名称。 */
  textStyle?: string | null
  /** 标注文字前缀。 */
  textPrefix?: string | null
  /** 标注文字后缀。 */
  textSuffix?: string | null
}

/** 单个标注相对于 DIMSTYLE 的显式覆盖项。 @author snihao */
interface DimensionStyleOverride {
  /** 覆盖文字高度。 */
  textHeight?: number | null
  /** 覆盖箭头长度。 */
  arrowSize?: number | null
  /** 覆盖尺寸界线起点留白。 */
  extensionOffset?: number | null
  /** 覆盖尺寸界线超出长度。 */
  extensionBeyond?: number | null
  /** 覆盖文字间隙。 */
  textGap?: number | null
  /** 覆盖圆心标记尺寸。 */
  centerMarkSize?: number | null
  /** 覆盖尺寸线颜色。 */
  dimensionLineColor?: DimensionStyleColor
  /** 覆盖尺寸界线颜色。 */
  extensionLineColor?: DimensionStyleColor
  /** 覆盖文字颜色。 */
  textColor?: DimensionStyleColor
  /** 覆盖第一条尺寸界线开关。 */
  suppressFirstExtension?: boolean | null
  /** 覆盖第二条尺寸界线开关。 */
  suppressSecondExtension?: boolean | null
  /** 覆盖尺寸线开关。 */
  suppressDimensionLine?: boolean | null
  /** 覆盖文字样式名称。 */
  textStyle?: string | null
  /** 覆盖文字前缀。 */
  textPrefix?: string | null
  /** 覆盖文字后缀。 */
  textSuffix?: string | null
}

/** 工具名称 */
type ToolName = 'select' | 'line' | 'polyline' | 'rectangle' | 'circle' | 'arc' | 'ellipse' | 'text' | 'annotate' | 'angular' | 'radius' | 'diameter' | 'arcLength' | 'ordinate' | 'freehand' | 'measure'

/** 单位 */
type DrawingUnit = 'mm' | 'inch'

/** 关联尺寸使用的持久化对象捕捉引用。 */
interface PointReference {
  kind: 'endpoint' | 'midpoint' | 'center' | 'quadrant' | 'intersection' | 'perpendicular' | 'nearest' | 'tangent'
  entityId: string
  segmentIndex: number | null
  t: number | null
  relatedEntityId?: string | null
  relatedSegmentIndex?: number | null
  fallback: Point
}

/** 半径或直径标注的持久化来源引用。 */
interface DimensionSourceReference {
  /** 来源几何类型。 */
  kind: 'circle'
  /** 来源圆实体的 ID。 */
  entityId: string
}

/** 通用标注来源几何引用；旧 dimensionRefs/dimensionSource 继续兼容。 */
type DimensionGeometryReference =
  | { kind: 'point'; ref: PointReference }
  | { kind: 'segment'; entityId: string; segmentIndex: number; fallback: [Point, Point] }
  | { kind: 'circle'; entityId: string; fallbackCenter: Point; fallbackRadius: number }
  | { kind: 'curve'; entityId: string; parameterRange?: [number, number] }

/** 标注中一个来源几何的角色。 */
interface DimensionAssociation {
  role: 'start' | 'end' | 'line1' | 'line2' | 'center' | 'curve'
  source: DimensionGeometryReference
}

/** 表面粗糙度标注的持久化来源绑定。 */
interface SurfaceRoughnessSource {
  /** 图纸中的来源几何实体 ID。 */
  entityId: string
  /** 创建关联时来源实体的内容指纹。 */
  entityFingerprint: string
  /** 可选的来源特征引用 ID，用于追溯关联。 */
  featureId?: string
}

/** 形位公差的几何特征；保留 `profile` 以兼容旧图纸。 */
type GeometricToleranceCharacteristic =
  | 'position'
  | 'flatness'
  | 'straightness'
  | 'circularity'
  | 'cylindricity'
  | 'perpendicularity'
  | 'parallelism'
  | 'angularity'
  | 'profile'
  | 'profile-of-line'
  | 'profile-of-surface'
  | 'concentricity'
  | 'symmetry'
  | 'circular-runout'
  | 'total-runout'

/** 形位公差的公差带符号选项。 */
type GeometricToleranceZone = 'none' | 'diameter'

/** 形位公差的材料条件修饰符。 */
type GeometricToleranceMaterialCondition = 'none' | 'MMC' | 'LMC' | 'RFS'

/** 可选的双行复合形位公差框中的一行定义。 */
interface GeometricToleranceRow {
  characteristic: GeometricToleranceCharacteristic
  tolerance: number
  toleranceZone: GeometricToleranceZone
  materialCondition: GeometricToleranceMaterialCondition
  datumReferences: string[]
}

/** 可编辑形位公差标注的持久化来源绑定。 */
interface GeometricToleranceSource {
  /** 图纸中的来源几何实体 ID。 */
  entityId: string
  /** 创建关联时来源实体的内容指纹。 */
  entityFingerprint: string
}

/** 基准要素符号的修饰符。 */
type DatumFeatureModifier = 'none' | 'MMC' | 'LMC'

/** 可编辑基准要素符号的持久化来源绑定。 */
interface DatumFeatureSource {
  /** 图纸中的来源几何实体 ID。 */
  entityId: string
  /** 创建关联时来源实体的内容指纹。 */
  entityFingerprint: string
}

/** 在多段线近似渲染结果之外保留的精确参数几何。 */
interface ParametricCurveGeometry {
  type: 'arc' | 'ellipse'
  center: Point
  axisX: Point
  axisY: Point
  startParameter: number
  sweepParameter: number
}

/** 包围盒 */
interface Bounds {
  /** 最小 X */
  minX: number
  /** 最小 Y */
  minY: number
  /** 最大 X */
  maxX: number
  /** 最大 Y */
  maxY: number
}

/** 绘图实体 */
interface Entity {
  /** 工程线型语义，与显示像素无关。 */
  lineRole?: 'THICK_CONTINUOUS' | 'THIN_CONTINUOUS'
  /** 实体 ID */
  id: string
  /** 实体类型 */
  type: EntityType
  /** 图层名 */
  layer: string
  /** 颜色 #RRGGBB */
  color: string | null
  /** 颜色继承模式：图层、块或实体显式值。 */
  colorMode?: EntityStyleMode
  /** CAD 有效线宽；画布按屏幕宽度显示，导出时转换回 DXF lineweight。 */
  lineWidth: number | null
  /** DXF 原始线型名称；用于把覆盖实体交给 dxf-render */
  dxfLineType?: string | null
  /** LWPOLYLINE/POLYLINE 的几何宽度，不等同于 lineweight */
  polylineWidth?: number | null
  /** 线型：实线、虚线或点画线 */
  lineType?: LineType | null
  /** 线型继承模式：图层、块或实体显式值。 */
  lineTypeMode?: EntityStyleMode
  /** 线宽继承模式：图层、块或实体显式值。 */
  lineWidthMode?: EntityStyleMode
  /** DXF 等外部格式导入的原始线型节奏；用户修改线型后清除 */
  lineDash?: number[] | null
  /** 导入图元的线帽样式 */
  lineCap?: 'round' | 'butt' | 'square' | null
  /** 导入图元的线段连接样式 */
  lineJoin?: 'round' | 'bevel' | 'miter' | null
  /** 直线起点（line） */
  start?: Point | null
  /** 直线终点（line） */
  end?: Point | null
  /** 多段线顶点列表（polyline） */
  points?: Point[] | null
  /** 是否闭合（polyline） */
  closed?: boolean
  /** 导入曲线多段线时保留的精确圆弧或椭圆语义。 */
  curveGeometry?: ParametricCurveGeometry | null
  /** 圆心（circle） */
  center?: Point | null
  /** 半径（circle） */
  radius?: number | null
  /** 文字内容（text） */
  content?: string | null
  /** 文字位置（text/annotation） */
  position?: Point | null
  /** 字号（text/annotation） */
  fontSize?: number | null
  /** DXF STYLE 名称 */
  textStyle?: string | null
  /** TEXT code 41 的水平宽度因子 */
  textWidthFactor?: number | null
  /** MTEXT code 41 的文字框宽度 */
  textBoxWidth?: number | null
  /** 原始文字实体类型，编辑覆盖时保持 TEXT/MTEXT 语义 */
  dxfTextType?: 'TEXT' | 'MTEXT' | null
  /** 导入文字的水平锚点 */
  textAlign?: 'left' | 'center' | 'right' | null
  /** 导入文字的垂直锚点 */
  textBaseline?: 'alphabetic' | 'top' | 'middle' | 'bottom' | null
  /** 原始 DXF 实体句柄；用于高保真显示、编辑替换和合并导出 */
  sourceHandle?: string | null
  /** 原始 DXF 实体是否已经转换到可编辑覆盖层 */
  sourceEdited?: boolean
  /** 导入的源实体需由 Canvas 绘制，以保留 DXF 真彩色和线宽显示。 */
  sourceCanvasStyle?: boolean
  /** 累计旋转角度（除 circle 外的可旋转图元，单位：度） */
  rotation?: number | null
  /** 引线顶点列表（annotation） */
  leader?: Point[] | null
  /** 标注文字（annotation） */
  text?: string | null
  /** 专用标注的渲染语义。 */
  annotationKind?: 'surface-roughness' | 'geometric-tolerance' | 'datum-feature' | null
  /** 表面粗糙度指标，例如 Ra 或 Rz。 */
  surfaceRoughnessMetric?: string | null
  /** 使用声明单位表示的正数粗糙度值。 */
  surfaceRoughnessValue?: number | null
  /** 显式指定的粗糙度单位。 */
  surfaceRoughnessUnit?: string | null
  /** 表面粗糙度标注的稳定来源绑定。 */
  surfaceRoughnessSource?: SurfaceRoughnessSource | null
  /** 形位公差标注所表示的几何特征。 */
  characteristic?: GeometricToleranceCharacteristic | null
  /** 大于零的形位公差值。 */
  tolerance?: number | null
  /** 公差带中可选的直径符号。 */
  toleranceZone?: GeometricToleranceZone | null
  /** 公差值的材料条件修饰符。 */
  materialCondition?: GeometricToleranceMaterialCondition | null
  /** 按顺序排列的基准引用标签，最多三项。 */
  datumReferences?: string[] | null
  /** 可选的复合公差框行定义，只允许恰好两行。 */
  geometricToleranceRows?: GeometricToleranceRow[] | null
  /** 形位公差标注的稳定来源绑定。 */
  geometricToleranceSource?: GeometricToleranceSource | null
  /** 显示在基准符号方框内的基准要素标签。 */
  datumLabel?: string | null
  /** 显示在基准标签旁的可选材料边界修饰符。 */
  datumFeatureModifier?: DatumFeatureModifier | null
  /** 基准要素符号的稳定来源绑定。 */
  datumFeatureSource?: DatumFeatureSource | null
  /** 浏览器生成的公差框及分隔线线段。 */
  annotationSegments?: Array<[Point, Point]> | null
  /** 标注文字是否已由用户手动定位 */
  textPositionManual?: boolean
  /** 导入 DXF 计算出的原始文字锚点；首次几何编辑后切换到对应原生工具的定位语义。 */
  dimensionTextSourcePosition?: boolean
  /** 原生 DXF 标注类型。`annotation` 仅用于旧图形标注与引线。 */
  dimensionType?: DimensionType | null
  /** 原生标注的第一个测量点。 */
  dimensionStart?: Point | null
  /** 原生标注的第二个测量点。 */
  dimensionEnd?: Point | null
  /** 角度、半径、弧长标注的圆心或角顶点。 */
  dimensionCenter?: Point | null
  /** 半径/直径标注的半径；直径标注也可由两个测量点推导。 */
  dimensionRadius?: number | null
  /** 角度标注的 DXF 语义，区分两直线角度和三点角度。 */
  dimensionAngularMode?: AngularDimensionMode | null
  /** 两直线角度标注的第一条直线起点。 */
  dimensionAngularLine1Start?: Point | null
  /** 两直线角度标注的第二条直线起点。 */
  dimensionAngularLine2Start?: Point | null
  /** 坐标标注的坐标方向。 */
  dimensionOrdinateType?: OrdinateDimensionType | null
  /** 坐标标注的基准原点。 */
  dimensionOrigin?: Point | null
  /** 坐标标注的引线终点或偏移向量终点。 */
  dimensionOffset?: Point | null
  /** 尺寸线上的放置点；用于保留标注偏移和 DXF 定义点。 */
  dimensionLinePosition?: Point | null
  /** 线性标注方向，采用编辑器画布坐标角度。 */
  dimensionAngle?: number | null
  /** DXF DIMSTYLE 名称；空值时使用当前文档默认样式。 */
  dimensionStyle?: string | null
  /** 标注相对于 DIMSTYLE 的显式样式覆盖。 */
  dimensionStyleOverrides?: DimensionStyleOverride | null
  /** DXF DIMENSION 的显式文字覆写；空值代表由 CAD 自动计算。 */
  dimensionTextOverride?: string | null
  /** 标注文字高度是否由实体手动指定。 */
  dimensionTextHeightManual?: boolean
  /** 导入匿名标注块中的实际字高，用于保留实体级 DXF 覆盖效果。 */
  dimensionTextSourceHeight?: boolean
  /** 源 DXF 匿名标注块中的可见线段，仅用于显示、命中和编辑预览。 */
  dimensionDisplaySegments?: Array<[Point, Point]> | null
  /** 尺寸标注两个测量点的持久化引用。 */
  dimensionRefs?: [PointReference | null, PointReference | null] | null
  /** 半径和直径标注的持久化来源引用。 */
  dimensionSource?: DimensionSourceReference | null
  /** 通用标注来源引用；用于新建角度、圆弧等标注的稳定关联。 */
  dimensionAssociations?: DimensionAssociation[] | null
  /** 显示的尺寸文字是否已由用户手动覆盖。 */
  dimensionTextManual?: boolean
  /** 子图元列表（仅 group 类型） */
  children?: Entity[] | null
  /** 所属组合 ID（子图元标识其归属，便于解组时还原） */
  groupId?: string | null
}

/** 图纸数据 */
interface Drawing {
  /** 单位 */
  unit: DrawingUnit
  /** 宽度 */
  width: number
  /** 高度 */
  height: number
  /** 实体列表 */
  entities: Entity[]
  /** 图层表；旧数据缺失时按实体图层动态补齐。 */
  layers?: LayerDefinition[]
  /** DXF DIMSTYLE 表的可视化子集。 */
  dimensionStyles?: DimensionStyleDefinition[]
  /** 新建尺寸标注使用的当前 DIMSTYLE 样式。 */
  currentDimensionStyle?: string | null
}

/** DXF 图层表中的最小可编辑属性。 @author snihao */
interface LayerDefinition {
  /** 图层名称。 */
  name: string
  /** 图层默认颜色。 */
  color: string
  /** 图层默认 CAD 有效线宽。 */
  lineWidth: number | null
  /** 图层默认线型。 */
  lineType: LineType
  /** 原始 DXF 线型名称。 */
  dxfLineType?: string | null
  /** 原始 DXF 线型节奏。 */
  lineDash?: number[] | null
  /** 是否参与渲染和选择。 */
  visible: boolean
  /** 冻结图层不参与渲染、选择和捕捉。 */
  frozen: boolean
  /** 锁定图层可选择和捕捉，但不可修改。 */
  locked: boolean
}

/** 编辑器状态 */
interface EditorState {
  /** 图纸数据 */
  drawing: Drawing
  /** 选中实体 ID */
  selectedId: string | null
  /** 多选实体 ID；selectedId 表示其中的主选中项 */
  selectedIds: string[]
  /** 当前工具 */
  activeTool: ToolName
  /** 默认颜色 */
  defaultColor: string
  /** 默认图层 */
  defaultLayer: string
  /** 默认线宽 */
  defaultLineWidth: number
  /** 新建普通文字的默认模型空间字高；尺寸标注使用当前 DIMSTYLE。 */
  defaultFontSize: number
  /** 新建图元默认线型 */
  defaultLineType: LineType
  /** 编辑画布背景色 */
  canvasBackground: string
  /** 是否显示网格与原点辅助线 */
  showCanvasGuides: boolean
  /** 历史栈（JSON 快照） */
  history: string[]
  /** 历史指针 */
  historyIndex: number
}

/** 手柄信息 */
interface HandleInfo {
  /** X 坐标 */
  x: number
  /** Y 坐标 */
  y: number
  /** 顶点索引 */
  index: number
  /** 手柄角色 */
  role: 'start' | 'end' | 'vertex' | 'center' | 'radius' | 'position' | 'leader' | 'move' | 'resize' | 'rotate'
}

/** 手柄命中结果 */
interface HandleHit {
  /** 顶点索引 */
  index: number
  /** 手柄角色 */
  role: string
}
