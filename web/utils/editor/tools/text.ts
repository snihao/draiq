/** 文字工具：点击画布后在点击位置旁显示内联输入框。 */
import { BaseTool } from '#draiq/utils/editor/tools/base'
import type { ToolContext, ToolPoint } from '#draiq/utils/editor/tools/base'

export class TextTool extends BaseTool {
  constructor(ctx: ToolContext) {
    super(ctx)
  }

  onActivate(): void {
    this.clearSnap()
    this.status('文字：点击画布放置位置，然后直接输入内容')
  }

  onDeactivate(): void {
    this.clearSnap()
  }

  onPointerDown(event: PointerEvent, pt: ToolPoint): void {
    const resolved = this.resolvePoint(pt, { bypass: event.altKey, allowAngleSnap: false })
    this.beginTextInput({ x: resolved.point[0], y: resolved.point[1] })
  }

  onPointerMove(event: PointerEvent, pt: ToolPoint): void {
    this.resolvePoint(pt, { bypass: event.altKey, allowAngleSnap: false })
    this.requestRender()
  }
}
