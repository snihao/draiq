/** Canvas 2D 渲染器：离屏缓存 + 视口剔除 + 双层绘制。
 * 实体层（离屏 canvas）：所有已提交图元，仅在图元或视口变化时重渲染，否则 blit。
 * 交互层（主 canvas）：网格 + blit 实体层 + 选中 halo/手柄 + 工具预览，每帧重画但量小。
 */
import { annotationTextLayout, arcDimensionArrowGeometry, dimensionPoints, dimensionSegments, hitEntity, entityBounds, isDimensionEntity, isRectanglePolyline, type DimensionSegmentOptions } from '#draiq/utils/editor/geometry'
import { isLayerFrozen, resolveEntityStyle } from '#draiq/utils/editor/layers'
import { canvasLineWidth } from '#draiq/utils/editor/lineWidth'
import { resolveDimensionStyle, type EffectiveDimensionStyle } from '#draiq/utils/editor/dimensionStyles'
import type { Viewport } from '#draiq/utils/editor/viewport'

/** 手柄屏幕像素半边长 */
const HANDLE_SIZE = 7
/** 旋转柄与图元包围盒顶部的屏幕像素距离 */
const ROTATE_OFFSET_PX = 30
/** 尺寸界线距离测量点的留白 */
const DIMENSION_EXTENSION_GAP = 3
/** 尺寸界线穿过尺寸线后的超出长度 */
const DIMENSION_EXTENSION_OVERHANG = 4
/** 选中高亮色 */
const HALO_COLOR = '#F2B84B'
/** 默认颜色 */
const DEFAULT_COLOR = '#1f2933'
/** 默认线宽 */
const DEFAULT_WIDTH = 1.2
/** 线宽最小屏幕像素，避免缩小时变亚像素看不见 */
const MIN_SCREEN_PX = 0.8
/** 保证显式指定的 0.13 毫米剖面线清晰可见，同时避免与轮廓线同样粗重。 */
const THIN_SCREEN_PX = 0.5

/** 在两种渲染路径中，为显式细线设置较小的最小屏幕宽度。 */
function minimumStrokePixels(entity: Entity, unit: DrawingUnit): number {
  const widthMillimeters = (entity.lineWidth || 0) * (unit === 'inch' ? 25.4 : 1)
  return entity.lineWidthMode === 'explicit' && widthMillimeters > 0 && widthMillimeters <= 0.15
    ? THIN_SCREEN_PX : MIN_SCREEN_PX
}

/** 缓存后的叶子图元渲染记录 */
interface RenderRecord {
  entity: Entity
  bounds: Bounds
  path: Path2D | null
  ancestorIds: string[]
  /** 实体属于未修改的原始 INSERT 块或组合。 */
  sourceOnly: boolean
  order: number
}

/** DXF 保真图层启用时，单个编辑器实体在 Canvas 上的绘制方式。 @author snihao */
export type ReferenceCanvasRenderMode = 'full' | 'textOnly' | 'none'

/**
 * 决定 DXF 保真图层启用时实体在 Canvas 上的绘制方式。
 * 原生标注的线由 WebGL 保真图层负责，文字始终由 Canvas 补绘以避免匿名块文字被过滤后消失。
 * @param entity 待判断实体。
 * @param sourceOnly 是否继承了父组合的源图层绘制约束。
 * @returns Canvas 绘制方式。
 * @author snihao
 */
export function referenceCanvasRenderMode(entity: Entity, sourceOnly = false): ReferenceCanvasRenderMode {
  if (entity.type === 'text') return 'full'
  const unchangedSource = (sourceOnly || (!!entity.sourceHandle && entity.sourceEdited !== true))
    && entity.sourceCanvasStyle !== true
  if (entity.type === 'dimension' && unchangedSource) return 'textOnly'
  if (unchangedSource) return 'none'
  return 'full'
}

/** 同一颜色和线宽的批量路径 */
interface PathBatch {
  color: string
  lineWidth: number
  minimumScreenWidth: number
  lineType: LineType
  lineDash: number[] | null
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  path: Path2D
}

/** 框选语义：窗口选择要求完整包含，交叉选择只要求与窗口相交。 @author snihao */
export type SelectionMode = 'window' | 'crossing'

