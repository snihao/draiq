/**
 * HATCH 解析使用的原始 ASCII DXF 组码对。
 * @author snihao
 */
export interface DxfHatchPair {
  /** DXF 组码。 */
  code: number
  /** 组码对应的原始值。 */
  value: string
}

/**
 * 裁剪后可见的单段 HATCH 图案线。
 * @author snihao
 */
export interface DxfHatchSegment {
  /** 图纸坐标系中的线段起点。 */
  start: Point
  /** 图纸坐标系中的线段终点。 */
  end: Point
}

/**
 * 一组平行 HATCH 图案线的定义。
 * @author snihao
 */
interface HatchPatternLine {
  /** 图案线族的基点。 */
  base: Point
  /** 沿图案线方向的单位向量。 */
  direction: Point
  /** 相邻平行图案线之间的偏移向量。 */
  offset: Point
  /** 正数表示实线长度，负数表示间隔长度。 */
  dashes: number[]
}

/**
 * HATCH 多段线边界的顶点。
 * @author snihao
 */
interface PolylineVertex {
  /** HATCH OCS 坐标系中的边界顶点。 */
  point: Point
  /** 从当前顶点开始的线段凸度。 */
  bulge: number
}

/**
 * 将 HATCH OCS 坐标转换为图纸坐标。
 * @param point OCS 平面坐标。
 * @param z OCS 高程。
 * @returns 图纸坐标系中的点。
 * @author snihao
 */
type OcsPointMapper = (point: Point, z: number) => Point

const EPSILON = 1e-8
const MAX_HATCH_SEGMENTS = 12000
const MAX_PATTERN_FAMILIES = 12000

/**
 * 重建 DXF HATCH 显式图案线并按边界裁剪。
 * 编辑器暂无填充实体，因此实体填充不生成线段。
 * @param pairs HATCH 实体的 DXF 组码对。
 * @param mapPoint OCS 坐标转换函数。
 * @returns 裁剪后的可见图案线段。
 * @author snihao
 */
export function buildDxfHatchSegments(pairs: DxfHatchPair[], mapPoint: OcsPointMapper): DxfHatchSegment[] {
  if (firstNumber(pairs, 70) === 1) return []
  const elevation = firstNumber(pairs, 30)
  const polygons = parseBoundaryPolygons(pairs, mapPoint, elevation)
  if (!polygons.length) return []
  const patterns = parsePatternLines(pairs, mapPoint, elevation)
  const result: DxfHatchSegment[] = []

  for (const pattern of patterns) {
    appendPatternSegments(result, pattern, polygons)
    if (result.length >= MAX_HATCH_SEGMENTS) break
  }
  return result
}

/**
 * 将所有 HATCH 边界路径解析为图纸坐标系中的采样多边形。
 * @param pairs HATCH 实体的 DXF 组码对。
 * @param mapPoint OCS 坐标转换函数。
 * @param elevation HATCH 的 OCS 高程。
 * @returns 边界多边形列表。
 * @author snihao
 */
function parseBoundaryPolygons(pairs: DxfHatchPair[], mapPoint: OcsPointMapper, elevation: number): Point[][] {
  const countIndex = findCode(pairs, 91)
  if (countIndex < 0) return []
  const pathCount = Math.max(0, Math.trunc(numberValue(pairs[countIndex])))
  const polygons: Point[][] = []
  let cursor = countIndex + 1

  for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
    const start = findCode(pairs, 92, cursor)
    if (start < 0) break
    const nextPath = findCode(pairs, 92, start + 1)
    const patternStart = findCode(pairs, 75, start + 1)
    const end = minimumPositive(nextPath, patternStart, pairs.length)
    const flags = Math.trunc(numberValue(pairs[start]))
    const polygon = (flags & 2) !== 0
      ? parsePolylineBoundary(pairs, start + 1, end, mapPoint, elevation)
      : parseEdgeBoundary(pairs, start + 1, end, mapPoint, elevation)
    const normalized = normalizePolygon(polygon)
    if (normalized.length >= 3 && Math.abs(polygonArea(normalized)) > EPSILON) polygons.push(normalized)
    cursor = end
  }
  return polygons
}

