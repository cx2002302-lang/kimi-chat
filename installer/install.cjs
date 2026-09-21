#!/usr/bin/env node
/**
 * kimi-chat 安装器 —— 把「聊天按钮 + 历史面板 + VCP 渲染」注入 Kimi Code Web UI。
 *
 * 原理：Kimi Code 官方插件体系不提供 UI 注入能力，但 `kimi web` 的静态目录
 * （~/.cache/kimi-code/web/<版本>/linux-x64/<hash>/dist-web/）中新增文件会被
 * 直接 Serve、修改 index.html 即时生效。因此：
 *   1. 拷贝插件 web/ 与 assets/fonts/ 到 <dist-web>/assets/kimi-chat/
 *   2. 在 index.html 的 boot.js 之后插入一行 <script src="/assets/kimi-chat/vcp-loader.js">
 *
 * 幂等：index.html 含补丁标记则跳过；重复安装、kimi 升级后重跑均安全。
 * 每次修改前自动备份 index.html（*.bak-kimichat-<时间戳>）。
 *
 * 用法：
 *   node install.cjs [插件目录]           # 默认取本脚本上级目录
 *   node install.cjs [插件目录] --dry-run # 只探测不写入
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const MARKER = 'kimi-chat-patch'
const ASSET_DIR = 'assets/kimi-chat'
const LOADER_TAG = '<script src="/assets/kimi-chat/vcp-loader.js"></script>'

function log(...a) { console.log('[kimi-chat:install]', ...a) }
function warn(...a) { console.warn('[kimi-chat:install]', ...a) }

/** 解析插件根目录（含 kimi.plugin.json 的一级）。 */
function resolvePluginRoot() {
  const arg = process.argv.find(a => !a.startsWith('--'))
  if (arg && fs.existsSync(path.join(arg, 'kimi.plugin.json'))) return path.resolve(arg)
  if (arg && fs.existsSync(path.join(arg, 'web', 'vcp-loader.js'))) return path.resolve(arg)
  const here = path.resolve(__dirname, '..')
  if (fs.existsSync(path.join(here, 'kimi.plugin.json'))) return here
  console.error('未找到插件根目录：请把插件路径作为参数传入（含 kimi.plugin.json 的目录）')
  process.exit(1)
}

/** 候选缓存根：XDG_CACHE_HOME > ~/.cache；另兼容 KIMI_CODE_HOME 下的 cache。 */
function cacheRoots() {
  const roots = []
  if (process.env.XDG_CACHE_HOME) roots.push(path.join(process.env.XDG_CACHE_HOME, 'kimi-code'))
  roots.push(path.join(os.homedir(), '.cache', 'kimi-code'))
  if (process.env.KIMI_CODE_HOME) {
    roots.push(path.join(process.env.KIMI_CODE_HOME, 'cache'))
    roots.push(path.join(path.dirname(process.env.KIMI_CODE_HOME.replace(/\/+$/, '')), '.cache', 'kimi-code'))
  }
  return roots.filter((r, i) => roots.indexOf(r) === i)
}

/** 扫描所有 dist-web 目录（含遗留旧版本，全部打补丁，保证任意版本被启用时均可用）。 */
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

