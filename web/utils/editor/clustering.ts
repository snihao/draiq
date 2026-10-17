/**
 * 空间聚类与组合图元检测。
 *
 * 核心思路：
 * 1. 把图元的端点（line 端点、polyline 顶点、circle 圆心、文字位置等）撒到空间中
 * 2. 用网格分块建立空间索引，O(N) 找出彼此邻近（距离 ≤ PROXIMITY_TOL）的端点对
 * 3. 用 Union-Find 把"端点邻近"的图元合并为同一簇
 * 4. 对每个簇做闭环检测：把线段端点吸附为图节点，线段作为边，DFS 检测环
 * 5. 满足"图元数 ≥ MIN_GROUP_SIZE 且形成闭环"的簇转为 group 实体
 *
 * 复杂度：端点数 P、图元数 N。网格查询近似 O(1)，整体接近 O(P)。
 */
import { genId } from '#draiq/utils/editor/geometry'

/** 邻近容差：端点距离 ≤ 此值视为同一连接点（world 单位） */
const PROXIMITY_TOL = 1.5
/** 一个簇至少包含多少个图元才考虑合并为组合 */
const MIN_GROUP_SIZE = 3
/** 网格单元大小（取邻近容差的 2 倍，保证查询只需看相邻 9 格） */
const CELL_SIZE = PROXIMITY_TOL * 2

/** Union-Find 数据结构 */
class UnionFind {
  /** 父节点数组，index 对应图元在原数组中的下标 */
  private parent: number[]
  /** 子树大小，用于按秩合并 */
  private rank: number[]

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array(n).fill(1)
  }

  /** 查找根节点（路径压缩） */
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }

  /** 合并两个集合 */
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb
      this.rank[rb] += this.rank[ra]
    } else {
      this.parent[rb] = ra
      this.rank[ra] += this.rank[rb]
    }
  }
}

/**
 * 提取图元的关键端点（用于聚类连接判断）。
 * - line: start, end
 * - polyline: 仅首尾点；中间顶点不会决定它与其他实体是否连接
 * - circle/text/annotation: 不参与轮廓连接聚类
 */
function extractKeyPoints(entity: Entity): Point[] {
  switch (entity.type) {
    case 'line':
      return [entity.start!, entity.end!]
    case 'polyline':
      return entity.points?.length ? [entity.points[0], entity.points[entity.points.length - 1]] : []
    default:
      return []
  }
}

/** 网格坐标键 */
function cellKey(x: number, y: number): string {
  return `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}`
}

/**
 * 对图元列表做空间聚类，返回可合并为组合的簇（每个簇是图元下标数组）。
 * 只返回满足"图元数 ≥ MIN_GROUP_SIZE 且形成闭环"的簇。
 */
export function detectClusters(entities: Entity[]): number[][] {
  const n = entities.length
  if (n < MIN_GROUP_SIZE) return []

  // 1. 收集所有端点及其所属图元下标
  interface P {
    x: number
    y: number
    owner: number
  }
  const points: P[] = []
  for (let i = 0; i < n; i++) {
    if (entities[i].type === 'group') continue
    for (const [x, y] of extractKeyPoints(entities[i])) {
      points.push({ x, y, owner: i })
    }
  }
  if (points.length < MIN_GROUP_SIZE * 2) return []

  // 2. 网格分块：cell -> 端点下标列表
  const grid = new Map<string, number[]>()
  for (let i = 0; i < points.length; i++) {
    const k = cellKey(points[i].x, points[i].y)
    let arr = grid.get(k)
    if (!arr) {
      arr = []
      grid.set(k, arr)
    }
    arr.push(i)
  }

  // 3. Union-Find 合并"端点邻近"的图元
  const uf = new UnionFind(n)
  const tol2 = PROXIMITY_TOL * PROXIMITY_TOL
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const cx = Math.floor(p.x / CELL_SIZE)
    const cy = Math.floor(p.y / CELL_SIZE)
    // 检查当前 cell 及相邻 8 个 cell
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighbors = grid.get(`${cx + dx},${cy + dy}`)
        if (!neighbors) continue
        for (const j of neighbors) {
          if (j <= i) continue
          const q = points[j]
          const ddx = p.x - q.x
          const ddy = p.y - q.y
          if (ddx * ddx + ddy * ddy <= tol2) {
            uf.union(p.owner, q.owner)
          }
        }
      }
    }
  }

  // 4. 按根分组
  const clusters = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (entities[i].type === 'group') continue
    const root = uf.find(i)
    let arr = clusters.get(root)
    if (!arr) {
      arr = []
      clusters.set(root, arr)
    }
    arr.push(i)
  }

  // 5. 过滤：图元数 ≥ 阈值 且 形成闭环
  const result: number[][] = []
  for (const indices of clusters.values()) {
    if (indices.length < MIN_GROUP_SIZE) continue
    if (hasClosedLoop(entities, indices)) {
      result.push(indices)
    }
  }
  return result
}

