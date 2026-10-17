/** SVG 导入后的保守几何优化：只合并样式一致、端点连接且无分叉的直线链。 */
import { genId } from '#draiq/utils/editor/geometry'

/** SVG 导入阶段已经保留 0.1 精度，使用略大的容差吸附同一点 */
const MERGE_TOLERANCE = 0.15

interface LineEdge {
  entity: Entity
  startNode: string
  endNode: string
}

/** 按样式生成键，只有完全同样式的直线才允许合并 */
function styleKey(entity: Entity): string {
  return `${entity.layer}|${entity.color || ''}|${entity.lineWidth ?? ''}`
}

/** 把端点量化为稳定节点键 */
function pointKey(point: Point): string {
  return `${Math.round(point[0] / MERGE_TOLERANCE)},${Math.round(point[1] / MERGE_TOLERANCE)}`
}

/** 判断两个点是否足够接近 */
function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) <= MERGE_TOLERANCE && Math.abs(a[1] - b[1]) <= MERGE_TOLERANCE
}

/**
 * 合并连续直线链为 polyline。
 * 分叉点会终止链，避免改变原始拓扑；单条直线保持原状。
 */
export function mergeConnectedLines(entities: Entity[]): Entity[] {
  const nonLines: Entity[] = []
  const styleGroups = new Map<string, Entity[]>()
  for (const entity of entities) {
    if (entity.type !== 'line' || !entity.start || !entity.end || samePoint(entity.start, entity.end)) {
      nonLines.push(entity)
      continue
    }
    const key = styleKey(entity)
    const group = styleGroups.get(key)
    if (group) group.push(entity)
    else styleGroups.set(key, [entity])
  }

  const optimized: Entity[] = [...nonLines]
  for (const lines of styleGroups.values()) optimized.push(...mergeStyleGroup(lines))
  return optimized
}

/** 合并单个样式组内的无分叉线链 */
function mergeStyleGroup(lines: Entity[]): Entity[] {
  if (lines.length < 2) return lines
  const edges: LineEdge[] = lines.map((entity) => ({
    entity,
    startNode: pointKey(entity.start!),
    endNode: pointKey(entity.end!),
  }))
  const adjacency = new Map<string, number[]>()
  for (let index = 0; index < edges.length; index++) {
    for (const node of [edges[index].startNode, edges[index].endNode]) {
      const bucket = adjacency.get(node)
      if (bucket) bucket.push(index)
      else adjacency.set(node, [index])
    }
  }

  const visited = new Set<number>()
  const result: Entity[] = []
  const startEdges: number[] = []
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index]
    if ((adjacency.get(edge.startNode)?.length || 0) !== 2 || (adjacency.get(edge.endNode)?.length || 0) !== 2) {
      startEdges.push(index)
    }
  }
  // 无分叉起点优先；剩余未访问边是闭环。
  for (const index of [...startEdges, ...edges.map((_, i) => i)]) {
    if (visited.has(index)) continue
    result.push(buildChain(index, edges, adjacency, visited))
  }
  return result
}

/** 从指定边向前追踪一条链 */
function buildChain(
  startIndex: number,
  edges: LineEdge[],
  adjacency: Map<string, number[]>,
  visited: Set<number>,
): Entity {
  const first = edges[startIndex]
  const startDegree = adjacency.get(first.startNode)?.length || 0
  const endDegree = adjacency.get(first.endNode)?.length || 0
  const forward = startDegree !== 2 || endDegree === 2
  let currentNode = forward ? first.startNode : first.endNode
  let edgeIndex = startIndex
  const points: Point[] = [forward ? first.entity.start! : first.entity.end!]
  let closed = false

  while (!visited.has(edgeIndex)) {
    visited.add(edgeIndex)
    const edge = edges[edgeIndex]
    const followsForward = edge.startNode === currentNode
    const nextNode = followsForward ? edge.endNode : edge.startNode
    const nextPoint = followsForward ? edge.entity.end! : edge.entity.start!
    points.push(nextPoint)
    currentNode = nextNode
    if (currentNode === (forward ? first.startNode : first.endNode)) {
      closed = points.length > 3
      break
    }
    const candidates = (adjacency.get(currentNode) || []).filter((index) => !visited.has(index))
    if ((adjacency.get(currentNode)?.length || 0) !== 2 || candidates.length !== 1) break
    edgeIndex = candidates[0]
  }

  if (points.length === 2) return first.entity
  if (closed && samePoint(points[0], points[points.length - 1])) points.pop()
  return {
    id: genId('merged'),
    type: 'polyline',
    layer: first.entity.layer,
    color: first.entity.color,
    lineWidth: first.entity.lineWidth,
    points,
    closed,
  }
}
