# @draiq/editor

Draiq 的二维绘图前端，基于 Nuxt 3、Vue 3 和 TypeScript，也可作为 Nuxt Layer 使用。

## 独立运行

在本目录执行 `npm ci`，然后使用 `npm run dev`、`npm run typecheck` 或 `npm run build`。DXF 导出需要配套的 FastAPI 服务；完整安装和部署说明见项目仓库根目录的 README。

## 在 Nuxt 项目中复用

在 Draiq 根目录执行 `npm run pack:editor`，再在目标项目中安装生成的包：

```bash
npm install /path/to/draiq-editor-0.1.1.tgz
```

```ts
export default defineNuxtConfig({
  extends: ['@draiq/editor'],
})
```

Layer 包含 `/editor` 工作区和跳转到该工作区的首页，提供 `#draiq/` 导入别名。它面向 Nuxt 应用使用，包含自己的应用壳、全局样式和路由；接入已有应用时请检查路由及主题是否冲突。

DXF 服务不包含在此 npm 包中。默认请求 `http://127.0.0.1:8011`，可通过构建环境变量 `NUXT_DXF_INTERNAL_URL` 指定其他服务地址。

## 许可

采用 [MIT License](LICENSE)，允许个人和商业使用，保留包中许可证和版权声明。第三方依赖遵循各自的许可证。