/**
 * 闭环检测：端点经容差吸附后作为节点，实际线段作为边。
 * 复杂度为 O(V + E)，避免旧实现对大簇进行 O(n² × P²) 两两比较。
 */
function hasClosedLoop(entities: Entity[], indices: number[]): boolean {
  if (indices.length < 3) return false
  const nodePoints: Point[] = []
  const nodeGrid = new Map<string, number[]>()
  const adj: number[][] = []
  const tol2 = PROXIMITY_TOL * PROXIMITY_TOL

  /** 把容差范围内的端点吸附为同一个图节点 */
  const nodeOf = (point: Point): number => {
    const cx = Math.floor(point[0] / CELL_SIZE)
    const cy = Math.floor(point[1] / CELL_SIZE)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of nodeGrid.get(`${cx + dx},${cy + dy}`) || []) {
          const existing = nodePoints[index]
          const ddx = existing[0] - point[0]
          const ddy = existing[1] - point[1]
          if (ddx * ddx + ddy * ddy <= tol2) return index
        }
      }
    }
    const index = nodePoints.length
    nodePoints.push(point)
    adj.push([])
    const key = `${cx},${cy}`
    const bucket = nodeGrid.get(key)
    if (bucket) bucket.push(index)
    else nodeGrid.set(key, [index])
    return index
  }

  /** 添加一个真实几何线段 */
  const addEdge = (a: Point, b: Point): void => {
    const na = nodeOf(a)
    const nb = nodeOf(b)
    if (na === nb) return
    adj[na].push(nb)
    adj[nb].push(na)
  }

  for (const index of indices) {
    const entity = entities[index]
    if (entity.type === 'line') {
      addEdge(entity.start!, entity.end!)
    } else if (entity.type === 'polyline') {
      const points = entity.points || []
      for (let i = 1; i < points.length; i++) addEdge(points[i - 1], points[i])
      if (entity.closed && points.length > 2) addEdge(points[points.length - 1], points[0])
    }
  }

  // DFS 检测环
  const visited = new Array(adj.length).fill(false)
  function dfs(u: number, parent: number): boolean {
    visited[u] = true
    for (const v of adj[u]) {
      if (v === parent) continue
      if (visited[v]) return true
      if (dfs(v, u)) return true
    }
    return false
  }
  for (let i = 0; i < adj.length; i++) {
    if (!visited[i]) {
      if (dfs(i, -1)) return true
    }
  }
  return false
}

/**
 * 把指定簇内的图元合并为一个 group 实体。
 * 子图元保留在 children 中，并打上 groupId 标记便于解组。
 */
export function buildGroupEntity(entities: Entity[], indices: number[]): Entity {
  const groupId = genId('grp')
  const children: Entity[] = []
  for (const idx of indices) {
    const child = entities[idx]
    child.groupId = groupId
    children.push(child)
  }
  // 组合的图层/颜色取第一个子图元（统一外观）
  const first = children[0]
  return {
    id: groupId,
    type: 'group',
    layer: first.layer,
    color: first.color,
    lineWidth: first.lineWidth,
    children,
    groupId: null,
  }
}

/**
 * 对整张图纸做智能组合：返回新的图元数组（已合并的子图元被替换为 group 实体）。
 * 不修改原数组，返回新数组。
 */
export function autoGroup(entities: Entity[]): Entity[] {
  const clusters = detectClusters(entities)
  if (!clusters.length) return entities.slice()

  // 标记被合并的图元
  const merged = new Set<number>()
  for (const indices of clusters) {
    for (const idx of indices) merged.add(idx)
  }

  const result: Entity[] = []
  // 先放未合并的图元
  for (let i = 0; i < entities.length; i++) {
    if (!merged.has(i)) result.push(entities[i])
  }
  // 再放每个簇生成的 group
  for (const indices of clusters) {
    result.push(buildGroupEntity(entities, indices))
  }
  return result
}
