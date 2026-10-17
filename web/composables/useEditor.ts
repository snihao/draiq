/**
 * 编辑器核心 Composable：装配状态、渲染循环、工具、事件路由、历史记录。
 * 将原项目 main.js 的命令式入口封装为 Vue3 响应式 API，供编辑器组件使用。
 *
 * 职责：
 * - 持有 EditorState（reactive），暴露给组件渲染
 * - 装配 ToolContext 并实例化所有工具
 * - 管理 rAF 节流的渲染循环（主画布 + 工具预览 + 小屏）
 * - 处理撤销/重做、导入 SVG、导出 DXF、清空、适配视图
 * - 暴露事件处理函数供组件绑定
 */
import { computed, getCurrentInstance, reactive, ref, shallowReactive, shallowRef, onBeforeUnmount } from 'vue'
import { DEFAULTS, TOOL_SHORTCUTS } from '#draiq/utils/editor/config'
import { inferTextFontSize } from '#draiq/utils/editor/textDefaults'
import { clamp, drawingBounds, genId } from '#draiq/utils/editor/geometry'
import { Renderer } from '#draiq/utils/editor/renderer'
import { Viewport } from '#draiq/utils/editor/viewport'
import { Minimap } from '#draiq/utils/editor/minimap'
import { parseSvgFile } from '#draiq/utils/editor/svgImport'
import type { DxfReferenceTransform } from '#draiq/utils/editor/dxfImport'
import { readDxfFile } from '#draiq/utils/editor/dxfEncoding'
import { parseDxfFile } from '#draiq/utils/editor/dxfImport'
import { DxfReferenceRenderer } from '#draiq/utils/editor/dxfReferenceRenderer'
import { TOOL_CLASSES } from '#draiq/utils/editor/tools/index'
import type { BaseTool, ToolContext, ToolPoint } from '#draiq/utils/editor/tools/index'
import { DEFAULT_DRAFTING_SETTINGS, drawSnapOverlay, pointFromCadPolar, SnapEngine } from '#draiq/utils/editor/snapping/index'
import type { DraftingSettings, SnapResolveOptions, SnapResult } from '#draiq/utils/editor/snapping/index'
import { exportDxf, exportMergedDxf } from '#draiq/api/dxf'
import { autoGroup } from '#draiq/utils/editor/clustering'
import { mergeConnectedLines } from '#draiq/utils/editor/geometryOptimize'
import { detachDimensionAssociationsForEntities, syncAssociativeDimensions } from '#draiq/utils/editor/associativeDimensions'
import { applyExplicitEntityStyle, createLayerDefinition, ensureDrawingLayers, isEntityEditable, isLayerFrozen, isLayerLocked, resolveEntityStyle } from '#draiq/utils/editor/layers'
import { ensureDrawingDimensionStyles } from '#draiq/utils/editor/dimensionStyles'
import { resolveCadCoordinateInput } from '#draiq/utils/editor/dynamicInput'
import type { MeasurementResult } from '#draiq/utils/editor/measurement'
import {
  applyTransform,
  cloneEntitiesForPaste,
  detachOutsideSelection,
  selectedEntityIds,
  selectedRootEntities,
  selectionCenter,
} from '#draiq/utils/editor/transform'
import {
  breakEntity,
  extendEntity,
  joinEntities,
  offsetEntity,
  setPolylineClosed,
  trimEntity,
} from '#draiq/utils/editor/topology'

/** 历史栈最大容量 */
const HISTORY_LIMIT = 100
/** 绘图辅助偏好的本地存储键。 */
const DRAFTING_STORAGE_KEY = 'editor.draftingAssist.v1'

type DynamicInputField = 'length' | 'angle'

interface DynamicInputState {
  activeField: DynamicInputField
  lengthText: string
  angleText: string
  screenX: number
  screenY: number
  valid: boolean
}

interface DynamicMeasurement {
  anchor: Point
  point: Point
  length: number
  angle: number
  screenX: number
  screenY: number
}

/** 编辑器内部剪贴板快照。 @author snihao */
interface ClipboardState {
  /** 待粘贴的实体快照。 */
  entities: Entity[]
  /** 复制时记录的基点。 */
  base: Point
  /** 复制时的根实体 ID。 */
  selectedIds: string[]
}

