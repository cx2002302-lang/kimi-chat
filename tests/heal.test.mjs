/**
 * kimi-chat 自愈测试 —— 模拟 kimi 的「hash 校验还原」，验证 heal.cjs 能补回来。
 * 运行：node tests/heal.test.mjs
 * 覆盖：v0.1.0 的持久性缺陷（补丁被服务重启回滚）不再复现。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
const ok = (name, cond) => { cond ? (pass++, console.log('  ok -', name)) : (fail++, console.log('  FAIL -', name)) }

// ---- 搭一个假的 Web UI 目录，并通过 KIMI_CODE_HOME 指过去 ----
const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'kimi-chat-test-'))
const dist = path.join(fakeHome, 'cache', 'web', '9.9.9', 'linux-x64', 'deadbeef', 'dist-web')
mkdirSync(path.join(dist, 'assets'), { recursive: true })
const PRISTINE = `<!doctype html>
<html lang="en">
  <head>
    <script src="/boot.js"></script>
    <title>Kimi Code Web</title>
    <script type="module" crossorigin src="/assets/index-XXXX.js"></script>
  </head>
  <body><div id="app"></div></body>
</html>`
writeFileSync(path.join(dist, 'index.html'), PRISTINE)
process.env.KIMI_CODE_HOME = fakeHome

const heal = require(path.join(root, 'installer', 'heal.cjs'))
const MARKER = heal.MARKER

console.log('自愈器基础行为:')
ok('发现假 Web UI 目录', heal.findDistDirs().includes(dist))

// 1) 首次自愈（等价于 kimi 回滚后的恢复）—— 用 healOne 精确断言目标目录
let n = heal.healOne(dist) ? 1 : 0
const after1 = readFileSync(path.join(dist, 'index.html'), 'utf8')
ok('首次自愈报告 1 个目录', n === 1)
ok('补丁标记已注入', after1.includes(MARKER))
ok('loader 脚本已插入 boot.js 之后', /<\/script>\s*<!-- kimi-chat-patch[\s\S]*?<script src="\/assets\/kimi-chat\/vcp-loader\.js"><\/script>/.test(after1))
ok('原始引用未被破坏', after1.includes('/assets/index-XXXX.js') && after1.includes('<title>Kimi Code Web</title>'))
ok('资产目录被一并补齐', existsSync(path.join(dist, 'assets', 'kimi-chat', 'vcp-loader.js')))

// 2) 幂等：再跑一次不应改动
const mtime1 = readFileSync(path.join(dist, 'index.html'), 'utf8')
n = heal.healOne(dist) ? 1 : 0
ok('重复自愈不改动（幂等）', heal.healOne(dist) === false && readFileSync(path.join(dist, 'index.html'), 'utf8') === mtime1)

// 3) 模拟 kimi 启动还原（写回原始内容）→ 自愈必须补回来
writeFileSync(path.join(dist, 'index.html'), PRISTINE)
n = heal.healOne(dist) ? 1 : 0
ok('还原后能再次自愈', n === 1 && readFileSync(path.join(dist, 'index.html'), 'utf8').includes(MARKER))

// 4) 资产被清掉时也能恢复
rmSync(path.join(dist, 'assets', 'kimi-chat'), { recursive: true, force: true })
writeFileSync(path.join(dist, 'index.html'), PRISTINE)
n = heal.healOne(dist) ? 1 : 0
ok('资产被清 + 补丁被还原 → 一并恢复', n === 1
  && readFileSync(path.join(dist, 'index.html'), 'utf8').includes(MARKER)
  && existsSync(path.join(dist, 'assets', 'kimi-chat', 'vcp-render.js')))

// 5) 结构异常时不误伤
const weird = path.join(fakeHome, 'cache', 'web', '9.9.9', 'linux-x64', 'nope', 'dist-web')
mkdirSync(weird, { recursive: true })
writeFileSync(path.join(weird, 'index.html'), '<html>no head no body</html>')
const before = readFileSync(path.join(weird, 'index.html'), 'utf8')
heal.healOne(weird)
ok('无插入点的畸形 HTML 不被改动', readFileSync(path.join(weird, 'index.html'), 'utf8') === before)

rmSync(fakeHome, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
