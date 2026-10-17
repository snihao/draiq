<template>
  <div class="editor-shell flex h-[100dvh] max-h-[100dvh] min-h-0 min-w-0 flex-col overflow-hidden bg-[#e9eeef] text-slate-800 dark:bg-[#111817] dark:text-slate-100">
    <EditorTopbar />
    <EditorWorkspace />
    <EditorStatusbar />
  </div>
</template>

<script setup lang="ts">
import { useEditor } from '#draiq/composables/useEditor'
import { editorKey } from '#draiq/composables/editorKey'
import EditorTopbar from '#draiq/components/editor/EditorTopbar.vue'
import EditorWorkspace from '#draiq/components/editor/EditorWorkspace.vue'
import EditorStatusbar from '#draiq/components/editor/EditorStatusbar.vue'

const editor = useEditor()
provide(editorKey, editor)
</script>
