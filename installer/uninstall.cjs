#!/usr/bin/env node
/**
 * kimi-chat 卸载器 —— 还原 Kimi Code Web UI。
 *   1. 从最新备份还原 index.html（*.bak-kimichat-*）
 *   2. 删除投放的 assets/kimi-chat/ 目录
 * 用法：node uninstall.cjs [--dry-run]
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ASSET_DIR = 'assets/kimi-chat'

function log(...a) { console.log('[kimi-chat:uninstall]', ...a) }
function warn(...a) { console.warn('[kimi-chat:uninstall]', ...a) }

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

function unpatch(dist, dryRun) {
  const indexPath = path.join(dist, 'index.html')
  const html = fs.readFileSync(indexPath, 'utf8')
  let acted = false

  // 1) 还原 index.html：优先最新备份；无备份则手工剥离注入行
  const backups = fs.readdirSync(dist)
    .filter(f => /^index\.html\.bak-kimichat-/.test(f))
    .sort().reverse()
  if (backups.length && html.includes('kimi-chat-patch')) {
    if (!dryRun) fs.copyFileSync(path.join(dist, backups[0]), indexPath)
    log('已从备份还原 index.html：', dist, '（' + backups[0] + '）')
    acted = true
  } else if (html.includes('kimi-chat-patch')) {
    const cleaned = html
      .replace(/\n?\s*<!-- kimi-chat-patch[^>]*-->/g, '')
      .replace(/\n?\s*<script src="\/assets\/kimi-chat\/vcp-loader\.js"><\/script>/g, '')
    if (cleaned !== html) {
      if (!dryRun) fs.writeFileSync(indexPath, cleaned)
      log('已剥离注入行（无备份可用）：', dist)
      acted = true
    }
  }

  // 2) 删除资产目录
  const assetDir = path.join(dist, ASSET_DIR)
  if (fs.existsSync(assetDir)) {
    if (!dryRun) fs.rmSync(assetDir, { recursive: true, force: true })
    log('已删除资产目录：', assetDir)
    acted = true
  }
  if (!acted) log('无需处理：', dist)
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  // 先停看门狗，避免它在我们还原期间又把补丁打回去
  try {
    if (!dryRun) {
      const w = require('./watch.cjs')
      if (w.isRunning()) { w.stop(); log('看门狗已停止') }
    }
  } catch {}
  const dists = findDistDirs()
  if (!dists.length) { warn('未找到 Web UI 静态目录'); process.exit(1) }
  for (const dist of dists) unpatch(dist, dryRun)
  log(dryRun ? '探测完成（未做任何修改）' : '卸载完成。如仍需移除插件本体：/plugins remove kimi-chat')
}

main()
