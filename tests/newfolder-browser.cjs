/**
 * kimi-chat 浏览器测试：「添加工作区」文件夹选择器的新建文件夹功能
 * 运行：NODE_PATH=<playwright所在node_modules> node tests/newfolder-browser.cjs [baseUrl]
 *
 * 依赖：kimi web 运行中；本机 Node 可读写 /tmp。
 * 用例会真的在 /tmp 下建目录（用完即删）。
 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')

const BASE = process.argv[2] || 'http://127.0.0.1:58627'
const NAME = 'kc-nf-e2e-' + Date.now().toString(36)
const DIR = '/tmp/' + NAME
const DIR2 = '/tmp/' + NAME + '-dup'

let pass = 0, fail = 0
const check = (n, c) => { c ? (pass++, console.log('  ok -', n)) : (fail++, console.log('  FAIL -', n)) }

/** 打开「添加工作区」对话框（需先开启侧边栏多标签，Workspaces 页才有 folder-plus 入口）。 */
async function openDialog(page) {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('aside.side *')].find(e => /^workspaces$/i.test((e.innerText || '').trim()) && e.children.length === 0)
    if (el) (el.closest('button,label,[role="radio"]') || el).click()
  })
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('aside.side button')].find(x => /new workspace/i.test(x.getAttribute('aria-label') || ''))
    if (btn) btn.click()
  })
  await page.waitForTimeout(2000)
}

/** 通过面包屑 + 目录行导航到绝对路径（逐级点击）。 */
async function navigateTo(page, target) {
  await page.evaluate(() => {
    const root = document.querySelector('.aw .crumbs .crumb')
    if (root) root.click()
  })
  await page.waitForTimeout(1200)
  const segs = target.split('/').filter(Boolean)
  for (const seg of segs) {
    const okGo = await page.evaluate((s) => {
      const row = [...document.querySelectorAll('.aw .folder-row')].find(r => (r.querySelector('.folder-name') || {}).textContent === s)
      if (!row) return false
      row.click(); return true
    }, seg)
    if (!okGo) throw new Error('导航失败，找不到子目录: ' + seg)
    await page.waitForTimeout(1200)
  }
}

async function openPopover(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('.kc-nf-btn')
    const pop = document.querySelector('.kc-nf-pop')
    if (btn && pop.hidden) btn.click()
  })
  await page.waitForTimeout(350)
}
async function typeAndSubmit(page, value) {
  await page.evaluate((v) => {
    const input = document.querySelector('.kc-nf-input')
    input.value = v
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }, value)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
}

