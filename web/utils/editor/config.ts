/** 全局默认配置与常量。所有模块共享，便于统一调整。 */

/** 默认配置 */
export const DEFAULTS = Object.freeze({
  /** 单位 */
  unit: 'mm' as DrawingUnit,
  /** 画布宽度 */
  width: 800,
  /** 画布高度 */
  height: 600,
  /** 默认颜色 */
  color: '#2764AF',
  /** 默认图层 */
  layer: 'default',
  /** 默认线宽 */
  lineWidth: 1.6,
  /** 默认线型 */
  lineType: 'solid' as LineType,
  /** 编辑画布背景色 */
  canvasBackground: '#F8FAF9',
  /** 默认显示网格和原点辅助线 */
  showCanvasGuides: true,
  /** 新建普通文字的默认模型空间字高；尺寸标注使用当前 DIMSTYLE。 */
  fontSize: 14,
})

/** 图层默认色板；ByLayer 实体会继承对应图层颜色。 */
export const LAYER_COLORS = Object.freeze({
  cut: '#2F6F73',
  hole: '#3C6EA8',
  mark: '#A15F2B',
  default: '#526170',
  dimension: '#B23B3B',
  text: '#1F2933',
})

/** 工具元数据：顺序与显示名 */
export const TOOL_ORDER = Object.freeze([
  'select',
  'text',
  'annotate',
  'freehand',
  'measure',
  'line',
  'polyline',
  'rectangle',
  'circle',
  'arc',
  'ellipse',
  'angular',
  'radius',
  'diameter',
  'arcLength',
  'ordinate',
] as ToolName[])

/** 工具显示名 */
export const TOOL_LABELS: Record<ToolName, string> = {
  select: '选择',
  line: '直线',
  polyline: '多段线',
  rectangle: '矩形',
  circle: '圆形',
  arc: '圆弧',
  ellipse: '椭圆',
  text: '文字',
  annotate: '尺寸标注',
  angular: '角度标注',
  radius: '半径标注',
  diameter: '直径标注',
  arcLength: '弧长标注',
  ordinate: '坐标标注',
  freehand: '手绘',
  measure: '测量',
}

/** 工具快捷键：使用单字母，避免与浏览器常用组合快捷键冲突 */
export const TOOL_SHORTCUTS: Record<ToolName, string> = {
  select: 'V',
  line: 'L',
  polyline: 'P',
  rectangle: 'R',
  circle: 'C',
  arc: 'G',
  ellipse: 'E',
  text: 'T',
  annotate: 'A',
  angular: 'J',
  radius: 'H',
  diameter: 'I',
  arcLength: 'U',
  ordinate: 'O',
  freehand: 'F',
  measure: 'Q',
}

/** 实体类型显示名 */
export const ENTITY_LABELS: Record<EntityType, string> = {
  line: '直线',
  polyline: '多段线',
  circle: '圆形',
  text: '文字',
  annotation: '标注',
  dimension: '原生尺寸标注',
  group: '组合',
}
