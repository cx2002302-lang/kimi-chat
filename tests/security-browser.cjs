/**
 * kimi-chat 安全测试（浏览器端，需要 Playwright + 运行中的 kimi web）
 * 运行：NODE_PATH=<playwright所在node_modules> node tests/security-browser.cjs [baseUrl]
 * 验证：非可信模式下 script/iframe/on 事件/javascript: 协议全部过滤；
 *       受控 onclick="input('...')" 桥保留；可信模式下闭合 script 执行。
 */
const { chromium } = require('playwright')

const BASE = process.argv[2] || 'http://127.0.0.1:58642'

const EVIL = `<div id="vcp-root" style="background:#fff;color:#222;padding:20px;">
<style>#vcp-root .t{font-size:18px;}</style>
<div class="t">安全测试卡</div>
<script>window.__vcpEvilRan = (window.__vcpEvilRan||0)+1; window.__vcpEvilDirect = true;</script>
<iframe src="https://evil.example.com"></iframe>
<object data="x"></object>
<embed src="x">
<img src="x" onerror="window.__vcpImgOnerror = true">
<a href="javascript:window.__vcpJsUrl = true">坏链接</a>
<a href="https://good.example.com">好链接</a>
<button onclick="input('受控桥')">受控按钮</button>
<button onclick="window.__vcpBtnHack = true">恶意按钮</button>
<svg onclick="window.__vcpSvgHack = true"><circle r="10"></circle></svg>
</div>`

const TRUSTED = `<div id="vcp-root" style="background:#fff;color:#222;padding:20px;">
<style>#vcp-root .t{font-size:18px;}</style>
<div class="t">可信模式测试</div>
<script>window.__vcpTrustedRanFlag = true;</script>
</div>`

;(async () => {
  const token = require('fs').readFileSync(require('node:os').homedir() + '/.kimi-code/server.token', 'utf8').trim()
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', () => {}) // resolveLanguage 噪音
  await page.addInitScript(() => { localStorage.setItem('kimi-web.onboarded', '1') })
  await page.goto(`${BASE}/#token=${token}`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(9000)

  async function injectCard(html) {
    await page.evaluate((h) => {
      const chat = document.querySelector('.chat') || document.body
      const container = document.createElement('div')
      container.className = 'code-block-container'
      container.setAttribute('data-markstream-code-block-state', 'settled')
      const pre = document.createElement('pre')
      pre.setAttribute('data-language', 'vcp')
      const code = document.createElement('code')
      code.textContent = h
      pre.appendChild(code)
      container.appendChild(pre)
      chat.appendChild(container)
    }, html)
    await page.waitForTimeout(2500)
  }

  let pass = 0, fail = 0
  function check(name, cond) {
    if (cond) { pass++; console.log('  ok -', name) }
    else { fail++; console.log('  FAIL -', name) }
  }

  // ---- 非可信模式 ----
  console.log('非可信模式（安全默认）:')
  await injectCard(EVIL)
  const r1 = await page.evaluate(() => {
    const cards = document.querySelectorAll('[data-vcp-card]')
    const c = cards[cards.length - 1] // 最后一张 = 刚注入的测试卡
    if (!c) return { noCard: true }
    return {
      scriptTags: c.querySelectorAll('script').length,
      iframe: c.querySelectorAll('iframe').length,
      objectEmbed: c.querySelectorAll('object,embed').length,
      jsUrlLinks: Array.from(c.querySelectorAll('a')).filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length,
      goodLink: Array.from(c.querySelectorAll('a')).some(a => a.getAttribute('href') === 'https://good.example.com'),
      controlledBtn: !!c.querySelector('button[onclick^="input("]'),
      evilBtn: Array.from(c.querySelectorAll('button')).some(b => /__vcpBtnHack/.test(b.getAttribute('onclick') || '')),
      svgHandler: Array.from(c.querySelectorAll('svg *')).some(el => el.getAttribute('onclick')),
      imgOnerror: !!c.querySelector('img[onerror]'),
      evilDirect: !!window.__vcpEvilDirect,
      evilRan: window.__vcpEvilRan || 0,
    }
  })
  check('卡片已渲染', !r1.noCard)
  check('script 被剥离', r1.scriptTags === 0)
  check('iframe 被剥离', r1.iframe === 0)
  check('object/embed 被剥离', r1.objectEmbed === 0)
  check('javascript: 链接被剥离', r1.jsUrlLinks === 0)
  check('https 链接保留', r1.goodLink === true)
  check('受控 onclick 桥保留', r1.controlledBtn === true)
  check('恶意 onclick 被剥离', r1.evilBtn === false)
  check('SVG on* 被剥离', r1.svgHandler === false)
  check('img onerror 被剥离', r1.imgOnerror === false)
  check('内联 script 未执行', r1.evilRan === 0 && r1.evilDirect === false)

  // ---- 可信模式 ----
  console.log('可信模式（显式开启）:')
  await page.evaluate(() => localStorage.setItem('kimi-chat.trusted', '1'))
  await injectCard(TRUSTED)
  await page.waitForTimeout(1500)
  const r2 = await page.evaluate(() => {
    const cards = document.querySelectorAll('[data-vcp-card]')
    return {
      scriptExecuted: window.__vcpTrustedRanFlag === true,
      scriptTags: cards.length ? cards[cards.length - 1].querySelectorAll('script').length : -1,
    }
  })
  check('可信模式闭合 script 执行', r2.scriptExecuted === true)
  check('可信模式 script 提取出 DOM（不重复渲染）', r2.scriptTags === 0)

  // ---- 还原 ----
  await page.evaluate(() => localStorage.setItem('kimi-chat.trusted', '0'))
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