export class Renderer {
  /** 主画布 */
  canvas: HTMLCanvasElement
  /** 主画布上下文 */
  gctx: CanvasRenderingContext2D
  /** 当前缩放比例 */
  currentScale = 1
  /** 离屏实体层缓存 */
  layer: HTMLCanvasElement
  /** 离屏实体层上下文 */
  private layerG: CanvasRenderingContext2D
  /** 实体内容版本号，markDirty 时自增 */
  private layerVersion = 0
  /** 上次渲染实体层时的签名（版本+视口+尺寸） */
  private layerKey = ''
  /** 缓存几何对应的实体版本 */
  private recordsVersion = -1
  /** 扁平化叶子图元及其 Path2D/包围盒缓存 */
  private records: RenderRecord[] = []
  private recordLookup = new Map<string, RenderRecord>()
  /** 渲染侧实体 ID 索引，避免多选每帧递归查找 */
  private entityLookup = new Map<string, Entity>()
  /** 空间网格：只保存覆盖单元数量可控的图元 */
  private spatialGrid = new Map<string, number[]>()
  /** 跨越大量网格单元的图元，查询时始终作为候选 */
  private globalRecordIndices: number[] = []
  /** 空间网格单元尺寸 */
  private gridCellSize = 1
  /** 当前渲染图纸，用于解析图层继承样式。 */
  private currentDrawing: Drawing | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.gctx = canvas.getContext('2d')!
    this.layer = document.createElement('canvas')
    this.layerG = this.layer.getContext('2d')!
  }

  /** 实体发生变化时调用，使离屏缓存失效 */
  markDirty(): void {
    this.layerVersion++
  }

  /** 主渲染：网格 + 实体层(blit) + 选中 halo/手柄 */
  render(state: EditorState, viewport: Viewport, referenceActive = false): void {
    if (this.currentDrawing !== state.drawing) this.markDirty()
    this.currentDrawing = state.drawing
    this.currentScale = viewport.scale
    const g = this.gctx
    const dpr = viewport.dpr
    const cssW = this.canvas.clientWidth || 800
    const cssH = this.canvas.clientHeight || 600

    // 1. 清空主画布 + 低对比工作区底色
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, cssW, cssH)
    if (!referenceActive) {
      g.fillStyle = state.canvasBackground || '#F8FAF9'
      g.fillRect(0, 0, cssW, cssH)
    }

    // 2. 网格
    if (state.showCanvasGuides) this.drawGrid(g, viewport, state.canvasBackground)

    // 3. 实体层：仅在图元变化或视口/尺寸变化时重渲染，否则 blit
    const selectionKey = state.selectedIds.join(',')
    const key = this.layerVersion + '|' + selectionKey + '|' + referenceActive + '|' + viewport.scale + '|' + viewport.offsetX + '|'
      + viewport.offsetY + '|' + dpr + '|' + cssW + '|' + cssH
    if (key !== this.layerKey) {
      this._renderEntityLayer(state, viewport, cssW, cssH, dpr, referenceActive)
      this.layerKey = key
    }
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.drawImage(this.layer, 0, 0)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    // 4. 选中 halo + 手柄
    const selectedEntities = state.selectedIds
      .map((id) => this.entityLookup.get(id) || null)
      .filter((entity): entity is Entity => !!entity)
    if (selectedEntities.length) {
      for (const ent of selectedEntities) {
        if (isLayerFrozen(state.drawing, ent.layer)) continue
        g.save()
        viewport.apply(g)
        if (this.canDrawCanvasEntity(ent, referenceActive)) {
          this.drawEntity(g, ent)
          if (this.hasStroke(ent)) this.drawHalo(g, ent)
        }
        if (state.activeTool === 'select' && selectedEntities.length === 1) this.drawHandles(g, ent, viewport)
        g.restore()
      }
      if (selectedEntities.length > 1) this.drawMultiSelectionBounds(g, selectedEntities, viewport)
    }
  }

  /** 把所有实体渲染到离屏缓存（带视口剔除） */
  private _renderEntityLayer(state: EditorState, viewport: Viewport, cssW: number, cssH: number, dpr: number, referenceActive: boolean): void {
    const cw = Math.round(cssW * dpr)
    const ch = Math.round(cssH * dpr)
    if (this.layer.width !== cw) this.layer.width = cw
    if (this.layer.height !== ch) this.layer.height = ch
    const g = this.layerG
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, cw, ch)
    this.ensureRenderRecords(state)
    const [wx0, wy0] = viewport.toWorld(0, 0)
    const [wx1, wy1] = viewport.toWorld(cssW, cssH)
    const vminX = Math.min(wx0, wx1), vmaxX = Math.max(wx0, wx1)
    const vminY = Math.min(wy0, wy1), vmaxY = Math.max(wy0, wy1)

    const visible = this.queryVisibleRecords(vminX, vminY, vmaxX, vmaxY)
    const batches = new Map<string, PathBatch>()
    const textRecords: RenderRecord[] = []
    const referenceDimensionTextRecords: RenderRecord[] = []
    const dimensionRecords: RenderRecord[] = []
    const selectedIds = new Set(state.selectedIds)

    for (const record of visible) {
      if (isLayerFrozen(state.drawing, record.entity.layer)) continue
      const referenceMode = referenceActive
        ? referenceCanvasRenderMode(record.entity, record.sourceOnly)
        : 'full'
      if (referenceMode === 'none') continue
      if (selectedIds.has(record.entity.id) || record.ancestorIds.some((id) => selectedIds.has(id))) continue
      if (referenceMode === 'textOnly') {
        referenceDimensionTextRecords.push(record)
        continue
      }
      if (!record.path) {
        textRecords.push(record)
        continue
      }
      if (record.entity.type === 'dimension') {
        dimensionRecords.push(record)
        textRecords.push(record)
        continue
      }
      const style = resolveEntityStyle(record.entity, state.drawing)
      const color = style.color || DEFAULT_COLOR
      const lineWidth = style.lineWidth || DEFAULT_WIDTH
      const minimumScreenWidth = minimumStrokePixels(record.entity, state.drawing.unit)
      const lineType = style.lineType || 'solid'
      const lineDash = style.lineDash || null
      const lineCap = record.entity.lineCap || 'round'
      const lineJoin = record.entity.lineJoin || 'round'
      const key = `${color}|${lineWidth}|${minimumScreenWidth}|${lineType}|${lineDash?.join(',') || ''}|${lineCap}|${lineJoin}`
      let batch = batches.get(key)
      if (!batch) {
        batch = { color, lineWidth, minimumScreenWidth, lineType, lineDash, lineCap, lineJoin, path: new Path2D() }
        batches.set(key, batch)
      }
      batch.path.addPath(record.path)
      if (record.entity.type === 'annotation') textRecords.push(record)
    }

    g.setTransform(dpr * viewport.scale, 0, 0, dpr * viewport.scale,
      dpr * viewport.offsetX, dpr * viewport.offsetY)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const batch of batches.values()) {
      g.strokeStyle = batch.color
      g.lineWidth = canvasLineWidth(batch.lineWidth, viewport.scale, batch.minimumScreenWidth)
      g.lineCap = batch.lineCap
      g.lineJoin = batch.lineJoin
      g.setLineDash(batch.lineDash || this.lineDash(batch.lineType, batch.lineWidth))
      g.stroke(batch.path)
    }
    g.setLineDash([])
    for (const record of dimensionRecords) {
      if (isLayerFrozen(state.drawing, record.entity.layer)) continue
      this.strokeDimensionSegments(g, record.entity, state.drawing)
    }
    for (const record of referenceDimensionTextRecords) {
      this.drawDimensionText(g, record.entity, state.drawing)
    }
    for (const record of textRecords) {
      const entity = record.entity
      const style = resolveEntityStyle(entity, state.drawing)
      const dimensionStyle = entity.type === 'dimension' ? resolveDimensionStyle(entity, state.drawing) : null
      const color = dimensionStyle?.textColor || style.color || entity.color || DEFAULT_COLOR
      if (entity.type === 'text') {
        this.drawText(g, entity.position!, entity.content, entity.fontSize, entity.rotation, color, entity.textAlign, entity.textBaseline, entity.textWidthFactor)
      } else if (entity.type === 'annotation' || entity.type === 'dimension') {
        if (isDimensionEntity(entity)) this.drawDimensionArrows(g, entity, dimensionStyle?.dimensionLineColor || color, dimensionStyle)
        this.drawDimensionText(g, entity, state.drawing)
      }
    }
  }

  /** 当数据版本变化时，一次性重建包围盒、Path2D 和空间索引 */
  private ensureRenderRecords(state: EditorState): void {
    if (this.recordsVersion === this.layerVersion) return
    const records: RenderRecord[] = []
    this.entityLookup.clear()
    this.recordLookup.clear()
    for (const entity of state.drawing.entities) this.flattenEntity(entity, [], records, false, state.drawing)
    this.records = records
    this.buildSpatialGrid(records)
    this.recordsVersion = this.layerVersion
  }

  /**
   * 把业务 group 展开为叶子渲染记录，组合关系仍用于选择和编辑。
   * @param entity 当前实体。
   * @param ancestorIds 祖先组合 ID。
   * @param records 输出渲染记录。
   * @param sourceOnly 是否仅由 DXF 保真层显示。
   * @param drawing 当前图纸。
   * @returns 无返回值；记录写入 records。
   * @author snihao
   */
  private flattenEntity(
    entity: Entity,
    ancestorIds: string[],
    records: RenderRecord[],
    sourceOnly: boolean,
    drawing: Drawing,
  ): void {
    this.entityLookup.set(entity.id, entity)
    if (entity.type === 'group') {
      const nextAncestors = [...ancestorIds, entity.id]
      const childSourceOnly = sourceOnly
        || (!!entity.sourceHandle && !entity.sourceEdited && entity.sourceCanvasStyle !== true)
      for (const child of entity.children || []) this.flattenEntity(child, nextAncestors, records, childSourceOnly, drawing)
      return
    }
    const record: RenderRecord = {
      entity,
      bounds: entityBounds(entity, drawing),
      path: this.createEntityPath(entity),
      ancestorIds,
      sourceOnly,
      order: records.length,
    }
    records.push(record)
    this.recordLookup.set(entity.id, record)
  }

  /**
   * 判断渲染记录是否需要由 Canvas 绘制；导入文字使用系统 CJK 字体以保证字符完整。
   * @param record 待判断的渲染记录。
   * @returns 是否需要由 Canvas 绘制。
   * @author snihao
   */
  private canDrawCanvasRecord(record: RenderRecord): boolean {
    return referenceCanvasRenderMode(record.entity, record.sourceOnly) !== 'none'
  }

  private canDrawCanvasEntity(entity: Entity, referenceActive: boolean): boolean {
    if (!referenceActive) return true
    if (entity.type === 'group') {
      return !entity.sourceHandle || entity.sourceEdited === true || entity.sourceCanvasStyle === true
    }
    const record = this.recordLookup.get(entity.id)
    return record
      ? this.canDrawCanvasRecord(record)
      : (!entity.sourceHandle || entity.sourceEdited === true || entity.sourceCanvasStyle === true)
  }

  /**
   * 仅绘制标注文字，供完整 Canvas 标注和 DXF 保真标注共同复用。
   * @param g 画布上下文。
   * @param entity 标注实体。
   * @param drawing 当前图纸。
   * @returns 无返回值。
   * @author snihao
   */
  private drawDimensionText(g: CanvasRenderingContext2D, entity: Entity, drawing: Drawing): void {
    const entityStyle = resolveEntityStyle(entity, drawing)
    const dimensionStyle = entity.type === 'dimension' ? resolveDimensionStyle(entity, drawing) : null
    const color = dimensionStyle?.textColor || entityStyle.color || entity.color || DEFAULT_COLOR
    const layout = annotationTextLayout(entity, drawing)
    this.drawText(
      g,
      layout.position,
      layout.text,
      layout.fontSize,
      layout.rotation,
      color,
      layout.textAlign,
      layout.textBaseline,
      layout.textWidthFactor,
    )
  }

  /** 预编译无需每帧重复遍历顶点的 Path2D */
  private createEntityPath(entity: Entity): Path2D | null {
    if (entity.type === 'text') return null
    const path = new Path2D()
    if (entity.type === 'line') {
      path.moveTo(entity.start![0], entity.start![1])
      path.lineTo(entity.end![0], entity.end![1])
    } else if (entity.type === 'polyline') {
      const points = entity.points || []
      if (!points.length) return null
      path.moveTo(points[0][0], points[0][1])
      for (let i = 1; i < points.length; i++) path.lineTo(points[i][0], points[i][1])
      if (entity.closed) path.closePath()
    } else if (entity.type === 'circle') {
      path.arc(entity.center![0], entity.center![1], entity.radius!, 0, Math.PI * 2)
    } else if (entity.type === 'annotation' || entity.type === 'dimension') {
      const leader = entity.leader || []
      const segments = dimensionSegments(entity, this.dimensionSegmentOptions(entity))
      if (segments.length) {
        for (const [start, end] of segments) {
          path.moveTo(start[0], start[1])
          path.lineTo(end[0], end[1])
        }
      } else {
        if (!leader.length) return null
        path.moveTo(leader[0][0], leader[0][1])
        for (let i = 1; i < leader.length; i++) path.lineTo(leader[i][0], leader[i][1])
      }
    } else {
      return null
    }
    return path
  }

  /** 建立均匀空间网格，避免每次点击和视口变化扫描全部记录 */
  private buildSpatialGrid(records: RenderRecord[]): void {
    this.spatialGrid.clear()
    this.globalRecordIndices = []
    if (!records.length) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const record of records) {
      minX = Math.min(minX, record.bounds.minX)
      minY = Math.min(minY, record.bounds.minY)
      maxX = Math.max(maxX, record.bounds.maxX)
      maxY = Math.max(maxY, record.bounds.maxY)
    }
    const span = Math.max(maxX - minX, maxY - minY, 1)
    this.gridCellSize = Math.max(span / Math.max(8, Math.ceil(Math.sqrt(records.length))), 1e-6)
    for (let index = 0; index < records.length; index++) {
      const bounds = records[index].bounds
      const x0 = Math.floor(bounds.minX / this.gridCellSize)
      const x1 = Math.floor(bounds.maxX / this.gridCellSize)
      const y0 = Math.floor(bounds.minY / this.gridCellSize)
      const y1 = Math.floor(bounds.maxY / this.gridCellSize)
      const cellCount = (x1 - x0 + 1) * (y1 - y0 + 1)
      if (cellCount > 128) {
        this.globalRecordIndices.push(index)
        continue
      }
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${x},${y}`
          const bucket = this.spatialGrid.get(key)
          if (bucket) bucket.push(index)
          else this.spatialGrid.set(key, [index])
        }
      }
    }
  }

  /** 查询与世界坐标矩形相交的叶子图元 */
  private queryVisibleRecords(minX: number, minY: number, maxX: number, maxY: number): RenderRecord[] {
    if (!this.records.length) return []
    const x0 = Math.floor(minX / this.gridCellSize)
    const x1 = Math.floor(maxX / this.gridCellSize)
    const y0 = Math.floor(minY / this.gridCellSize)
    const y1 = Math.floor(maxY / this.gridCellSize)
    const queryCellCount = (x1 - x0 + 1) * (y1 - y0 + 1)
    const candidates = new Set<number>(this.globalRecordIndices)
    if (queryCellCount > 4096) {
      for (let i = 0; i < this.records.length; i++) candidates.add(i)
    } else {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (const index of this.spatialGrid.get(`${x},${y}`) || []) candidates.add(index)
        }
      }
    }
    const result: RenderRecord[] = []
    for (const index of candidates) {
      const record = this.records[index]
      const bounds = record.bounds
      if (bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < minY || bounds.minY > maxY) continue
      result.push(record)
    }
    return result
  }

  /** 判断实体是否有描边（用于 halo 高亮） */
  hasStroke(e: Entity): boolean {
    if (e.type === 'group') return true
    return e.type === 'line' || e.type === 'polyline' || e.type === 'circle' || e.type === 'annotation' || e.type === 'dimension'
  }

  /** 绘制网格 */
  private drawGrid(g: CanvasRenderingContext2D, viewport: Viewport, background: string): void {
    const W = this.canvas.clientWidth
    const H = this.canvas.clientHeight
    const targetWorld = 22 / viewport.scale
    const step = niceStep(targetWorld)
    const majorStep = step * 5
    const [wx0, wy0] = viewport.toWorld(0, 0)
    const [wx1, wy1] = viewport.toWorld(W, H)
    const startX = Math.floor(wx0 / step) * step
    const startY = Math.floor(wy0 / step) * step
    const darkBackground = this.isDarkColor(background)
    g.strokeStyle = darkBackground ? 'rgba(255,255,255,0.10)' : 'rgba(42,68,65,0.09)'
    g.lineWidth = 0.75
    g.beginPath()
    for (let x = startX; x <= wx1; x += step) {
      const [sx] = viewport.toScreen(x, 0)
      g.moveTo(sx, 0)
      g.lineTo(sx, H)
    }
    for (let y = startY; y <= wy1; y += step) {
      const [, sy] = viewport.toScreen(0, y)
      g.moveTo(0, sy)
      g.lineTo(W, sy)
    }
    g.stroke()

    const majorStartX = Math.floor(wx0 / majorStep) * majorStep
    const majorStartY = Math.floor(wy0 / majorStep) * majorStep
    g.strokeStyle = darkBackground ? 'rgba(255,255,255,0.18)' : 'rgba(42,68,65,0.16)'
    g.lineWidth = 1
    g.beginPath()
    for (let x = majorStartX; x <= wx1; x += majorStep) {
      const [sx] = viewport.toScreen(x, 0)
      g.moveTo(sx, 0)
      g.lineTo(sx, H)
    }
    for (let y = majorStartY; y <= wy1; y += majorStep) {
      const [, sy] = viewport.toScreen(0, y)
      g.moveTo(0, sy)
      g.lineTo(W, sy)
    }
    g.stroke()

    // 原点轴仅在可见范围内绘制，帮助识别 SVG 坐标方向。
    const [originX, originY] = viewport.toScreen(0, 0)
    g.strokeStyle = darkBackground ? 'rgba(255,255,255,0.30)' : 'rgba(42,68,65,0.28)'
    g.lineWidth = 1.2
    g.beginPath()
    if (originX >= 0 && originX <= W) {
      g.moveTo(originX, 0)
      g.lineTo(originX, H)
    }
    if (originY >= 0 && originY <= H) {
      g.moveTo(0, originY)
      g.lineTo(W, originY)
    }
    g.stroke()
  }

  private isDarkColor(color: string): boolean {
    const hex = color.replace('#', '')
    if (!/^[0-9a-f]{6}$/i.test(hex)) return false
    const r = Number.parseInt(hex.slice(0, 2), 16)
    const green = Number.parseInt(hex.slice(2, 4), 16)
    const b = Number.parseInt(hex.slice(4, 6), 16)
    return (r * 0.299 + green * 0.587 + b * 0.114) < 145
  }

  /** 选中高亮：使用固定屏幕宽度，避免覆盖 CAD 实际线宽。 */
  private drawHalo(g: CanvasRenderingContext2D, e: Entity): void {
    if (e.type === 'group') {
      // 组合高亮：所有子图元描 halo + 整体边框
      for (const child of e.children || []) {
        if (this.hasStroke(child) && (!this.currentDrawing || !isLayerFrozen(this.currentDrawing, child.layer))) this.drawHalo(g, child)
      }
      // 整体边框
      const b = this._groupBounds(e)
      if (b) {
        g.save()
        g.strokeStyle = HALO_COLOR
        g.globalAlpha = 0.7
        g.lineWidth = 1.5 / this.currentScale
        g.setLineDash([6 / this.currentScale, 3 / this.currentScale])
        g.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY)
        g.restore()
      }
      return
    }
    g.save()
    g.strokeStyle = HALO_COLOR
    g.globalAlpha = 0.45
    g.lineWidth = canvasLineWidth(2.5, this.currentScale, MIN_SCREEN_PX)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    this.strokePath(g, e)
    g.restore()
  }

  /** 计算组合包围盒（world 坐标） */
  private _groupBounds(e: Entity): Bounds | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const child of e.children || []) {
      const b = this._entityBounds(child)
      if (!b) continue
      if (b.minX < minX) minX = b.minX
      if (b.minY < minY) minY = b.minY
      if (b.maxX > maxX) maxX = b.maxX
      if (b.maxY > maxY) maxY = b.maxY
    }
    if (!Number.isFinite(minX)) return null
    return { minX, minY, maxX, maxY }
  }

  /** 单实体包围盒（world 坐标） */
  private _entityBounds(e: Entity): Bounds | null {
    if (e.type === 'line') {
      return {
        minX: Math.min(e.start![0], e.end![0]),
        minY: Math.min(e.start![1], e.end![1]),
        maxX: Math.max(e.start![0], e.end![0]),
        maxY: Math.max(e.start![1], e.end![1]),
      }
    }
    if (e.type === 'polyline') {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of e.points!) {
        if (p[0] < minX) minX = p[0]
        if (p[1] < minY) minY = p[1]
        if (p[0] > maxX) maxX = p[0]
        if (p[1] > maxY) maxY = p[1]
      }
      return { minX, minY, maxX, maxY }
    }
    if (e.type === 'circle') {
      return {
        minX: e.center![0] - e.radius!,
        minY: e.center![1] - e.radius!,
        maxX: e.center![0] + e.radius!,
        maxY: e.center![1] + e.radius!,
      }
    }
    return null
  }

  /** 描边路径 */
  private strokePath(g: CanvasRenderingContext2D, e: Entity): void {
    g.beginPath()
    if (e.type === 'line') {
      g.moveTo(e.start![0], e.start![1])
      g.lineTo(e.end![0], e.end![1])
    } else if (e.type === 'polyline') {
      const pts = e.points!
      g.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
      if (e.closed) g.closePath()
    } else if (e.type === 'circle') {
      g.arc(e.center![0], e.center![1], e.radius!, 0, Math.PI * 2)
    } else if (e.type === 'annotation' || e.type === 'dimension') {
      const ld = e.leader || []
      const segments = dimensionSegments(e, this.dimensionSegmentOptions(e))
      if (segments.length) {
        for (const [start, end] of segments) {
          g.moveTo(start[0], start[1])
          g.lineTo(end[0], end[1])
        }
      } else {
        if (!ld.length) return
        g.moveTo(ld[0][0], ld[0][1])
        for (let i = 1; i < ld.length; i++) g.lineTo(ld[i][0], ld[i][1])
      }
    }
    g.stroke()
  }

  /** 绘制单个实体 */
  drawEntity(g: CanvasRenderingContext2D, e: Entity): void {
    // 组合：递归绘制子图元（保留各自颜色/线宽）
    if (e.type === 'group') {
      for (const child of e.children || []) {
        if (!this.currentDrawing || !isLayerFrozen(this.currentDrawing, child.layer)) this.drawEntity(g, child)
      }
      return
    }
    const style = this.currentDrawing ? resolveEntityStyle(e, this.currentDrawing) : null
    const dimensionStyle = e.type === 'dimension' && this.currentDrawing ? resolveDimensionStyle(e, this.currentDrawing) : null
    const color = dimensionStyle?.dimensionLineColor || style?.color || e.color || DEFAULT_COLOR
    const lw = style?.lineWidth || e.lineWidth || DEFAULT_WIDTH
    g.strokeStyle = color
    g.fillStyle = color
    g.lineWidth = canvasLineWidth(lw, this.currentScale,
      minimumStrokePixels(e, this.currentDrawing?.unit || 'mm'))
    g.lineCap = e.lineCap || 'round'
    g.lineJoin = e.lineJoin || 'round'
    g.setLineDash(style?.lineDash || e.lineDash || this.lineDash(style?.lineType || e.lineType || 'solid', lw))

    if (e.type === 'line' || e.type === 'polyline' || e.type === 'circle') {
      this.strokePath(g, e)
    } else if (e.type === 'text') {
      this.drawText(g, e.position!, e.content, e.fontSize, e.rotation, color, e.textAlign, e.textBaseline, e.textWidthFactor)
    } else if (e.type === 'annotation' || e.type === 'dimension') {
      if (isDimensionEntity(e) && dimensionStyle && this.currentDrawing) this.strokeDimensionSegments(g, e, this.currentDrawing)
      else this.strokePath(g, e)
      if (isDimensionEntity(e)) this.drawDimensionArrows(g, e, dimensionStyle?.dimensionLineColor || color, dimensionStyle)
      if (this.currentDrawing) this.drawDimensionText(g, e, this.currentDrawing)
    }
    g.setLineDash([])
  }

  private lineDash(lineType: LineType, lineWidth: number): number[] {
    const unit = Math.max(1, lineWidth)
    if (lineType === 'dashed') return [6 * unit, 3 * unit]
    if (lineType === 'dashdot') return [7 * unit, 2.5 * unit, 1.2 * unit, 2.5 * unit]
    return []
  }

  /** 按 DIMSTYLE 分别描绘尺寸线和尺寸界线。
   * @param g 画布上下文。
   * @param entity 原生标注实体。
   * @param drawing 当前图纸。
   * @author snihao
   */
  private strokeDimensionSegments(g: CanvasRenderingContext2D, entity: Entity, drawing: Drawing): void {
    const style = resolveDimensionStyle(entity, drawing)
    const segments = dimensionSegments(entity, this.dimensionSegmentOptions(entity))
    if (!segments.length) return
    const hasExtensions = entity.dimensionType === 'linear' || entity.dimensionType === 'aligned' || entity.dimensionType === 'angular' || entity.dimensionType === 'arcLength'
    const extensionCount = hasExtensions
      ? (style.suppressFirstExtension ? 0 : 1) + (style.suppressSecondExtension ? 0 : 1)
      : 0
    const extensionPath = new Path2D()
    const dimensionPath = new Path2D()
    segments.forEach(([start, end], index) => {
      const path = index < extensionCount ? extensionPath : dimensionPath
      path.moveTo(start[0], start[1])
      path.lineTo(end[0], end[1])
    })
    const entityStyle = resolveEntityStyle(entity, drawing)
    const lineWidth = canvasLineWidth(entityStyle.lineWidth || DEFAULT_WIDTH, this.currentScale, MIN_SCREEN_PX)
    g.save()
    g.lineWidth = lineWidth
    g.lineCap = entity.lineCap || 'round'
    g.lineJoin = entity.lineJoin || 'round'
    g.setLineDash(entityStyle.lineDash || this.lineDash(entityStyle.lineType || 'solid', lineWidth))
    if (extensionCount && style.extensionLineColor && extensionPath) {
      g.strokeStyle = style.extensionLineColor
      g.stroke(extensionPath)
    } else if (extensionCount) {
      g.strokeStyle = style.dimensionLineColor || entityStyle.color || DEFAULT_COLOR
      g.stroke(extensionPath)
    }
    if (segments.length > extensionCount) {
      g.strokeStyle = style.dimensionLineColor || entityStyle.color || DEFAULT_COLOR
      g.stroke(dimensionPath)
    }
    g.restore()
  }

  /** 绘制文字 */
  private drawText(
    g: CanvasRenderingContext2D,
    pos: Point,
    content: string | null | undefined,
    fontSize: number | null | undefined,
    rotation: number | null | undefined,
    color: string,
    textAlign?: 'left' | 'center' | 'right' | null,
    textBaseline?: 'alphabetic' | 'top' | 'middle' | 'bottom' | null,
    textWidthFactor?: number | null,
  ): void {
    if (!content) return
    const fs = fontSize || 14
    g.save()
    g.translate(pos[0], pos[1])
    if (rotation) g.rotate((rotation * Math.PI) / 180)
    if (textWidthFactor != null && Number.isFinite(textWidthFactor) && textWidthFactor > 0 && Math.abs(textWidthFactor - 1) > 1e-6) {
      g.scale(textWidthFactor, 1)
    }
    g.fillStyle = color
    g.font = `${fs}px Geist, "PingFang SC", "Microsoft YaHei", sans-serif`
    g.textAlign = textAlign || 'left'
    g.textBaseline = textBaseline || 'alphabetic'
    const lineHeight = fs * 1.25
    const lines = content.split('\n')
    const startY = textBaseline === 'middle'
      ? -(lines.length - 1) * lineHeight / 2
      : textBaseline === 'bottom'
      ? -(lines.length - 1) * lineHeight
      : 0
    lines.forEach((line, index) => g.fillText(line, 0, startY + index * lineHeight))
    g.restore()
  }

  /** 返回实体的所有手柄点 */
  getHandles(e: Entity): HandleInfo[] {
    if (e.type === 'line') {
      return this.addTransformHandles(e, [
        { x: e.start![0], y: e.start![1], index: 0, role: 'start' },
        { x: e.end![0], y: e.end![1], index: 1, role: 'end' },
      ])
    }
    if (e.type === 'polyline') {
      const points = e.points || []
      const handles: HandleInfo[] = isRectanglePolyline(e)
        ? points.map((point, index) => ({ x: point[0], y: point[1], index, role: 'resize' as const }))
        : this.sampleVertexIndices(points.length, 4, !!e.closed)
          .map((index) => ({ x: points[index][0], y: points[index][1], index, role: 'vertex' as const }))
      return this.addTransformHandles(e, handles)
    }
    if (e.type === 'circle') {
      return [
        { x: e.center![0], y: e.center![1], index: 0, role: 'move' as const },
        { x: e.center![0] + e.radius!, y: e.center![1], index: 1, role: 'radius' as const },
        { x: e.center![0], y: e.center![1] + e.radius!, index: 2, role: 'radius' as const },
        { x: e.center![0] - e.radius!, y: e.center![1], index: 3, role: 'radius' as const },
        { x: e.center![0], y: e.center![1] - e.radius!, index: 4, role: 'radius' as const },
      ]
    }
    if (e.type === 'text') {
      return this.addTransformHandles(e, [])
    }
    if (e.type === 'annotation' || e.type === 'dimension') {
      const leader = e.leader || []
      const dimension = dimensionPoints(e)
      if (e.type === 'dimension') {
        const handles: HandleInfo[] = []
        const circularDimension = e.dimensionType === 'radius' || e.dimensionType === 'diameter'
        if (e.dimensionType === 'radius') {
          if (e.dimensionStart) handles.push({ x: e.dimensionStart[0], y: e.dimensionStart[1], index: 1, role: 'leader' })
        } else if (e.dimensionType === 'diameter') {
          if (e.dimensionStart) handles.push({ x: e.dimensionStart[0], y: e.dimensionStart[1], index: 0, role: 'leader' })
          if (e.dimensionEnd) handles.push({ x: e.dimensionEnd[0], y: e.dimensionEnd[1], index: 1, role: 'leader' })
        } else if (e.dimensionType === 'ordinate') {
          if (e.dimensionStart) handles.push({ x: e.dimensionStart[0], y: e.dimensionStart[1], index: 0, role: 'leader' })
          if (e.dimensionOffset) handles.push({ x: e.dimensionOffset[0], y: e.dimensionOffset[1], index: 1, role: 'leader' })
          if (e.dimensionOrigin) handles.push({ x: e.dimensionOrigin[0], y: e.dimensionOrigin[1], index: 2, role: 'leader' })
        } else if (e.dimensionType === 'angular' || e.dimensionType === 'arcLength') {
          if (e.dimensionStart) handles.push({ x: e.dimensionStart[0], y: e.dimensionStart[1], index: 0, role: 'leader' })
          if (e.dimensionEnd) handles.push({ x: e.dimensionEnd[0], y: e.dimensionEnd[1], index: 1, role: 'leader' })
          if (e.dimensionCenter) handles.push({ x: e.dimensionCenter[0], y: e.dimensionCenter[1], index: 2, role: 'leader' })
          if (e.dimensionLinePosition) handles.push({ x: e.dimensionLinePosition[0], y: e.dimensionLinePosition[1], index: 3, role: 'leader' })
        } else if (dimension) {
          handles.push(...dimension.map((point, index) => ({ x: point[0], y: point[1], index, role: 'leader' as const })))
        }
        const textPosition = annotationTextLayout(e, this.currentDrawing || undefined).position
        handles.push({ x: textPosition[0], y: textPosition[1], index: 4, role: 'position' })
        return circularDimension ? handles : this.addTransformHandles(e, handles)
      }
      const indices = dimension
        ? dimension.map((_, index) => index)
        : this.sampleVertexIndices(leader.length, 3, false)
      const hs: HandleInfo[] = indices
        .map((index) => {
          const point = dimension ? dimension[index] : leader[index]
          return { x: point[0], y: point[1], index, role: 'leader' as const }
        })
      const textPosition = annotationTextLayout(e, this.currentDrawing || undefined).position
      hs.push({ x: textPosition[0], y: textPosition[1], index: dimension ? 4 : leader.length, role: 'position' })
      return this.addTransformHandles(e, hs)
    }
    if (e.type === 'group') {
      // 组合使用四角缩放、中心移动和顶部旋转柄。
      const b = this._groupBounds(e)
      if (!b) return []
      return this.addTransformHandles(e, [
        { x: b.minX, y: b.minY, index: 0, role: 'resize' },
        { x: b.maxX, y: b.minY, index: 1, role: 'resize' },
        { x: b.maxX, y: b.maxY, index: 2, role: 'resize' },
        { x: b.minX, y: b.maxY, index: 3, role: 'resize' },
      ])
    }
    return []
  }

  /** 为非圆形图元补充中心位移点和外置旋转柄 */
  private addTransformHandles(e: Entity, handles: HandleInfo[]): HandleInfo[] {
    const bounds = entityBounds(e, this.currentDrawing || undefined)
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerY = (bounds.minY + bounds.maxY) / 2
    handles.push({ x: centerX, y: centerY, index: -1, role: 'move' })
    handles.push({
      x: centerX,
      y: bounds.minY - ROTATE_OFFSET_PX / Math.max(this.currentScale, 1e-6),
      index: -1,
      role: 'rotate',
    })
    return handles
  }

  /** 计算尺寸界线：测量点处留白，并穿过尺寸线后继续延伸。 */
  private extensionLine(measurePoint: Point, dimensionPoint: Point): [Point, Point] {
    const dx = dimensionPoint[0] - measurePoint[0]
    const dy = dimensionPoint[1] - measurePoint[1]
    const length = Math.max(Math.hypot(dx, dy), 1e-6)
    const ux = dx / length
    const uy = dy / length
    return [
      [measurePoint[0] + ux * DIMENSION_EXTENSION_GAP, measurePoint[1] + uy * DIMENSION_EXTENSION_GAP],
      [dimensionPoint[0] + ux * DIMENSION_EXTENSION_OVERHANG, dimensionPoint[1] + uy * DIMENSION_EXTENSION_OVERHANG],
    ]
  }

  /** 在线性标注尺寸线两端绘制向内的实心长三角箭头。 */
  private drawDimensionArrows(g: CanvasRenderingContext2D, entity: Entity, color: string, style?: EffectiveDimensionStyle | null): void {
    const points = dimensionPoints(entity)
    if (!points) return
    const lineWidth = Math.max(1e-6, entity.lineWidth || DEFAULT_WIDTH)
    const fontSize = Math.max(1e-6, style?.textHeight || entity.fontSize || 2.5)
    const fallbackArrowLength = Math.max(fontSize * 0.8, lineWidth * 2)
    const preferredArrowLength = Math.max(1e-6, style?.arrowSize || fallbackArrowLength)
    const drawArrow = (tip: Point, direction: Point): void => {
      const length = Math.max(Math.hypot(direction[0], direction[1]), 1e-6)
      const ux = direction[0] / length
      const uy = direction[1] / length
      const nx = -uy
      const ny = ux
      const arrowLength = Math.max(1e-6, Math.min(preferredArrowLength, length * 0.24))
      const arrowHalfWidth = arrowLength * 0.3
      g.moveTo(tip[0], tip[1])
      g.lineTo(tip[0] + ux * arrowLength + nx * arrowHalfWidth, tip[1] + uy * arrowLength + ny * arrowHalfWidth)
      g.lineTo(tip[0] + ux * arrowLength - nx * arrowHalfWidth, tip[1] + uy * arrowLength - ny * arrowHalfWidth)
      g.closePath()
    }
    g.save()
    g.fillStyle = color
    g.beginPath()
    if (entity.dimensionType === 'radius') {
      drawArrow(points[1], [points[0][0] - points[1][0], points[0][1] - points[1][1]])
    } else if (entity.dimensionType === 'ordinate') {
      drawArrow(points[1], [points[0][0] - points[1][0], points[0][1] - points[1][1]])
    } else if (entity.dimensionType === 'angular' || entity.dimensionType === 'arcLength') {
      const arrows = arcDimensionArrowGeometry(entity)
      if (arrows) {
        drawArrow(arrows[0].tip, arrows[0].direction)
        drawArrow(arrows[1].tip, arrows[1].direction)
      }
    } else if (entity.dimensionType === 'diameter') {
      drawArrow(points[0], [points[1][0] - points[0][0], points[1][1] - points[0][1]])
      drawArrow(points[1], [points[0][0] - points[1][0], points[0][1] - points[1][1]])
    } else {
      const start = points[2]
      const end = points[3]
      drawArrow(start, [end[0] - start[0], end[1] - start[1]])
      drawArrow(end, [start[0] - end[0], start[1] - end[1]])
    }
    g.fill()
    g.restore()
  }

  /** 返回实体当前使用的尺寸线段样式参数。
   * @param entity 原生标注实体。
   * @returns 尺寸线段过滤参数。
   * @author snihao
   */
  private dimensionSegmentOptions(entity: Entity): DimensionSegmentOptions | undefined {
    if (entity.type !== 'dimension' || !this.currentDrawing) return undefined
    const style = resolveDimensionStyle(entity, this.currentDrawing)
    return {
      extensionOffset: style.extensionOffset,
      extensionBeyond: style.extensionBeyond,
      suppressFirstExtension: style.suppressFirstExtension,
      suppressSecondExtension: style.suppressSecondExtension,
      suppressDimensionLine: style.suppressDimensionLine,
    }
  }

  /** 从复杂折线中均匀抽取最多 maxCount 个可编辑顶点 */
  private sampleVertexIndices(length: number, maxCount: number, closed: boolean): number[] {
    if (length <= maxCount) return Array.from({ length }, (_, index) => index)
    const result = new Set<number>()
    if (closed) {
      for (let i = 0; i < maxCount; i++) result.add(Math.floor((i * length) / maxCount))
    } else {
      for (let i = 0; i < maxCount; i++) result.add(Math.round((i * (length - 1)) / (maxCount - 1)))
    }
    return Array.from(result)
  }

  /** 绘制手柄 */
  private drawHandles(g: CanvasRenderingContext2D, e: Entity, viewport: Viewport): void {
    const s = viewport.scale
    const half = HANDLE_SIZE / s
    g.save()
    const handles = this.getHandles(e)
    const rotateHandle = handles.find((handle) => handle.role === 'rotate')
    if (rotateHandle) {
      const bounds = entityBounds(e, this.currentDrawing || undefined)
      g.beginPath()
      g.moveTo((bounds.minX + bounds.maxX) / 2, bounds.minY)
      g.lineTo(rotateHandle.x, rotateHandle.y)
      g.strokeStyle = '#73817f'
      g.lineWidth = 1 / s
      g.setLineDash([3 / s, 3 / s])
      g.stroke()
      g.setLineDash([])
    }
    for (const h of handles) {
      g.beginPath()
      if (h.role === 'rotate') {
        const radius = 8 / s
        g.arc(h.x, h.y, radius, 0, Math.PI * 2)
        g.fillStyle = '#ffffff'
        g.fill()
        g.strokeStyle = '#2764AF'
        g.lineWidth = 1.5 / s
        g.stroke()
        g.beginPath()
        g.arc(h.x, h.y, 4.2 / s, -Math.PI * 0.15, Math.PI * 1.35)
        g.stroke()
        g.beginPath()
        g.moveTo(h.x - 4.5 / s, h.y - 3.5 / s)
        g.lineTo(h.x - 1 / s, h.y - 4.8 / s)
        g.lineTo(h.x - 2 / s, h.y - 1.2 / s)
        g.closePath()
        g.fillStyle = '#2764AF'
        g.fill()
      } else if (h.role === 'move') {
        g.arc(h.x, h.y, 5.5 / s, 0, Math.PI * 2)
        g.fillStyle = '#2764AF'
        g.fill()
        g.strokeStyle = '#ffffff'
        g.lineWidth = 1.5 / s
        g.stroke()
      } else {
        g.rect(h.x - half, h.y - half, half * 2, half * 2)
        g.fillStyle = '#ffffff'
        g.fill()
        g.strokeStyle = h.role === 'resize' ? '#2764AF' : '#17202a'
        g.lineWidth = 1.5 / s
        g.stroke()
      }
    }
    g.restore()
  }

  /** 多选时只绘制一个整体包围框，不显示密集的单点手柄 */
  private drawMultiSelectionBounds(g: CanvasRenderingContext2D, entities: Entity[], viewport: Viewport): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const entity of entities) {
      const bounds = entityBounds(entity, this.currentDrawing || undefined)
      minX = Math.min(minX, bounds.minX)
      minY = Math.min(minY, bounds.minY)
      maxX = Math.max(maxX, bounds.maxX)
      maxY = Math.max(maxY, bounds.maxY)
    }
    if (!Number.isFinite(minX)) return
    g.save()
    viewport.apply(g)
    g.strokeStyle = HALO_COLOR
    g.lineWidth = 1.5 / viewport.scale
    g.setLineDash([7 / viewport.scale, 4 / viewport.scale])
    g.strokeRect(minX, minY, maxX - minX, maxY - minY)
    g.restore()
  }

  /** 在 world 坐标下命中实体（从顶层往下，返回第一个命中的实体） */
  hitTest(worldPt: Point, state: EditorState, viewport: Viewport): Entity | null {
    const tol = viewport.hitTol()
    this.ensureRenderRecords(state)
    const candidates = this.queryVisibleRecords(
      worldPt[0] - tol,
      worldPt[1] - tol,
      worldPt[0] + tol,
      worldPt[1] + tol,
    ).sort((a, b) => b.order - a.order)
    for (const record of candidates) {
      if (isLayerFrozen(state.drawing, record.entity.layer)) continue
      if (!hitEntity(worldPt, record.entity, tol, state.drawing)) continue
      const ownerId = record.ancestorIds[0]
      return ownerId ? this.entityLookup.get(ownerId) || null : record.entity
    }
    return null
  }

  /**
   * 查询框选矩形内的顶层实体或组合。
   * @param bounds 框选世界坐标范围。
   * @param state 编辑器状态。
   * @param mode 窗口选择或交叉选择。
   * @returns 命中的顶层实体列表。
   * @author snihao
   */
  selectInBounds(bounds: Bounds, state: EditorState, mode: SelectionMode = 'crossing'): Entity[] {
    this.ensureRenderRecords(state)
    const records = this.queryVisibleRecords(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY)
    const ids = new Set<string>()
    const result: Entity[] = []
    for (const record of records.sort((a, b) => a.order - b.order)) {
      if (isLayerFrozen(state.drawing, record.entity.layer)) continue
      const ownerId = record.ancestorIds[0] || record.entity.id
      if (ids.has(ownerId)) continue
      ids.add(ownerId)
      const entity = ownerId === record.entity.id
        ? record.entity
        : this.entityLookup.get(ownerId) || null
      if (!entity) continue
      if (mode === 'window') {
        const entityBoundsValue = entityBounds(entity, state.drawing)
        const contained = entityBoundsValue.minX >= bounds.minX
          && entityBoundsValue.maxX <= bounds.maxX
          && entityBoundsValue.minY >= bounds.minY
          && entityBoundsValue.maxY <= bounds.maxY
        if (!contained) continue
      }
      result.push(entity)
    }
    return result
  }

  /** 命中手柄：返回 {index, role} 或 null */
  hitHandle(worldPt: Point, entity: Entity, viewport: Viewport): HandleHit | null {
    const tol = viewport.handleTol()
    const hs = this.getHandles(entity)
    for (const h of hs) {
      if (Math.abs(worldPt[0] - h.x) <= tol && Math.abs(worldPt[1] - h.y) <= tol) {
        return { index: h.index, role: h.role }
      }
    }
    return null
  }
}

/** niceStep：把任意步长对齐到 1/2/5 × 10^n */
function niceStep(x: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(x)))
  const n = x / pow
  let m: number
  if (n < 1.5) m = 1
  else if (n < 3.5) m = 2
  else if (n < 7.5) m = 5
  else m = 10
  return m * pow
}
