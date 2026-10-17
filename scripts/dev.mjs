import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const python = process.env.DRAIQ_PYTHON || 'python'
const children = [
  spawn(python, ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', '8011', '--reload', '--reload-dir', 'server'], { cwd: projectRoot, stdio: 'inherit', windowsHide: true }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], { cwd: new URL('../web/', import.meta.url), stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' }),
]
let stopping = false
/** 任一开发服务退出或用户按下 Ctrl+C 时，同时停止前后端进程。 */
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  process.exitCode = code
}
for (const child of children) {
  child.once('error', error => { console.error(error.message); stop(1) })
  child.once('exit', code => stop(code || 0))
}
process.once('SIGINT', () => stop())
process.once('SIGTERM', () => stop())
