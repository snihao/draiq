import { entityBounds, genId, isDimensionEntity, mirrorEntity, moveEntity, rotateEntity, scaleEntity } from '#draiq/utils/editor/geometry'

/** 粘贴操作的实体克隆结果。 @author snihao */
export interface CloneResult {
  /** 克隆后的实体列表。 */
  entities: Entity[]
  /** 原实体 ID 到新实体 ID 的映射。 */
  idMap: Map<string, string>
  /** 克隆后仍保持选中的根实体 ID。 */
  selectedIds: string[]
  /** 因引用集合外实体而解除的测量点关联数。 */
  detachedDimensionCount: number
}

/**
 * 返回未被已选组合覆盖的选择根节点。
 * @param drawing 当前图纸。
 * @param selectedIds 当前选择 ID。
 * @returns 可直接参与变换的根实体。
 * @author snihao
 */
export function selectedRootEntities(drawing: Drawing, selectedIds: string[]): Entity[] {
  const selected = new Set(selectedIds)
  const roots: Entity[] = []
  /** 递归遍历实体树并过滤被父组合覆盖的选择。 @author snihao */
  const visit = (entities: Entity[], ancestorSelected: boolean): void => {
    for (const entity of entities) {
      const isSelected = selected.has(entity.id)
      if (isSelected && !ancestorSelected) roots.push(entity)
      if (entity.children?.length) visit(entity.children, ancestorSelected || isSelected)
    }
  }
  visit(drawing.entities, false)
  return roots
}

/**
 * 收集实体树中的全部 ID。
 * @param entity 实体树根节点。
 * @returns 包含根节点和所有子节点的 ID 集合。
 * @author snihao
 */
export function entityTreeIds(entity: Entity): Set<string> {
  /** 递归收集当前实体及其子实体 ID。 @author snihao */
  const ids = new Set<string>()
  const visit = (item: Entity): void => {
    ids.add(item.id)
    for (const child of item.children || []) visit(child)
  }
  visit(entity)
  return ids
}

/**
 * 收集选择覆盖的实体 ID，包括已选组合的子实体。
 * @param drawing 当前图纸。
 * @param selectedIds 当前选择 ID。
 * @returns 本次变换实际覆盖的实体 ID 集合。
 * @author snihao
 */
export function selectedEntityIds(drawing: Drawing, selectedIds: string[]): Set<string> {
  const ids = new Set<string>()
  for (const entity of selectedRootEntities(drawing, selectedIds)) {
    for (const id of entityTreeIds(entity)) ids.add(id)
  }
  return ids
}

/**
 * 计算选择包围盒的世界坐标中心。
 * @param entities 参与计算的实体根节点。
 * @returns 选择包围盒中心点。
 * @author snihao
 */
export function selectionCenter(entities: Entity[]): Point {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const entity of entities) {
    const bounds = entityBounds(entity)
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
  }
  if (!Number.isFinite(minX)) return [0, 0]
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}

/**
 * 克隆选择用于粘贴：先分配 ID，再重写标注引用，确保只指向新副本。
 * @param source 待克隆的实体根节点。
 * @param selectedIds 需要在副本中继续保持选中的实体 ID。
 * @returns 克隆实体、ID 映射、选中 ID 和解除关联统计。
 * @author snihao
 */
