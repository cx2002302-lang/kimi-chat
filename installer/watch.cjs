#!/usr/bin/env node
/**
 * kimi-chat 看门狗：持续保证 Web UI 的 index.html 带补丁标记。
 *
 * 为什么需要：Kimi Code CLI 在启动 `kimi web` 时会按内嵌 hash 清单**校验并还原**
 * 所有原始文件（index.html / boot.js / 主 bundle），我们的补丁会被回滚。
 * 新增文件（assets/kimi-chat/）不在清单内，不会被清理。
 * 因此补丁必须在「服务启动之后」被重新施加——本看门狗每 3 秒检查一次，
 * 缺失即自愈（含资产目录缺失时重新拷贝）。
 *
 * 用法：
 *   node watch.cjs          启动（单例，已在运行则直接退出）
 *   node watch.cjs status   查看状态
 *   node watch.cjs stop     停止
 *   node watch.cjs run --foreground   前台运行（调试）
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const PLUGIN_ROOT = process.env.KIMI_PLUGIN_ROOT || path.resolve(__dirname, '..')
const HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')
const STATE_DIR = path.join(HOME, 'kimi-chat')
const PID_FILE = path.join(STATE_DIR, 'watch.pid')
const LOG_FILE = path.join(STATE_DIR, 'watch.log')
const INTERVAL_MS = 3000

function heal() {
  try {
    // 延迟 require：保证 hook 场景下也从插件目录解析
    return require(path.join(__dirname, 'heal.cjs')).run()
  } catch (e) {
    return -1
  }
}
function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
    if (!pid) return null
    process.kill(pid, 0) // 存活探测
    return pid
  } catch {
    return null
  }
}
function isRunning() { return readPid() !== null }

function startDetached() {
  if (isRunning()) return false
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [__filename, 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { KIMI_PLUGIN_ROOT: PLUGIN_ROOT }),
  })
  child.unref()
  fs.writeFileSync(PID_FILE, String(child.pid))
  return true
}
function stop() {
  const pid = readPid()
  if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
  try { fs.unlinkSync(PID_FILE) } catch {}
  return !!pid
}
function logLine(msg) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n')
  } catch {}
}
function loop() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(PID_FILE, String(process.pid))
  logLine('watchdog started pid=' + process.pid)
  // 同进程托管本地聊天服务（话题存储 + 聊天/生成代理），端口被占时自动降级为纯看门狗
  try {
    require(path.join(__dirname, 'service.cjs')).start()
  } catch (e) {
    logLine('service start failed: ' + e.message)
  }
  const tick = () => {
    const n = heal()
    if (n > 0) logLine('healed ' + n + ' dist dir(s)')
  }
  tick()
  const timer = setInterval(tick, INTERVAL_MS)
  const shutdown = () => {
    clearInterval(timer)
    try { fs.unlinkSync(PID_FILE) } catch {}
    logLine('watchdog stopped')
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const cmd = process.argv[2] || 'start'
if (require.main === module) {
  if (cmd === 'run') loop()
  else if (cmd === 'stop') console.log(stop() ? 'watchdog stopped' : 'watchdog not running')
  else if (cmd === 'status') console.log(isRunning() ? 'watchdog running pid=' + readPid() : 'watchdog not running')
  else {
    const started = startDetached()
    console.log(started ? 'watchdog started' : 'watchdog already running (pid=' + readPid() + ')')
  }
}
module.exports = { startDetached, isRunning, stop, heal }
