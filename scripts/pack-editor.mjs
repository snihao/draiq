import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync(new URL('../releases/', import.meta.url), { recursive: true })
// 每次分发编辑器模块时附带许可证和版权声明。
copyFileSync(new URL('../LICENSE', import.meta.url), new URL('../web/LICENSE', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('请使用 npm run pack:editor 执行打包')
const result = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--pack-destination', '../releases'], {
  cwd: new URL('../web/', import.meta.url), stdio: 'inherit', windowsHide: true,
})
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
