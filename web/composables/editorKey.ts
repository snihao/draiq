/**
 * 编辑器注入键：用于跨组件共享同一个 useEditor 实例。
 * 在 pages/editor.vue 中调用 useEditor() 后 provide，子组件通过 inject 获取。
 */
import type { InjectionKey } from 'vue'
import type { useEditor } from '#draiq/composables/useEditor'

/** 编辑器实例类型 */
export type EditorInstance = ReturnType<typeof useEditor>

/** 编辑器注入键 */
export const editorKey: InjectionKey<EditorInstance> = Symbol('editor')