/**
 * 解析包含凸度圆弧段的 HATCH 多段线边界。
 * @param pairs HATCH 实体的 DXF 组码对。
 * @param start 边界数据起始索引。
 * @param end 边界数据结束索引。
 * @param mapPoint OCS 坐标转换函数。
 * @param elevation HATCH 的 OCS 高程。
 * @returns 边界采样点。
 * @author snihao
 */
function parsePolylineBoundary(
  pairs: DxfHatchPair[],
  start: number,
  end: number,
  mapPoint: OcsPointMapper,
  elevation: number,
): Point[] {
  const closedIndex = findCode(pairs, 73, start, end)
  const countIndex = findCode(pairs, 93, start, end)
  if (countIndex < 0) return []
  const closed = closedIndex >= 0 && numberValue(pairs[closedIndex]) !== 0
  const vertexCount = Math.max(0, Math.trunc(numberValue(pairs[countIndex])))
  const vertices: PolylineVertex[] = []
  let cursor = countIndex + 1

  for (let index = 0; index < vertexCount; index++) {
    const xIndex = findCode(pairs, 10, cursor, end)
    if (xIndex < 0) break
    const nextX = findCode(pairs, 10, xIndex + 1, end)
    const vertexEnd = nextX < 0 ? end : nextX
    vertices.push({
      point: [numberValue(pairs[xIndex]), numberInRange(pairs, 20, xIndex + 1, vertexEnd)],
      bulge: numberInRange(pairs, 42, xIndex + 1, vertexEnd),
    })
    cursor = vertexEnd
  }
  return expandBulgeVertices(vertices, closed).map((point) => mapPoint(point, elevation))
}

/**
 * 解析由独立边组成的 HATCH 边界，并对曲线边采样。
 * @param pairs HATCH 实体的 DXF 组码对。
 * @param start 边界数据起始索引。
 * @param end 边界数据结束索引。
 * @param mapPoint OCS 坐标转换函数。
 * @param elevation HATCH 的 OCS 高程。
 * @returns 按连接顺序排列的边界采样点。
 * @author snihao
 */
function parseEdgeBoundary(
  pairs: DxfHatchPair[],
  start: number,
  end: number,
  mapPoint: OcsPointMapper,
  elevation: number,
): Point[] {
  const countIndex = findCode(pairs, 93, start, end)
  if (countIndex < 0) return []
  const edgeCount = Math.max(0, Math.trunc(numberValue(pairs[countIndex])))
  const polygon: Point[] = []
  let cursor = countIndex + 1

  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex++) {
    const edgeStart = findCode(pairs, 72, cursor, end)
    if (edgeStart < 0) break
    const nextEdge = edgeIndex + 1 < edgeCount ? findCode(pairs, 72, edgeStart + 1, end) : end
    const edgeEnd = nextEdge < 0 ? end : nextEdge
    const edge = parseBoundaryEdge(pairs, edgeStart, edgeEnd, mapPoint, elevation)
    appendConnectedEdge(polygon, edge)
    cursor = edgeEnd
  }
  return polygon
}

/**
 * 将一条 HATCH 边界边转换为采样点序列。
 * @param pairs HATCH 实体的 DXF 组码对。
 * @param start 边界边数据起始索引。
 * @param end 边界边数据结束索引。
 * @param mapPoint OCS 坐标转换函数。
 * @param elevation HATCH 的 OCS 高程。
 * @returns 边界边采样点。
 * @author snihao
 */
