<script setup lang="ts">
import EditorToolbar from '#draiq/components/editor/EditorToolbar.vue'
import EditorCanvas from '#draiq/components/editor/EditorCanvas.vue'
import EditorMinimap from '#draiq/components/editor/EditorMinimap.vue'
import EditorViewportControls from '#draiq/components/editor/EditorViewportControls.vue'
import EditorInspector from '#draiq/components/editor/EditorInspector.vue'
</script>

<template>
  <main class="relative flex min-h-0 flex-1 overflow-hidden border-y border-slate-200/80 bg-[#f2f5f5] dark:border-white/10 dark:bg-[#151d1c]">
    <EditorToolbar />
    <section class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-2.5 sm:pl-2">
      <EditorCanvas />
      <EditorMinimap />
      <EditorViewportControls />
    </section>
    <EditorInspector :initially-collapsed="true" class="max-md:hidden" />
  </main>
</template>
