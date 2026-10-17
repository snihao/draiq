<template>
  <n-config-provider :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <NuxtPage />
    <n-global-style />
  </n-config-provider>
</template>

<script setup lang="ts">
import type { GlobalThemeOverrides } from 'naive-ui'
import { dateZhCN, zhCN } from 'naive-ui'
import { useThemeTransition } from '#draiq/composables/useThemeTransition'

const { theme, isDark, handleThemeToggle, switchTheme } = useThemeTransition()

/** 编辑器统一使用品牌蓝作为主要强调色。 */
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#2764AF',
    primaryColorHover: '#3677C8',
    primaryColorPressed: '#1E4F8D',
    primaryColorSuppl: '#2764AF',
    borderRadius: '7px',
    fontFamily: 'Geist, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif',
    fontFamilyMono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
}

provide('theme', theme)
provide('isDark', isDark)
provide('switchTheme', switchTheme)
provide('handleThemeToggle', handleThemeToggle)
</script>

<style lang="scss">
body {
  padding: 0;
  margin: 0;
  min-width: 0;
  min-height: 100dvh;
  color: #172027;
  background: #e9eeef;
  font-family: Geist, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

html {
  min-width: 0;
  min-height: 100%;
}

button,
input,
textarea {
  font: inherit;
}

button:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid rgba(39, 100, 175, 0.75);
  outline-offset: 2px;
}

/* View Transition 圆形裁剪动画样式 */
::view-transition-old(root),
::view-transition-new(root) {
  animation: none !important;
  mix-blend-mode: normal;
}

/* 切换到 dark mode: 旧视图(亮)在上层，执行收缩动画 */
.theme-transition-to-dark::view-transition-old(root) {
  z-index: 2147483646;
}

.theme-transition-to-dark::view-transition-new(root) {
  z-index: 1;
}

/* 切换到 light mode: 新视图(亮)在上层，执行展开动画 */
.theme-transition-to-light::view-transition-old(root) {
  z-index: 1;
}

.theme-transition-to-light::view-transition-new(root) {
  z-index: 2147483646;
}
</style>