function parseBoundaryEdge(
  pairs: DxfHatchPair[],
  start: number,
  end: number,
  mapPoint: OcsPointMapper,
  elevation: number,
): Point[] {
  const type = Math.trunc(numberValue(pairs[start]))
  if (type === 1) {
    return [
      mapPoint([numberInRange(pairs, 10, start + 1, end), numberInRange(pairs, 20, start + 1, end)], elevation),
      mapPoint([numberInRange(pairs, 11, start + 1, end), numberInRange(pairs, 21, start + 1, end)], elevation),
    ]
  }
  if (type === 2) {
    const center: Point = [numberInRange(pairs, 10, start + 1, end), numberInRange(pairs, 20, start + 1, end)]
    const radius = Math.abs(numberInRange(pairs, 40, start + 1, end))
    return sampleBoundaryCurve(
      numberInRange(pairs, 50, start + 1, end) * Math.PI / 180,
      numberInRange(pairs, 51, start + 1, end) * Math.PI / 180,
      numberInRange(pairs, 73, start + 1, end) !== 0,
      (parameter) => [center[0] + Math.cos(parameter) * radius, center[1] + Math.sin(parameter) * radius],
      mapPoint,
      elevation,
    )
  }
  if (type === 3) {
    const center: Point = [numberInRange(pairs, 10, start + 1, end), numberInRange(pairs, 20, start + 1, end)]
    const major: Point = [numberInRange(pairs, 11, start + 1, end), numberInRange(pairs, 21, start + 1, end)]
    const ratio = Math.abs(numberInRange(pairs, 40, start + 1, end, 1))
    const minor: Point = [-major[1] * ratio, major[0] * ratio]
    return sampleBoundaryCurve(
      numberInRange(pairs, 50, start + 1, end) * Math.PI / 180,
      numberInRange(pairs, 51, start + 1, end) * Math.PI / 180,
      numberInRange(pairs, 73, start + 1, end) !== 0,
      (parameter) => [
        center[0] + major[0] * Math.cos(parameter) + minor[0] * Math.sin(parameter),
        center[1] + major[1] * Math.cos(parameter) + minor[1] * Math.sin(parameter),
      ],
      mapPoint,
      elevation,
    )
  }
  if (type === 4) {
    return controlPointsInRange(pairs, start + 1, end).map((point) => mapPoint(point, elevation))
  }
  return []
}

/**
 * 按顺时针或逆时针方向采样圆形参数区间。
 * @param start 起始参数。
 * @param end 结束参数。
 * @param counterClockwise 是否按逆时针方向采样。
 * @param pointAt 根据参数计算 OCS 坐标点的函数。
 * @param mapPoint OCS 坐标转换函数。
 * @param elevation HATCH 的 OCS 高程。
 * @returns 图纸坐标系中的曲线采样点。
 * @author snihao
 */
function sampleBoundaryCurve(
  start: number,
  end: number,
  counterClockwise: boolean,
  pointAt: (parameter: number) => Point,
  mapPoint: OcsPointMapper,
  elevation: number,
): Point[] {
  const sweep = counterClockwise
    ? positiveAngle(end - start) || Math.PI * 2
    : -(positiveAngle(start - end) || Math.PI * 2)
  const count = Math.min(512, Math.max(12, Math.ceil(Math.abs(sweep) * 180 / Math.PI / 3)))
  return Array.from({ length: count + 1 }, (_, index) => (
    mapPoint(pointAt(start + sweep * index / count), elevation)
  ))
}

/**
 * 读取样条曲线控制点，作为边界的保守近似。
 * @param pairs HATCH 实体的 DXF 组码对。
 * @param start 样条数据起始索引。
 * @param end 样条数据结束索引。
 * @returns 样条控制点。
 * @author snihao
 */
function controlPointsInRange(pairs: DxfHatchPair[], start: number, end: number): Point[] {
  const points: Point[] = []
  let cursor = start
  while (cursor < end) {
    const xIndex = findCode(pairs, 10, cursor, end)
    if (xIndex < 0) break
    const nextX = findCode(pairs, 10, xIndex + 1, end)
    const pointEnd = nextX < 0 ? end : nextX
    points.push([numberValue(pairs[xIndex]), numberInRange(pairs, 20, xIndex + 1, pointEnd)])
    cursor = pointEnd
  }
  return points
}

