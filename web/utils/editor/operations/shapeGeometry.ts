/** 绘图工具共用的矩形顶点计算。 */
export function rectanglePoints(first: Point, opposite: Point): Point[] {
  const minX = Math.min(first[0], opposite[0])
  const minY = Math.min(first[1], opposite[1])
  const maxX = Math.max(first[0], opposite[0])
  const maxY = Math.max(first[1], opposite[1])
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
}

/** 根据图纸坐标系中的中心点和边长构造正多边形。 */
export function regularPolygonPoints(center: Point, sides: number, sideLength: number): Point[] {
  if (!Number.isInteger(sides) || sides < 3 || sides > 128
    || !Number.isFinite(sideLength) || sideLength <= 0
    || !center.every(Number.isFinite)) {
    throw new Error('正多边形参数无效')
  }
  const radius = sideLength / (2 * Math.sin(Math.PI / sides))
  const startAngle = 3 * Math.PI / 2 - Math.PI / sides
  // 三边形保留旧版左下、右下、顶部的顶点顺序。
  return Array.from({ length: sides }, (_, index): Point => {
    const angle = startAngle + index * 2 * Math.PI / sides
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]
  })
}
