/** SVG 文件 → 可编辑图纸 JSON 的解析器。
 * 支持 line/polyline/polygon/rect/circle/ellipse/text/path 以及 <g> 变换叠加。
 * 曲线（C/Q/A）做等长 tessellation 转为多段线，保证可编辑。
 */
import { DEFAULTS } from '#draiq/utils/editor/config'
import { drawingBounds, genId, round } from '#draiq/utils/editor/geometry'
import { createLayerDefinition } from '#draiq/utils/editor/layers'

/** 2D 仿射矩阵 [a,b,c,d,e,f] */
type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function matMul(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

function applyMat(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** 解析 transform 字符串为单个累加矩阵 */
function parseTransform(str: string | null): Matrix {
  if (!str) return IDENTITY
  let m = IDENTITY
  const re = /(matrix|translate|rotate|scale)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(str)) !== null) {
    const op = match[1]
    const args = match[2].trim().split(/[\s,]+/).map(Number)
    let step = IDENTITY
    if (op === 'matrix') step = args as Matrix
    else if (op === 'translate') step = [1, 0, 0, 1, args[0] || 0, args[1] || 0]
    else if (op === 'scale') {
      const sx = args[0] == null ? 1 : args[0]
      const sy = args[1] == null ? sx : args[1]
      step = [sx, 0, 0, sy, 0, 0]
    } else if (op === 'rotate') {
      const ang = ((args[0] || 0) * Math.PI) / 180
      const cos = Math.cos(ang)
      const sin = Math.sin(ang)
      const r: Matrix = [cos, sin, -sin, cos, 0, 0]
      if (args.length >= 3) {
        const cx = args[1]
        const cy = args[2]
        step = matMul([1, 0, 0, 1, cx, cy], matMul(r, [1, 0, 0, 1, -cx, -cy]))
      } else {
        step = r
      }
    }
    m = matMul(m, step)
  }
  return m
}

function readStroke(node: Element): string | null {
  const attr = node.getAttribute('stroke')
  if (attr && attr !== 'none') return normalizeColor(attr)
  const style = node.getAttribute('style') || ''
  const m = /stroke\s*:\s*([^;]+)/i.exec(style)
  if (m && m[1].trim() !== 'none') return normalizeColor(m[1].trim())
  return null
}

function readStrokeWidth(node: Element): number | null {
  const attr = node.getAttribute('stroke-width')
  if (attr) return parseFloat(attr) || null
  const style = node.getAttribute('style') || ''
  const m = /stroke-width\s*:\s*([^;]+)/i.exec(style)
  if (m) return parseFloat(m[1]) || null
  return null
}

function readFontSize(node: Element): number {
  const attr = node.getAttribute('font-size')
  if (attr) return parseFloat(attr) || DEFAULTS.fontSize
  const style = node.getAttribute('style') || ''
  const m = /font-size\s*:\s*([^;]+)/i.exec(style)
  if (m) return parseFloat(m[1]) || DEFAULTS.fontSize
  return DEFAULTS.fontSize
}

/** 把颜色名/rgb/hex 归一为 #RRGGBB */
const colorCache = new Map<string, string | null>()
function normalizeColor(input: string): string | null {
  if (!input) return null
  const key = input.trim()
  if (colorCache.has(key)) return colorCache.get(key)!
  let result: string | null = null
  try {
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillStyle = key
    const v = ctx.fillStyle
    if (v.startsWith('#')) result = v.toUpperCase()
    else if (v.startsWith('rgb')) {
      const nums = v.match(/\d+/g)
      if (nums) result = '#' + nums.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('').toUpperCase()
    }
  } catch {
    result = null
  }
  colorCache.set(key, result)
  return result
}

function num(node: Element, name: string, fallback = 0): number {
  const v = node.getAttribute(name)
  return v == null ? fallback : parseFloat(v) || fallback
}