/**
 * 在容忍源边反向或轻微断开的同时，按连接顺序追加边界边。
 * @param target 已连接的边界点。
 * @param source 待追加的边界边采样点。
 * @returns 无返回值。
 * @author snihao
 */
function appendConnectedEdge(target: Point[], source: Point[]): void {
  if (!source.length) return
  const edge = source.slice()
  if (!target.length) {
    target.push(...edge)
    return
  }
  const last = target[target.length - 1]
  if (pointDistance(last, edge[edge.length - 1]) < pointDistance(last, edge[0])) edge.reverse()
  const firstIndex = pointDistance(last, edge[0]) <= EPSILON ? 1 : 0
  target.push(...edge.slice(firstIndex))
}

/**
 * 移除重复闭合点和相邻的数值重复点。
 * @param points 原始边界点。
 * @returns 规范化后的边界点。
 * @author snihao
 */
function normalizePolygon(points: Point[]): Point[] {
  const result: Point[] = []
  for (const point of points) {
    if (!result.length || pointDistance(result[result.length - 1], point) > EPSILON) result.push(point)
  }
  if (result.length > 1 && pointDistance(result[0], result[result.length - 1]) <= EPSILON) result.pop()
  return result
}

/**
 * 解析组码 78 之后保存的图案线定义，并转换到图纸坐标系。
 * @param pairs HATCH 实体的 DXF 组码对。
 * @param mapPoint OCS 坐标转换函数。
 * @param elevation HATCH 的 OCS 高程。
 * @returns 图案线族定义。
 * @author snihao
 */
function parsePatternLines(pairs: DxfHatchPair[], mapPoint: OcsPointMapper, elevation: number): HatchPatternLine[] {
  const countIndex = findCode(pairs, 78)
  if (countIndex < 0) return []
  const count = Math.max(0, Math.trunc(numberValue(pairs[countIndex])))
  const patterns: HatchPatternLine[] = []
  let cursor = countIndex + 1

  for (let index = 0; index < count; index++) {
    const start = findCode(pairs, 53, cursor)
    if (start < 0) break
    const next = findCode(pairs, 53, start + 1)
    const seedStart = findCode(pairs, 98, start + 1)
    const end = minimumPositive(next, seedStart, pairs.length)
    const angle = numberValue(pairs[start]) * Math.PI / 180
    const localBase: Point = [
      numberInRange(pairs, 43, start + 1, end),
      numberInRange(pairs, 44, start + 1, end),
    ]
    const localOffset: Point = [
      numberInRange(pairs, 45, start + 1, end),
      numberInRange(pairs, 46, start + 1, end),
    ]
    const base = mapPoint(localBase, elevation)
    const directionEnd = mapPoint([localBase[0] + Math.cos(angle), localBase[1] + Math.sin(angle)], elevation)
    const directionVector: Point = [directionEnd[0] - base[0], directionEnd[1] - base[1]]
    const directionScale = Math.hypot(directionVector[0], directionVector[1])
    const offsetEnd = mapPoint([localBase[0] + localOffset[0], localBase[1] + localOffset[1]], elevation)
    if (directionScale > EPSILON) {
      patterns.push({
        base,
        direction: [directionVector[0] / directionScale, directionVector[1] / directionScale],
        offset: [offsetEnd[0] - base[0], offsetEnd[1] - base[1]],
        dashes: valuesInRange(pairs, 49, start + 1, end).map((value) => value * directionScale),
      })
    }
    cursor = end
  }
  return patterns
}

/**
 * 生成一组平行图案线，并按所有边界环裁剪后追加到结果。
 * @param result 用于收集可见图案线段的数组。
 * @param pattern 图案线族定义。
 * @param polygons HATCH 边界多边形列表。
 * @returns 无返回值。
 * @author snihao
 */