export function cloneEntitiesForPaste(
  source: Entity[],
  selectedIds: string[] = [],
  allocateId: (entity: Entity) => string = entity => genId(entity.type),
): CloneResult {
  const entities = source.map((entity) => JSON.parse(JSON.stringify(entity)) as Entity)
  const idMap = new Map<string, string>()
  const selectedRoots = new Set(source.map((entity) => entity.id))
  let detachedDimensionCount = 0

  /** 为实体树预分配新 ID，保证引用重写不会受遍历顺序影响。 @author snihao */
  const allocate = (entity: Entity): void => {
    idMap.set(entity.id, allocateId(entity))
    for (const child of entity.children || []) allocate(child)
  }
  for (const entity of entities) allocate(entity)

  /** 重写实体 ID、组合归属、源句柄和关联标注引用。 @author snihao */
  const rewrite = (entity: Entity, parentId: string | null): void => {
    const oldId = entity.id
    entity.id = idMap.get(oldId) || genId(entity.type)
    entity.groupId = parentId
    // 粘贴实体属于新的 DXF 内容，不应继续覆盖原始源句柄。
    entity.sourceHandle = null
    entity.sourceEdited = false
    if (entity.dimensionRefs) {
      entity.dimensionRefs = entity.dimensionRefs.map((reference) => {
        if (!reference) return null
        const mappedEntityId = idMap.get(reference.entityId)
        if (!mappedEntityId) {
          detachedDimensionCount++
          return null
        }
        const mappedRelatedId = reference.relatedEntityId
          ? idMap.get(reference.relatedEntityId) || null
          : null
        if (reference.relatedEntityId && !mappedRelatedId) detachedDimensionCount++
        return {
          ...reference,
          entityId: mappedEntityId,
          relatedEntityId: mappedRelatedId,
          fallback: reference.fallback.slice() as Point,
        }
      }) as [PointReference | null, PointReference | null]
    }
    if (entity.dimensionSource) {
      const mappedEntityId = idMap.get(entity.dimensionSource.entityId)
      if (mappedEntityId) {
        entity.dimensionSource = { ...entity.dimensionSource, entityId: mappedEntityId }
      } else {
        entity.dimensionSource = null
        detachedDimensionCount++
      }
    }
    if (entity.dimensionAssociations?.length) {
      const associations: DimensionAssociation[] = []
      for (const association of entity.dimensionAssociations) {
        const source = association.source
        if (source.kind === 'point') {
          const mappedEntityId = idMap.get(source.ref.entityId)
          if (!mappedEntityId) {
            detachedDimensionCount++
            continue
          }
          const mappedRelatedId = source.ref.relatedEntityId
            ? idMap.get(source.ref.relatedEntityId) || null
            : null
          if (source.ref.relatedEntityId && !mappedRelatedId) {
            detachedDimensionCount++
            continue
          }
          associations.push({
            ...association,
            source: {
              kind: 'point',
              ref: {
                ...source.ref,
                entityId: mappedEntityId,
                relatedEntityId: mappedRelatedId,
                fallback: source.ref.fallback.slice() as Point,
              },
            },
          })
          continue
        }
        const mappedEntityId = idMap.get(source.entityId)
        if (!mappedEntityId) {
          detachedDimensionCount++
          continue
        }
        associations.push({
          ...association,
          source: {
            ...source,
            entityId: mappedEntityId,
            ...(source.kind === 'segment'
              ? { fallback: source.fallback.map((point) => point.slice() as Point) as [Point, Point] }
              : source.kind === 'circle'
                ? { fallbackCenter: source.fallbackCenter.slice() as Point }
                : source.parameterRange
                  ? { parameterRange: source.parameterRange.slice() as [number, number] }
                  : {}),
          },
        })
      }
      entity.dimensionAssociations = associations.length ? associations : null
    }
    for (const child of entity.children || []) rewrite(child, entity.id)
  }
  for (const entity of entities) rewrite(entity, null)

  const mappedSelectedIds = selectedIds
    .filter((id) => selectedRoots.has(id) || idMap.has(id))
    .map((id) => idMap.get(id))
    .filter((id): id is string => !!id)

  return { entities, idMap, selectedIds: mappedSelectedIds, detachedDimensionCount }
}

/**
 * 解除标注中指向未参与本次变换实体的测量点关联。
 * @param entity 待检查的实体。
 * @param movingIds 本次变换会移动的实体 ID。
 * @returns 被解除的测量点关联数。
 * @author snihao
 */
export function detachOutsideSelection(entity: Entity, movingIds: Set<string>): number {
  if (!isDimensionEntity(entity)) return 0
  let detached = 0
  if (entity.dimensionRefs) {
    for (let index = 0; index < entity.dimensionRefs.length; index++) {
      const reference = entity.dimensionRefs[index]
      if (reference && !movingIds.has(reference.entityId)) {
        entity.dimensionRefs[index] = null
        detached++
      }
    }
  }
  if (entity.dimensionSource && !movingIds.has(entity.dimensionSource.entityId)) {
    entity.dimensionSource = null
    detached++
  }
  if (entity.dimensionAssociations?.length) {
    const kept: DimensionAssociation[] = []
    for (const association of entity.dimensionAssociations) {
      const ids = genericAssociationEntityIds(association)
      if (ids.some((id) => !movingIds.has(id))) detached++
      else kept.push(association)
    }
    if (kept.length !== entity.dimensionAssociations.length) entity.dimensionAssociations = kept.length ? kept : null
  }
  return detached
}

/** 返回通用尺寸关联使用的所有来源实体 ID。 */
function genericAssociationEntityIds(association: DimensionAssociation): string[] {
  if (association.source.kind === 'point') {
    return [
      association.source.ref.entityId,
      ...(association.source.ref.relatedEntityId ? [association.source.ref.relatedEntityId] : []),
    ]
  }
  return [association.source.entityId]
}

/** 命令级变换的统一参数。 @author snihao */
export type TransformOperation =
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'rotate'; angle: number; origin: Point }
  | { kind: 'scale'; scaleX: number; scaleY: number; origin: Point }
  | { kind: 'mirror'; axisStart: Point; axisEnd: Point; mirrorText?: boolean }

/**
 * 对一组选择根节点应用一次命令级变换。
 * @param entities 参与变换的实体根节点。
 * @param operation 统一的变换参数。
 * @returns 无返回值；实体会在原地更新。
 * @author snihao
 */
export function applyTransform(entities: Entity[], operation: TransformOperation): void {
  for (const entity of entities) {
    if (operation.kind === 'move') moveEntity(entity, operation.dx, operation.dy)
    else if (operation.kind === 'rotate') rotateEntity(entity, operation.angle, operation.origin)
    else if (operation.kind === 'scale') scaleEntity(entity, operation.scaleX, operation.scaleY, operation.origin)
    else mirrorEntity(entity, operation.axisStart, operation.axisEnd, operation.mirrorText === true)
  }
}
