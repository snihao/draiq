/** CAD 动态坐标输入解析器，支持绝对、相对和极坐标语法。 */

/** 坐标输入解析结果。 @author snihao */
export interface CadCoordinateInput {
  /** 输入模式。 */
  mode: 'absolute' | 'relative' | 'polar'
  /** X 或距离。 */
  first: number
  /** Y 或角度。 */
  second: number
}

/** 解析 `X,Y`、`@X,Y` 和 `@距离<角度`。 @param value 输入文本。 @returns 解析结果或空值。 @author snihao */
export function parseCadCoordinateInput(value: string): CadCoordinateInput | null {
  const text = value.trim().replace(/\s+/g, '')
  if (!text) return null
  const relative = text.startsWith('@')
  const body = relative ? text.slice(1) : text
  if (!body) return null
  if (body.includes('<')) {
    if (!relative || body.indexOf('<') !== body.lastIndexOf('<')) return null
    const [distanceText, angleText] = body.split('<')
    const distance = parseNumber(distanceText)
    const angle = parseNumber(angleText)
    if (distance == null || angle == null || distance < 0) return null
    return { mode: 'polar', first: distance, second: angle }
  }
  const separator = body.indexOf(',') >= 0 ? ',' : body.indexOf(';') >= 0 ? ';' : ''
  if (!separator) return null
  const values = body.split(separator)
  if (values.length !== 2) return null
  const first = parseNumber(values[0])
  const second = parseNumber(values[1])
  if (first == null || second == null) return null
  return { mode: relative ? 'relative' : 'absolute', first, second }
}

/** 把 CAD 坐标输入解析为世界坐标。 @param value 输入文本。 @param anchor 相对坐标基点。 @returns 世界坐标或空值。 @author snihao */
export function resolveCadCoordinateInput(value: string, anchor: Point): Point | null {
  const result = parseCadCoordinateInput(value)
  if (!result) return null
  if (result.mode === 'absolute') return [result.first, result.second]
  if (result.mode === 'relative') return [anchor[0] + result.first, anchor[1] + result.second]
  const radians = result.second * Math.PI / 180
  return [anchor[0] + result.first * Math.cos(radians), anchor[1] - result.first * Math.sin(radians)]
}

function parseNumber(value: string): number | null {
  if (!value) return null
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}
