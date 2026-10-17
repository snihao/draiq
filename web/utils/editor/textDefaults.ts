/** 推断新建普通文字实体使用的模型空间字高。 */
export function inferTextFontSize(entities: Entity[], fallback: number): number {
  const counts = new Map<number, number>()

  const visit = (items: Entity[]): void => {
    for (const entity of items) {
      if (entity.type === 'text' && Number.isFinite(entity.fontSize) && entity.fontSize! > 0) {
        const height = entity.fontSize!
        counts.set(height, (counts.get(height) || 0) + 1)
      }
      if (entity.children?.length) visit(entity.children)
    }
  }

  visit(entities)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback
}
