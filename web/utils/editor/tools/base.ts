/** 所有工具的基类：定义生命周期钩子与对 ctx 的便捷访问。
 * ctx 由 useEditor 装配，提供 state、提交历史、请求刷新、状态栏等能力。
 * Canvas 模式下预览改为 drawPreview 钩子：工具自存状态，每帧由渲染循环调用绘制。
 */
import type { Renderer } from '#draiq/utils/editor/renderer'
import type { Viewport } from '#draiq/utils/editor/viewport'
import type { SnapResolveOptions, SnapResult } from '#draiq/utils/editor/snapping/index'
import type { MeasurementResult } from '#draiq/utils/editor/measurement'

/** 工具事件中的世界坐标点 */
export interface ToolPoint {
  /** 世界 X 坐标 */
  x: number
  /** 世界 Y 坐标 */
  y: number
}

/** 工具上下文：连接编辑器状态与命令式渲染管线 */
export interface ToolContext {
  /** 编辑器状态 */
  state: EditorState
  /** 主画布元素 */
  canvas: HTMLCanvasElement
  /** 渲染器 */
  renderer: Renderer
  /** 视口 */
  viewport: Viewport
  /** 设置底部状态栏文本 */
  setStatus: (text: string) => void
  /** 请求重绘一帧（预览靠 drawPreview 钩子） */
  requestRender: () => void
  /** 标记实体层缓存失效（拖拽等直接修改实体时调用） */
  markDirty: () => void
  /** 同步编辑覆盖层、实体缓存和属性面板（拖拽期间调用） */
  liveUpdate: () => void
  /** 提交历史快照 */
  commit: () => void
  /** 通知订阅者状态变化（刷新属性面板/图元列表等） */
  notify: () => void
  /** 按 ID 快速查找顶层或组合内图元 */
  findEntity: (id: string | null) => Entity | null
  /** 设置当前选择集合 */
  setSelection: (ids: string[]) => void
  /** 在指定画布位置开始文字输入 */
  beginTextInput: (point: ToolPoint) => void
  /** 在画布内编辑已有文字或标注 */
  beginTextEdit: (entity: Entity) => void
  /** 将原始指针坐标解析为对象捕捉/角度约束后的绘图点。 */
  resolvePoint: (point: ToolPoint, options?: SnapResolveOptions) => SnapResult
  /** 清理当前捕捉提示。 */
  clearSnap: () => void
  /** 结束当前工具，切回选择工具 */
  finishTool: () => void
  /** 删除当前选中实体 */
  deleteSelected: () => void
  /** 判断实体是否允许修改。 */
  isEntityEditable: (entity: Entity | null | undefined) => boolean
  /** 判断当前图层是否允许创建实体。 */
  canCreateOnLayer: (layer: string) => boolean
  /** 切换工具 */
  setTool: (name: ToolName) => void
  /** 更新当前测量结果；测量结果不写入图纸历史。 */
  setMeasurement: (result: MeasurementResult | null) => void
}

/** 默认样式（颜色/图层/线宽），用于新建实体 */
export interface ToolDefaults {
  /** 颜色 #RRGGBB */
  color: string
  /** 图层名 */
  layer: string
  /** 线宽 */
  lineWidth: number
  /** 线型 */
  lineType: LineType
}

/** 工具基类 */
export abstract class BaseTool {
  /** 工具上下文 */
  protected ctx: ToolContext

  constructor(ctx: ToolContext) {
    this.ctx = ctx
  }