function appendPatternSegments(result: DxfHatchSegment[], pattern: HatchPatternLine, polygons: Point[][]): void {
  const normalStep = cross(pattern.direction, pattern.offset)
  if (Math.abs(normalStep) < EPSILON) return
  const coordinates = polygons.flat().map((point) => cross(pattern.direction, [
    point[0] - pattern.base[0],
    point[1] - pattern.base[1],
  ]))
  const minCoordinate = Math.min(...coordinates)
  const maxCoordinate = Math.max(...coordinates)
  const firstRatio = minCoordinate / normalStep
  const secondRatio = maxCoordinate / normalStep
  const first = Math.ceil(Math.min(firstRatio, secondRatio) - EPSILON)
  const last = Math.floor(Math.max(firstRatio, secondRatio) + EPSILON)
  const familyCount = Math.max(0, last - first + 1)
  const stride = Math.max(1, Math.ceil(familyCount / MAX_PATTERN_FAMILIES))

  for (let family = first; family <= last; family += stride) {
    const origin: Point = [
      pattern.base[0] + pattern.offset[0] * family,
      pattern.base[1] + pattern.offset[1] * family,
    ]
    const intervals = clipInfiniteLine(origin, pattern.direction, polygons)
    appendDashedIntervals(result, origin, pattern.direction, intervals, pattern.dashes)
    if (result.length >= MAX_HATCH_SEGMENTS) return
  }
}

/**
 * 计算无限直线位于 HATCH 边界内部的标量区间。
 * @param origin 无限直线原点。
 * @param direction 无限直线单位方向。
 * @param polygons HATCH 边界多边形列表。
 * @returns 位于边界内部的标量区间。
 * @author snihao
 */
function clipInfiniteLine(origin: Point, direction: Point, polygons: Point[][]): Array<[number, number]> {
  const intersections: number[] = []
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index]
      const end = polygon[(index + 1) % polygon.length]
      const edge: Point = [end[0] - start[0], end[1] - start[1]]
      const denominator = cross(direction, edge)
      if (Math.abs(denominator) < EPSILON) continue
      const relative: Point = [start[0] - origin[0], start[1] - origin[1]]
      const edgeParameter = cross(relative, direction) / denominator
      if (edgeParameter < -EPSILON || edgeParameter > 1 + EPSILON) continue
      intersections.push(cross(relative, edge) / denominator)
    }
  }
  intersections.sort((a, b) => a - b)
  const unique = intersections.filter((value, index) => index === 0 || Math.abs(value - intersections[index - 1]) > EPSILON)
  const intervals: Array<[number, number]> = []
  for (let index = 0; index + 1 < unique.length; index++) {
    const start = unique[index]
    const end = unique[index + 1]
    if (end - start <= EPSILON) continue
    const midpoint = (start + end) / 2
    const point: Point = [origin[0] + direction[0] * midpoint, origin[1] + direction[1] * midpoint]
    if (insideHatch(point, polygons)) intervals.push([start, end])
  }
  return intervals
}

/**
 * 按 DXF 中正数实线、负数间隔的虚线定义拆分裁剪区间。
 * @param result 用于收集可见图案线段的数组。
 * @param origin 图案线原点。
 * @param direction 图案线单位方向。
 * @param intervals 已裁剪的标量区间。
 * @param dashes DXF 虚线长度序列。
 * @returns 无返回值。
 * @author snihao
 */
