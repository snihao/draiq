import type { DxfData } from 'dxf-render'
import type { Group, Material, Object3D, OrthographicCamera, Scene, WebGLRenderer } from 'three'

import type { DxfReferenceTransform } from '#draiq/utils/editor/dxfImport'
import type { Viewport } from '#draiq/utils/editor/viewport'

interface DxfSceneMaterials {
  disposeAll(): void
}

/** 原始 DXF 场景加载结果。 */
export interface DxfReferenceLoadResult {
  unsupported: string[]
  bounds: Bounds | null
}

/** 使用 dxf-render/Three.js 绘制未修改的原始 DXF，保留完整 CAD 显示语义。 */
export class DxfReferenceRenderer {
  private readonly canvas: HTMLCanvasElement
  private renderer: WebGLRenderer | null = null
  private scene: Scene | null = null
  private camera: OrthographicCamera | null = null
  private displayGroup: Group | null = null
  private sourceGroup: Group | null = null
  private materials: DxfSceneMaterials | null = null
  private dxfData: DxfData | null = null
  private sourceTransform: DxfReferenceTransform = { scale: 1, offsetX: 0, offsetY: 0 }
  private hiddenHandles = new Set<string>()
  private hiddenLayers = new Set<string>()
  private rebuildVersion = 0
  private rebuildScheduled = false
  private rebuildRunning = false
  private rebuildQueued = false
  private width = 800
  private height = 600
  private dpr = 1
  private lastViewport: Viewport | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  /** 是否已有可渲染的原始 DXF。 */
  get active(): boolean {
    return this.dxfData !== null
  }

  /** 解析并建立高保真 DXF 场景。 */
  async load(text: string, transform: DxfReferenceTransform): Promise<DxfReferenceLoadResult> {
    const { parseDxf } = await import('dxf-render')
    this.dxfData = normalizeSourceColors(parseDxf(text))
    this.rebuildQueued = false
    this.sourceTransform = transform
    this.hiddenHandles.clear()
    this.hiddenLayers.clear()
    return this.rebuildScene()
  }

  /** 隐藏已被编辑器覆盖层替换的原始实体。 */
  setHiddenHandles(handles: Iterable<string>): void {
    const next = new Set(Array.from(handles, (handle) => handle.toUpperCase()))
    if (sameSet(next, this.hiddenHandles)) return
    this.hiddenHandles = next
    this.scheduleRebuild()
  }

  /** 隐藏指定 DXF 图层，和编辑器图层表保持一致。 @param layers 图层名称集合。 @returns 无返回值。 @author snihao */
  setHiddenLayers(layers: Iterable<string>): void {
    const next = new Set(Array.from(layers, (layer) => layer.toUpperCase()))
    if (sameSet(next, this.hiddenLayers)) return
    this.hiddenLayers = next
    this.scheduleRebuild()
  }