/** 创建独立绘图工作区，管理图元、工具、导入导出与撤销历史。 */
export function useEditor() {
  // ---- 响应式状态（与渲染器/工具共享同一对象引用）----
  // Drawing 保持普通对象，避免数千图元和顶点被 Vue 深度 Proxy。
  // 面板刷新由 dataVersion / selectionVersion 显式驱动。
  const state = shallowReactive<EditorState>({
    drawing: {
      unit: DEFAULTS.unit,
      width: DEFAULTS.width,
      height: DEFAULTS.height,
      entities: [],
      layers: [createLayerDefinition(DEFAULTS.layer)],
    },
    selectedId: null,
    selectedIds: [],
    activeTool: 'select',
    defaultColor: DEFAULTS.color,
    defaultLayer: DEFAULTS.layer,
    defaultLineWidth: DEFAULTS.lineWidth,
    defaultFontSize: DEFAULTS.fontSize,
    defaultLineType: DEFAULTS.lineType,
    canvasBackground: DEFAULTS.canvasBackground,
    showCanvasGuides: DEFAULTS.showCanvasGuides,
    history: [],
    historyIndex: -1,
  })
  /** 对象捕捉与角度约束设置；属于工作区偏好，不写入图纸历史。 */
  const drafting = reactive<DraftingSettings>({ ...DEFAULT_DRAFTING_SETTINGS })

  /** 底部状态栏文本 */
  const statusText = ref('就绪')
  /** 当前文档显示名称 */
  const documentName = ref('未命名图纸.svg')
  /** 画布指针对应的世界坐标 */
  const pointerPosition = ref<ToolPoint | null>(null)
  /** 经对象捕捉/方向约束解析后的世界坐标。 */
  const resolvedPointerPosition = ref<ToolPoint | null>(null)
  /** 文字工具的画布内联输入状态 */
  const textInput = ref<{
    entityId: string | null
    mode: 'create' | 'edit'
    worldX: number
    worldY: number
    screenX: number
    screenY: number
    value: string
  } | null>(null)
  /** 在当前线段旁显示精确长度与角度输入框。 */
  const dynamicInput = ref<DynamicInputState | null>(null)
  /** 当前测量结果；测量不写入图纸历史。 */
  const measurement = ref<MeasurementResult | null>(null)
  let dynamicMeasurement: DynamicMeasurement | null = null
  /** 加载遮罩是否可见 */
  const loading = ref(false)
  /** 加载遮罩文本 */
  const loadingText = ref('处理中…')
  /** 图元结构或属性发生变化时递增 */
  const dataVersion = ref(0)
  /** 仅选择状态变化时递增，避免重建图层列表 */
  const selectionVersion = ref(0)
  /** 兼容旧组件：version 仅代表数据变化 */
  const version = dataVersion
  /** ID → 实体的非响应式快速索引 */
  const entityById = new Map<string, Entity>()
  /** ID → 父数组及下标的快速索引 */
  const entityLocationById = new Map<string, { list: Entity[]; index: number }>()

  // ---- 命令式实例（shallowRef 避免 Vue 深度代理 Canvas/Renderer）----
  const canvasRef = ref<HTMLCanvasElement | null>(null)
  const dxfCanvasRef = ref<HTMLCanvasElement | null>(null)
  const minimapRef = ref<HTMLCanvasElement | null>(null)
  const renderer = shallowRef<Renderer | null>(null)
  const dxfReferenceRenderer = shallowRef<DxfReferenceRenderer | null>(null)
  const viewport = reactive(new Viewport())
  const minimap = shallowRef<Minimap | null>(null)
  /** 统一绘图捕捉引擎。 */
  const snapEngine = shallowRef(new SnapEngine())
  /** 当前激活工具（shallowRef，工具实例不参与响应式） */
  const activeTool = shallowRef<BaseTool | null>(null)
  /** 工具实例表 */
  const tools = shallowRef<Record<string, BaseTool>>({})

  // ---- 渲染循环：rAF 节流 ----
  let rafPending = false
  /** 小屏上次绘制时的视口签名 */
  let miniSig = ''
  /** 小屏上次绘制时的图元数 */
  let miniEntCount = -1
  /** 小屏上次绘制时的选择集合签名 */
  let miniSelectionSig = ''
  /** ResizeObserver 实例 */
  let ro: ResizeObserver | null = null
  /** 上一次画布 CSS 尺寸，用于响应式布局变化时保持视图中心。 */
  let canvasSize = { width: 0, height: 0 }
  /** 平移状态 */
  let panning: { x: number; y: number } | null = null
  /** 当前画布上的触摸指针。 */
  const touchPointers = new Map<number, { x: number; y: number }>()
  /** 双指手势的上一帧几何状态。 */
  let touchGesture: { centerX: number; centerY: number; distance: number } | null = null
  /** 双指手势开始后，剩余手指全部抬起前不再恢复单指绘图。 */
  let touchGestureConsumed = false
  /** 小屏拖拽中 */
  let minimapDragging = false
  /** 当前导入的原始 DXF 文本；存在时导出采用“原文件 + 编辑覆盖层”合并模式。 */
  let originalDxfText: string | null = null
  let dxfReferenceTransform: DxfReferenceTransform | null = null
  const sourceBaselineById = new Map<string, string>()
  const sourceHandleById = new Map<string, string>()
  const editedSourceHandles = new Set<string>()
  const canvasStyleSourceHandles = new Set<string>()
  /** 编辑器内部剪贴板会持续保留，以支持连续 Ctrl+V 粘贴。 @author snihao */
  const clipboard = shallowRef<ClipboardState | null>(null)

  /**
   * 请求重绘一帧：rAF 合并多次 requestRender 调用。
   * 绘制流程：主画布渲染 → 工具预览叠加 → 小屏条件刷新。
   */
  function requestRender(): void {
    if (rafPending || !renderer.value) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      const r = renderer.value!
      dxfReferenceRenderer.value?.render(viewport)
      r.render(state, viewport, dxfReferenceRenderer.value?.active === true)
      // 工具预览叠加（world 变换）
      const tool = activeTool.value
      if (tool) {
        const g = r.gctx
        g.save()
        viewport.apply(g)
        tool.drawPreview(g, viewport)
        g.restore()
      }
      const snapResult = snapEngine.value.current
      if (snapResult) drawSnapOverlay(r.gctx, viewport, snapResult, state.drawing.unit)
      // 小屏导航图：仅当视口/图元数/选中变化时刷新，绘制中不刷新以保证跟手。
      const sig = `${viewport.scale}|${viewport.offsetX}|${viewport.offsetY}`
      const n = state.drawing.entities.length
      const selectionSig = state.selectedIds.join('|')
      if (sig !== miniSig || n !== miniEntCount || selectionSig !== miniSelectionSig) {
        minimap.value?.render(state, viewport)
        miniSig = sig
        miniEntCount = n
        miniSelectionSig = selectionSig
      }
    })
  }

  /** 标记实体层缓存失效（渲染器 + 小屏） */
  function markDirty(): void {
    renderer.value?.markDirty()
    minimap.value?.markDirty()
    // 图元数量不变的属性编辑也必须触发小地图刷新。
    miniSig = ''
  }

  /** 通知图元数据消费者刷新 */
  function notifyData(): void {
    dataVersion.value++
    requestRender()
  }

  /** 通知选择状态消费者刷新，不触发图元列表重建 */
  function notifySelection(): void {
    selectionVersion.value++
    requestRender()
  }

  /** 重建实体与位置索引；仅在提交、导入、撤销等数据边界执行 */
  function rebuildEntityIndex(): void {
    entityById.clear()
    entityLocationById.clear()
    const visit = (list: Entity[]): void => {
      for (let index = 0; index < list.length; index++) {
        const entity = list[index]
        entityById.set(entity.id, entity)
        entityLocationById.set(entity.id, { list, index })
        if (entity.children) visit(entity.children)
      }
    }
    visit(state.drawing.entities)
    snapEngine.value.rebuild(state.drawing)
  }

  /** 生成忽略运行时覆盖标记的实体比较串。 */
  function comparableEntity(entity: Entity): string {
    return JSON.stringify(entity, (key, value) => key === 'sourceEdited' ? undefined : value)
  }

  /** 记录 DXF 导入时的可编辑实体基线，用于判断哪些原实体需要被替换。 */
  function captureDxfSourceBaseline(drawing: Drawing): void {
    sourceBaselineById.clear()
    sourceHandleById.clear()
    editedSourceHandles.clear()
    canvasStyleSourceHandles.clear()
    const visit = (entities: Entity[]): void => {
      for (const entity of entities) {
        if (entity.sourceHandle) {
          sourceBaselineById.set(entity.id, comparableEntity(entity))
          sourceHandleById.set(entity.id, entity.sourceHandle.toUpperCase())
          if (entity.sourceCanvasStyle === true) canvasStyleSourceHandles.add(entity.sourceHandle.toUpperCase())
        }
        if (entity.children) visit(entity.children)
      }
    }
    visit(drawing.entities)
  }

  /** 对比导入基线，切换原图隐藏和可编辑覆盖层。 */
  function syncDxfSourceEdits(): void {
    if (!originalDxfText) return
    const current = new Map<string, Entity>()
    const visit = (entities: Entity[]): void => {
      for (const entity of entities) {
        current.set(entity.id, entity)
        if (entity.children) visit(entity.children)
      }
    }
    visit(state.drawing.entities)
    const nextHandles = new Set<string>()
    let overlayChanged = false
    for (const [id, baseline] of sourceBaselineById) {
      const entity = current.get(id)
      const edited = !entity || comparableEntity(entity) !== baseline
      const handle = sourceHandleById.get(id)
      if (edited && handle) nextHandles.add(handle)
      if (entity && entity.sourceEdited !== edited) {
        entity.sourceEdited = edited
        overlayChanged = true
      }
    }
    const handlesChanged = nextHandles.size !== editedSourceHandles.size
      || Array.from(nextHandles).some((handle) => !editedSourceHandles.has(handle))
    if (handlesChanged) {
      editedSourceHandles.clear()
      for (const handle of nextHandles) editedSourceHandles.add(handle)
    }
    if (dxfReferenceTransform) {
      // WebGL 层保留未修改的 DXF 原图作为参考。编辑后和新建的
      // 实体由 Renderer 在 Canvas 上绘制，使线宽和文字修改
      // 立即可见，无需等待 DXF 场景重建。
      dxfReferenceRenderer.value?.setHiddenHandles(new Set([...nextHandles, ...canvasStyleSourceHandles]))
      dxfReferenceRenderer.value?.setHiddenLayers(
        (state.drawing.layers || [])
          .filter((layer) => layer.visible === false || layer.frozen === true)
          .map((layer) => layer.name),
      )
    }
    if (handlesChanged || overlayChanged) markDirty()
  }

  /** 清除原始 DXF 保真层和合并导出上下文。 */
  function clearDxfSource(): void {
    originalDxfText = null
    dxfReferenceTransform = null
    sourceBaselineById.clear()
    sourceHandleById.clear()
    editedSourceHandles.clear()
    canvasStyleSourceHandles.clear()
    dxfReferenceRenderer.value?.clear()
  }

  /** 导入文件期间暂停画布编辑，保留视口导航。 */
  function isCanvasReadOnly(): boolean {
    return loading.value
  }

  // ---- 历史记录 ----
  /** 生成当前状态快照 */
  function snapshot(): string {
    return JSON.stringify({ drawing: state.drawing, selectedId: state.selectedId, selectedIds: state.selectedIds })
  }

  /** 从快照恢复状态 */
  function restore(json: string): void {
    const data = JSON.parse(json)
    state.drawing = data.drawing
    ensureDrawingLayers(state.drawing)
    state.selectedIds = Array.isArray(data.selectedIds)
      ? data.selectedIds
      : data.selectedId ? [data.selectedId] : []
    state.selectedId = state.selectedIds[state.selectedIds.length - 1] || null
    rebuildEntityIndex()
  }

  /** 入历史栈 */
  function pushHistory(): void {
    state.history = state.history.slice(0, state.historyIndex + 1)
    state.history.push(snapshot())
    const entityCount = entityById.size
    const limit = entityCount > 10000 ? 10 : entityCount > 4000 ? 20 : HISTORY_LIMIT
    if (state.history.length > limit) state.history.shift()
    state.historyIndex = state.history.length - 1
  }

  /** 提交一次变更：入历史并通知刷新 */
  function commit(): void {
    ensureDrawingLayers(state.drawing)
    rebuildEntityIndex()
    if (syncAssociativeDimensions(state.drawing)) snapEngine.value.rebuild(state.drawing)
    syncDxfSourceEdits()
    pushHistory()
    markDirty()
    notifyData()
  }

  /** 实时刷新画布（不入历史栈，用于输入过程中的实时预览） */
  function liveUpdate(): void {
    // 输入或指针操作尚未完成时，保持可编辑 Canvas 层
    // 与原图可见性同步。
    if (syncAssociativeDimensions(state.drawing)) snapEngine.value.rebuild(state.drawing)
    syncDxfSourceEdits()
    markDirty()
    selectionVersion.value++
    requestRender()
  }

  /** 撤销 */
  function undo(): void {
    if (state.historyIndex <= 0) return
    state.historyIndex -= 1
    restore(state.history[state.historyIndex])
    syncDxfSourceEdits()
    markDirty()
    notifyData()
    selectionVersion.value++
    statusText.value = '已撤销'
  }

  /** 重做 */
  function redo(): void {
    if (state.historyIndex >= state.history.length - 1) return
    state.historyIndex += 1
    restore(state.history[state.historyIndex])
    syncDxfSourceEdits()
    markDirty()
    notifyData()
    selectionVersion.value++
    statusText.value = '已重做'
  }

  /** 用新图纸替换当前内容（用于导入 SVG 或清空），并重置历史 */
  function replaceDrawing(drawing: Drawing, preserveDxfSource = false): void {
    if (!preserveDxfSource) clearDxfSource()
    ensureDrawingLayers(drawing)
    ensureDrawingDimensionStyles(drawing)
    state.drawing = drawing
    const inferred = inferImportedDefaults(drawing.entities)
    state.defaultColor = inferred.color
    state.defaultLayer = inferred.layer
    state.defaultLineWidth = inferred.lineWidth
    state.defaultFontSize = inferred.fontSize
    state.defaultLineType = inferred.lineType
    state.selectedId = null
    state.selectedIds = []
    measurement.value = null
    state.history = []
    state.historyIndex = -1
    rebuildEntityIndex()
    pushHistory()
    markDirty()
    notifyData()
    selectionVersion.value++
  }

  function inferImportedDefaults(entities: Entity[]): {
    lineWidth: number
    fontSize: number
    color: string
    layer: string
    lineType: LineType
  } {
    const lineWidthCounts = new Map<number, number>()
    const colors: string[] = []
    const layers: string[] = []
    const lineTypes: LineType[] = []
    const visit = (items: Entity[]): void => {
      for (const entity of items) {
        if (entity.children?.length) visit(entity.children)
        if (!entity.children?.length && entity.lineWidth != null && Number.isFinite(entity.lineWidth)) {
          const segmentCount = entity.type === 'polyline' ? Math.max(1, (entity.points?.length || 1) - 1 + (entity.closed ? 1 : 0)) : 1
          lineWidthCounts.set(entity.lineWidth, (lineWidthCounts.get(entity.lineWidth) || 0) + segmentCount)
        }
        if (!entity.children?.length) {
          if (entity.color) colors.push(entity.color)
          if (entity.layer) layers.push(entity.layer)
          if (entity.type !== 'text' && entity.lineType) lineTypes.push(entity.lineType)
        }
      }
    }
    visit(entities)
    const mode = <T extends string | number>(values: T[], fallback: T): T => {
      if (!values.length) return fallback
      const counts = new Map<T, number>()
      for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    }
    const lineWidth = [...lineWidthCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULTS.lineWidth
    return {
      lineWidth,
      fontSize: inferTextFontSize(entities, DEFAULTS.fontSize),
      color: mode(colors, DEFAULTS.color),
      layer: mode(layers, DEFAULTS.layer),
      lineType: mode(lineTypes, DEFAULTS.lineType),
    }
  }

  /** 返回当前图纸的规范化图层表。 @returns 图层定义列表。 @author snihao */
  function getLayers(): LayerDefinition[] {
    // 图层规范化会补齐 drawing.layers。文件导入期间，
    // 此兼容读取路径也不应修改图纸。
    if (isCanvasReadOnly()) {
      const readonlyDrawing: Drawing = {
        ...state.drawing,
        layers: state.drawing.layers?.map((layer) => ({ ...layer })),
      }
      return ensureDrawingLayers(readonlyDrawing)
    }
    return ensureDrawingLayers(state.drawing)
  }

  /** 创建图层并切换为当前图层。 @param name 图层名称。 @returns 是否创建成功。 @author snihao */
  function createLayer(name: string): boolean {
    const normalized = name.trim()
    if (!normalized) {
      statusText.value = '图层名称不能为空'
      return false
    }
    const layers = getLayers()
    if (layers.some((layer) => layer.name === normalized)) {
      statusText.value = '图层已存在'
      return false
    }
    layers.push(createLayerDefinition(normalized))
    state.defaultLayer = normalized
    commit()
    statusText.value = `已创建图层 ${normalized}`
    return true
  }

  /** 重命名图层并同步实体引用。 @param source 原图层名称。 @param target 新图层名称。 @returns 是否重命名成功。 @author snihao */
  function renameLayer(source: string, target: string): boolean {
    const from = source.trim()
    const to = target.trim()
    if (!from || !to || from === to) return false
    const layers = getLayers()
    const layer = layers.find((item) => item.name === from)
    if (!layer || layers.some((item) => item.name === to)) {
      statusText.value = '图层不存在或目标名称已使用'
      return false
    }
    if (layer.locked) {
      statusText.value = '锁定图层不可重命名'
      return false
    }
    layer.name = to
    visitEntities(state.drawing.entities, (entity) => {
      if (entity.layer === from) entity.layer = to
    })
    if (state.defaultLayer === from) state.defaultLayer = to
    commit()
    statusText.value = `已将图层 ${from} 重命名为 ${to}`
    return true
  }

  /** 删除图层；非空图层必须提供迁移目标。 @param name 待删除图层。 @param migrateTo 实体迁移目标。 @returns 是否删除成功。 @author snihao */
  function deleteLayer(name: string, migrateTo?: string): boolean {
    const normalized = name.trim()
    const layers = getLayers()
    const layer = layers.find((item) => item.name === normalized)
    if (!layer) return false
    if (layer.locked) {
      statusText.value = '锁定图层不可删除'
      return false
    }
    const hasEntities = (() => {
      let found = false
      visitEntities(state.drawing.entities, (entity) => {
        if (entity.layer === normalized) found = true
      })
      return found
    })()
    const target = migrateTo?.trim()
    if (hasEntities && (!target || target === normalized || !layers.some((item) => item.name === target))) {
      statusText.value = '非空图层需要选择迁移目标'
      return false
    }
    if (hasEntities) visitEntities(state.drawing.entities, (entity) => {
      if (entity.layer === normalized) entity.layer = target!
    })
    state.drawing.layers = layers.filter((item) => item.name !== normalized)
    if (!state.drawing.layers.length) state.drawing.layers = [createLayerDefinition(DEFAULTS.layer)]
    if (state.defaultLayer === normalized) state.defaultLayer = state.drawing.layers[0].name
    commit()
    statusText.value = hasEntities ? `已删除图层并迁移实体到 ${target}` : `已删除图层 ${normalized}`
    return true
  }

  /** 更新图层显示、锁定和默认样式。 @param name 图层名称。 @param patch 图层属性补丁。 @returns 是否更新成功。 @author snihao */
  function updateLayer(name: string, patch: Partial<LayerDefinition>): boolean {
    const layer = getLayers().find((item) => item.name === name)
    if (!layer) return false
    if (layer.locked && (patch.locked !== false || Object.keys(patch).some((key) => key !== 'locked'))) {
      statusText.value = '锁定图层不可修改属性'
      return false
    }
    if (patch.color && /^#[0-9a-f]{6}$/i.test(patch.color)) layer.color = patch.color.toUpperCase()
    if (patch.lineWidth !== undefined) layer.lineWidth = patch.lineWidth == null ? null : Math.max(0.05, patch.lineWidth)
    if (patch.lineType) layer.lineType = patch.lineType
    if (patch.dxfLineType !== undefined) layer.dxfLineType = patch.dxfLineType || null
    if (patch.visible !== undefined) layer.visible = patch.visible
    if (patch.frozen !== undefined) layer.frozen = patch.frozen
    if (patch.locked !== undefined) layer.locked = patch.locked
    setSelection(state.selectedIds)
    commit()
    statusText.value = `已更新图层 ${name}`
    return true
  }

  /** 独立显示指定图层，其余图层暂时隐藏。 @param name 图层名称。 @returns 是否更新成功。 @author snihao */
  function isolateLayer(name: string): boolean {
    const layers = getLayers()
    if (!layers.some((layer) => layer.name === name)) return false
    for (const layer of layers) layer.visible = layer.name === name
    commit()
    statusText.value = `已隔离图层 ${name}`
    return true
  }

  /** 恢复全部图层显示。 @returns 无返回值。 @author snihao */
  function showAllLayers(): void {
    for (const layer of getLayers()) layer.visible = true
    commit()
    statusText.value = '已显示全部图层'
  }

  /** 删除指定实体（支持顶层与子图元） */
  function deleteEntity(id: string): boolean {
    const entity = findEntity(id)
    if (!isEntityEditable(state.drawing, entity)) {
      statusText.value = '当前图层已锁定或冻结，无法删除'
      return false
    }
    const loc = findEntityLocation(id)
    if (!loc) return false
    loc.list.splice(loc.index, 1)
    if (state.selectedIds.includes(id)) setSelection(state.selectedIds.filter((selectedId) => selectedId !== id))
    commit()
    return true
  }

  /** 删除当前选中实体 */
  function deleteSelected(): void {
    const ids = new Set(state.selectedIds)
    if (!ids.size) {
      statusText.value = '无选中图元'
      return
    }
    const editableIds = new Set([...ids].filter((id) => isEntityEditable(state.drawing, findEntity(id))))
    if (!editableIds.size) {
      statusText.value = '选中图层已锁定或冻结，无法删除'
      return
    }
    const removeFrom = (list: Entity[]): Entity[] => list
      .filter((entity) => !editableIds.has(entity.id))
      .map((entity) => {
        if (entity.children) entity.children = removeFrom(entity.children)
        return entity
      })
    state.drawing.entities = removeFrom(state.drawing.entities)
    setSelection([])
    commit()
    statusText.value = `已删除 ${editableIds.size} 个图元`
  }

  /** 当前选择中不被父组合覆盖的变换根节点。 @author snihao */
  function selectedTransformRoots(): Entity[] {
    return selectedRootEntities(state.drawing, state.selectedIds)
  }

  /** 检查命令目标是否全部允许修改。 @param entities 待检查实体。 @returns 是否允许。 @author snihao */
  function ensureEditableTargets(entities: Entity[]): boolean {
    const blocked = entities.find((entity) => !isEntityEditable(state.drawing, entity))
    if (blocked) {
      statusText.value = '选择集中包含锁定或冻结图层，无法修改'
      return false
    }
    return true
  }

  /** 解除选中尺寸中指向未移动源实体的测量点关联。 @author snihao */
  function detachTransformAssociations(roots: Entity[], movingIds: Set<string>): number {
    let detached = 0
    const visit = (entity: Entity): void => {
      detached += detachOutsideSelection(entity, movingIds)
      for (const child of entity.children || []) visit(child)
    }
    for (const root of roots) visit(root)
    return detached
  }

  /**
   * 复制当前选择，保留源快照以支持连续粘贴。
   * @param basePoint 可选的复制基点，未提供时使用当前指针或选择中心。
   * @returns 是否成功创建剪贴板快照。
   * @author snihao
   */
  function copySelected(basePoint?: Point): boolean {
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '无选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    clipboard.value = {
      entities: JSON.parse(JSON.stringify(roots)) as Entity[],
      base: basePoint
        ? basePoint.slice() as Point
        : pointerPosition.value
          ? [pointerPosition.value.x, pointerPosition.value.y]
          : selectionCenter(roots),
      selectedIds: roots.map((entity) => entity.id),
    }
    statusText.value = `已复制 ${roots.length} 个图元`
    return true
  }

  /**
   * 将剪贴板副本放置到指定目标点；未指定时跟随当前指针或偏移 10 个单位。
   * @param target 可选的粘贴目标点。
   * @returns 是否成功创建副本。
   * @author snihao
   */
  function pasteClipboard(target?: Point): boolean {
    const current = clipboard.value
    if (!current) {
      statusText.value = '剪贴板为空'
      return false
    }
    const destination = target
      ? target.slice() as Point
      : pointerPosition.value
        ? [pointerPosition.value.x, pointerPosition.value.y] as Point
        : [current.base[0] + 10, current.base[1] + 10] as Point
    const clone = cloneEntitiesForPaste(current.entities, current.selectedIds)
    applyTransform(clone.entities, {
      kind: 'move',
      dx: destination[0] - current.base[0],
      dy: destination[1] - current.base[1],
    })
    state.drawing.entities.push(...clone.entities)
    setSelection(clone.selectedIds)
    commit()
    statusText.value = clone.detachedDimensionCount
      ? `已粘贴 ${clone.entities.length} 个图元，解除 ${clone.detachedDimensionCount} 个外部标注关联`
      : `已粘贴 ${clone.entities.length} 个图元`
    return true
  }

  /**
   * 创建一个偏移 10 个单位的快捷副本，并保留剪贴板用于连续粘贴。
   * @returns 是否成功创建副本。
   * @author snihao
   */
  function duplicateSelected(): boolean {
    if (!copySelected()) return false
    const current = clipboard.value!
    return pasteClipboard([current.base[0] + 10, current.base[1] + 10])
  }

  /**
   * 以 X/Y 位移精确移动当前选择；一次命令只产生一条历史记录。
   * @param dx X 方向位移。
   * @param dy Y 方向位移。
   * @returns 是否成功提交变换。
   * @author snihao
   */
  function moveSelectedBy(dx: number, dy: number): boolean {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      statusText.value = '移动位移无效'
      return false
    }
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '无选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    const movingIds = selectedEntityIds(state.drawing, state.selectedIds)
    const detached = detachTransformAssociations(roots, movingIds)
    applyTransform(roots, { kind: 'move', dx, dy })
    commit()
    statusText.value = detached ? `已移动，解除 ${detached} 个标注关联` : '已精确移动'
    return true
  }

  /**
   * 以基点和目标点精确移动当前选择。
   * @param target 目标点。
   * @param base 可选基点，未提供时使用选择中心。
   * @returns 是否成功提交变换。
   * @author snihao
   */
  function moveSelectedTo(target: Point, base?: Point): boolean {
    if (!target || !Number.isFinite(target[0]) || !Number.isFinite(target[1])) return false
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '无选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    const origin = base || selectionCenter(roots)
    return moveSelectedBy(target[0] - origin[0], target[1] - origin[1])
  }

  /**
   * 绕选择中心或指定基点旋转，角度单位为度。
   * @param angleDegrees 旋转角度。
   * @param origin 可选旋转基点，未提供时使用选择中心。
   * @returns 是否成功提交变换。
   * @author snihao
   */
  function rotateSelected(angleDegrees: number, origin?: Point): boolean {
    if (!Number.isFinite(angleDegrees)) {
      statusText.value = '旋转角度无效'
      return false
    }
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '无选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    const movingIds = selectedEntityIds(state.drawing, state.selectedIds)
    const detached = detachTransformAssociations(roots, movingIds)
    applyTransform(roots, { kind: 'rotate', angle: angleDegrees * Math.PI / 180, origin: origin || selectionCenter(roots) })
    commit()
    statusText.value = detached ? `已旋转，解除 ${detached} 个标注关联` : `已旋转 ${angleDegrees}°`
    return true
  }

  /**
   * 绕选择中心或指定基点缩放；非等比缩放会保留椭圆曲线语义。
   * @param scaleX X 方向缩放比例。
   * @param scaleY Y 方向缩放比例，缺省时使用 scaleX。
   * @param origin 可选缩放基点，未提供时使用选择中心。
   * @returns 是否成功提交变换。
   * @author snihao
   */
  function scaleSelected(scaleX: number, scaleY = scaleX, origin?: Point): boolean {
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
      statusText.value = '缩放比例必须为正数'
      return false
    }
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '无选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    const movingIds = selectedEntityIds(state.drawing, state.selectedIds)
    const detached = detachTransformAssociations(roots, movingIds)
    applyTransform(roots, { kind: 'scale', scaleX, scaleY, origin: origin || selectionCenter(roots) })
    commit()
    statusText.value = detached ? `已缩放，解除 ${detached} 个标注关联` : `已缩放 ${scaleX} × ${scaleY}`
    return true
  }

  /**
   * 按两点定义镜像；可选择保留源对象并生成一份新副本。
   * @param axisStart 镜像轴起点。
   * @param axisEnd 镜像轴终点。
   * @param mirrorText 是否同时镜像文字方向。
   * @param keepSource 是否保留原实体。
   * @returns 是否成功提交变换。
   * @author snihao
   */
  function mirrorSelected(axisStart: Point, axisEnd: Point, mirrorText = false, keepSource = false): boolean {
    const dx = axisEnd[0] - axisStart[0]
    const dy = axisEnd[1] - axisStart[1]
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-9) {
      statusText.value = '镜像轴必须由两个不同点定义'
      return false
    }
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '无选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    if (keepSource) {
      const clone = cloneEntitiesForPaste(roots, roots.map((entity) => entity.id))
      applyTransform(clone.entities, { kind: 'mirror', axisStart, axisEnd, mirrorText })
      state.drawing.entities.push(...clone.entities)
      setSelection(clone.selectedIds)
      commit()
      statusText.value = clone.detachedDimensionCount
        ? `已镜像并保留源对象，解除 ${clone.detachedDimensionCount} 个外部标注关联`
        : '已镜像并保留源对象'
      return true
    }
    const movingIds = selectedEntityIds(state.drawing, state.selectedIds)
    const detached = detachTransformAssociations(roots, movingIds)
    applyTransform(roots, { kind: 'mirror', axisStart, axisEnd, mirrorText })
    commit()
    statusText.value = detached ? `已镜像，解除 ${detached} 个标注关联` : '已镜像'
    return true
  }

  /** 递归访问实体树，供拓扑命令清理关联和批量属性使用。 @param entities 待访问实体。 @param visitor 实体访问回调。 @returns 无返回值。 @author snihao */
  function visitEntities(entities: Entity[], visitor: (entity: Entity) => void): void {
    for (const entity of entities) {
      visitor(entity)
      if (entity.children) visitEntities(entity.children, visitor)
    }
  }

  /** 清理实体的 DXF 源句柄，使拓扑替换进入编辑覆盖层。 @param entity 待清理实体。 @returns 无返回值。 @author snihao */
  function clearSourceMetadata(entity: Entity): void {
    entity.sourceHandle = null
    entity.sourceEdited = false
    for (const child of entity.children || []) clearSourceMetadata(child)
  }

  /** 解除指向被拓扑修改实体的标注关联。 @param entityIds 受影响实体 ID。 @returns 被解除的关联数量。 @author snihao */
  function detachTopologyAssociations(entityIds: Set<string>): number {
    let detached = 0
    visitEntities(state.drawing.entities, (entity) => {
      detached += detachDimensionAssociationsForEntities(entity, entityIds)
    })
    return detached
  }

  /** 在实体树中替换一个实体，保持原父级列表和索引。 @param id 源实体 ID。 @param replacement 替换实体。 @returns 是否找到并完成替换。 @author snihao */
  function replaceEntity(id: string, replacement: Entity): boolean {
    const location = findEntityLocation(id)
    if (!location) return false
    clearSourceMetadata(replacement)
    location.list.splice(location.index, 1, replacement)
    return true
  }

  /** 从实体树中删除一组实体。 @param ids 待删除实体 ID 集合。 @returns 实际删除数量。 @author snihao */
  function removeEntities(ids: Set<string>): number {
    let removed = 0
    const removeFrom = (list: Entity[]): Entity[] => list.filter((entity) => {
      if (ids.has(entity.id)) {
        removed++
        return false
      }
      if (entity.children) entity.children = removeFrom(entity.children)
      return true
    })
    state.drawing.entities = removeFrom(state.drawing.entities)
    return removed
  }

  /** 取得当前选中的拓扑目标；未传边界时默认第一个选中实体为边界。 @param boundaryId 可选边界 ID。 @param targetIds 可选目标 ID 列表。 @returns 边界和目标实体。 @author snihao */
  function topologyTargets(boundaryId?: string, targetIds?: string[]): { boundary: Entity; targets: Entity[] } | null {
    const boundary = findEntity(boundaryId || state.selectedIds[0] || null)
    if (!boundary) return null
    const ids = targetIds || state.selectedIds.filter((id) => id !== boundary.id)
    const targets = ids.map((id) => findEntity(id)).filter((entity): entity is Entity => !!entity && entity.id !== boundary.id)
    if (!isEntityEditable(state.drawing, boundary) || targets.some((entity) => !isEntityEditable(state.drawing, entity))) {
      statusText.value = '选择集中包含锁定或冻结图层，无法拓扑修改'
      return null
    }
    return targets.length ? { boundary, targets } : null
  }

  /** 执行偏移命令，并把所有有效副本一次性提交到历史记录。 @param amount 偏移距离。 @param side 可选光标位置。 @returns 是否至少生成一个副本。 @author snihao */
  function offsetSelected(amount: number, side?: Point): boolean {
    if (!Number.isFinite(amount) || Math.abs(amount) < 1e-7) {
      statusText.value = '偏移距离必须为非零数值'
      return false
    }
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '未选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    const created: Entity[] = []
    let failed = 0
    let reason = ''
    for (const root of roots) {
      const result = offsetEntity(root, amount, side || (pointerPosition.value ? [pointerPosition.value.x, pointerPosition.value.y] : null))
      if (result.ok && result.entity) created.push(result.entity)
      else {
        failed++
        reason = result.reason || reason
      }
    }
    if (!created.length) {
      statusText.value = reason || '偏移失败，未生成有效实体'
      return false
    }
    state.drawing.entities.push(...created)
    setSelection(created.map((entity) => entity.id))
    commit()
    statusText.value = failed ? `已偏移 ${created.length} 个图元，${failed} 个失败` : `已偏移 ${created.length} 个图元`
    return true
  }

  /** 执行修剪命令，默认使用第一个选中实体作为边界。 @param boundaryId 可选边界 ID。 @param targetIds 可选目标 ID 列表。 @param pickPoint 可选待删除部分上的点。 @returns 是否至少完成一个修剪。 @author snihao */
  function trimSelected(boundaryId?: string, targetIds?: string[], pickPoint?: Point): boolean {
    const selection = topologyTargets(boundaryId, targetIds)
    if (!selection) {
      statusText.value = '请先选择边界和待修剪图元'
      return false
    }
    let detached = 0
    let changed = 0
    let failed = 0
    let reason = ''
    for (const target of selection.targets) {
      const result = trimEntity(target, selection.boundary, pickPoint || (pointerPosition.value ? [pointerPosition.value.x, pointerPosition.value.y] : undefined))
      if (result.ok && result.entity) {
        detached += detachTopologyAssociations(new Set([target.id]))
        replaceEntity(target.id, result.entity)
        changed++
      } else {
        failed++
        reason = result.reason || reason
      }
    }
    if (!changed) {
      statusText.value = reason || '修剪失败，未找到有效交点'
      return false
    }
    commit()
    statusText.value = `已修剪 ${changed} 个图元${failed ? `，${failed} 个失败` : ''}${detached ? `，解除 ${detached} 个标注关联` : ''}`
    return true
  }

  /** 执行延伸命令，默认使用第一个选中实体作为边界。 @param boundaryId 可选边界 ID。 @param targetIds 可选目标 ID 列表。 @param pickPoint 可选端点拾取位置。 @returns 是否至少完成一个延伸。 @author snihao */
  function extendSelected(boundaryId?: string, targetIds?: string[], pickPoint?: Point): boolean {
    const selection = topologyTargets(boundaryId, targetIds)
    if (!selection) {
      statusText.value = '请先选择边界和待延伸图元'
      return false
    }
    let detached = 0
    let changed = 0
    let failed = 0
    let reason = ''
    for (const target of selection.targets) {
      const result = extendEntity(target, selection.boundary, pickPoint || (pointerPosition.value ? [pointerPosition.value.x, pointerPosition.value.y] : undefined))
      if (result.ok && result.entity) {
        detached += detachTopologyAssociations(new Set([target.id]))
        replaceEntity(target.id, result.entity)
        changed++
      } else {
        failed++
        reason = result.reason || reason
      }
    }
    if (!changed) {
      statusText.value = reason || '延伸失败，未找到边界外的交点'
      return false
    }
    commit()
    statusText.value = `已延伸 ${changed} 个图元${failed ? `，${failed} 个失败` : ''}${detached ? `，解除 ${detached} 个标注关联` : ''}`
    return true
  }

  /** 执行打断命令，默认使用光标位置或实体中点作为单点打断位置。 @param firstPoint 第一个打断点。 @param secondPoint 可选第二个打断点。 @returns 是否至少完成一个打断。 @author snihao */
  function breakSelected(firstPoint?: Point, secondPoint?: Point): boolean {
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '未选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    let detached = 0
    let changed = 0
    let failed = 0
    let reason = ''
    const nextSelection: string[] = []
    for (const target of roots) {
      const point = firstPoint || (pointerPosition.value ? [pointerPosition.value.x, pointerPosition.value.y] : null) || undefined
      if (!point) {
        failed++
        reason = '请提供打断点'
        continue
      }
      const result = breakEntity(target, point, secondPoint)
      if (result.ok && result.entities?.length) {
        const location = findEntityLocation(target.id)
        if (location) {
          detached += detachTopologyAssociations(new Set([target.id]))
          clearSourceMetadata(result.entities[0])
          for (const entity of result.entities.slice(1)) clearSourceMetadata(entity)
          location.list.splice(location.index, 1, ...result.entities)
          rebuildEntityIndex()
          nextSelection.push(...result.entities.map((entity) => entity.id))
          changed++
        }
      } else {
        failed++
        reason = result.reason || reason
      }
    }
    if (!changed) {
      statusText.value = reason || '打断失败'
      return false
    }
    setSelection(nextSelection)
    commit()
    statusText.value = `已打断 ${changed} 个图元${failed ? `，${failed} 个失败` : ''}${detached ? `，解除 ${detached} 个标注关联` : ''}`
    return true
  }

  /** 连接当前选中的共线图元。 @param tolerance 端点连接容差。 @returns 是否完成连接。 @author snihao */
  function joinSelected(tolerance = 1e-4): boolean {
    const roots = selectedTransformRoots().filter((entity) => entity.type === 'line' || entity.type === 'polyline')
    if (roots.length < 2) {
      statusText.value = '请至少选择两条直线或多段线'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    const result = joinEntities(roots, tolerance)
    if (!result.ok || !result.entity) {
      statusText.value = result.reason || '连接失败'
      return false
    }
    const ids = new Set(roots.map((entity) => entity.id))
    const detached = detachTopologyAssociations(ids)
    removeEntities(ids)
    clearSourceMetadata(result.entity)
    state.drawing.entities.push(result.entity)
    setSelection([result.entity.id])
    commit()
    statusText.value = `已连接 ${roots.length} 个图元${detached ? `，解除 ${detached} 个标注关联` : ''}`
    return true
  }

  /** 闭合或打开当前选中的多段线。 @param closed 可选目标状态，省略时根据当前选择切换。 @returns 是否完成操作。 @author snihao */
  function closeSelected(closed?: boolean): boolean {
    const roots = selectedTransformRoots().filter((entity) => entity.type === 'polyline')
    if (!roots.length) {
      statusText.value = '请选择多段线'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    const desired = closed === undefined ? !roots.every((entity) => entity.closed) : closed
    let detached = 0
    let changed = 0
    for (const target of roots) {
      const result = setPolylineClosed(target, desired)
      if (result.ok && result.entity) {
        detached += detachTopologyAssociations(new Set([target.id]))
        if (replaceEntity(target.id, result.entity)) changed++
      }
    }
    if (!changed) return false
    commit()
    statusText.value = `${desired ? '已闭合' : '已打开'} ${changed} 条多段线${detached ? `，解除 ${detached} 个标注关联` : ''}`
    return true
  }

  /** 选择所有顶层图元。 @returns 无返回值。 @author snihao */
  function selectAll(): void {
    setSelection(state.drawing.entities.map((entity) => entity.id))
    notifySelection()
    statusText.value = `已选择 ${state.selectedIds.length} 个图元`
  }

  /** 清空当前选择。 @returns 无返回值。 @author snihao */
  function clearSelection(): void {
    setSelection([])
    notifySelection()
    statusText.value = '已取消选择'
  }

  /** 反选所有顶层图元。 @returns 无返回值。 @author snihao */
  function invertSelection(): void {
    const selected = new Set(state.selectedIds)
    setSelection(state.drawing.entities.map((entity) => entity.id).filter((id) => !selected.has(id)))
    notifySelection()
    statusText.value = `已反选 ${state.selectedIds.length} 个图元`
  }

  /** 按类型、图层或颜色筛选顶层图元。 @param filter 筛选条件。 @returns 无返回值。 @author snihao */
  function selectByFilter(filter: { type?: EntityType; layer?: string; color?: string } = {}): void {
    const matches = (entity: Entity): boolean => {
      if (filter.type && entity.type !== filter.type) return false
      if (filter.layer && entity.layer !== filter.layer) return false
      if (filter.color && (entity.color || '').toUpperCase() !== filter.color.toUpperCase()) return false
      return true
    }
    const ids = state.drawing.entities.filter((entity) => matches(entity) || (entity.type === 'group' && (entity.children || []).some(matches))).map((entity) => entity.id)
    setSelection(ids)
    notifySelection()
    statusText.value = `筛选出 ${ids.length} 个图元`
  }

  /** 根据主选中图元的类型、图层和颜色选择同类图元。 @returns 无返回值。 @author snihao */
  function selectSimilar(): void {
    const source = findEntity(state.selectedId)
    if (!source) {
      statusText.value = '请先选择一个图元'
      return
    }
    selectByFilter({ type: source.type, layer: source.layer, color: source.color || undefined })
  }

  /** 批量修改选中图元的图层、颜色、线型和线宽。 @param style 要应用的样式。 @returns 是否修改成功。 @author snihao */
  function applySelectedStyle(style: Partial<Pick<Entity, 'layer' | 'color' | 'lineType' | 'lineWidth'>>): boolean {
    const roots = selectedTransformRoots()
    if (!roots.length) {
      statusText.value = '未选中图元'
      return false
    }
    if (!ensureEditableTargets(roots)) return false
    let changed = 0
    const apply = (entity: Entity): void => {
      if (style.layer !== undefined) entity.layer = style.layer || 'default'
      applyExplicitEntityStyle(entity, style)
      changed++
      for (const child of entity.children || []) apply(child)
    }
    for (const root of roots) apply(root)
    if (!changed) return false
    commit()
    statusText.value = `已批量修改 ${changed} 个图元属性`
    return true
  }

  /** 同步单选主项与多选集合 */
  function setSelection(ids: string[]): void {
    // 新建工具会在 commit 重建索引前先选中新实体，因此这里不依赖旧索引过滤。
    const unique = Array.from(new Set(ids))
    state.selectedIds = unique.filter((id) => {
      const entity = findEntity(id)
      return !entity || !isLayerFrozen(state.drawing, entity.layer)
    })
    state.selectedId = state.selectedIds[state.selectedIds.length - 1] || null
  }

  /** 查找实体（递归查找组合的子图元） */
  function findEntity(id: string | null): Entity | null {
    if (!id) return null
    return entityById.get(id) || null
  }

  /** 查找实体所在的父数组与索引（用于子图元定位） */
  function findEntityLocation(id: string): { list: Entity[]; index: number } | null {
    return entityLocationById.get(id) || null
  }

  /**
   * 智能组合：对当前图纸所有非 group 图元做空间聚类 + 闭环检测，
   * 把满足条件的图元合并为 group 实体。返回新增组合数。
   */
  function autoGroupAll(): number {
    if (state.drawing.entities.some((entity) => !isEntityEditable(state.drawing, entity))) {
      statusText.value = '图纸包含锁定或冻结图层，无法智能组合'
      return 0
    }
    const before = state.drawing.entities.filter((e) => e.type === 'group').length
    const next = autoGroup(state.drawing.entities)
    const after = next.filter((e) => e.type === 'group').length
    if (after === before) {
      statusText.value = '未检测到可合并的组合'
      return 0
    }
    state.drawing.entities = next
    commit()
    statusText.value = `已合并 ${after - before} 个组合`
    return after - before
  }

  /**
   * 解散当前选中的组合：把 group 的 children 还原到 entities 顶层。
   * 非组合实体不操作。
   */
  function ungroupSelected(): void {
    const id = state.selectedId
    if (!id) {
      statusText.value = '未选中组合'
      return
    }
    const ent = findEntity(id)
    if (!ent || ent.type !== 'group' || !ent.children) {
      statusText.value = '选中的不是组合'
      return
    }
    if (!isEntityEditable(state.drawing, ent)) {
      statusText.value = '当前图层已锁定或冻结，无法解散组合'
      return
    }
    const children = ent.children.map((c) => ({ ...c, groupId: null }))
    const idx = state.drawing.entities.findIndex((e) => e.id === id)
    if (idx < 0) return
    // 用展开替换 group 实体
    const next = state.drawing.entities.slice()
    next.splice(idx, 1, ...children)
    state.drawing.entities = next
    state.selectedId = children[0]?.id || null
    state.selectedIds = state.selectedId ? [state.selectedId] : []
    commit()
    statusText.value = `已解散组合（${children.length} 个图元）`
  }

  // ---- 绘图辅助 ----
  /** 清理当前捕捉反馈，但保留原始指针坐标。 */
  function formatDynamicNumber(value: number): string {
    return Number(value.toFixed(6)).toString()
  }

  function parseDynamicNumber(value: string): number | null {
    const parsed = Number(value.trim().replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }

  function dynamicPoint(): Point | null {
    const input = dynamicInput.value
    const measurement = dynamicMeasurement
    if (!input || !measurement) return null
    const coordinate = resolveCadCoordinateInput(input.lengthText, measurement.anchor)
    if (coordinate) return coordinate
    const length = parseDynamicNumber(input.lengthText)
    const angle = parseDynamicNumber(input.angleText)
    if (length === null || length <= 0 || angle === null) return null
    return pointFromCadPolar(measurement.anchor, length, angle)
  }

  function applyDynamicInputPreview(): void {
    const input = dynamicInput.value
    if (!input) return
    const point = dynamicPoint()
    input.valid = !!point
    if (!point) return
    const [screenX, screenY] = viewport.toScreen(point[0], point[1])
    input.screenX = screenX
    input.screenY = screenY
    resolvedPointerPosition.value = { x: point[0], y: point[1] }
    activeTool.value?.onDynamicInputPreview(point)
    requestRender()
  }

  /** 根据最近一次带锚点的指针测量启动精确输入。 */
  function beginDynamicInput(initial = ''): boolean {
    if (isCanvasReadOnly()) return false
    const measurement = dynamicMeasurement
    if (!measurement || !activeTool.value?.getDynamicInputAnchor()) return false
    dynamicInput.value = {
      activeField: 'length',
      lengthText: initial === '.' ? '0.' : initial || formatDynamicNumber(measurement.length),
      angleText: formatDynamicNumber(measurement.angle),
      screenX: measurement.screenX,
      screenY: measurement.screenY,
      valid: true,
    }
    snapEngine.value.clear()
    applyDynamicInputPreview()
    return true
  }

  function updateDynamicInput(field: DynamicInputField, value: string): void {
    const input = dynamicInput.value
    if (!input) return
    if (field === 'length') input.lengthText = value
    else input.angleText = value
    applyDynamicInputPreview()
  }

  function focusDynamicInputField(field: DynamicInputField): void {
    if (dynamicInput.value) dynamicInput.value.activeField = field
  }

  function cancelDynamicInput(restorePreview = true): void {
    if (!dynamicInput.value) return
    dynamicInput.value = null
    if (restorePreview && dynamicMeasurement) {
      const point = dynamicMeasurement.point
      resolvedPointerPosition.value = { x: point[0], y: point[1] }
      activeTool.value?.onDynamicInputPreview(point)
    }
    if (!restorePreview) dynamicMeasurement = null
    requestRender()
  }

  function confirmDynamicInput(): boolean {
    if (isCanvasReadOnly()) {
      cancelDynamicInput(false)
      return false
    }
    const point = dynamicPoint()
    if (!point || !dynamicInput.value) {
      if (dynamicInput.value) dynamicInput.value.valid = false
      return false
    }
    dynamicInput.value = null
    dynamicMeasurement = null
    activeTool.value?.onDynamicInput(point)
    requestRender()
    return true
  }

  /** 动态输入框获得焦点时处理回车、制表和退出键。 */
  function onDynamicInputKeydown(event: KeyboardEvent): boolean {
    const input = dynamicInput.value
    if (!input) return false
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      confirmDynamicInput()
      return true
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      input.activeField = input.activeField === 'length' ? 'angle' : 'length'
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancelDynamicInput()
      return true
    }
    return false
  }

  function captureDynamicMeasurement(result: SnapResult): void {
    const anchor = activeTool.value?.getDynamicInputAnchor()
    const measurement = result.measurement
    if (!anchor || !measurement) {
      if (!dynamicInput.value) dynamicMeasurement = null
      return
    }
    const [screenX, screenY] = viewport.toScreen(result.point[0], result.point[1])
    dynamicMeasurement = {
      anchor: anchor.slice() as Point,
      point: result.point.slice() as Point,
      length: measurement.length,
      angle: measurement.angle,
      screenX,
      screenY,
    }
  }

  function clearSnap(): void {
    snapEngine.value.clear()
    resolvedPointerPosition.value = null
    dynamicInput.value = null
    dynamicMeasurement = null
    requestRender()
  }

  /** 视口变化后使旧屏幕比例下的捕捉结果失效，但不取消动态输入状态。 */
  function invalidateSnapForViewportChange(): void {
    snapEngine.value.clear()
    resolvedPointerPosition.value = null
  }

  /** 统一解析工具指针坐标，并同步状态栏显示坐标。 */
  function resolveDrawingPoint(point: ToolPoint, options: SnapResolveOptions = {}): SnapResult {
    const result = snapEngine.value.resolve([point.x, point.y], viewport, drafting, options)
    resolvedPointerPosition.value = { x: result.point[0], y: result.point[1] }
    captureDynamicMeasurement(result)
    requestRender()
    return result
  }

  /** 更新绘图辅助偏好，保证正交和极轴模式互斥。 */
  function updateDraftingSettings(patch: Partial<DraftingSettings>): boolean {
    if (patch.orthoEnabled === true) patch = { ...patch, polarEnabled: false }
    if (patch.polarEnabled === true) patch = { ...patch, orthoEnabled: false }
    Object.assign(drafting, patch)
    drafting.polarIncrement = Math.max(1, Math.min(180, drafting.polarIncrement))
    drafting.tolerancePx = Math.max(4, Math.min(24, drafting.tolerancePx))
    drafting.hoverTolerancePx = Math.max(drafting.tolerancePx, Math.min(32, drafting.hoverTolerancePx))
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DRAFTING_STORAGE_KEY, JSON.stringify(drafting))
    }
    clearSnap()
    return true
  }

  /** 切换对象捕捉。 */
  function toggleObjectSnap(): void {
    if (!updateDraftingSettings({ snapEnabled: !drafting.snapEnabled })) return
    statusText.value = `对象捕捉：${drafting.snapEnabled ? '开启' : '关闭'}`
  }

  /** 切换正交模式；开启时自动关闭极轴。 */
  function toggleOrtho(): void {
    if (!updateDraftingSettings({ orthoEnabled: !drafting.orthoEnabled })) return
    statusText.value = `正交：${drafting.orthoEnabled ? '开启' : '关闭'}`
  }

  /** 切换极轴模式；开启时自动关闭正交。 */
  function togglePolar(): void {
    if (!updateDraftingSettings({ polarEnabled: !drafting.polarEnabled })) return
    statusText.value = drafting.polarEnabled ? `极轴：${drafting.polarIncrement}°` : '极轴：关闭'
  }

  /** 从本地存储恢复经过类型校验的绘图辅助设置。 */
  function restoreDraftingSettings(): void {
    const saved = window.localStorage.getItem(DRAFTING_STORAGE_KEY)
    if (!saved) return
    try {
      const value: unknown = JSON.parse(saved)
      if (!value || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      const booleanKeys: Array<keyof DraftingSettings> = [
        'snapEnabled', 'orthoEnabled', 'polarEnabled', 'endpointEnabled',
        'midpointEnabled', 'centerEnabled', 'quadrantEnabled', 'intersectionEnabled',
        'perpendicularEnabled', 'nearestEnabled', 'tangentEnabled',
      ]
      const patch: Partial<DraftingSettings> = {}
      for (const key of booleanKeys) {
        if (typeof record[key] === 'boolean') Object.assign(patch, { [key]: record[key] })
      }
      if (typeof record.polarIncrement === 'number' && Number.isFinite(record.polarIncrement)) patch.polarIncrement = record.polarIncrement
      if (typeof record.tolerancePx === 'number' && Number.isFinite(record.tolerancePx)) patch.tolerancePx = record.tolerancePx
      if (typeof record.hoverTolerancePx === 'number' && Number.isFinite(record.hoverTolerancePx)) patch.hoverTolerancePx = record.hoverTolerancePx
      Object.assign(drafting, patch)
      if (drafting.orthoEnabled) drafting.polarEnabled = false
    } catch {
      window.localStorage.removeItem(DRAFTING_STORAGE_KEY)
    }
  }

  // ---- 工具切换 ----
  /** 切换工具 */
  function setTool(name: ToolName): void {
    const next = tools.value[name]
    if (!next) return
    if (name !== 'select' && isCanvasReadOnly()) {
      statusText.value = '正在导入文件，请稍候'
      return
    }
    if (name !== 'text') textInput.value = null
    activeTool.value?.onDeactivate()
    snapEngine.value.clear()
    dynamicInput.value = null
    dynamicMeasurement = null
    resolvedPointerPosition.value = null
    activeTool.value = next
    state.activeTool = name
    next.onActivate()
    requestRender()
  }

  /** 结束当前工具，切回选择 */
  function finishTool(): void {
    setTool('select')
  }

  /** 在画布点击位置显示文字输入框 */
  function beginTextInput(point: ToolPoint): void {
    if (isLayerLocked(state.drawing, state.defaultLayer) || isLayerFrozen(state.drawing, state.defaultLayer)) {
      statusText.value = '当前图层已锁定或冻结，无法创建文字'
      return
    }
    const [screenX, screenY] = viewport.toScreen(point.x, point.y)
    textInput.value = {
      entityId: null,
      mode: 'create',
      worldX: point.x,
      worldY: point.y,
      screenX,
      screenY,
      value: '',
    }
    statusText.value = '输入文字，Enter 换行，Ctrl/⌘ + Enter 保存，Esc 取消'
  }

  /** 在画布内打开已有文字或标注的编辑器 */
  function beginTextEdit(entity: Entity): void {
    if ((entity.type !== 'text' && entity.type !== 'annotation' && entity.type !== 'dimension') || !entity.position) return
    const [screenX, screenY] = viewport.toScreen(entity.position[0], entity.position[1])
    textInput.value = {
      entityId: entity.id,
      mode: 'edit',
      worldX: entity.position[0],
      worldY: entity.position[1],
      screenX,
      screenY,
      value: entity.type === 'text' ? entity.content || '' : entity.text || '',
    }
    statusText.value = '编辑文字，Enter 换行，Ctrl/⌘ + Enter 保存，Esc 取消'
  }

  /** 确认画布内联文字输入并创建实体 */
  function confirmTextInput(): void {
    const input = textInput.value
    if (!input) return
    const content = input.value.trim()
    if (input.mode === 'edit' && input.entityId) {
      const entity = findEntity(input.entityId)
      if (entity && !isEntityEditable(state.drawing, entity)) {
        cancelTextInput()
        statusText.value = '当前图层已锁定或冻结，无法修改文字'
        return
      }
      if (entity?.type === 'text') entity.content = content
      else if (entity?.type === 'annotation' || entity?.type === 'dimension') {
        entity.text = content
        entity.dimensionTextManual = true
        if (entity.type === 'dimension') entity.dimensionTextOverride = content || null
      }
      textInput.value = null
      if (entity) {
        commit()
        statusText.value = '已更新文字'
      }
      return
    }
    if (!content) {
      cancelTextInput()
      return
    }
    const entity: Entity = {
      id: genId('text'),
      type: 'text',
      layer: state.defaultLayer,
      color: state.defaultColor,
      lineWidth: state.defaultLineWidth,
      lineType: state.defaultLineType,
      position: [input.worldX, input.worldY],
      content,
      fontSize: state.defaultFontSize,
      rotation: 0,
    }
    if (isLayerLocked(state.drawing, state.defaultLayer) || isLayerFrozen(state.drawing, state.defaultLayer)) {
      cancelTextInput()
      statusText.value = '当前图层已锁定或冻结，无法创建文字'
      return
    }
    state.drawing.entities.push(entity)
    textInput.value = null
    // 新实体尚未进入 ID 索引，先直接同步选择，commit 会重建索引。
    state.selectedIds = [entity.id]
    state.selectedId = entity.id
    commit()
    setTool('select')
    statusText.value = '已创建文字'
  }

  /** 取消画布内联文字输入 */
  function cancelTextInput(): void {
    textInput.value = null
    setTool('select')
    statusText.value = '已取消文字输入'
  }

  // ---- 工具上下文 ----
  function buildContext(): ToolContext {
    return {
      state,
      get canvas() {
        return canvasRef.value!
      },
      get renderer() {
        return renderer.value!
      },
      viewport,
      setStatus: (text: string) => {
        statusText.value = text
      },
      requestRender,
      markDirty,
      liveUpdate,
      commit,
      notify: notifySelection,
      findEntity,
      setSelection,
      beginTextInput,
      beginTextEdit,
      resolvePoint: resolveDrawingPoint,
      clearSnap,
      finishTool,
      deleteSelected,
      isEntityEditable: (entity: Entity | null | undefined) => isEntityEditable(state.drawing, entity),
      canCreateOnLayer: (layer: string) => !isLayerLocked(state.drawing, layer) && !isLayerFrozen(state.drawing, layer),
      setTool,
      setMeasurement: (result: MeasurementResult | null) => {
        measurement.value = result
      },
    }
  }

  // ---- Canvas 尺寸自适应（高 DPI） ----
  function resizeCanvas(): void {
    const canvas = canvasRef.value
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    viewport.setDpr(dpr)
    const w = canvas.clientWidth || 800
    const h = canvas.clientHeight || 600
    const previousCenter = canvasSize.width > 0 && canvasSize.height > 0
      ? viewport.toWorld(canvasSize.width / 2, canvasSize.height / 2)
      : null
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    invalidateSnapForViewportChange()
    if (previousCenter) {
      viewport.offsetX = w / 2 - previousCenter[0] * viewport.scale
      viewport.offsetY = h / 2 - previousCenter[1] * viewport.scale
    }
    canvasSize = { width: w, height: h }
    dxfReferenceRenderer.value?.resize(w, h, dpr)
    minimap.value?.setMainSize(w, h)
    requestRender()
  }

  // ---- 屏幕坐标 → world 坐标 ----
  function toPoint(event: PointerEvent | MouseEvent): ToolPoint {
    const canvas = canvasRef.value!
    const rect = canvas.getBoundingClientRect()
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top
    const [x, y] = viewport.toWorld(sx, sy)
    return { x, y }
  }

  // ---- 适配视图 ----
  function fitView(): void {
    const canvas = canvasRef.value
    if (!canvas) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) {
      requestAnimationFrame(fitView)
      return
    }
    const b = drawingBounds(state.drawing) || {
      minX: 0,
      minY: 0,
      maxX: state.drawing.width,
      maxY: state.drawing.height,
    }
    if (!Number.isFinite(b.minX)) return
    invalidateSnapForViewportChange()
    viewport.fit(b, w, h, 60)
    requestRender()
  }

  /** 定位明确实体引用，不修改选择或历史。 */
  function focusEntities(ids: string[]): boolean {
    const drawing = state.drawing
    const entities = selectedRootEntities(drawing, ids)
    const canvas = canvasRef.value
    if (!entities.length || !canvas || canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return false
    const bounds = drawingBounds({ ...drawing, entities })
    if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return false
    invalidateSnapForViewportChange()
    viewport.fit(bounds, canvas.clientWidth, canvas.clientHeight, Math.min(60, canvas.clientWidth / 4, canvas.clientHeight / 4))
    requestRender()
    return true
  }

  /** 以画布中心为锚点执行缩放 */
  function zoomAtCanvasCenter(factor: number): void {
    const canvas = canvasRef.value
    if (!canvas) return
    invalidateSnapForViewportChange()
    viewport.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor)
    requestRender()
  }

  /** 放大一级 */
  function zoomIn(): void {
    zoomAtCanvasCenter(1.2)
  }

  /** 缩小一级 */
  function zoomOut(): void {
    zoomAtCanvasCenter(1 / 1.2)
  }

  /** 恢复 100% 缩放，同时保持当前视图中心不变 */
  function resetZoom(): void {
    const targetScale = clamp(1, 1e-5, 200)
    zoomAtCanvasCenter(targetScale / viewport.scale)
  }

  /** 仅刷新画布外观设置，不写入图元历史 */
  function refreshCanvasAppearance(): void {
    requestRender()
  }

  // ---- 小屏导航图交互 ----
  /** 小屏坐标转世界坐标 */
  function minimapToWorld(event: PointerEvent | MouseEvent): ToolPoint | null {
    const el = minimapRef.value
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top
    const fit = minimap.value?._fit
    if (!fit) return null
    return { x: (sx - fit.offX) / fit.scale, y: (sy - fit.offY) / fit.scale }
  }

  /** 让指定世界坐标出现在画布中心 */
  function centerViewportOn(worldX: number, worldY: number): void {
    const canvas = canvasRef.value
    if (!canvas) return
    const w = canvas.clientWidth || 800
    const h = canvas.clientHeight || 600
    invalidateSnapForViewportChange()
    viewport.offsetX = w / 2 - worldX * viewport.scale
    viewport.offsetY = h / 2 - worldY * viewport.scale
    requestRender()
  }

  /** 小屏 pointerdown */
  function onMinimapPointerDown(event: PointerEvent): void {
    event.preventDefault()
    minimapDragging = true
    minimapRef.value?.setPointerCapture(event.pointerId)
    const p = minimapToWorld(event)
    if (p) centerViewportOn(p.x, p.y)
  }

  /** 小屏 pointermove */
  function onMinimapPointerMove(event: PointerEvent): void {
    if (!minimapDragging) return
    const p = minimapToWorld(event)
    if (p) centerViewportOn(p.x, p.y)
  }

  /** 小屏 pointerup / pointercancel */
  function onMinimapPointerUp(event: PointerEvent): void {
    if (!minimapDragging) return
    minimapDragging = false
    try {
      minimapRef.value?.releasePointerCapture(event.pointerId)
    } catch (e) {
      // 忽略释放捕获异常
    }
  }

  // ---- 主画布事件处理 ----
  /** 主画布滚轮缩放 */
  function onCanvasWheel(event: WheelEvent): void {
    event.preventDefault()
    const canvas = canvasRef.value!
    const rect = canvas.getBoundingClientRect()
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    invalidateSnapForViewportChange()
    viewport.zoomAt(sx, sy, factor)
    requestRender()
  }

  /** 读取当前双指中心和间距。 */
  function currentTouchGesture(): { centerX: number; centerY: number; distance: number } | null {
    const points = Array.from(touchPointers.values()).slice(0, 2)
    if (points.length < 2) return null
    const [first, second] = points
    return {
      centerX: (first.x + second.x) / 2,
      centerY: (first.y + second.y) / 2,
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    }
  }

  /** 将浏览器合并的高频采样转换为世界坐标。 */
  function coalescedPoints(event: PointerEvent): ToolPoint[] {
    if (typeof event.getCoalescedEvents !== 'function') return []
    try {
      return event.getCoalescedEvents()
        .filter((sample) => sample.clientX !== event.clientX || sample.clientY !== event.clientY)
        .map(toPoint)
    } catch {
      return []
    }
  }

  /** 取消当前指针操作；连续绘图工具通过重新激活清空其中间状态。 */
  function cancelActivePointer(event: PointerEvent): void {
    const tool = activeTool.value
    if (!tool) return
    tool.onPointerCancel(event)
    if (state.activeTool !== 'select' && state.activeTool !== 'freehand') {
      tool.onDeactivate()
      tool.onActivate()
    }
  }

  /** 主画布 pointerdown */
  function onCanvasPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'touch') {
      event.preventDefault()
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      canvasRef.value?.setPointerCapture(event.pointerId)
      if (touchPointers.size >= 2) {
        if (!touchGestureConsumed) cancelActivePointer(event)
        touchGestureConsumed = true
        touchGesture = currentTouchGesture()
        snapEngine.value.clear()
        resolvedPointerPosition.value = null
        requestRender()
        return
      }
      if (touchGestureConsumed) return
    }
    // 中键平移
    if (event.button === 1) {
      panning = { x: event.clientX, y: event.clientY }
      snapEngine.value.clear()
      resolvedPointerPosition.value = null
      canvasRef.value?.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button !== 0) return
    if (isCanvasReadOnly()) return
    cancelDynamicInput(false)
    activeTool.value?.onPointerDown(event, toPoint(event))
  }

  /** 主画布 pointermove */
  function onCanvasPointerMove(event: PointerEvent): void {
    if (event.pointerType === 'touch' && touchPointers.has(event.pointerId)) {
      event.preventDefault()
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touchGestureConsumed) {
        const next = currentTouchGesture()
        const canvas = canvasRef.value
        if (touchGesture && next && canvas) {
          const rect = canvas.getBoundingClientRect()
          invalidateSnapForViewportChange()
          viewport.pan(next.centerX - touchGesture.centerX, next.centerY - touchGesture.centerY)
          viewport.zoomAt(next.centerX - rect.left, next.centerY - rect.top, next.distance / touchGesture.distance)
          requestRender()
        }
        touchGesture = next
        return
      }
    }
    pointerPosition.value = toPoint(event)
    resolvedPointerPosition.value = null
    if (isCanvasReadOnly() && !panning) return
    if (panning) {
      invalidateSnapForViewportChange()
      viewport.pan(event.clientX - panning.x, event.clientY - panning.y)
      panning.x = event.clientX
      panning.y = event.clientY
      requestRender()
      return
    }
    activeTool.value?.onPointerMove(event, pointerPosition.value, coalescedPoints(event))
  }

  /** 指针离开画布时清理状态栏坐标 */
  function onCanvasPointerLeave(): void {
    if (!panning && !dynamicInput.value) {
      pointerPosition.value = null
      resolvedPointerPosition.value = null
      snapEngine.value.clear()
      dynamicMeasurement = null
      requestRender()
    }
  }

  /** 主画布 pointerup / pointercancel */
  function onCanvasPointerUp(event: PointerEvent): void {
    if (event.pointerType === 'touch') {
      const consumed = touchGestureConsumed
      touchPointers.delete(event.pointerId)
      try {
        canvasRef.value?.releasePointerCapture(event.pointerId)
      } catch {
        // 浏览器可能已经释放捕获。
      }
      if (consumed) {
        touchGesture = currentTouchGesture()
        if (touchPointers.size === 0) touchGestureConsumed = false
        return
      }
    }
    if (panning) {
      panning = null
      try {
        canvasRef.value?.releasePointerCapture(event.pointerId)
      } catch (e) {
        // 忽略释放捕获异常
      }
      return
    }
    if (isCanvasReadOnly()) return
    activeTool.value?.onPointerUp(event, toPoint(event))
  }

  /** 主画布 pointercancel：取消未完成工具，不按正常抬手提交。 */
  function onCanvasPointerCancel(event: PointerEvent): void {
    if (event.pointerType === 'touch') {
      touchPointers.delete(event.pointerId)
      touchGesture = currentTouchGesture()
      if (touchPointers.size === 0) touchGestureConsumed = false
    }
    panning = null
    cancelActivePointer(event)
    snapEngine.value.clear()
    resolvedPointerPosition.value = null
    requestRender()
  }

  /** 主画布 dblclick */
  function onCanvasDoubleClick(event: MouseEvent): void {
    if (isCanvasReadOnly()) return
    activeTool.value?.onDoubleClick(event as PointerEvent, toPoint(event))
  }

  /**
   * 处理全局键盘事件，包括快捷复制、粘贴和变换命令。
   * @param event 键盘事件。
   * @returns 无返回值。
   * @author snihao
   */
  function onWindowKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (isCanvasReadOnly()) return

    if (dynamicInput.value && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      if (onDynamicInputKeydown(event)) return
      const input = dynamicInput.value
      const field = input.activeField
      const acceptsCharacter = field === 'length'
        ? /^[0-9.,@<+\-]$/.test(event.key)
        : /^[0-9.,-]$/.test(event.key)
      if (acceptsCharacter || event.key === 'Backspace') {
        event.preventDefault()
        const current = field === 'length' ? input.lengthText : input.angleText
        const next = event.key === 'Backspace' ? current.slice(0, -1) : current + event.key
        updateDynamicInput(field, next)
        return
      }
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    const key = event.key.toLowerCase()
    if (event.ctrlKey || event.metaKey) {
      if (key === 'c') {
        event.preventDefault()
        copySelected()
        return
      }
      if (key === 'v') {
        event.preventDefault()
        pasteClipboard()
        return
      }
      if (key === 'd') {
        event.preventDefault()
        duplicateSelected()
        return
      }
    }
    if (event.key === 'F3') {
      event.preventDefault()
      toggleObjectSnap()
      return
    }
    if (event.key === 'F8') {
      event.preventDefault()
      toggleOrtho()
      return
    }
    if (event.key === 'F10') {
      event.preventDefault()
      togglePolar()
      return
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && (/^[0-9]$/.test(event.key) || event.key === '.')) {
      if (beginDynamicInput(event.key)) {
        event.preventDefault()
        return
      }
    }
    if (event.key === 'Tab') {
      const result = snapEngine.value.cycle()
      if (result) {
        event.preventDefault()
        resolvedPointerPosition.value = { x: result.point[0], y: result.point[1] }
        captureDynamicMeasurement(result)
        activeTool.value?.onSnapCycle(result)
        requestRender()
        return
      }
    }
    if (event.shiftKey && event.code === 'Digit1') {
      event.preventDefault()
      fitView()
    } else if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    } else if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault()
      redo()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setTool('select')
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const tool = (Object.entries(TOOL_SHORTCUTS) as [ToolName, string][])
        .find(([, shortcut]) => shortcut.toLowerCase() === key)?.[0]
      if (tool) {
        event.preventDefault()
        setTool(tool)
      } else {
        activeTool.value?.onKeyDown(event)
      }
    } else {
      activeTool.value?.onKeyDown(event)
    }
  }

  /** 将未知异常转换为可读错误信息 */
  function errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return /[\u4e00-\u9fff]/.test(message) ? message : '操作失败，请检查文件格式和服务状态'
  }

  // ---- 顶部操作 ----
  /** 导出 DXF */
  async function handleExport(): Promise<void> {
    statusText.value = '导出中…'
    try {
      syncDxfSourceEdits()
      const fileName = documentName.value.replace(/\.[^.]+$/, '') + '-edited.dxf'
      if (originalDxfText && dxfReferenceTransform) {
        await exportMergedDxf(
          originalDxfText,
          state.drawing,
          Array.from(editedSourceHandles),
          dxfReferenceTransform,
          fileName,
        )
      } else {
        await exportDxf(state.drawing, fileName)
      }
      statusText.value = `已导出 ${fileName}`
    } catch (err: unknown) {
      statusText.value = '导出失败：' + errorMessage(err)
      console.error('DXF 导出失败：', err)
    }
  }

  /** 清空画布 */
  function handleClear(): void {
    replaceDrawing({
      unit: DEFAULTS.unit,
      width: state.drawing.width,
      height: state.drawing.height,
      entities: [],
      layers: [createLayerDefinition(DEFAULTS.layer)],
    })
    statusText.value = '已清空画布'
  }

  /** 导入 SVG 文件 */
  async function handleImportSvg(file: File): Promise<void> {
    loading.value = true
    loadingText.value = '正在解析 SVG…'
    statusText.value = '导入中…'
    try {
      const text = await file.text()
      // 让 UI 先渲染加载遮罩再开始解析
      await new Promise((r) => setTimeout(r, 30))
      const drawing = parseSvgFile(text)
      documentName.value = file.name
      const sourceCount = drawing.entities.length
      // 先做真实几何合并，减少后续绘制、命中、历史记录和 DXF 实体数量。
      drawing.entities = mergeConnectedLines(drawing.entities)
      // 智能组合只保留业务语义；闭环算法已改为线性复杂度。
      drawing.entities = autoGroup(drawing.entities)
      replaceDrawing(drawing)
      fitView()
      const groupCount = drawing.entities.filter((e) => e.type === 'group').length
      const reducedCount = sourceCount - drawing.entities.length
      statusText.value = groupCount > 0
        ? `已导入 ${drawing.entities.length} 项（减少 ${Math.max(0, reducedCount)} 项，含 ${groupCount} 个组合）`
        : `已导入 ${drawing.entities.length} 个图元（减少 ${Math.max(0, reducedCount)} 项）`
    } catch (err: unknown) {
      statusText.value = '导入失败：' + errorMessage(err)
      console.error('SVG 导入失败：', err)
    } finally {
      loading.value = false
    }
  }

  /** 导入 ASCII DXF 文件并转换为当前可编辑实体 */
  async function handleImportDxf(file: File): Promise<void> {
    loading.value = true
    loadingText.value = '正在解析 DXF…'
    statusText.value = '导入中…'
    try {
      const { text } = await readDxfFile(file)
      await new Promise((resolve) => setTimeout(resolve, 30))
      clearDxfSource()
      const { drawing, unsupported, referenceTransform } = parseDxfFile(text)
      documentName.value = file.name
      const sourceCount = drawing.entities.length
      replaceDrawing(drawing, true)
      originalDxfText = text
      dxfReferenceTransform = referenceTransform
      captureDxfSourceBaseline(drawing)
      const referenceResult = await dxfReferenceRenderer.value?.load(text, referenceTransform)
      dxfReferenceRenderer.value?.setHiddenHandles(canvasStyleSourceHandles)
      dxfReferenceRenderer.value?.setHiddenLayers(
        (drawing.layers || [])
          .filter((layer) => layer.visible === false || layer.frozen === true)
          .map((layer) => layer.name),
      )
      const referenceUnsupported = referenceResult?.unsupported || []
      markDirty()
      const fitImportedDxf = (): void => {
        const canvas = canvasRef.value
        const w = canvas?.clientWidth || 0
        const h = canvas?.clientHeight || 0
        if (!canvas || !w || !h) {
          requestAnimationFrame(fitImportedDxf)
          return
        }
        // 使用转换后的编辑器坐标边界；保真渲染层的 originOffset 可能与编辑器坐标不同。
        const bounds = drawingBounds(drawing)
        if (Number.isFinite(bounds.minX)) viewport.fitToRatio(bounds, w, h, 0.8)
        else fitView()
        requestRender()
      }
      fitImportedDxf()
      const viewOnly = Object.values(unsupported).reduce((sum, count) => sum + count, 0)
      const unsupportedDetail = referenceUnsupported.length ? `，渲染器未覆盖：${referenceUnsupported.join('、')}` : ''
      statusText.value = viewOnly
        ? `DXF 已保真导入；${sourceCount} 项可二次编辑，另有 ${viewOnly} 项保留原样显示${unsupportedDetail}`
        : `DXF 已保真导入；${sourceCount} 项可二次编辑${unsupportedDetail}`
    } catch (err: unknown) {
      statusText.value = 'DXF 导入失败：' + errorMessage(err)
      console.error('DXF 导入失败：', err)
    } finally {
      loading.value = false
    }
  }

  // ---- 初始化（由子组件 onMounted 显式调用，避免 ref 同步时序问题）----
  /** 是否已完成初始化 */
  let initialized = false

  /** 尝试执行完整初始化（当 canvas 和 minimap 都就绪时触发） */
  function tryInit(): void {
    if (initialized) return
    const canvas = canvasRef.value
    const dxfCanvas = dxfCanvasRef.value
    const minimapEl = minimapRef.value
    if (!canvas || !dxfCanvas || !minimapEl) return
    initialized = true

    const savedBackground = window.localStorage.getItem('editor.canvasBackground')
    if (savedBackground && /^#[0-9A-F]{6}$/i.test(savedBackground)) state.canvasBackground = savedBackground.toUpperCase()
    const savedGuides = window.localStorage.getItem('editor.showCanvasGuides')
    if (savedGuides !== null) state.showCanvasGuides = savedGuides === 'true'
    restoreDraftingSettings()
    rebuildEntityIndex()

    renderer.value = new Renderer(canvas)
    dxfReferenceRenderer.value = new DxfReferenceRenderer(dxfCanvas)
    minimap.value = new Minimap(minimapEl)

    // 实例化所有工具
    const ctx = buildContext()
    const toolMap: Record<string, BaseTool> = {}
    for (const [name, ToolClass] of Object.entries(TOOL_CLASSES)) {
      toolMap[name] = new ToolClass(ctx)
    }
    tools.value = toolMap
    activeTool.value = toolMap.select

    // 默认进入空白图纸，由用户绘制或导入内容
    setTool('select')

    // 尺寸自适应监听
    ro = new ResizeObserver(() => resizeCanvas())
    ro.observe(canvas)
    window.addEventListener('resize', resizeCanvas)
    window.addEventListener('keydown', onWindowKeyDown)

    // 等 layout 完成后 resize + fit
    requestAnimationFrame(() => {
      resizeCanvas()
      fitView()
      statusText.value = '就绪：滚轮缩放，中键拖拽平移，可导入 SVG 或直接绘制'
    })
  }

  /** 设置主画布元素（由 EditorCanvas 的 onMounted 调用） */
  function initCanvas(el: HTMLCanvasElement): void {
    canvasRef.value = el
    tryInit()
  }

  /** 设置原始 DXF WebGL 画布元素。 */
  function initDxfCanvas(el: HTMLCanvasElement): void {
    dxfCanvasRef.value = el
    tryInit()
  }

  /** 设置小屏画布元素（由 EditorMinimap 的 onMounted 调用） */
  function initMinimap(el: HTMLCanvasElement): void {
    minimapRef.value = el
    tryInit()
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      ro?.disconnect()
      window.removeEventListener('resize', resizeCanvas)
      window.removeEventListener('keydown', onWindowKeyDown)
      dxfReferenceRenderer.value?.dispose()
    })
  }

  // 保存空白初始状态，让第一次绘制也能撤销。
  pushHistory()

  return {
    // 状态
    state,
    drafting,
    statusText,
    documentName,
    pointerPosition,
    resolvedPointerPosition,
    textInput,
    dynamicInput,
    measurement,
    loading,
    loadingText,
    version,
    dataVersion,
    selectionVersion,
    viewport,
    isCanvasReadOnly,
    // DOM 引用（组件绑定 ref）
    canvasRef,
    minimapRef,
    // 工具
    setTool,
    toggleObjectSnap,
    toggleOrtho,
    togglePolar,
    updateDraftingSettings,
    updateDynamicInput,
    focusDynamicInputField,
    onDynamicInputKeydown,
    // 图层
    getLayers,
    createLayer,
    renameLayer,
    deleteLayer,
    updateLayer,
    isolateLayer,
    showAllLayers,
    isLayerLocked: (name: string) => isLayerLocked(state.drawing, name),
    isLayerFrozen: (name: string) => isLayerFrozen(state.drawing, name),
    isEntityEditable: (entity: Entity | null | undefined) => isEntityEditable(state.drawing, entity),
    resolveEntityStyle: (entity: Entity) => resolveEntityStyle(entity, state.drawing),
    // 历史
    undo,
    redo,
    commit,
    liveUpdate,
    notify: notifySelection,
    notifyData,
    // 实体操作
    findEntity,
    setSelection,
    deleteSelected,
    deleteEntity,
    replaceDrawing,
    copySelected,
    pasteClipboard,
    duplicateSelected,
    moveSelectedBy,
    moveSelectedTo,
    rotateSelected,
    scaleSelected,
    mirrorSelected,
    offsetSelected,
    trimSelected,
    extendSelected,
    breakSelected,
    joinSelected,
    closeSelected,
    selectAll,
    clearSelection,
    invertSelection,
    selectByFilter,
    selectSimilar,
    applySelectedStyle,
    clipboard,
    // 组合操作
    autoGroupAll,
    ungroupSelected,
    // 视图
    fitView,
    focusEntities,
    zoomIn,
    zoomOut,
    resetZoom,
    refreshCanvasAppearance,
    resizeCanvas,
    // 初始化（子组件 onMounted 调用）
    initCanvas,
    initDxfCanvas,
    initMinimap,
    // 顶部操作
    handleExport,
    handleClear,
    handleImportSvg,
    handleImportDxf,
    confirmTextInput,
    cancelTextInput,
    // 主画布事件
    onCanvasWheel,
    onCanvasPointerDown,
    onCanvasPointerMove,
    onCanvasPointerLeave,
    onCanvasPointerUp,
    onCanvasPointerCancel,
    onCanvasDoubleClick,
    // 小屏事件
    onMinimapPointerDown,
    onMinimapPointerMove,
    onMinimapPointerUp,
  }
}
