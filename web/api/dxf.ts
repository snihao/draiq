// ============================================
// DXF 导出接口定义
// ============================================
// 与 Python 后端交互：POST 当前图纸 JSON，下载返回的 DXF 文件。
// 通过同源 Nuxt 代理访问 DXF 服务。

import { annotationTextPosition } from '#draiq/utils/editor/geometry'
import type { DxfReferenceTransform } from '#draiq/utils/editor/dxfImport'

/** DXF 导出接口基础地址（由 nuxt.config.ts 的 routeRules 代理到 Python 服务） */
const DXF_API_BASE = '/api/export'

/** 访问 DXF 服务，将浏览器原生网络错误转换为中文提示。 */
async function requestDxf(url: string, options?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, options)
  } catch (error) {
    throw new Error('无法连接 DXF 服务，请检查网络连接及服务是否启动', { cause: error })
  }
}

/** 提取服务端的中文校验信息，避免直接向用户显示原始响应内容。 */
async function dxfErrorMessage(response: Response): Promise<string> {
  const fallback = `DXF 服务请求失败（HTTP ${response.status}）`
  const text = await response.text()
  try {
    const body: unknown = JSON.parse(text)
    if (!body || typeof body !== 'object' || !('detail' in body)) return fallback
    const detail = body.detail
    if (typeof detail === 'string' && /[\u4e00-\u9fff]/.test(detail)) return detail
    if (Array.isArray(detail)) {
      const messages = detail.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object' || !('msg' in item) || typeof item.msg !== 'string') return []
        if (!/[\u4e00-\u9fff]/.test(item.msg)) return []
        const location = 'loc' in item && Array.isArray(item.loc)
          ? item.loc.filter((part) => part !== 'body').join('.') : ''
        return [location ? `${location}：${item.msg}` : item.msg]
      })
      if (messages.length) return [...new Set(messages)].join('；')
    }
  } catch {
    // 非结构化响应仅显示请求状态，避免暴露代理错误页面。
  }
  return fallback
}

/**
 * 展开组合图元：把 group 的 children 还原为顶层独立图元（递归处理嵌套）。
 * DXF 后端识别图元实体和原生 dimension，不识别 group。
 */
function flattenGroups(entities: Entity[]): Entity[] {
  const out: Entity[] = []
  for (const e of entities) {
    if (e.type === 'group' && e.children) {
      for (const child of flattenGroups(e.children)) {
        // 解除 groupId 标记，导出为独立图元
        out.push({ ...child, groupId: null })
      }
    } else {
      out.push((e.type === 'annotation' || e.type === 'dimension') ? { ...e, position: annotationTextPosition(e) } : e)
    }
  }
  return out
}

/** 仅提取新增或已替换的覆盖层实体；未修改原实体继续保留在原 DXF 中。 */
function flattenEditedEntities(
  entities: Entity[],
  parentEdited = false,
  defaultTextStyle: string | null = null,
  defaultTextType: 'TEXT' | 'MTEXT' = 'TEXT',
): Entity[] {
  const out: Entity[] = []
  for (const entity of entities) {
    const edited = parentEdited || entity.sourceEdited === true
    if (entity.type === 'group' && entity.children) {
      if (entity.sourceHandle && !edited) continue
      out.push(...flattenEditedEntities(entity.children, edited, defaultTextStyle, defaultTextType))
      continue
    }
    if (edited || !entity.sourceHandle) {
      const normalized = entity.type === 'annotation' || entity.type === 'dimension'
        ? { ...entity, position: annotationTextPosition(entity) }
        : { ...entity }
      if ((normalized.type === 'text' || normalized.type === 'annotation') && !normalized.textStyle && defaultTextStyle) {
        normalized.textStyle = defaultTextStyle
      }
      if (normalized.type === 'text' && !normalized.dxfTextType) normalized.dxfTextType = defaultTextType
      out.push({ ...normalized, groupId: null, sourceHandle: null, sourceEdited: false })
    }
  }
  return out
}

function findTextStyle(entities: Entity[]): string | null {
  for (const entity of entities) {
    if (entity.textStyle) return entity.textStyle
    if (entity.children) {
      const nested = findTextStyle(entity.children)
      if (nested) return nested
    }
  }
  return null
}

function findTextType(entities: Entity[]): 'TEXT' | 'MTEXT' | null {
  for (const entity of entities) {
    if (entity.type === 'text' && entity.dxfTextType) return entity.dxfTextType
    if (entity.children) {
      const nested = findTextType(entity.children)
      if (nested) return nested
    }
  }
  return null
}

/** 下载接口返回的 DXF Blob。 */
async function downloadDxfResponse(response: Response, fileName: string): Promise<void> {
  if (!response.ok) {
    throw new Error(await dxfErrorMessage(response))
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/**
 * 导出图纸为 DXF 文件并触发浏览器下载
 * @param drawing 图纸数据
 * @param fileName 下载文件名（默认 drawing.dxf）
 * @throws 网络错误或服务端转换失败时抛出
 */
export async function exportDxf(drawing: Drawing, fileName = 'drawing.dxf'): Promise<void> {
  // 导出前展开所有 group，避免后端校验失败
  const flatDrawing: Drawing = {
    ...drawing,
    entities: flattenGroups(drawing.entities),
  }
  const response = await requestDxf(`${DXF_API_BASE}/dxf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flatDrawing),
  })

  await downloadDxfResponse(response, fileName)
}

/**
 * 在原始 DXF 上删除被修改的句柄，并写入新增/编辑后的覆盖层实体。
 * @param originalDxf 原始 ASCII DXF 文本
 * @param drawing 当前编辑器图纸
 * @param removedHandles 需要由覆盖层替换或删除的原实体句柄
 * @param transform 原始 WCS 到编辑器 world 的变换
 * @param fileName 下载文件名
 */
export async function exportMergedDxf(
  originalDxf: string,
  drawing: Drawing,
  removedHandles: string[],
  transform: DxfReferenceTransform,
  fileName = 'drawing-edited.dxf',
): Promise<void> {
  const defaultTextStyle = findTextStyle(drawing.entities)
  const defaultTextType = findTextType(drawing.entities) || 'TEXT'
  const response = await requestDxf(`${DXF_API_BASE}/dxf/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalDxf,
      drawing: { ...drawing, entities: flattenEditedEntities(drawing.entities, false, defaultTextStyle, defaultTextType) },
      removedHandles,
      transform,
    }),
  })
  await downloadDxfResponse(response, fileName)
}

/**
 * 健康检查（用于调试 Python 服务是否在线）
 * @returns 服务状态文本
 */
export async function checkDxfHealth(): Promise<string> {
  const response = await requestDxf('/api/health')
  if (!response.ok) throw new Error(await dxfErrorMessage(response))
  return response.text()
}