function parseViewBox(svgEl: Element): { x: number; y: number; width: number; height: number } {
  const vb = svgEl.getAttribute('viewBox')
  if (vb) {
    const [x, y, w, h] = vb.split(/[\s,]+/).map(Number)
    return { x: x || 0, y: y || 0, width: w || DEFAULTS.width, height: h || DEFAULTS.height }
  }
  return {
    x: 0,
    y: 0,
    width: num(svgEl, 'width', DEFAULTS.width),
    height: num(svgEl, 'height', DEFAULTS.height),
  }
}

function pointsStringToArray(str: string): Point[] {
  return (str || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .reduce((acc: number[][], n, i) => {
      if (i % 2 === 0) acc.push([n])
      else acc[acc.length - 1].push(n)
      return acc
    }, [])
    .filter((p) => p.length === 2) as Point[]
}

function extractRotation(node: Element): number {
  const t = node.getAttribute('transform') || ''
  const m = /rotate\s*\(([-\d.]+)/.exec(t)
  return m ? Number(m[1]) : 0
}

/** path d 解析：返回子路径数组 */
function parsePath(d: string): { points: Point[]; closed: boolean }[] {
  const subpaths: { points: Point[]; closed: boolean }[] = []
  let cur: Point = [0, 0]
  let start: Point = [0, 0]
  let points: Point[] = []
  let lastCmd = ''
  let lastCtrl: Point | null = null

  const flush = (closed: boolean) => {
    if (points.length) subpaths.push({ points: points.map((p) => p.slice() as Point), closed })
    points = []
  }

  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi
  const tokens: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(d)) !== null) tokens.push(m[0])

  const isLetter = (tk: string) => /[MmLlHhVvCcSsQqTtAaZz]/.test(tk)
  const relOf = (cmd: string) => cmd && cmd === cmd.toLowerCase() && cmd !== cmd.toUpperCase()

  let i = 0
  const next = () => Number(tokens[i++])
  while (i < tokens.length) {
    let t = tokens[i++]
    if (isLetter(t)) {
      lastCmd = t
      if (i >= tokens.length || isLetter(tokens[i])) continue
    } else {
      i--
    }
    const rel = relOf(lastCmd)

    switch (lastCmd.toUpperCase()) {
      case 'M': {
        let x = next()
        let y = next()
        if (rel) { x += cur[0]; y += cur[1] }
        if (points.length) flush(false)
        cur = [x, y]
        start = cur.slice() as Point
        points.push(cur.slice() as Point)
        lastCtrl = null
        lastCmd = rel ? 'l' : 'L'
        break
      }
      case 'L': {
        let x = next()
        let y = next()
        if (rel) { x += cur[0]; y += cur[1] }
        cur = [x, y]
        points.push(cur.slice() as Point)
        lastCtrl = null
        break
      }
      case 'H': {
        let x = next()
        if (rel) x += cur[0]
        cur = [x, cur[1]]
        points.push(cur.slice() as Point)
        lastCtrl = null
        break
      }
      case 'V': {
        let y = next()
        if (rel) y += cur[1]
        cur = [cur[0], y]
        points.push(cur.slice() as Point)
        lastCtrl = null
        break
      }
      case 'Z': {
        flush(true)
        cur = start.slice() as Point
        lastCtrl = null
        break
      }
      case 'C': {
        const c1 = [next(), next()] as Point
        const c2 = [next(), next()] as Point
        const e = [next(), next()] as Point
        const pts = rel
          ? [[c1[0] + cur[0], c1[1] + cur[1]], [c2[0] + cur[0], c2[1] + cur[1]], [e[0] + cur[0], e[1] + cur[1]]] as Point[]
          : [c1, c2, e]
        tessellateCubic(cur, pts[0], pts[1], pts[2], points)
        cur = pts[2].slice() as Point
        lastCtrl = pts[1].slice() as Point
        break
      }
      case 'S': {
        const c2 = [next(), next()] as Point
        const e = [next(), next()] as Point
        const c1 = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] as Point : cur.slice() as Point
        const pts = rel
          ? [[c2[0] + cur[0], c2[1] + cur[1]], [e[0] + cur[0], e[1] + cur[1]]] as Point[]
          : [c2, e]
        tessellateCubic(cur, c1, pts[0], pts[1], points)
        cur = pts[1].slice() as Point
        lastCtrl = pts[0].slice() as Point
        break
      }
      case 'Q': {
        const c = [next(), next()] as Point
        const e = [next(), next()] as Point
        const pts = rel
          ? [[c[0] + cur[0], c[1] + cur[1]], [e[0] + cur[0], e[1] + cur[1]]] as Point[]
          : [c, e]
        tessellateQuadratic(cur, pts[0], pts[1], points)
        cur = pts[1].slice() as Point
        lastCtrl = pts[0].slice() as Point
        break
      }
      case 'T': {
        const e = [next(), next()] as Point
        const c = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] as Point : cur.slice() as Point
        const ee = rel ? [e[0] + cur[0], e[1] + cur[1]] as Point : e
        tessellateQuadratic(cur, c, ee, points)
        cur = ee.slice() as Point
        lastCtrl = c.slice() as Point
        break
      }
      case 'A': {
        const rx = next()
        const ry = next()
        const xRot = next()
        const large = next()
        const sweep = next()
        const x = next()
        const y = next()
        const end = rel ? [x + cur[0], y + cur[1]] as Point : [x, y] as Point
        tessellateArc(cur, end, rx, ry, xRot, large, sweep, points)
        cur = end.slice() as Point
        lastCtrl = null
        break
      }
      default:
        break
    }
  }
  flush(false)
  return subpaths
}

function tessellateCubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Point[]): void {
  const steps = 16
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    const x = mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0]
    const y = mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1]
    out.push([x, y])
  }
}

function tessellateQuadratic(p0: Point, p1: Point, p2: Point, out: Point[]): void {
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0]
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
    out.push([x, y])
  }
}

function tessellateArc(p0: Point, p1: Point, rx: number, ry: number, xRotDeg: number, largeArc: number, sweep: number, out: Point[]): void {
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (rx === 0 || ry === 0) { out.push(p1.slice() as Point); return }
  const phi = (xRotDeg * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx = (p0[0] - p1[0]) / 2
  const dy = (p0[1] - p1[1]) / 2
  const x1p = cosPhi * dx + sinPhi * dy
  const y1p = -sinPhi * dx + cosPhi * dy
  let rxs = rx * rx
  let rys = ry * ry
  const x1ps = x1p * x1p
  const y1ps = y1p * y1p
  const denom = rxs * y1ps + rys * x1ps
  let lambda = denom === 0 ? 0 : (rxs * rys) / denom
  if (lambda < 1) {
    const k = Math.sqrt(1 / lambda)
    rx *= k
    ry *= k
    rxs = rx * rx
    rys = ry * ry
  }
  const sign = largeArc === sweep ? -1 : 1
  const num = rxs * y1ps + rys * x1ps
  const den = num === 0 ? 0 : rxs * rys - num
  const coef = Math.sqrt(Math.max(0, den) / Math.max(1e-12, num))
  const cxp = sign * coef * (rx * y1p) / ry
  const cyp = sign * coef * -(ry * x1p) / rx
  const cx = cosPhi * cxp - sinPhi * cyp + (p0[0] + p1[0]) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (p0[1] + p1[1]) / 2
  const ang = (ux: number, uy: number) => {
    const a = Math.atan2(uy, ux)
    return a < 0 ? a + 2 * Math.PI : a
  }
  const a1 = ang((x1p - cxp) / rx, (y1p - cyp) / ry)
  let aDelta = ang((-x1p - cxp) / rx, (-y1p - cyp) / ry) - a1
  if (!sweep && aDelta > 0) aDelta -= 2 * Math.PI
  if (sweep && aDelta < 0) aDelta += 2 * Math.PI
  const steps = Math.max(8, Math.ceil(Math.abs(aDelta) * 16))
  for (let i = 1; i <= steps; i++) {
    const a = a1 + (aDelta * i) / steps
    const xt = rx * Math.cos(a)
    const yt = ry * Math.sin(a)
    out.push([cosPhi * xt - sinPhi * yt + cx, sinPhi * xt + cosPhi * yt + cy])
  }
}

interface InheritedStyle {
  color: string | null
  lineWidth: number | null
  layer: string
}

const SKIP_TAGS = new Set(['defs', 'metadata', 'style', 'title', 'desc', 'clippath', 'mask', 'pattern', 'sodipodi:namedview', 'inkscape:'])

/** 主入口：解析 SVG 文本为 drawing 对象 */
export function parseSvgFile(svgText: string): Drawing {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgText, 'image/svg+xml')
  const svgEl = doc.documentElement
  if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') {
    throw new Error('无效的 SVG 文件')
  }
  const parseError = svgEl.querySelector('parsererror')
  if (parseError) throw new Error('SVG 解析失败')

  const vb = parseViewBox(svgEl)
  const drawing: Drawing = {
    unit: DEFAULTS.unit,
    width: vb.width,
    height: vb.height,
    entities: [],
    layers: [createLayerDefinition(DEFAULTS.layer)],
  }

  const inherited: InheritedStyle = { color: null, lineWidth: null, layer: 'default' }
  walk(svgEl, matMul(parseTransform(svgEl.getAttribute('transform')), IDENTITY), inherited, drawing.entities)

  if (vb.x !== 0 || vb.y !== 0) {
    for (const e of drawing.entities) translateEntity(e, -vb.x, -vb.y)
  }
  // 很多设计软件会在 SVG 根节点中写入一个与 viewBox 完全重合的矩形，
  // 它只是画布边框，不属于实际图形，导入时不生成实体。
  drawing.entities = drawing.entities.filter((entity) => !isCanvasFrame(entity, vb.width, vb.height))
  centerDrawingEntities(drawing)
  return drawing
}

