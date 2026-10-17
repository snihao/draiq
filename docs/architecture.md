# 绘图架构

Draiq 由浏览器绘图应用和 DXF 导出服务组成，可以从本目录独立安装、构建与部署。

## 前端

- `web/pages/editor.vue`：创建工作区实例并提供给子组件，首页重定向到该页面。
- `web/composables/useEditor.ts`：管理图纸、选择、绘图工具、视口、历史与文件操作。
- `web/components/editor/`：画布、工具栏、图层、标注样式与属性面板。
- `web/utils/editor/tools/`：鼠标与触控绘图工具。
- `web/utils/editor/snapping/`：对象捕捉、正交约束与极轴追踪。
- `web/utils/editor/factories/`：基础图元和尺寸实体的创建与参数校验。
- `web/utils/editor/associativeDimensions.ts`：关联尺寸随源几何更新。

图纸使用普通对象保存，界面通过显式版本通知刷新，以减少大量图元被深层响应式代理的成本。修改通过历史快照实现撤销与重做。文件导入期间暂停编辑，避免并发修改。

Canvas 2D 承载编辑图元、工具预览与捕捉提示。导入 DXF 时额外使用 WebGL 原图参考层；被修改或删除的原实体按句柄隐藏，编辑结果由 Canvas 绘制。导航缩略图使用独立画布。

当前图纸和历史仅保存在内存中；本地存储只保存工具栏、画布和捕捉偏好。

## 文件与服务

SVG 与 DXF 在浏览器中读取和解析。导出通过 `web/api/dxf.ts` 向同源接口提交图纸：

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 检查 DXF 服务状态 |
| `POST /api/export/dxf` | 将图纸数据转换为 DXF |
| `POST /api/export/dxf/merge` | 在原始 DXF 中应用删除与编辑后的实体 |

Nuxt 的 `routeRules` 将上述路径代理到 FastAPI。代理目标由构建时的 `NUXT_DXF_INTERNAL_URL` 决定，默认为 `http://127.0.0.1:8011`；Docker 构建使用 `http://api:8011`。

`server/main.py` 通过 Pydantic 校验输入，使用 ezdxf 创建或修改文档，并直接返回文件内容。服务不提供账号、项目存储或文件上传管理功能。

## 编辑器模块

`web/` 同时是 `@draiq/editor` Nuxt Layer。运行 `npm run pack:editor` 会生成 `releases/draiq-editor-0.1.1.tgz`，包中附带许可证及版权声明。版本来自 `web/package.json`。

在另一个 Nuxt 项目中安装后，通过 `extends: ['@draiq/editor']` 复用工作区，通过 `#draiq/` 导入绘图组件与工具。DXF 服务需要单独部署。
