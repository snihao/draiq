import { dimensionSegments, entityBounds } from '#draiq/utils/editor/geometry'
import { isLayerFrozen } from '#draiq/utils/editor/layers'

/** 可参与捕捉的线段图元。 */
export interface SnapSegmentPrimitive {
  type: 'segment'
  entityId: string
  segmentIndex: number
  start: Point
  end: Point
  bounds: Bounds
  order: number
}

/** 可参与捕捉的圆形图元。 */
export interface SnapCirclePrimitive {
  type: 'circle'
  entityId: string
  center: Point
  radius: number
  bounds: Bounds
  order: number
}

/** 在多段线渲染结果之外保留的精确圆弧或椭圆图元。 */
export interface SnapCurvePrimitive {
  type: 'curve'
  entityId: string
  curve: ParametricCurveGeometry
  bounds: Bounds
  order: number
}

export type SnapPrimitive = SnapSegmentPrimitive | SnapCirclePrimitive | SnapCurvePrimitive

/**
 * 轻量空间索引：以线段而非整个多段线为粒度，避免复杂 DXF 在每次
 * pointermove 时遍历全部顶点。
 */
export class SnapIndex {
  private primitives: SnapPrimitive[] = []
  private spatialGrid = new Map<string, number[]>()
  private globalIndices: number[] = []
  private gridCellSize = 1

  /** 使用当前图纸重建捕捉几何。 */
  rebuild(drawing: Drawing): void {
    const primitives: SnapPrimitive[] = []
    let order = 0
    const addSegment = (entityId: string, segmentIndex: number, start: Point, end: Point): void => {
      primitives.push({
        type: 'segment',
        entityId,
        segmentIndex,
        start,
        end,
        bounds: {
          minX: Math.min(start[0], end[0]),
          minY: Math.min(start[1], end[1]),
          maxX: Math.max(start[0], end[0]),
          maxY: Math.max(start[1], end[1]),
        },
        order: order++,
      })
    }

    const visit = (entity: Entity): void => {
      if (isLayerFrozen(drawing, entity.layer)) return
      if (entity.type === 'group') {
        for (const child of entity.children || []) visit(child)
        return
      }
      if (entity.type === 'line' && entity.start && entity.end) {
        addSegment(entity.id, 0, entity.start, entity.end)
        return
      }
      if (entity.type === 'polyline') {
        if (entity.curveGeometry) {
          primitives.push({
            type: 'curve',
            entityId: entity.id,
            curve: entity.curveGeometry,
            bounds: entityBounds(entity),
            order: order++,
          })
          return
        }
        const points = entity.points || []
        const segmentCount = entity.closed ? points.length : Math.max(0, points.length - 1)
        for (let index = 0; index < segmentCount; index++) {
          addSegment(entity.id, index, points[index], points[(index + 1) % points.length])
        }
        return
      }
      if (entity.type === 'circle' && entity.center && entity.radius != null) {
        primitives.push({
          type: 'circle',
          entityId: entity.id,
          center: entity.center,
          radius: entity.radius,
          bounds: entityBounds(entity),
          order: order++,
        })
        return
      }
      if (entity.type === 'annotation' || entity.type === 'dimension') {
        const dimension = dimensionSegments(entity)
        const points = entity.leader || []
        if (dimension.length) {
          dimension.forEach(([start, end], index) => addSegment(entity.id, index, start, end))
        } else {
          for (let index = 0; index + 1 < points.length; index++) {
            addSegment(entity.id, index, points[index], points[index + 1])
          }
        }
      }
    }

    for (const entity of drawing.entities) visit(entity)
    this.primitives = primitives
    this.buildGrid()
  }

  /** 查询与指定世界坐标矩形相交的捕捉图元。 */
  query(bounds: Bounds): SnapPrimitive[] {
    if (!this.primitives.length) return []
    const x0 = Math.floor(bounds.minX / this.gridCellSize)
    const x1 = Math.floor(bounds.maxX / this.gridCellSize)
    const y0 = Math.floor(bounds.minY / this.gridCellSize)
    const y1 = Math.floor(bounds.maxY / this.gridCellSize)
    const queryCellCount = (x1 - x0 + 1) * (y1 - y0 + 1)
    const candidates = new Set<number>(this.globalIndices)

    if (queryCellCount > 4096) {
      for (let index = 0; index < this.primitives.length; index++) candidates.add(index)
    } else {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (const index of this.spatialGrid.get(`${x},${y}`) || []) candidates.add(index)
        }
      }
    }

    const result: SnapPrimitive[] = []
    for (const index of candidates) {
      const primitive = this.primitives[index]
      const item = primitive.bounds
      if (item.maxX < bounds.minX || item.minX > bounds.maxX || item.maxY < bounds.minY || item.minY > bounds.maxY) continue
      result.push(primitive)
    }
    return result
  }

  /** 建立均匀网格；跨越过多单元的长线或大圆进入全局候选表。 */
  private buildGrid(): void {
    this.spatialGrid.clear()
    this.globalIndices = []
    if (!this.primitives.length) return

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const primitive of this.primitives) {
      minX = Math.min(minX, primitive.bounds.minX)
      minY = Math.min(minY, primitive.bounds.minY)
      maxX = Math.max(maxX, primitive.bounds.maxX)
      maxY = Math.max(maxY, primitive.bounds.maxY)
    }
    const span = Math.max(maxX - minX, maxY - minY, 1)
    this.gridCellSize = Math.max(span / Math.max(12, Math.ceil(Math.sqrt(this.primitives.length))), 1e-6)

    for (let index = 0; index < this.primitives.length; index++) {
      const bounds = this.primitives[index].bounds
      const x0 = Math.floor(bounds.minX / this.gridCellSize)
      const x1 = Math.floor(bounds.maxX / this.gridCellSize)
      const y0 = Math.floor(bounds.minY / this.gridCellSize)
      const y1 = Math.floor(bounds.maxY / this.gridCellSize)
      const cellCount = (x1 - x0 + 1) * (y1 - y0 + 1)
      if (cellCount > 128) {
        this.globalIndices.push(index)
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
}
