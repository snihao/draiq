import { fileURLToPath } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'

const drawingRoot = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/')
const dxfUrl = (process.env.NUXT_DXF_INTERNAL_URL || 'http://127.0.0.1:8011').replace(/\/$/, '')

export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: false },
  alias: { '#draiq': drawingRoot },
  modules: ['nuxtjs-naive-ui'],
  css: [drawingRoot + 'assets/css/tailwind.css'],
  runtimeConfig: { dxfInternalUrl: dxfUrl },
  build: { transpile: ['vueuc', 'naive-ui', '@css-render/vue3-ssr'] },
  postcss: { plugins: { '@tailwindcss/postcss': {}, autoprefixer: {} } },
  vite: {
    ssr: { noExternal: ['naive-ui', 'vueuc', '@css-render/vue3-ssr'] },
    css: { preprocessorOptions: { scss: { additionalData: '@use "' + drawingRoot.replaceAll('\\', '/') + 'assets/css/constant.scss" as *;' } } },
    plugins: [
      AutoImport({ imports: [{ 'naive-ui': ['useDialog', 'useMessage', 'useNotification', 'useLoadingBar'] }, 'vue', 'vue-router'], exclude: [/node_modules\/(?!@draiq\/editor\/)/], dts: false }),
      Components({ resolvers: [NaiveUiResolver()], exclude: [/node_modules\/(?!@draiq\/editor\/)/], dts: false }),
    ],
  },
  app: { head: {
    title: 'Draiq 智绘 - 在线二维绘图工具',
    meta: [
      { name: 'description', content: 'Draiq 智绘，一款轻量的在线二维绘图工具。支持精确绘图、对象捕捉、图层、尺寸标注，以及 SVG / DXF 导入与 DXF 导出。' },
      { name: 'application-name', content: 'Draiq' },
    ],
    link: [{ rel: 'icon', type: 'image/png', href: '/brand/draiq-icon.png' }],
  } },
  routeRules: {
    '/api/export/**': { proxy: dxfUrl + '/api/export/**' },
    '/api/health': { proxy: dxfUrl + '/api/health' },
  },
})