function centerDrawingEntities(drawing: Drawing): void {
  if (!drawing.entities.length) return
  const bounds = drawingBounds(drawing)
  const contentCenterX = (bounds.minX + bounds.maxX) / 2
  const contentCenterY = (bounds.minY + bounds.maxY) / 2
  const dx = drawing.width / 2 - contentCenterX
  const dy = drawing.height / 2 - contentCenterY
  for (const entity of drawing.entities) translateEntity(entity, dx, dy)
}

function isCanvasFrame(entity: Entity, width: number, height: number): boolean {
  if (entity.type !== 'polyline' || !entity.closed || entity.points?.length !== 4) return false
  const tolerance = Math.max(0.01, Math.max(width, height) * 1e-6)
  const corners: Point[] = [[0, 0], [width, 0], [width, height], [0, height]]
  return corners.every(([cx, cy]) => entity.points!.some(([x, y]) => (
    Math.abs(x - cx) <= tolerance && Math.abs(y - cy) <= tolerance
  )))
}

function walk(node: Element, matrix: Matrix, inherited: InheritedStyle, out: Entity[]): void {
  for (const child of Array.from(node.children)) {
    const tag = child.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) continue
    const local = parseTransform(child.getAttribute('transform'))
    const m = matMul(matrix, local)
    const color = readStroke(child) || inherited.color
    const lineWidth = readStrokeWidth(child) ?? inherited.lineWidth
    const layer = child.getAttribute('data-layer') || inherited.layer

    if (tag === 'g') {
      walk(child, m, { color, lineWidth, layer }, out)
      continue
    }

    const entity = buildEntity(child, m, { color, lineWidth, layer })
    if (entity) {
      if (Array.isArray(entity)) entity.forEach((e) => out.push(e))
      else out.push(entity)
    }
  }
}

