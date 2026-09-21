/**
 * kimi-chat 回归测试：渲染开关降级 + 抽屉续聊跳转
 * 运行：NODE_PATH=<playwright所在node_modules> node tests/regression-browser.cjs [baseUrl]
 */
const { chromium } = require('playwright')

const BASE = process.argv[2] || 'http://127.0.0.1:58642'
const CARD = `<div id="vcp-root" style="background:#f5f2ef;color:#2b2b28;padding:20px;"><style>#vcp-root .t{font-size:18px;}</style><div class="t">降级测试卡</div></div>`

;(async () => {
  const token = require('fs').readFileSync(require('node:os').homedir() + '/.kimi-code/server.token', 'utf8').trim()
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', () => {})
  await page.addInitScript(() => { localStorage.setItem('kimi-web.onboarded', '1') })
  await page.goto(`${BASE}/#token=${token}`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(9000)

  let pass = 0, fail = 0
  const check = (n, c) => { c ? (pass++, console.log('  ok -', n)) : (fail++, console.log('  FAIL -', n)) }

  // 1) 关闭渲染开关 → vcp 块保持代码形态
  console.log('渲染开关关闭（优雅降级）:')
  await page.evaluate(() => localStorage.setItem('kimi-chat.render', '0'))
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(9000)
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
  }, CARD)
  await page.waitForTimeout(3000)
  const r1 = await page.evaluate(() => ({
    card: !!document.querySelector('[data-vcp-card]'),
    preLeft: !!document.querySelector('pre[data-language="vcp"]'),
  }))
  check('未渲染成卡片', r1.card === false)
  check('保持代码块展示', r1.preLeft === true)

  // 2) 打开渲染开关 → 同一内容渲染成卡片
  console.log('渲染开关打开:')
  await page.evaluate(() => localStorage.setItem('kimi-chat.render', '1'))
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(9000)
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
  }, CARD)
  await page.waitForTimeout(3000)
  const r2 = await page.evaluate(() => ({ card: !!document.querySelector('[data-vcp-card]') }))
  check('渲染成卡片', r2.card === true)

  // 3) 独立话题：种数据 → 抽屉列表 → 点击进入聊天视图 → 消息渲染
  console.log('独立话题面板:')
  const SVC = 'http://127.0.0.1:58931'
  const SVC_TOKEN = require('fs').readFileSync(require('node:os').homedir() + '/.kimi-code/server.token', 'utf8').trim()
  const AUTH = { Authorization: 'Bearer ' + SVC_TOKEN }
  const seed = await fetch(SVC + '/api/topics', { method: 'POST', headers: AUTH, body: '{}' }).then(r => r.json())
  await fetch(SVC + '/api/topics/' + seed.id + '/messages', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AUTH),
    body: JSON.stringify({ role: 'user', content: '回归测试消息一' }),
  })
  await fetch(SVC + '/api/topics/' + seed.id + '/messages', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, AUTH),
    body: JSON.stringify({ role: 'assistant', content: '回归测试**回复**一' }),
  })
  await fetch(SVC + '/api/topics/' + seed.id, {
    method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, AUTH),
    body: JSON.stringify({ title: '回归测试话题' }),
  })
  await page.evaluate(() => document.getElementById('kc-chat-btn').click())
  await page.waitForTimeout(2500)
  const r3 = await page.evaluate(() => {
    const root = document.getElementById('kc-module-host').shadowRoot
    const items = root.querySelectorAll('.kc-item')
    return { count: items.length, down: !root.querySelector('.kc-svcdown').hidden }
  })
  check('服务在线且列表有条目', r3.count > 0 && r3.down === false)
  await page.evaluate((id) => {
    const root = document.getElementById('kc-module-host').shadowRoot
    root.querySelector('.kc-item[data-id="' + id + '"] .kc-item-body').click()
  }, seed.id)
  await page.waitForTimeout(2000)
  const r4 = await page.evaluate(() => {
    const root = document.getElementById('kc-module-host').shadowRoot
    return {
      chatVisible: !root.querySelector('.kc-chat').hidden,
      bubbles: root.querySelectorAll('.kc-msg').length,
      mdBold: !!root.querySelector('.kc-msg-content b'),
      title: root.querySelector('.kc-chattitle').textContent,
    }
  })
  check('进入聊天视图', r4.chatVisible === true)
  check('历史消息渲染（2 条）', r4.bubbles === 2)
  check('Markdown 加粗渲染', r4.mdBold === true)
  check('标题显示', r4.title === '回归测试话题')

  // 4) 发送消息：流式回复 → 完整渲染 → 服务端落盘（用全新话题验证自动起名）
  console.log('流式对话（CLI 默认模型）:')
  const fresh = await fetch(SVC + '/api/topics', { method: 'POST', headers: AUTH, body: '{}' }).then(r => r.json())
  // 列表是模块打开时加载的，需重开模块刷新出新话题
  await page.evaluate(() => document.getElementById('kc-chat-btn').click()) // 关
  await page.waitForTimeout(600)
  await page.evaluate(() => document.getElementById('kc-chat-btn').click()) // 开
  await page.waitForTimeout(1800)
  await page.evaluate((id) => {
    const root = document.getElementById('kc-module-host').shadowRoot
    root.querySelector('.kc-item[data-id="' + id + '"] .kc-item-body').click()
  }, fresh.id)
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    const root = document.getElementById('kc-module-host').shadowRoot
    const input = root.querySelector('.kc-input')
    input.value = '只回复"回归通过"四个字，不要其他内容'
    root.querySelector('.kc-send').click()
  })
  let streamed = false
  for (let i = 0; i < 24; i++) { // 最多等 120s
    await page.waitForTimeout(5000)
    const st = await page.evaluate(() => {
      const root = document.getElementById('kc-module-host').shadowRoot
      const msgs = root.querySelectorAll('.kc-msg-ai .kc-msg-content')
      const last = msgs[msgs.length - 1]
      return { streaming: !!root.querySelector('.kc-streaming'), text: last ? last.textContent : '' }
    })
    if (!st.streaming && st.text.length > 0) { streamed = true; break }
  }
  check('收到流式回复并完成渲染', streamed === true)
  const persisted = await fetch(SVC + '/api/topics/' + fresh.id, { headers: AUTH }).then(r => r.json())
  check('服务端已落盘（2 条消息）', (persisted.messages || []).length === 2)
  check('自动起名生效', persisted.title && persisted.title !== '新话题')

  // 5) 开展会话：一键把话题带去真实会话（自动填入并发送 → 跳转 /sessions/<id>）
  console.log('开展会话桥:')
  await page.evaluate(() => {
    const root = document.getElementById('kc-module-host').shadowRoot
    root.querySelector('[data-act="promote"]').click()
  })
  await page.waitForTimeout(1200)
  const r5 = await page.evaluate(() => ({
    moduleClosed: document.getElementById('kc-module-host').style.display === 'none',
  }))
  check('模块已关闭', r5.moduleClosed === true)
  let sessionUrl = ''
  for (let i = 0; i < 15; i++) { // 等自动填入+发送 → 跳转新会话（最多 30s）
    await page.waitForTimeout(2000)
    sessionUrl = page.url()
    if (/\/sessions\//.test(sessionUrl)) break
  }
  check('已开展新会话（跳转 /sessions/<id>）', /\/sessions\//.test(sessionUrl))

  // 6) 搜索过滤
  console.log('话题搜索:')
  await page.evaluate(() => document.getElementById('kc-chat-btn').click())
  await page.waitForTimeout(2000)
  const r6 = await page.evaluate(() => {
    const root = document.getElementById('kc-module-host').shadowRoot
    const s = root.querySelector('.kc-search')
    s.value = 'zzz不存在的关键词zzz'
    s.dispatchEvent(new Event('input', { bubbles: true }))
    return { items: root.querySelectorAll('.kc-item').length, empty: !!root.querySelector('.kc-empty') };
  })
  check('无结果时显示空态', r6.items === 0 && r6.empty === true)

  // 清理测试话题
  await fetch(SVC + '/api/topics/' + seed.id, { method: 'DELETE', headers: AUTH })
  await fetch(SVC + '/api/topics/' + fresh.id, { method: 'DELETE', headers: AUTH })

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