;(async () => {
  const token = fs.readFileSync(os.homedir() + '/.kimi-code/server.token', 'utf8').trim()
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', () => {})
  await page.addInitScript(() => {
    localStorage.setItem('kimi-web.onboarded', '1')
    localStorage.setItem('kimi-web.sidebar-multi-tab', '1') // 打开 Workspaces 标签
  })
  await page.goto(`${BASE}/#token=${token}`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(9000)

  try {
    console.log('注入与基础交互:')
    await openDialog(page)
    const injected = await page.evaluate(() => {
      const bar = document.querySelector('.aw > .crumbbar > .kc-nf-bar')
      const list = document.querySelector('.aw > .folder-list')
      return { bar: !!bar, afterCrumbs: bar ? bar.previousElementSibling && bar.previousElementSibling.className : null, list: !!list }
    })
    check('按钮已注入 .crumbbar', injected.bar === true)
    check('注入在面包屑之后', /crumbs/.test(injected.afterCrumbs || ''))
    check('选择器仍可用', injected.list === true)
    check('样式表已注入', await page.evaluate(() => !!document.getElementById('kc-nf-style')))
    check('按钮默认可见', await page.evaluate(() => document.querySelector('.kc-nf-btn').offsetParent !== null))

    await page.evaluate(() => document.querySelector('.kc-nf-btn').click())
    await page.waitForTimeout(400)
    const pop = await page.evaluate(() => {
      const p = document.querySelector('.kc-nf-pop')
      const st = getComputedStyle(p)
      const crumbs = [...document.querySelectorAll('.aw .crumbs .crumb')].map(c => c.textContent.trim())
      return { hidden: p.hidden, w: p.getBoundingClientRect().width, dir: document.querySelector('.kc-nf-dir').innerText, lastCrumb: crumbs[crumbs.length - 1] || '', focused: document.activeElement === document.querySelector('.kc-nf-input') }
    })
    check('浮层已展开', pop.hidden === false)
    check('浮层宽度生效（样式表生效）', pop.w > 200)
    check('提示当前目录', pop.dir.includes(pop.lastCrumb) && pop.dir.includes('下新建'))
    check('输入框自动聚焦', pop.focused === true)

    console.log('校验:')
    await typeAndSubmit(page, '')
    check('空名称拦截', /请输入文件夹名称/.test(await page.evaluate(() => document.querySelector('.kc-nf-err').textContent)))
    await typeAndSubmit(page, 'a/b')
    check('含 / 拦截', /不能包含/.test(await page.evaluate(() => document.querySelector('.kc-nf-err').textContent)))
    await typeAndSubmit(page, '..')
    check('.. 拦截', /不能是 \. 或 \.\./.test(await page.evaluate(() => document.querySelector('.kc-nf-err').textContent)))
    check('拦截时未建目录', !fs.existsSync('/tmp/a') && !fs.existsSync(require('node:path').join(process.cwd(), 'a')))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Esc 可收起浮层', await page.evaluate(() => document.querySelector('.kc-nf-pop').hidden === true))

    console.log('创建:')
    await navigateTo(page, '/tmp')
    const at = await page.evaluate(() => document.querySelector('.crumbs .crumb.last').textContent.trim())
    check('导航到 /tmp', at === 'tmp')

    await openPopover(page)
    await typeAndSubmit(page, NAME)
    check('磁盘上目录已创建', fs.existsSync(DIR))
    const ui = await page.evaluate((n) => {
      const rows = [...document.querySelectorAll('.aw .folder-row')].map(r => (r.querySelector('.folder-name') || {}).textContent)
      return { rows, popHidden: document.querySelector('.kc-nf-pop').hidden, input: document.querySelector('.kc-nf-input').value }
    }, NAME)
    check('列表中已出现新目录', ui.rows.indexOf(NAME) !== -1)
    check('创建后浮层收起', ui.popHidden === true)
    check('创建后输入清空', ui.input === '')

    console.log('重名与后续动作:')
    fs.mkdirSync(DIR2, { recursive: true })
    await openPopover(page)
    await typeAndSubmit(page, NAME + '-dup')
    check('重名报错', /已存在/.test(await page.evaluate(() => document.querySelector('.kc-nf-err').textContent)))
    check('报错时浮层保持展开', await page.evaluate(() => document.querySelector('.kc-nf-pop').hidden === false))
    check('点到浮层外可收起', await (async () => {
      await page.evaluate(() => document.querySelector('.aw .folder-list').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
      await page.waitForTimeout(300)
      return page.evaluate(() => document.querySelector('.kc-nf-pop').hidden === true)
    })())

    const resumed = await page.evaluate((n) => {
      const row = [...document.querySelectorAll('.aw .folder-row')].find(r => (r.querySelector('.folder-name') || {}).textContent === n)
      if (!row) return false
      row.click(); return true
    }, NAME)
    await page.waitForTimeout(1200)
    check('可进入新建的目录', resumed === true && (await page.evaluate(() => document.querySelector('.crumbs .crumb.last').textContent.trim())) === NAME)
    check('进入后仍可再次新建', await page.evaluate(() => !!document.querySelector('.kc-nf-btn')))
    check('原有「Open this folder」未被破坏', await page.evaluate(() => {
      const b = document.querySelector('.aw .ui-button--primary')
      return !!b && !b.disabled && /Open this folder/.test(b.innerText)
    }))

    // 用「Cancel」收尾：不新增工作区，避免污染用户环境
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.aw .actions button')]
      const cancel = btns.find(b => /Cancel/.test(b.innerText))
      if (cancel) cancel.click()
    })
    await page.waitForTimeout(1500)
    check('「Cancel」仍可关闭对话框', await page.evaluate(() => !document.querySelector('.aw')))
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true })
    fs.rmSync(DIR2, { recursive: true, force: true })
    console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
    await browser.close()
    process.exit(fail ? 1 : 0)
  }
})().catch(e => { console.error(e); process.exit(1) })