function buildEntity(node: Element, m: Matrix, style: InheritedStyle): Entity | Entity[] | null {
  const tag = node.tagName.toLowerCase()
  const base = () => ({
    id: genId(tag),
    layer: style.layer,
    color: style.color || DEFAULTS.color,
    lineWidth: style.lineWidth || DEFAULTS.lineWidth,
  })

  switch (tag) {
    case 'line': {
      const e: Entity = { ...base(), type: 'line' }
      e.start = applyMat(m, num(node, 'x1'), num(node, 'y1')).map(round) as Point
      e.end = applyMat(m, num(node, 'x2'), num(node, 'y2')).map(round) as Point
      return e
    }
    case 'polyline':
    case 'polygon': {
      const pts = pointsStringToArray(node.getAttribute('points') || '').map((p) => applyMat(m, p[0], p[1]).map(round) as Point)
      if (pts.length < 2) return null
      return { ...base(), type: 'polyline', points: pts, closed: tag === 'polygon' } as Entity
    }
    case 'rect': {
      const x = num(node, 'x')
      const y = num(node, 'y')
      const w = num(node, 'width')
      const h = num(node, 'height')
      const pts: Point[] = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ].map((p) => applyMat(m, p[0], p[1]).map(round) as Point)
      return { ...base(), type: 'polyline', points: pts, closed: true } as Entity
    }
    case 'circle': {
      const cx = num(node, 'cx')
      const cy = num(node, 'cy')
      const r = num(node, 'r')
      if (r <= 0) return null
      const [tx, ty] = applyMat(m, cx, cy)
      return { ...base(), type: 'circle', center: [round(tx), round(ty)], radius: round(r * scaleOf(m)) } as Entity
    }
    case 'ellipse': {
      const cx = num(node, 'cx')
      const cy = num(node, 'cy')
      const rx = num(node, 'rx')
      const ry = num(node, 'ry')
      const [tx, ty] = applyMat(m, cx, cy)
      if (Math.abs(rx - ry) < 0.5) {
        return { ...base(), type: 'circle', center: [round(tx), round(ty)], radius: round(rx * scaleOf(m)) } as Entity
      }
      const steps = 48
      const pts: Point[] = []
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * 2 * Math.PI
        pts.push(applyMat(m, cx + rx * Math.cos(a), cy + ry * Math.sin(a)).map(round) as Point)
      }
      return { ...base(), type: 'polyline', points: pts, closed: true } as Entity
    }
    case 'text': {
      const x = num(node, 'x')
      const y = num(node, 'y')
      const [tx, ty] = applyMat(m, x, y)
      const content = (node.textContent || '').trim()
      return {
        ...base(),
        type: 'text',
        position: [round(tx), round(ty)],
        content: content || '文字',
        fontSize: round(readFontSize(node) * scaleOf(m)),
        rotation: round(extractRotation(node), 0),
      } as Entity
    }
    case 'path': {
      const d = node.getAttribute('d') || ''
      const subs = parsePath(d)
      const out: Entity[] = []
      for (const sub of subs) {
        if (sub.points.length < 2) continue
        const pts = sub.points.map((p) => applyMat(m, p[0], p[1]).map(round) as Point)
        out.push({ ...base(), id: genId('path'), type: 'polyline', points: pts, closed: !!sub.closed } as Entity)
      }
      return out.length ? out : null
    }
    default:
      return null
  }
}

function scaleOf(m: Matrix): number {
  return Math.hypot(m[0], m[1]) || 1
}

function translateEntity(e: Entity, dx: number, dy: number): void {
  if (e.type === 'line') {
    e.start = [e.start![0] + dx, e.start![1] + dy]
    e.end = [e.end![0] + dx, e.end![1] + dy]
  } else if (e.type === 'polyline') {
    e.points = e.points!.map((p) => [p[0] + dx, p[1] + dy])
  } else if (e.type === 'circle') {
    e.center = [e.center![0] + dx, e.center![1] + dy]
  } else if (e.type === 'text') {
    e.position = [e.position![0] + dx, e.position![1] + dy]
  } else if (e.type === 'annotation') {
    e.leader = e.leader!.map((p) => [p[0] + dx, p[1] + dy])
    e.position = [e.position![0] + dx, e.position![1] + dy]
  }
}