  /** 工具激活时调用 */
  onActivate(): void {}
  /** 工具停用时调用 */
  onDeactivate(): void {}
  /** 指针按下 */
  onPointerDown(event: PointerEvent, pt: ToolPoint): void {}
  /** 指针移动 */
  onPointerMove(event: PointerEvent, pt: ToolPoint, coalescedPoints: ToolPoint[] = []): void {}
  /** 指针抬起 */
  onPointerUp(event: PointerEvent, pt: ToolPoint): void {}
  /** 指针被浏览器或系统取消 */
  onPointerCancel(event: PointerEvent): void {}
  /** 双击 */
  onDoubleClick(event: PointerEvent, pt: ToolPoint): void {}
  /** 键盘按下 */
  onKeyDown(event: KeyboardEvent): void {}
  /** Tab 切换到同位置的下一个捕捉候选。 */
  onSnapCycle(result: SnapResult): void {}
  /** 精确长度和角度输入使用的锚点；不可用时为 null。 */
  getDynamicInputAnchor(): Point | null { return null }
  /** 根据精确长度和角度输入的点更新工具预览。 */
  onDynamicInputPreview(point: Point): void {}
  /** 使用工具正常的提交路径接收精确长度和角度输入的点。 */
  onDynamicInput(point: Point): void {}

  /** 预览钩子：在 renderer 渲染完实体后调用，工具在 world 坐标下绘制临时图形。
   * g 为 canvas 2d 上下文（已应用 viewport 变换），viewport 用于查 scale。
   */
  drawPreview(g: CanvasRenderingContext2D, viewport: Viewport): void {}

  /** 编辑器状态 */
  get state(): EditorState {
    return this.ctx.state
  }
  /** 图纸数据 */
  get drawing(): Drawing {
    return this.ctx.state.drawing
  }
  /** 主画布 */
  get canvas(): HTMLCanvasElement {
    return this.ctx.canvas
  }
  /** 视口 */
  get viewport(): Viewport {
    return this.ctx.viewport
  }

  /** 设置状态栏文本 */
  status(text: string): void {
    this.ctx.setStatus(text)
  }
  /** 请求重绘一帧 */
  requestRender(): void {
    this.ctx.requestRender()
  }
  /** 标记实体层缓存失效 */
  markDirty(): void {
    this.ctx.markDirty()
  }

  /** 同步编辑中的实体变化，不写入历史栈 */
  liveUpdate(): void {
    this.ctx.liveUpdate()
  }
  /** 按 ID 快速查找图元 */
  findEntity(id: string | null): Entity | null {
    return this.ctx.findEntity(id)
  }
  /** 提交历史快照 */
  commit(): void {
    this.ctx.commit()
  }
  /** 通知订阅者状态变化 */
  notify(): void {
    this.ctx.notify()
  }
  /** 选中实体 */
  select(id: string | null): void {
    this.ctx.setSelection(id ? [id] : [])
  }
  /** 选中多个实体 */
  selectMany(ids: string[]): void {
    this.ctx.setSelection(ids)
  }
  /** 在画布点击位置开始文字输入 */
  beginTextInput(point: ToolPoint): void {
    this.ctx.beginTextInput(point)
  }
  /** 在画布内编辑已有文字或标注 */
  beginTextEdit(entity: Entity): void {
    this.ctx.beginTextEdit(entity)
  }
  /** 解析对象捕捉和角度约束。 */
  resolvePoint(point: ToolPoint, options: SnapResolveOptions = {}): SnapResult {
    return this.ctx.resolvePoint(point, options)
  }
  /** 清理当前捕捉提示。 */
  clearSnap(): void {
    this.ctx.clearSnap()
  }
  /** 结束当前工具，切回选择 */
  finish(): void {
    this.ctx.finishTool()
  }

  /** 更新当前测量结果。 */
  setMeasurement(result: MeasurementResult | null): void {
    this.ctx.setMeasurement(result)
  }

  /** 判断当前默认图层是否可创建。 @returns 是否可创建。 @author snihao */
  canCreate(): boolean {
    return this.ctx.canCreateOnLayer(this.defaults().layer)
  }

  /** 当前默认样式（颜色/图层/线宽），用于新建实体 */
  defaults(): ToolDefaults {
    const s = this.ctx.state
    return { color: s.defaultColor, layer: s.defaultLayer, lineWidth: s.defaultLineWidth, lineType: s.defaultLineType }
  }
}