  /** 同步 CSS 尺寸和 DPR。 */
  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.dpr = Math.max(1, dpr)
    if (!this.renderer || !this.camera) return
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setSize(this.width, this.height, false)
    this.camera.left = 0
    this.camera.right = this.width
    this.camera.top = 0
    this.camera.bottom = this.height
    this.camera.updateProjectionMatrix()
  }

  /** 使用编辑器同一视口绘制原始 DXF。 */
  render(viewport: Viewport): void {
    this.lastViewport = viewport
    if (!this.renderer || !this.scene || !this.camera || !this.displayGroup) return
    this.displayGroup.scale.set(viewport.scale, viewport.scale, 1)
    this.displayGroup.position.set(viewport.offsetX, viewport.offsetY, 0)
    this.renderer.render(this.scene, this.camera)
  }

  /** 清除当前原始 DXF，但保留 WebGL 上下文供下一次导入复用。 */
  clear(): void {
    this.rebuildVersion++
    this.dxfData = null
    this.hiddenHandles.clear()
    this.hiddenLayers.clear()
    this.rebuildQueued = false
    this.disposeSourceScene()
    if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera)
  }

  /** 释放 WebGL、几何与材质资源。 */
  dispose(): void {
    this.clear()
    this.renderer?.dispose()
    this.renderer = null
    this.scene = null
    this.camera = null
    this.displayGroup = null
  }

  private async ensureRuntime(): Promise<void> {
    if (this.renderer && this.scene && this.camera && this.displayGroup) return
    const THREE = await import('three')
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true })
    this.renderer.setClearColor(0x000000, 0)
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(0, this.width, 0, this.height, -100000, 100000)
    this.camera.position.set(0, 0, 1000)
    this.displayGroup = new THREE.Group()
    this.scene.add(this.displayGroup)
    this.resize(this.width, this.height, this.dpr)
  }

  private async rebuildScene(): Promise<DxfReferenceLoadResult> {
    const source = this.dxfData
    if (!source) return { unsupported: [], bounds: null }
    const version = ++this.rebuildVersion
    await this.ensureRuntime()
    const { createThreeObjectsFromDXF } = await import('dxf-render')
    const filtered: DxfData = {
      ...source,
      entities: source.entities.filter((entity) => {
        const handle = entity.handle === undefined ? '' : String(entity.handle).toUpperCase()
        const layer = typeof entity.layer === 'string' ? entity.layer.toUpperCase() : ''
        return !isTextEntity(entity)
          && (!handle || !this.hiddenHandles.has(handle))
          && (!layer || !this.hiddenLayers.has(layer))
      }).map(withoutEmbeddedText),
      blocks: Object.fromEntries(Object.entries(source.blocks || {}).map(([name, block]) => {
        // dxf-render 对模型空间和图纸空间块可能只返回元数据，运行时不一定带 entities。
        const blockRecord = block && typeof block === 'object' ? block : {}
        const rawEntities = (blockRecord as { entities?: unknown }).entities
        const blockEntities = Array.isArray(rawEntities)
          ? rawEntities as DxfData['entities']
          : []
        return [name, {
          ...blockRecord,
          entities: blockEntities.filter((entity) => {
            const layer = typeof entity.layer === 'string' ? entity.layer.toUpperCase() : ''
            return !isTextEntity(entity) && (!layer || !this.hiddenLayers.has(layer))
          }).map(withoutEmbeddedText),
        }]
      })),
    }
    const result = await createThreeObjectsFromDXF(filtered)
    if (version !== this.rebuildVersion || !this.displayGroup) {
      disposeObject(result.group)
      result.materials.disposeAll()
      return { unsupported: [], bounds: null }
    }
    this.disposeSourceScene()
    this.sourceGroup = result.group
    this.materials = result.materials
    const { scale, offsetX, offsetY } = this.sourceTransform
    this.sourceGroup.scale.set(scale, -scale, scale)
    this.sourceGroup.position.set(
      offsetX + result.originOffset.x * scale,
      offsetY - result.originOffset.y * scale,
      result.originOffset.z * scale,
    )
    this.displayGroup.add(this.sourceGroup)
    this.displayGroup.updateMatrixWorld(true)
    const THREE = await import('three')
    const box = new THREE.Box3().setFromObject(this.sourceGroup)
    const bounds = box.isEmpty() ? null : {
      minX: box.min.x,
      minY: box.min.y,
      maxX: box.max.x,
      maxY: box.max.y,
    }
    if (this.lastViewport) this.render(this.lastViewport)
    return { unsupported: result.unsupportedEntities || [], bounds }
  }

  private scheduleRebuild(): void {
    if (!this.dxfData) return
    this.rebuildQueued = true
    if (this.rebuildScheduled || this.rebuildRunning) return
    this.rebuildScheduled = true
    requestAnimationFrame(() => {
      this.rebuildScheduled = false
      void this.flushRebuild()
    })
  }

  private async flushRebuild(): Promise<void> {
    if (!this.dxfData || this.rebuildRunning || !this.rebuildQueued) return
    this.rebuildQueued = false
    this.rebuildRunning = true
    try {
      await this.rebuildScene()
    } finally {
      this.rebuildRunning = false
      if (this.rebuildQueued) this.scheduleRebuild()
    }
  }

  private disposeSourceScene(): void {
    if (this.sourceGroup && this.displayGroup) this.displayGroup.remove(this.sourceGroup)
    if (this.sourceGroup) disposeObject(this.sourceGroup)
    this.materials?.disposeAll()
    this.sourceGroup = null
    this.materials = null
  }
}

/**
 * 判断实体是否属于需要由 Canvas 绘制的文字类型。
 * @param entity DXF 原始实体。
 * @returns 是否为文字实体。
 * @author snihao
 */
function isTextEntity(entity: { type?: unknown }): boolean {
  const type = typeof entity.type === 'string' ? entity.type.toUpperCase() : ''
  return type === 'TEXT' || type === 'MTEXT' || type === 'ATTRIB' || type === 'ATTDEF'
}

/**
 * 移除 INSERT 实体中由 dxf-render 内嵌绘制的属性文字，避免与 Canvas 文字重复。
 * @param entity DXF 原始实体。
 * @returns 移除内嵌属性文字后的实体。
 * @author snihao
 */
function withoutEmbeddedText<T>(entity: T): T {
  if (!entity || typeof entity !== 'object' || !Array.isArray((entity as { attribs?: unknown }).attribs)) return entity
  return { ...entity, attribs: [] }
}

/** dxf-render 在 `color` 中保存真彩色，但只有同时存在 ACI
 * 索引时才应用该颜色；构建原图前先修正这一解析差异。 */
function normalizeSourceColors(data: DxfData): DxfData {
  const visit = (entity: unknown): void => {
    if (!entity || typeof entity !== 'object') return
    const value = entity as {
      color?: unknown
      colorIndex?: unknown
      entities?: unknown[]
      attributes?: unknown[]
    }
    if (typeof value.color === 'number' && Number.isFinite(value.color)
      && (value.colorIndex === undefined || value.colorIndex === 256)) {
      value.colorIndex = 1
    }
    for (const child of value.entities || []) visit(child)
    for (const child of value.attributes || []) visit(child)
  }
  for (const entity of data.entities) visit(entity)
  for (const block of Object.values(data.blocks || {})) {
    for (const entity of ((block as { entities?: unknown[] }).entities || [])) visit(entity)
  }
  return data
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

function disposeObject(root: Object3D): void {
  root.traverse((object) => {
    const disposable = object as Object3D & { geometry?: { dispose(): void }; material?: Material | Material[] }
    disposable.geometry?.dispose()
    if (Array.isArray(disposable.material)) {
      for (const material of disposable.material) material.dispose()
    } else {
      disposable.material?.dispose()
    }
  })
}
