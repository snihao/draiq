<template>
  <div
    v-if="input"
    class="dynamic-input"
    :class="{ 'dynamic-input-invalid': !input.valid }"
    :style="positionStyle"
    @pointerdown.stop
    @click.stop
  >
    <label class="dynamic-field" :class="{ 'dynamic-field-active': input.activeField === 'length' }">
      <span class="dynamic-symbol">L</span>
      <input
        ref="lengthInputRef"
        data-dynamic-field="length"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        :aria-invalid="!input.valid"
        aria-label="长度"
        :value="input.lengthText"
        :disabled="isReadOnly"
        @focus="editor.focusDynamicInputField('length')"
        @input="onInput('length', $event)"
        @keydown="onKeydown"
      >
      <span class="dynamic-unit">{{ editor.state.drawing.unit }}</span>
    </label>
    <span class="dynamic-divider" />
    <label class="dynamic-field" :class="{ 'dynamic-field-active': input.activeField === 'angle' }">
      <span class="dynamic-symbol">A</span>
      <input
        ref="angleInputRef"
        data-dynamic-field="angle"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        :aria-invalid="!input.valid"
        aria-label="角度"
        :value="input.angleText"
        :disabled="isReadOnly"
        @focus="editor.focusDynamicInputField('angle')"
        @input="onInput('angle', $event)"
        @keydown="onKeydown"
      >
      <span class="dynamic-unit">deg</span>
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { editorKey } from '#draiq/composables/editorKey'

const editor = inject(editorKey)!
const lengthInputRef = ref<HTMLInputElement | null>(null)
const angleInputRef = ref<HTMLInputElement | null>(null)
const input = computed(() => editor.dynamicInput.value)
const isReadOnly = editor.loading

const positionStyle = computed(() => {
  const value = input.value
  const canvas = editor.canvasRef.value
  if (!value || !canvas) return { left: '8px', top: '8px' }
  const width = 248
  const height = 32
  const left = Math.min(Math.max(8, value.screenX + 16), Math.max(8, canvas.clientWidth - width - 8))
  const top = Math.min(Math.max(8, value.screenY + 16), Math.max(8, canvas.clientHeight - height - 8))
  return { left: `${left}px`, top: `${top}px` }
})

watch(input, async (value) => {
  if (!value) return
  await nextTick()
  const element = lengthInputRef.value
  element?.focus()
  const length = element?.value.length || 0
  element?.setSelectionRange(length, length)
})

watch(() => input.value?.activeField, async (field, previous) => {
  if (!field || !previous || field === previous) return
  await nextTick()
  const element = field === 'length' ? lengthInputRef.value : angleInputRef.value
  element?.focus()
  element?.select()
})

function onInput(field: 'length' | 'angle', event: Event): void {
  editor.updateDynamicInput(field, (event.target as HTMLInputElement).value)
}

function onKeydown(event: KeyboardEvent): void {
  editor.onDynamicInputKeydown(event)
}
</script>

<style scoped>
.dynamic-input {
  position: absolute;
  z-index: 9;
  display: flex;
  width: 248px;
  height: 32px;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid rgb(39 100 175 / 45%);
  border-radius: 4px;
  background: rgb(255 255 255 / 96%);
  box-shadow: 0 8px 22px rgb(22 52 80 / 18%);
  color: #42566b;
  backdrop-filter: blur(8px);
}
.dynamic-input-invalid {
  border-color: #dc4c4c;
}
.dynamic-field {
  display: grid;
  min-width: 0;
  flex: 1 1 0;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  padding: 0 7px;
  transition: background-color 120ms ease;
}
.dynamic-field-active {
  background: #eaf2fc;
}
.dynamic-symbol {
  color: #71808f;
  font-size: 9px;
  font-weight: 700;
}
.dynamic-field input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: #172b3e;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  outline: none;
}
.dynamic-unit {
  padding-left: 4px;
  color: #82909c;
  font-size: 9px;
}
.dynamic-divider {
  width: 1px;
  background: #d9e2eb;
}
:global(.dark) .dynamic-input {
  border-color: rgb(127 173 227 / 45%);
  background: rgb(24 35 33 / 96%);
  color: #d9e5e2;
}
:global(.dark) .dynamic-field-active {
  background: rgb(127 173 227 / 14%);
}
:global(.dark) .dynamic-field input {
  color: white;
}
:global(.dark) .dynamic-divider {
  background: rgb(255 255 255 / 12%);
}
</style>