function appendDashedIntervals(
  result: DxfHatchSegment[],
  origin: Point,
  direction: Point,
  intervals: Array<[number, number]>,
  dashes: number[],
): void {
  const cycle = dashes.reduce((total, value) => total + Math.abs(value), 0)
  for (const interval of intervals) {
    if (cycle <= EPSILON || !dashes.length) {
      appendSegment(result, origin, direction, interval[0], interval[1])
      if (result.length >= MAX_HATCH_SEGMENTS) return
      continue
    }
    let cycleStart = Math.floor(interval[0] / cycle) * cycle
    while (cycleStart < interval[1] - EPSILON) {
      let cursor = cycleStart
      for (const dash of dashes) {
        const next = cursor + Math.abs(dash)
        if (dash > 0) {
          const start = Math.max(cursor, interval[0])
          const end = Math.min(next, interval[1])
          if (end - start > EPSILON) appendSegment(result, origin, direction, start, end)
        }
        cursor = next
        if (result.length >= MAX_HATCH_SEGMENTS) return
      }
      cycleStart += cycle
    }
  }
}

/**
 * 将标量区间转换为实际线段并追加到结果。
 * @param result 用于收集图案线段的数组。
 * @param origin 图案线原点。
 * @param direction 图案线单位方向。
 * @param start 标量区间起点。
 * @param end 标量区间终点。
 * @returns 无返回值。
 * @author snihao
 */
function appendSegment(result: DxfHatchSegment[], origin: Point, direction: Point, start: number, end: number): void {
  result.push({
    start: [origin[0] + direction[0] * start, origin[1] + direction[1] * start],
    end: [origin[0] + direction[0] * end, origin[1] + direction[1] * end],
  })
}

/**
 * 使用奇偶规则判断点是否位于 HATCH 内部，以支持孔洞和嵌套边界。
 * @param point 待判断的点。
 * @param polygons HATCH 边界多边形列表。
 * @returns 点是否位于 HATCH 可见区域内。
 * @author snihao
 */
function insideHatch(point: Point, polygons: Point[][]): boolean {
  let inside = false
  for (const polygon of polygons) {
    if (insidePolygon(point, polygon)) inside = !inside
  }
  return inside
}

/**
 * 使用射线交点法判断点是否位于多边形内。
 * @param point 待判断的点。
 * @param polygon 多边形顶点。
 * @returns 点是否位于多边形内。
 * @author snihao
 */
function insidePolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]
    const b = polygon[previous]
    const crosses = (a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
    if (crosses) inside = !inside
  }
  return inside
}

/**
 * 将 LWPOLYLINE 风格的凸度线段展开为圆弧采样点。
 * @param vertices 带凸度的多段线顶点。
 * @param closed 多段线是否闭合。
 * @returns 展开圆弧后的边界点。
 * @author snihao
 */
function expandBulgeVertices(vertices: PolylineVertex[], closed: boolean): Point[] {
  if (vertices.length < 2) return vertices.map((vertex) => vertex.point)
  const points: Point[] = [vertices[0].point]
  const segmentCount = closed ? vertices.length : vertices.length - 1
  for (let index = 0; index < segmentCount; index++) {
    const from = vertices[index]
    const to = vertices[(index + 1) % vertices.length]
    if (Math.abs(from.bulge) < EPSILON) {
      points.push(to.point)
      continue
    }
    const dx = to.point[0] - from.point[0]
    const dy = to.point[1] - from.point[1]
    const chord = Math.hypot(dx, dy)
    if (chord < EPSILON) continue
    const midpoint: Point = [(from.point[0] + to.point[0]) / 2, (from.point[1] + to.point[1]) / 2]
    const offset = chord * (1 - from.bulge * from.bulge) / (4 * from.bulge)
    const center: Point = [midpoint[0] - dy / chord * offset, midpoint[1] + dx / chord * offset]
    const radius = pointDistance(from.point, center)
    const startAngle = Math.atan2(from.point[1] - center[1], from.point[0] - center[0])
    const sweep = 4 * Math.atan(from.bulge)
    const count = Math.max(4, Math.ceil(Math.abs(sweep) * 180 / Math.PI / 3))
    for (let step = 1; step <= count; step++) {
      const angle = startAngle + sweep * step / count
      points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)])
    }
  }
  if (closed && points.length > 1 && pointDistance(points[0], points[points.length - 1]) <= EPSILON) points.pop()
  return points
}