/** 在 index.html 中定位插入点：boot.js 之后；找不到则 </head> 前；再找不到则 </body> 前。 */
function insertPoint(html) {
  const m = /<script[^>]*src="\/boot\.js"[^>]*><\/script>/i.exec(html)
  if (m) return { at: m.index + m[0].length, how: 'after boot.js' }
  const head = html.indexOf('</head>')
  if (head !== -1) return { at: head, how: 'before </head>' }
  const body = html.indexOf('</body>')
  if (body !== -1) return { at: body, how: 'before </body>' }
  return null
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dst, ent.name)
    if (ent.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function patchDist(dist, pluginRoot, dryRun) {
  const indexPath = path.join(dist, 'index.html')
  const html = fs.readFileSync(indexPath, 'utf8')
  const alreadyPatched = html.includes(MARKER)
  const point = alreadyPatched ? null : insertPoint(html)
  if (!alreadyPatched && !point) { warn('index.html 未找到插入点，仅刷新资产：', dist) }

  if (dryRun) {
    log('[dry-run]', alreadyPatched ? '已打补丁，将刷新资产' : '将打补丁', '：', dist)
    return { skipped: false }
  }

  // 1) index.html 打补丁（已打则跳过；每次修改前备份）
  if (!alreadyPatched && point) {
    const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
    const bak = indexPath + '.bak-kimichat-' + ts
    fs.copyFileSync(indexPath, bak)
    const patched = html.slice(0, point.at) + '\n    <!-- ' + MARKER + ' v0.4.0 -->\n    ' + LOADER_TAG + html.slice(point.at)
    fs.writeFileSync(indexPath, patched)
    log('index.html 已打补丁（备份：' + path.basename(bak) + '）：', dist)
  } else if (alreadyPatched) {
    log('已打补丁，刷新资产：', dist)
  }

  // 2) 拷贝资产（每次刷新，保证与插件目录同步；先清后写）
  const assetDst = path.join(dist, ASSET_DIR)
  fs.rmSync(assetDst, { recursive: true, force: true })
  copyDir(path.join(pluginRoot, 'web'), assetDst)
  copyDir(path.join(pluginRoot, 'assets', 'fonts'), path.join(assetDst, 'fonts'))
  try {
    const v = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8')).version || ''
    fs.writeFileSync(path.join(assetDst, '.kc-version'), v)
  } catch {}

  // 3) 校验
  const loaderOk = fs.existsSync(path.join(assetDst, 'vcp-loader.js'))
  const markerOk = alreadyPatched || fs.readFileSync(indexPath, 'utf8').includes(MARKER)
  if (!loaderOk || !markerOk) { warn('校验失败：', dist); return { failed: true } }
  return { skipped: false }
}

/** 首装引导：创建本地服务配置（API key 从 --key= 或 KIMI_CHAT_MINIMAX_KEY 取）。 */
function ensureConfig() {
  const cfgFile = path.join(os.homedir(), '.kimi-code', 'kimi-chat', 'config.json')
  if (fs.existsSync(cfgFile)) return
  const keyArg = (process.argv.find(a => a.startsWith('--key=')) || '').slice(6)
  const key = keyArg || process.env.KIMI_CHAT_MINIMAX_KEY || ''
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
  fs.writeFileSync(cfgFile, JSON.stringify({
    minimax_api_key: key,
    minimax_base_url: 'https://api.minimaxi.com',
    chat_model: 'MiniMax-M2',
    image_model: 'image-01',
    port: 58931,
  }, null, 2), { mode: 0o600 })
  log('已创建配置', cfgFile, key ? '（含 API key）' : '（未含 API key：独立聊天需手动填入 minimax_api_key）')
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const pluginRoot = resolvePluginRoot()
  const dists = findDistDirs()
  if (!dists.length) {
    warn('未找到任何 Web UI 静态目录（~/.cache/kimi-code/web/*/*/*/dist-web）。')
    warn('请先运行一次 `kimi web` 让 CLI 下载 Web UI，然后重跑本安装器。')
    process.exit(1)
  }
  log('插件目录：', pluginRoot)
  log('发现', dists.length, '个 Web UI 目录')
  let ok = 0, fail = 0
  for (const dist of dists) {
    const r = patchDist(dist, pluginRoot, dryRun)
    if (r.failed) fail++
    else ok++
  }
  log(dryRun ? '探测完成' : '安装完成', '：成功', ok, '个，失败', fail, '个')
  if (!dryRun && ok > 0) {
    // 启动看门狗：kimi 每次启动 `kimi web` 都会回滚补丁，看门狗负责秒级自愈
    if (!process.argv.includes('--no-watch')) {
      try {
        const w = require('./watch.cjs')
        const started = w.isRunning() ? false : w.startDetached()
        log(started ? '看门狗已启动（每 3 秒自愈补丁）' : '看门狗已在运行')
      } catch (e) {
        warn('看门狗启动失败（不影响本次补丁）：', e.message)
      }
    }
    log('无需重启服务：补丁对运行中的服务即时生效，浏览器强刷 Ctrl+F5 查看效果。')
  }
  if (fail > 0) process.exit(1)
}

main()
