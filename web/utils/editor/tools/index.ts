/** 工具注册表：集中导出所有工具类，供 useEditor 统一实例化。 */
import { SelectTool } from '#draiq/utils/editor/tools/select'
import { LineTool } from '#draiq/utils/editor/tools/line'
import { PolylineTool } from '#draiq/utils/editor/tools/polyline'
import { RectangleTool } from '#draiq/utils/editor/tools/rectangle'
import { CircleTool } from '#draiq/utils/editor/tools/circle'
import { ArcTool } from '#draiq/utils/editor/tools/arc'
import { EllipseTool } from '#draiq/utils/editor/tools/ellipse'
import { TextTool } from '#draiq/utils/editor/tools/text'
import { AnnotateTool } from '#draiq/utils/editor/tools/annotate'
import {
  AngularDimensionTool,
  ArcLengthDimensionTool,
  DiameterDimensionTool,
  OrdinateDimensionTool,
  RadiusDimensionTool,
} from '#draiq/utils/editor/tools/professionalDimension'
import { FreehandTool } from '#draiq/utils/editor/tools/freehand'
import { MeasureTool } from '#draiq/utils/editor/tools/measure'
import type { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext } from '#draiq/utils/editor/tools/base'

/** 工具类构造器类型 */
type ToolConstructor = new (ctx: ToolContext) => BaseTool

/** 工具名 → 工具类映射 */
export const TOOL_CLASSES: Record<ToolName, ToolConstructor> = {
  select: SelectTool,
  line: LineTool,
  polyline: PolylineTool,
  rectangle: RectangleTool,
  circle: CircleTool,
  arc: ArcTool,
  ellipse: EllipseTool,
  text: TextTool,
  annotate: AnnotateTool,
  angular: AngularDimensionTool,
  radius: RadiusDimensionTool,
  diameter: DiameterDimensionTool,
  arcLength: ArcLengthDimensionTool,
  ordinate: OrdinateDimensionTool,
  freehand: FreehandTool,
  measure: MeasureTool,
}

export {
  SelectTool,
  LineTool,
  PolylineTool,
  RectangleTool,
  CircleTool,
  ArcTool,
  EllipseTool,
  TextTool,
  AnnotateTool,
  AngularDimensionTool,
  RadiusDimensionTool,
  DiameterDimensionTool,
  ArcLengthDimensionTool,
  OrdinateDimensionTool,
  FreehandTool,
  MeasureTool,
}
export type { BaseTool, ToolContext, ToolPoint, ToolDefaults } from '#draiq/utils/editor/tools/base'
