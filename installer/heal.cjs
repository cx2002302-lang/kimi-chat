#!/usr/bin/env node
/**
 * kimi-chat 自愈器：检测 Web UI 的 index.html 是否仍带补丁标记，缺失则重新打补丁。
 * 由插件 hook（SessionStart / SessionHeartbeat）调用，或手动执行。
 * 特性：静默、幂等、极快（只读 1KB 文件 + 字符串检查）；无补丁时从资产目录恢复注入。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const MARKER = 'kimi-chat-patch'
const ASSET_DIR = 'assets/kimi-chat'
const LOADER_TAG = '<script src="/assets/kimi-chat/vcp-loader.js"></script>'
const PLUGIN_ROOT = process.env.KIMI_PLUGIN_ROOT || path.resolve(__dirname, '..')

function cacheRoots() {
  const roots = []
  if (process.env.XDG_CACHE_HOME) roots.push(path.join(process.env.XDG_CACHE_HOME, 'kimi-code'))
  roots.push(path.join(os.homedir(), '.cache', 'kimi-code'))
  if (process.env.KIMI_CODE_HOME) roots.push(path.join(process.env.KIMI_CODE_HOME, 'cache'))
  return roots.filter((r, i) => roots.indexOf(r) === i)
}
function findDistDirs() {
  const out = []
  for (const root of cacheRoots()) {
    const webRoot = path.join(root, 'web')
    if (!fs.existsSync(webRoot)) continue
    for (const ver of fs.readdirSync(webRoot)) {
      const platDir = path.join(webRoot, ver, 'linux-x64')
      if (!fs.existsSync(platDir)) continue
      for (const hash of fs.readdirSync(platDir)) {
        const dist = path.join(platDir, hash, 'dist-web')
        if (fs.existsSync(path.join(dist, 'index.html'))) out.push(dist)
      }
    }
  }
  return out
}
function insertPoint(html) {
  const m = /<script[^>]*src="\/boot\.js"[^>]*><\/script>/i.exec(html)
  if (m) return m.index + m[0].length
  const head = html.indexOf('</head>')
  if (head !== -1) return head
  const body = html.indexOf('</body>')
  if (body !== -1) return body
  return -1
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name)
    if (ent.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}
function healOne(dist) {
  const indexPath = path.join(dist, 'index.html')
  let html
  try { html = fs.readFileSync(indexPath, 'utf8') } catch { return false }
  // 资产确保在场且为当前插件版本（缺失或版本不一致时重拷，保证升级生效）——先于 marker 判断
  let changed = false
  const assetDst = path.join(dist, ASSET_DIR)
  let pluginVer = ''
  try { pluginVer = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'kimi.plugin.json'), 'utf8')).version || '' } catch {}
  let deployedVer = null
  try { deployedVer = fs.readFileSync(path.join(assetDst, '.kc-version'), 'utf8').trim() } catch {}
  if (!fs.existsSync(path.join(assetDst, 'vcp-loader.js')) || deployedVer !== pluginVer) {
    try {
      copyDir(path.join(PLUGIN_ROOT, 'web'), assetDst)
      copyDir(path.join(PLUGIN_ROOT, 'assets', 'fonts'), path.join(assetDst, 'fonts'))
      fs.writeFileSync(path.join(assetDst, '.kc-version'), pluginVer)
      changed = true
    } catch { /* 资产失败时仍尝试补 index.html */ }
  }
  if (html.includes(MARKER)) return changed
  const at = insertPoint(html)
  if (at === -1) return changed
  const patched = html.slice(0, at) + '\n    <!-- ' + MARKER + ' v0.4.0 (healed) -->\n    ' + LOADER_TAG + html.slice(at)
  try { fs.writeFileSync(indexPath, patched) } catch { return changed }
  return true
}
function run() {
  let healed = 0
  for (const dist of findDistDirs()) if (healOne(dist)) healed++
  return healed
}
if (require.main === module) {
  const healed = run()
  if (process.argv.includes('--verbose')) console.log('[kimi-chat:heal] 已自愈', healed, '个 Web UI 目录')
  // 顺带确保看门狗在跑（重启/开机后由 hook 自动拉起；已在运行则零开销跳过）
  try {
    const w = require(path.join(__dirname, 'watch.cjs'))
    if (!w.isRunning()) {
      w.startDetached()
      if (process.argv.includes('--verbose')) console.log('[kimi-chat:heal] 看门狗已启动')
    }
  } catch { /* 看门狗拉起失败不影响自愈本身 */ }
}
module.exports = { run, healOne, findDistDirs, MARKER }