/**
 * 计算多边形的有向面积。
 * @param points 多边形顶点。
 * @returns 多边形有向面积。
 * @author snihao
 */
function polygonArea(points: Point[]): number {
  let area = 0
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length]
    area += points[index][0] * next[1] - next[0] * points[index][1]
  }
  return area / 2
}

/**
 * 在组码对的左闭右开区间中查找指定组码。
 * @param pairs DXF 组码对。
 * @param code 待查找的组码。
 * @param start 起始索引。
 * @param end 结束索引。
 * @returns 首个匹配索引；未找到时返回 -1。
 * @author snihao
 */
function findCode(pairs: DxfHatchPair[], code: number, start = 0, end = pairs.length): number {
  for (let index = start; index < end; index++) {
    if (pairs[index].code === code) return index
  }
  return -1
}

/**
 * 读取指定组码的首个数值。
 * @param pairs DXF 组码对。
 * @param code 待读取的组码。
 * @param fallback 未找到或数值无效时的后备值。
 * @returns 有限数值或后备值。
 * @author snihao
 */
function firstNumber(pairs: DxfHatchPair[], code: number, fallback = 0): number {
  const index = findCode(pairs, code)
  return index < 0 ? fallback : numberValue(pairs[index], fallback)
}

/**
 * 从指定索引范围读取一个组码数值。
 * @param pairs DXF 组码对。
 * @param code 待读取的组码。
 * @param start 起始索引。
 * @param end 结束索引。
 * @param fallback 未找到或数值无效时的后备值。
 * @returns 有限数值或后备值。
 * @author snihao
 */
function numberInRange(
  pairs: DxfHatchPair[],
  code: number,
  start: number,
  end: number,
  fallback = 0,
): number {
  const index = findCode(pairs, code, start, end)
  return index < 0 ? fallback : numberValue(pairs[index], fallback)
}

/**
 * 从指定索引范围读取一个组码的全部有效数值。
 * @param pairs DXF 组码对。
 * @param code 待读取的组码。
 * @param start 起始索引。
 * @param end 结束索引。
 * @returns 有限数值列表。
 * @author snihao
 */
function valuesInRange(pairs: DxfHatchPair[], code: number, start: number, end: number): number[] {
  const values: number[] = []
  for (let index = start; index < end; index++) {
    if (pairs[index].code !== code) continue
    const value = Number(pairs[index].value)
    if (Number.isFinite(value)) values.push(value)
  }
  return values
}

/**
 * 将一个组码值转换为有限数值。
 * @param pair DXF 组码对。
 * @param fallback 数值无效时的后备值。
 * @returns 有限数值或后备值。
 * @author snihao
 */
function numberValue(pair: DxfHatchPair, fallback = 0): number {
  const value = Number(pair.value)
  return Number.isFinite(value) ? value : fallback
}

/**
 * 读取一组索引中的最小非负值。
 * @param values 待比较的索引。
 * @returns 最小非负索引；不存在时返回 -1。
 * @author snihao
 */
function minimumPositive(...values: number[]): number {
  const valid = values.filter((value) => value >= 0)
  return valid.length ? Math.min(...valid) : -1
}

/**
 * 将弧度角规范化到非负整周范围。
 * @param value 原始弧度角。
 * @returns 位于 `[0, 2π)` 的弧度角。
 * @author snihao
 */
function positiveAngle(value: number): number {
  return (value % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
}

/**
 * 计算两个二维向量的叉积。
 * @param first 第一个二维向量。
 * @param second 第二个二维向量。
 * @returns 二维向量叉积。
 * @author snihao
 */
function cross(first: Point, second: Point): number {
  return first[0] * second[1] - first[1] * second[0]
}

/**
 * 计算两个点之间的欧氏距离。
 * @param first 第一个点。
 * @param second 第二个点。
 * @returns 两点距离。
 * @author snihao
 */
function pointDistance(first: Point, second: Point): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1])
}
