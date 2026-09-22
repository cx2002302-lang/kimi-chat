/*!
 * kimi-chat 主模块（Kimi Code Web UI 注入）v0.3.0
 * 功能：① 侧边栏「聊天」按钮 → 全屏「讨论空间」模块（复刻会话窗口形态）
 *       ② 话题管理：新建/搜索/置顶/重命名/删除/清空/生成图标/导出 Markdown
 *       ③ 讨论聊天：跟随 Kimi Code CLI 默认模型（本地服务代理，与会话同源），
 *          支持 Markdown / ```vcp HTML/SVG 视觉辅助 / /img 生图 / /tts 语音
 *       ④ 专用功能：开展会话（话题一键转为真实会话）/ 复制聊天ID / 复制引用
 *       ⑤ VCP 渲染开关（渲染 HTML / 美学注入 / 可信模式）
 *       ⑥ 会话消息区 ```vcp 代码块 → 视觉卡片渲染（观察器 + VCPRender 引擎）
 */
;(function () {
  'use strict'

  var VERSION = '0.6.2'
  // 服务地址跟随页面主机：本机浏览器→127.0.0.1，远程浏览器→服务器 IP（服务端有 token 认证）
  var SVC_DIRECT = location.protocol + '//' + location.hostname + ':58931'
  var SVC = SVC_DIRECT
  // 三级回退：① 同源反代入口（http://<host>:58931/ 打开 UI 时天然同源，任何 CSP/协议都能用）
  //           ② Service Worker 同源桥（secure context：localhost 或 https）
  //           ③ 直连 :58931（旧版 kimi web 无 CSP 时可跨端口）
  var svcReady = (async function () {
    try {
      var r = await fetch('/kc-api/health', { headers: svcHeaders() })
      var j = r.ok && (r.headers.get('content-type') || '').indexOf('json') !== -1 ? await r.json().catch(function () { return null }) : null
      if (j && j.ok === true && j.version) { SVC = location.origin + '/kc-api'; return true }
    } catch (e) {}
    SVC = SVC_DIRECT
    return false
  })()
  var MODULE_HASH = 'kc-chat'
  var LS = {
    render: 'kimi-chat.render',
    aesthetic: 'kimi-chat.aesthetic',
    trusted: 'kimi-chat.trusted'
  }

  function log() { if (typeof console !== 'undefined') console.debug.apply(console, ['[kimi-chat]'].concat([].slice.call(arguments))) }

  // ---------- 状态 ----------
  function lsGet(k, dft) { try { var v = localStorage.getItem(k); return v === null ? dft : v } catch (e) { return dft } }
  function lsSet(k, v) { try { localStorage.setItem(k, v) } catch (e) {} }
  // 默认值：渲染/美学默认开启；可信模式默认关闭（安全默认，仅放行受控 onclick 桥）。
  if (lsGet(LS.render, null) === null) lsSet(LS.render, '1')
  if (lsGet(LS.aesthetic, null) === null) lsSet(LS.aesthetic, '1')
  if (lsGet(LS.trusted, null) === null) lsSet(LS.trusted, '0')
  var state = {
    render: lsGet(LS.render, '1') === '1',
    aesthetic: lsGet(LS.aesthetic, '1') === '1',
    trusted: lsGet(LS.trusted, '0') === '1'
  }
  window.__vcpTrusted = function () { return lsGet(LS.trusted, '0') === '1' }

  function getToken() { return (window.__kcGetToken && window.__kcGetToken()) || null }

  // ---------- 字体注册 ----------
  function injectFonts() {
    if (document.getElementById('kc-fonts-link')) return
    var l = document.createElement('link')
    l.id = 'kc-fonts-link'
    l.rel = 'stylesheet'
    l.href = '/assets/kimi-chat/fonts/fonts.css'
    ;(document.head || document.documentElement).appendChild(l)
  }

  // ---------- vendor 资产按需加载 ----------
  var vendorLoading = {}
  function loadVendor(file) {
    var url = '/assets/kimi-chat/vendor/' + file
    if (vendorLoading[url]) return vendorLoading[url]
    vendorLoading[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script')
      s.src = url
      s.onload = function () { resolve() }
      s.onerror = function () { reject(new Error('vendor 加载失败: ' + file)) }
      ;(document.head || document.documentElement).appendChild(s)
    })
    return vendorLoading[url]
  }
  var vendorReady = null
  function ensureVendor() {
    if (vendorReady) return vendorReady
    // katex 样式（主文档）：缺失时 .katex-mathml 不隐藏，公式下方会多一行纯文本
    if (!document.querySelector('link[href="/assets/kimi-chat/vendor/katex.min.css"]')) {
      var kl = document.createElement('link')
      kl.rel = 'stylesheet'
      kl.href = '/assets/kimi-chat/vendor/katex.min.css'
      ;(document.head || document.documentElement).appendChild(kl)
    }
    // 必须顺序加载：auto-render 的 UMD 在执行时捕获 window.katex，
    // 与 katex.min.js 并行加载会捕获到 undefined（ParseError 崩溃）。
    vendorReady = loadVendor('katex.min.js')
      .then(function () { return loadVendor('auto-render.min.js') })
      .then(function () { return loadVendor('VCPColorEngine.js') })
      .then(function () { return loadVendor('mermaid.min.js') })
      .then(function () {
        try { window.VCPRender && window.VCPRender.warmupMermaid() } catch (e) {}
      })
      .catch(function (e) { log('vendor 加载异常（公式/图表/配色将降级）:', e.message) })
    return vendorReady
  }

  // ---------- 通用工具 ----------
  function relTime(iso) {
    var d = Date.now() - new Date(iso).getTime()
    var m = Math.floor(d / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return m + ' 分钟前'
    var h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时前'
    var dd = Math.floor(h / 24)
    if (dd < 30) return dd + ' 天前'
    return new Date(iso).toLocaleDateString()
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function toast(msg) {
    var t = document.createElement('div')
    t.setAttribute('style', 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:999999;background:rgba(20,24,30,.92);color:#fff;padding:9px 16px;border-radius:9px;font-size:12.5px;font-family:ui-sans-serif,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:340px;')
    t.textContent = msg
    document.body.appendChild(t)
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s' }, 1800)
    setTimeout(function () { t.remove() }, 2200)
  }
  function copyText(text, hint) {
    function done() { toast(hint || '已复制到剪贴板') }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacy() })
    } else legacy()
    function legacy() {
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('style', 'position:fixed;opacity:0')
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
        done()
      } catch (e) { toast('复制失败，请手动复制') }
    }
  }

  // ---------- Markdown 渲染（安全：先转义再套格式；```vcp 块走 VCP 引擎） ----------
  function mdRender(src) {
    var blocks = []
    var s = String(src == null ? '' : src)
    // 1) 抽出围栏代码块（vcp / 普通），避免内联规则污染
    s = s.replace(/```(\w*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, function (m, lang, code) {
      blocks.push({ lang: (lang || '').toLowerCase(), code: code.replace(/\n$/, '') })
      return '\n\u0000B' + (blocks.length - 1) + '\u0000\n'
    })
    // 2) 全文转义
    s = esc(s)
    // 3) 行内格式（作用于已转义文本）
    s = s.replace(/`([^`\n]+)`/g, '<code class="kc-ic">$1</code>')
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    // 4) 块级：按行分组
    var lines = s.split('\n')
    var html = ''
    var para = []
    var list = null
    function flushPara() {
      if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = [] }
    }
    function flushList() {
      if (list) { html += '<' + list.tag + '><li>' + list.items.join('</li><li>') + '</li></' + list.tag + '>'; list = null }
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i]
      var mb = /^\s*\u0000B(\d+)\u0000\s*$/.exec(ln)
      if (mb) {
        flushPara(); flushList()
        var blk = blocks[+mb[1]]
        if (blk.lang === 'vcp') html += '<div class="kc-vcp-slot" data-vi="' + mb[1] + '"></div>'
        else html += '<pre class="kc-code"' + (blk.lang ? ' data-lang="' + esc(blk.lang) + '"' : '') + '><code>' + blk.code + '</code></pre>'
        continue
      }
      var mh = /^(#{1,4})\s+(.*)$/.exec(ln)
      if (mh) { flushPara(); flushList(); var lv = mh[1].length; html += '<h' + lv + ' class="kc-h">' + mh[2] + '</h' + lv + '>'; continue }
      var mul = /^\s*[-*]\s+(.*)$/.exec(ln)
      if (mul) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] } } list.items.push(mul[1]); continue }
      var mol = /^\s*\d+[.、]\s+(.*)$/.exec(ln)
      if (mol) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] } } list.items.push(mol[1]); continue }
      var mq = /^&gt;\s?(.*)$/.exec(ln)
      if (mq) { flushPara(); flushList(); html += '<blockquote class="kc-q">' + mq[1] + '</blockquote>'; continue }
      // Markdown 表格：表头行 + 分隔行（|---|---|）触发表格模式
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        flushPara(); flushList()
        var splitRow = function (row) { return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim() }) }
        var heads = splitRow(ln)
        var rows = []
        i += 2
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++ }
        i--
        html += '<table><thead><tr><th>' + heads.join('</th><th>') + '</th></tr></thead><tbody>'
        for (var ri = 0; ri < rows.length; ri++) html += '<tr><td>' + rows[ri].join('</td><td>') + '</td></tr>'
        html += '</tbody></table>'
        continue
      }
      // 分割线
      if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) { flushPara(); flushList(); html += '<hr>'; continue }
      if (/^\s*$/.test(ln)) { flushPara(); flushList(); continue }
      para.push(ln)
    }
    flushPara(); flushList()
    return { html: html, blocks: blocks }
  }
  // 把容器里的 .kc-vcp-slot 替换为渲染后的 VCP 卡片（开关关闭/引擎缺失时降级为源码）
  function hydrateVcpSlots(container) {
    var slots = container.querySelectorAll('.kc-vcp-slot')
    for (var i = 0; i < slots.length; i++) {
      ;(function (slot) {
        var raw = ''
        try {
          var idx = +slot.getAttribute('data-vi')
          var payload = container.__vcpBlocks && container.__vcpBlocks[idx]
          raw = payload ? payload.code : ''
        } catch (e) {}
        if (!raw || !state.render || !window.VCPRender) {
          var pre = document.createElement('pre')
          pre.className = 'kc-code'
          pre.innerHTML = '<code>' + esc(raw || '（vcp 块）') + '</code>'
          slot.replaceWith(pre)
          return
        }
        try {
          var frag = window.VCPRender.render(raw)
          if (!frag) throw new Error('empty')
          var wrap = document.createElement('div')
          wrap.className = 'vcp-card'
          wrap.setAttribute('data-vcp-card', '1')
          wrap.appendChild(frag)
          slot.replaceWith(wrap)
          ensureVendor().then(function () { window.VCPRender.enhance(wrap) })
        } catch (err) {
          var pre2 = document.createElement('pre')
          pre2.className = 'kc-code'
          pre2.innerHTML = '<code>' + esc(raw) + '</code>'
          slot.replaceWith(pre2)
        }
      })(slots[i])
    }
  }
  // 渲染一条消息内容到元素（assistant: markdown+vcp；user: 纯文本）
  function renderInto(el, msg) {
    el.innerHTML = ''
    el.__vcpBlocks = null
    if (msg.role === 'assistant') {
      var r = mdRender(msg.content)
      el.__vcpBlocks = r.blocks
      el.innerHTML = r.html
      hydrateVcpSlots(el)
    } else {
      el.textContent = msg.content || ''
    }
    for (var i = 0; i < (msg.images || []).length; i++) {
      var img = document.createElement('img')
      img.className = 'kc-msg-img'
      img.src = svcUrl(msg.images[i])
      img.alt = '生成图像'
      el.appendChild(img)
    }
    for (var a = 0; a < (msg.audios || []).length; a++) {
      var au = document.createElement('audio')
      au.className = 'kc-msg-audio'
      au.controls = true
      au.src = svcUrl(msg.audios[a])
      au.style.cssText = 'display:block;margin-top:8px;width:100%;max-width:420px;'
      el.appendChild(au)
    }
  }

  // ---------- 本地服务 API ----------
  function svcHeaders(json) {
    var h = {}
    if (json) h['Content-Type'] = 'application/json'
    var t = getToken()
    if (t) h.Authorization = 'Bearer ' + t
    return h
  }
  // <img>/下载等无法带 Authorization 头的场景：token 走 query（服务端仅 GET 接受）
  function svcUrl(path) {
    var t = getToken()
    return SVC + path + (t ? (path.indexOf('?') === -1 ? '?' : '&') + 'access_token=' + encodeURIComponent(t) : '')
  }
  function svcOk() {
    return svcReady.then(function () {
      return fetch(SVC + '/api/health', { method: 'GET', headers: svcHeaders() })
    })
      .then(function (r) { return r.json() })
      .then(function (j) { return j && j.ok ? j : null })
      .catch(function () { return null })
  }
  function svcJson(path, opts) {
    opts = opts || {}
    opts.headers = Object.assign(svcHeaders(!!opts.body), opts.headers || {})
    return svcReady.then(function () {
      return fetch(SVC + path, opts)
    }).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
        return j
      })
    })
  }

  // ---------- 「聊天」按钮 ----------
  var BTN_STYLE = [
    'display:flex', 'align-items:center', 'gap:7px',
    'width:calc(100% - 16px)', 'margin:2px 8px 6px', 'padding:7px 12px',
    'border:1px solid var(--kc-border,rgba(128,128,128,.35))', 'border-radius:9px',
    'background:var(--kc-btn-bg,rgba(128,128,128,.08))', 'color:inherit',
    'font-size:13px', 'cursor:pointer', 'text-align:left',
    'transition:background .15s,border-color .15s'
  ].join(';')
  var CHAT_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  function ensureButton() {
    if (document.getElementById('kc-chat-btn')) return
    var anchor = document.querySelector('.btn-new-chat')
    if (!anchor || !anchor.parentElement) return
    var btn = document.createElement('button')
    btn.id = 'kc-chat-btn'
    btn.type = 'button'
    btn.title = '讨论空间（kimi-chat）'
    btn.setAttribute('style', BTN_STYLE)
    btn.innerHTML = CHAT_SVG + '<span>聊天</span>'
    btn.addEventListener('mouseenter', function () { btn.style.background = 'var(--kc-btn-bg-hover,rgba(128,128,128,.18))' })
    btn.addEventListener('mouseleave', function () { btn.style.background = 'var(--kc-btn-bg,rgba(128,128,128,.08))' })
    btn.addEventListener('click', function () { chatModule.toggle() })
    anchor.parentElement.insertBefore(btn, anchor.nextSibling)
    // 生成图标就绪后替换 SVG（模块图标，随插件打包）
    var probe = new Image()
    probe.onload = function () {
      if (!btn.isConnected) return
      var svg = btn.querySelector('svg')
      if (!svg) return
      var img = document.createElement('img')
      img.src = '/assets/kimi-chat/img/icon.png'
      img.alt = ''
      img.setAttribute('style', 'width:16px;height:16px;border-radius:4px;flex:none;object-fit:cover')
      svg.replaceWith(img)
    }
    probe.src = '/assets/kimi-chat/img/icon.png'
    log('聊天按钮已注入')
  }

  // ---------- 全屏「讨论空间」模块（Shadow DOM） ----------
  var chatModule = (function () {
    var host = null, root = null
    var open = false, filter = ''
    var topics = []
    var cur = null // 当前打开的话题（完整对象）
    var busy = false, aborter = null
    var els = {}
    // 界面偏好（来自服务端 /api/config 的 ui 块，设置页可改）
    var uiCfg = { card_style: 'editorial', color_mode: 'auto', think_collapse: true, right_rail: true }
    var railHidden = lsGet('kc.railhidden', '0') === '1'

    function build() {
      host = document.createElement('div')
      host.id = 'kc-module-host'
      host.setAttribute('style', 'position:fixed;inset:0;z-index:99980;display:none;')
      root = host.attachShadow({ mode: 'open' })
      var link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = '/assets/kimi-chat/vcp-chat.css'
      root.appendChild(link)
      // katex 样式必须进 shadow root，否则 .katex-mathml 不隐藏，公式下方多一行纯文本
      var klink = document.createElement('link')
      klink.rel = 'stylesheet'
      klink.href = '/assets/kimi-chat/vendor/katex.min.css'
      root.appendChild(klink)
      // 设置表单样式（与注入 kimi 设置页的表单共用）
      var fstyle = document.createElement('style')
      fstyle.textContent = KC_FORM_CSS
      root.appendChild(fstyle)
      var panel = document.createElement('div')
      panel.className = 'kc-module'
      panel.innerHTML =
        // ---- 左侧话题栏 ----
        '<div class="kc-rail">' +
        '  <div class="kc-rail-head">' +
        '    <img class="kc-rail-icon" src="/assets/kimi-chat/img/icon.png" alt="" onerror="this.style.display=\'none\'">' +
        '    <span class="kc-rail-title">聊天</span>' +
        '    <span class="kc-rail-sub">讨论空间</span>' +
        '    <button class="kc-icon-btn kc-rail-close" data-act="close" title="关闭（Esc）">✕</button>' +
        '  </div>' +
        '  <button class="kc-newtopic" data-act="new">＋ 新建话题</button>' +
        '  <div class="kc-searchwrap"><input class="kc-search" type="text" placeholder="搜索话题…" spellcheck="false"></div>' +
        '  <div class="kc-list" role="list"></div>' +
        '  <div class="kc-svcdown" hidden>' +
        '    <div class="kc-svcdown-title">连不上本地服务</div>' +
        '    <div class="kc-svcdown-tip">讨论空间需要 kimi-chat 本地服务。<br>' +
        '新版 kimi web 的安全策略（CSP）禁止页面跨端口直连，请改用统一入口打开：<br>' +
        '<code>http://' + location.hostname + ':58931/</code>（带上原页面的 token）<br>' +
        '或确认服务在运行：<code>node ~/.kimi-code/plugins/managed/kimi-chat/installer/watch.cjs status</code></div>' +
        '    <button class="kc-btn" data-act="retry">重试连接</button>' +
        '  </div>' +
        '  <div class="kc-rail-foot">' +
        '    <div class="kc-toggles">' +
        '      <label class="kc-toggle"><input type="checkbox" data-k="render"><span class="kc-switch"></span><span class="kc-tlabel">渲染 HTML</span></label>' +
        '      <label class="kc-toggle"><input type="checkbox" data-k="aesthetic"><span class="kc-switch"></span><span class="kc-tlabel">美学注入</span></label>' +
        '      <label class="kc-toggle kc-trusted"><input type="checkbox" data-k="trusted"><span class="kc-switch"></span><span class="kc-tlabel">可信模式<em>（允许执行卡片脚本，慎用）</em></span></label>' +
        '    </div>' +
        '    <div class="kc-status"></div>' +
        '    <div class="kc-ver"><button class="kc-setgear" data-act="settings" title="插件设置">⚙️</button> kimi-chat v' + VERSION + '</div>' +
        '  </div>' +
        '</div>' +
        // ---- 主区（复刻会话窗口形态） ----
        '<div class="kc-main">' +
        '  <div class="kc-welcome">' +
        '    <img class="kc-welcome-img" src="/assets/kimi-chat/img/empty.png" alt="">' +
        '    <div class="kc-welcome-title">讨论空间</div>' +
        '    <div class="kc-welcome-sub">讨论问题为主 —— 助手会用 HTML / SVG / 图表帮你把问题看清楚。<br>从左侧选择一个话题，或新建一个开始。</div>' +
        '    <button class="kc-btn kc-welcome-new" data-act="new">＋ 新建话题</button>' +
        '  </div>' +
        '  <div class="kc-chat" hidden>' +
        '    <header class="kc-chat-head">' +
        '      <div class="kc-head-col">' +
        '        <span class="kc-chattitle" title="双击重命名"></span>' +
        '        <div class="kc-chat-actions">' +
        '          <button class="kc-hbtn kc-hbtn-primary" data-act="promote" title="以此话题开展一个新的 Kimi Code 会话">⇗ 开展会话</button>' +
        '          <button class="kc-hbtn" data-act="copyid" title="复制聊天 ID">⧉ 聊天ID</button>' +
        '          <button class="kc-hbtn" data-act="export" title="导出 Markdown">⤓ 导出</button>' +
        '          <button class="kc-hbtn" data-act="clear" title="清空消息">🗑 清空</button>' +
        '        </div>' +
        '      </div>' +
        '      <button class="kc-icon-btn kc-rail-toggle" data-act="railtoggle" title="显示/隐藏信息栏">☰</button>' +
        '    </header>' +
        '    <div class="kc-body">' +
        '      <div class="kc-col">' +
        '        <div class="kc-msgs"></div>' +
        '        <div class="kc-composer-wrap">' +
        '          <div class="kc-composer">' +
        '            <textarea class="kc-input" rows="2" placeholder="讨论点什么… Enter 发送 / Shift+Enter 换行；/img 生图、/tts 语音"></textarea>' +
        '            <button class="kc-send" data-act="send" title="发送">↑</button>' +
        '            <button class="kc-stop" data-act="stop" title="停止" hidden>■</button>' +
        '          </div>' +
        '          <div class="kc-composer-hint">' +
        '            <button class="kc-model-btn" data-act="model" title="选择模型与思考强度（与会话同源）"></button>' +
        '            <span class="kc-hint-text">可生成 HTML/SVG 视觉辅助 · 编程任务请开会话</span>' +
        '          </div>' +
        '        </div>' +
        '      </div>' +
        // ---- 右侧信息栏（复刻会话窗口右栏：信息 / 自动归纳 / 快捷操作） ----
        '      <aside class="kc-rightrail">' +
        '        <section class="kc-rr-sec"><h4>话题信息</h4><div class="kc-rr-info"></div></section>' +
        '        <section class="kc-rr-sec"><h4>自动归纳</h4><div class="kc-rr-outline"></div></section>' +
        '        <section class="kc-rr-sec"><h4>快捷操作</h4><div class="kc-rr-actions">' +
        '          <button class="kc-rr-btn" data-act="promote">⇗ 开展会话</button>' +
        '          <button class="kc-rr-btn" data-act="copyid">⧉ 复制聊天 ID</button>' +
        '          <button class="kc-rr-btn" data-act="export">⤓ 导出 Markdown</button>' +
        '          <button class="kc-rr-btn" data-act="imgfill">🎨 生图（填入 /img）</button>' +
        '          <button class="kc-rr-btn" data-act="ttsfill">🔊 语音（填入 /tts）</button>' +
        '          <button class="kc-rr-btn" data-act="settings">⚙️ 插件设置</button>' +
        '        </div></section>' +
        '      </aside>' +
        '    </div>' +
        '  </div>' +
        '</div>' +
        // ---- 话题项菜单（浮层） ----
        '<div class="kc-menu" hidden>' +
        '  <button data-mact="promote">⇗ 开展会话</button>' +
        '  <button data-mact="copyid">⧉ 复制聊天 ID</button>' +
        '  <button data-mact="copyref">📋 复制话题引用</button>' +
        '  <button data-mact="export">⤓ 导出 Markdown</button>' +
        '  <button data-mact="icon">🎨 生成话题图标</button>' +
        '  <button data-mact="pin">📌 置顶 / 取消置顶</button>' +
        '  <button data-mact="rename">✏️ 重命名</button>' +
        '  <button data-mact="clear">🧹 清空消息</button>' +
        '  <button data-mact="delete" class="kc-danger">🗑 删除话题</button>' +
        '</div>' +
        // ---- 模型/思考强度选择浮层 ----
        '<div class="kc-modelpop" hidden>' +
        '  <div class="kc-mp-sec kc-mp-eff-sec">思考强度</div>' +
        '  <div class="kc-mp-efforts"></div>' +
        '  <div class="kc-mp-sec">模型（与会话同源）</div>' +
        '  <div class="kc-mp-models"></div>' +
        '</div>' +
        // ---- 插件设置弹窗（与 kimi 设置页里的 kimi-chat 页签共用同一个表单） ----
        '<div class="kc-setmask" hidden>' +
        '  <div class="kc-setdlg" role="dialog" aria-label="kimi-chat 设置">' +
        '    <header class="kc-sethead"><span>⚙️ kimi-chat 设置</span>' +
        '      <button class="kc-icon-btn" data-act="setclose" title="关闭">✕</button></header>' +
        '    <div class="kc-setbody"></div>' +
        '  </div>' +
        '</div>'
      root.appendChild(panel)
      document.body.appendChild(host)

      els.list = root.querySelector('.kc-list')
      els.search = root.querySelector('.kc-search')
      els.svcdown = root.querySelector('.kc-svcdown')
      els.welcome = root.querySelector('.kc-welcome')
      els.chat = root.querySelector('.kc-chat')
      els.chattitle = root.querySelector('.kc-chattitle')
      els.msgs = root.querySelector('.kc-msgs')
      els.input = root.querySelector('.kc-input')
      els.send = root.querySelector('.kc-send')
      els.stop = root.querySelector('.kc-stop')
      els.menu = root.querySelector('.kc-menu')
      els.status = root.querySelector('.kc-status')
      els.modelbtn = root.querySelector('.kc-model-btn')
      els.modelpop = root.querySelector('.kc-modelpop')
      els.mpEfforts = root.querySelector('.kc-mp-efforts')
      els.mpEffSec = root.querySelector('.kc-mp-eff-sec')
      els.mpModels = root.querySelector('.kc-mp-models')
      els.rightrail = root.querySelector('.kc-rightrail')
      els.rrInfo = root.querySelector('.kc-rr-info')
      els.rrOutline = root.querySelector('.kc-rr-outline')
      els.setmask = root.querySelector('.kc-setmask')
      els.setbody = root.querySelector('.kc-setbody')

      els.search.addEventListener('input', function () { filter = els.search.value.trim().toLowerCase(); renderList() })
      panel.addEventListener('click', onClick)
      // 聊天区内 VCP 卡片按钮：填入讨论输入框（而非 kimi composer）
      els.msgs.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[onclick^="input("]') : null
        if (!el) return
        var m = /^input\(\s*(['"])([\s\S]*)\1\s*\)$/.exec(el.getAttribute('onclick') || '')
        if (!m) return
        e.preventDefault(); e.stopPropagation()
        els.input.value = m[2]
        els.input.focus()
        autosize()
      }, true)
      els.chattitle.addEventListener('dblclick', function () { if (cur) renameTopic(cur.id) })
      els.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat() }
      })
      els.input.addEventListener('input', autosize)
      // 菜单/浮层外点击关闭
      document.addEventListener('mousedown', function (e) {
        var path = e.composedPath()
        if (!els.menu.hidden && !path.some(function (n) { return n === els.menu })) els.menu.hidden = true
        if (!els.modelpop.hidden && !path.some(function (n) { return n === els.modelpop || n === els.modelbtn })) els.modelpop.hidden = true
      })
      // Esc 关闭（设置弹窗优先）
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || !open) return
        if (els.setmask && !els.setmask.hidden) { closeSettings(); return }
        close()
      })
      // 开关
      Array.prototype.forEach.call(root.querySelectorAll('[data-k]'), function (cb) {
        var k = cb.getAttribute('data-k')
        cb.checked = state[k]
        cb.addEventListener('change', function () {
          state[k] = cb.checked
          lsSet(LS[k], cb.checked ? '1' : '0')
          if (k === 'render' && !cb.checked) {
            var aes = root.querySelector('[data-k="aesthetic"]')
            if (aes && aes.checked) { aes.checked = false; state.aesthetic = false; lsSet(LS.aesthetic, '0') }
          }
          log('开关', k, '=', cb.checked)
        })
      })
    }
    function autosize() {
      els.input.style.height = 'auto'
      els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px'
    }

    // ---------- 事件分发 ----------
    function onClick(e) {
      if (e.target === els.setmask) { closeSettings(); return }
      var actBtn = e.target.closest('[data-act]')
      if (actBtn) {
        var act = actBtn.getAttribute('data-act')
        if (act === 'close') close()
        else if (act === 'new') createTopic()
        else if (act === 'refresh') loadTopics()
        else if (act === 'retry') checkAndLoad()
        else if (act === 'send') sendChat()
        else if (act === 'stop') stopChat()
        else if (act === 'promote' && cur) promote(cur.id)
        else if (act === 'copyid' && cur) copyText(cur.id, '聊天 ID 已复制：' + cur.id)
        else if (act === 'export' && cur) exportTopic(cur.id)
        else if (act === 'clear' && cur) clearTopic(cur.id)
        else if (act === 'model') toggleModelPop()
        else if (act === 'settings') openSettings()
        else if (act === 'setclose') closeSettings()
        else if (act === 'railtoggle') toggleRail()
        else if (act === 'imgfill') { els.input.value = '/img '; els.input.focus(); autosize() }
        else if (act === 'ttsfill') { els.input.value = '/tts '; els.input.focus(); autosize() }
        return
      }
      var saveBtn = e.target.closest('[data-sact]')
      if (saveBtn) { onSettingsAction(saveBtn.getAttribute('data-sact')); return }
      var rrQ = e.target.closest('.kc-rr-q')
      if (rrQ) {
        var node = els.msgs.children[+rrQ.getAttribute('data-dom')]
        if (node && node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      var rrC = e.target.closest('[data-copyid]')
      if (rrC) { copyText(rrC.getAttribute('data-copyid'), '聊天 ID 已复制'); return }
      var effBtn = e.target.closest('[data-eff]')
      if (effBtn) { selectEffort(effBtn.getAttribute('data-eff')); return }
      var mdlBtn = e.target.closest('[data-mdl]')
      if (mdlBtn) { selectModel(mdlBtn.getAttribute('data-mdl')); return }
      var menuBtn = e.target.closest('.kc-item-menu')
      if (menuBtn) { e.stopPropagation(); openMenu(menuBtn); return }
      var mactBtn = e.target.closest('[data-mact]')
      if (mactBtn) { onMenuAction(mactBtn.getAttribute('data-mact')); return }
      var item = e.target.closest('.kc-item')
      if (item) openChat(item.getAttribute('data-id'))
    }

    // ---------- 话题列表 ----------
    function checkAndLoad() {
      svcOk().then(function (h) {
        if (!h) {
          els.list.innerHTML = ''
          els.svcdown.hidden = false
          els.status.textContent = '服务离线'
          // 新版 kimi web 的 CSP 禁止跨端口直连，服务本身正常时自动跳到统一入口（保留 token hash）
          if (location.port !== '58931') {
            var tip = els.svcdown.querySelector('.kc-svcdown-tip')
            if (tip) tip.innerHTML = '新版 kimi web 的安全策略（CSP）禁止页面跨端口直连。<br>正在带你跳到统一入口（自动带上 token）…'
            setTimeout(function () {
              // hash 里没 token 时，从本源 localStorage（kimi-web 已记住的凭证）捎上，
              // 这样只需跳一次，统一入口以后也记住登录态
              var hash = location.hash || ''
              if (hash.indexOf('token=') === -1) {
                var t = getToken()
                if (t) hash = '#token=' + encodeURIComponent(t)
              }
              location.replace(location.protocol + '//' + location.hostname + ':58931/' + hash)
            }, 1200)
          }
          return
        }
        els.svcdown.hidden = true
        els.status.textContent = (h.chat ? h.chat.model : '聊天后端未配置') + (h.image ? ' · 生图✓' : '') + (h.tts ? ' · 语音✓' : '')
        if (h.chat_error) els.status.textContent = '聊天后端异常'
        // 拉取界面偏好（答复样式/配色/思考折叠/右栏）
        svcJson('/api/config').then(function (cj) {
          if (cj && cj.ui) { uiCfg = Object.assign(uiCfg, cj.ui); applyUiCfg() }
        }).catch(function () {})
        loadTopics()
      })
    }
    function loadTopics() {
      svcJson('/api/topics').then(function (j) {
        topics = j.items || []
        renderList()
      }).catch(function (e) { log('话题列表失败:', e.message) })
    }
    function iconHtml(t) {
      if (t.icon && t.icon.charAt(0) === '/') return '<img class="kc-item-icon-img" src="' + esc(svcUrl(t.icon)) + '" alt="">'
      return '<span class="kc-item-icon-emoji">' + esc(t.icon || '💬') + '</span>'
    }
    function renderList() {
      var kw = filter
      var filtered = topics.filter(function (t) {
        if (!kw) return true
        return ((t.title || '') + ' ' + (t.preview || '')).toLowerCase().indexOf(kw) !== -1
      })
      if (!filtered.length) {
        els.list.innerHTML = '<div class="kc-empty">' + (topics.length ? '没有匹配的话题' : '还没有话题，点上方「＋ 新建话题」开始') + '</div>'
        return
      }
      var html = ''
      filtered.forEach(function (t) {
        html += '<div class="kc-item" data-id="' + esc(t.id) + '" role="listitem" tabindex="0">' +
          '<div class="kc-item-icon">' + iconHtml(t) + '</div>' +
          '<div class="kc-item-body">' +
          '  <div class="kc-item-title">' + (t.pinned ? '<span class="kc-pin">📌</span>' : '') + esc(t.title || '（未命名）') + '</div>' +
          '  <div class="kc-item-meta">' + relTime(t.updated_at) + ' · ' + (t.message_count || 0) + ' 条</div>' +
          (t.preview ? '<div class="kc-item-preview">' + esc(t.preview) + '</div>' : '') +
          '</div>' +
          '<button class="kc-item-menu" title="更多操作">⋯</button>' +
          '</div>'
      })
      els.list.innerHTML = html
    }
    function createTopic() {
      svcJson('/api/topics', { method: 'POST', body: '{}' })
        .then(function (t) { loadTopics(); openChat(t.id) })
        .catch(function (e) { toast('创建失败：' + e.message) })
    }

    // ---------- 话题项菜单 ----------
    var menuTopicId = null
    function openMenu(btn) {
      menuTopicId = btn.closest('.kc-item').getAttribute('data-id')
      var br = btn.getBoundingClientRect()
      var hr = host.getBoundingClientRect()
      els.menu.style.top = Math.min(br.bottom + 2, hr.height - 260) + 'px'
      els.menu.style.left = Math.max(br.left - 120, 8) + 'px'
      els.menu.hidden = false
    }
    function onMenuAction(act) {
      els.menu.hidden = true
      var id = menuTopicId
      if (!id) return
      if (act === 'promote') promote(id)
      else if (act === 'copyid') copyText(id, '聊天 ID 已复制：' + id)
      else if (act === 'copyref') copyRef(id)
      else if (act === 'export') exportTopic(id)
      else if (act === 'icon') genIcon(id)
      else if (act === 'pin') togglePin(id)
      else if (act === 'rename') renameTopic(id)
      else if (act === 'clear') clearTopic(id)
      else if (act === 'delete') deleteTopic(id)
    }
    function findTopic(id) {
      for (var i = 0; i < topics.length; i++) if (topics[i].id === id) return topics[i]
      return null
    }
    function renameTopic(id) {
      var t = findTopic(id) || cur || {}
      var name = window.prompt('话题名称：', t.title || '')
      if (!name || !name.trim()) return
      svcJson('/api/topics/' + id, { method: 'PATCH', body: JSON.stringify({ title: name.trim() }) })
        .then(function () {
          if (cur && cur.id === id) { cur.title = name.trim(); els.chattitle.textContent = cur.title }
          loadTopics()
        })
        .catch(function (e) { toast('重命名失败：' + e.message) })
    }
    function deleteTopic(id) {
      var t = findTopic(id) || {}
      if (!window.confirm('删除话题「' + (t.title || id) + '」？此操作不可恢复。')) return
      svcJson('/api/topics/' + id, { method: 'DELETE' })
        .then(function () { if (cur && cur.id === id) showWelcome(); loadTopics(); toast('已删除') })
        .catch(function (e) { toast('删除失败：' + e.message) })
    }
    function clearTopic(id) {
      var t = findTopic(id) || cur || {}
      if (!window.confirm('清空话题「' + (t.title || id) + '」的全部消息？')) return
      svcJson('/api/topics/' + id + '/messages', { method: 'DELETE' })
        .then(function () { if (cur && cur.id === id) { cur.messages = []; renderMessages() } loadTopics(); toast('已清空') })
        .catch(function (e) { toast('清空失败：' + e.message) })
    }
    function togglePin(id) {
      var t = findTopic(id)
      svcJson('/api/topics/' + id, { method: 'PATCH', body: JSON.stringify({ pinned: !(t && t.pinned) }) })
        .then(loadTopics)
        .catch(function (e) { toast('操作失败：' + e.message) })
    }
    function genIcon(id) {
      var t = findTopic(id) || {}
      toast('正在生成图标…')
      svcJson('/api/image', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'minimalist flat app icon, soft gradient background, a simple symbol representing "' + String(t.title || 'chat').replace(/"/g, '') + '", centered, no text', aspect_ratio: '1:1' })
      }).then(function (j) {
        return svcJson('/api/topics/' + id, { method: 'PATCH', body: JSON.stringify({ icon: j.url }) })
      }).then(function () { loadTopics(); toast('图标已更新') })
        .catch(function (e) { toast('图标生成失败：' + e.message) })
    }
    function exportTopic(id) {
      window.open(svcUrl('/api/topics/' + id + '/export'), '_blank')
    }

    // ---------- 模型 / 思考强度选择（与会话同源：/api/models ← CLI config.toml） ----------
    var modelsData = null, modelsAt = 0
    function loadModels(force) {
      if (!force && modelsData && Date.now() - modelsAt < 60000) return Promise.resolve(modelsData)
      return svcJson('/api/models').then(function (j) {
        modelsData = j
        modelsAt = Date.now()
        updateModelBtn()
        return j
      }).catch(function () { return modelsData })
    }
    function curModelId() {
      return (cur && cur.model) || (modelsData && modelsData.default_model) || ''
    }
    function curEntry() {
      if (!modelsData) return null
      var id = curModelId()
      for (var i = 0; i < modelsData.items.length; i++) if (modelsData.items[i].id === id) return modelsData.items[i]
      return null
    }
    function curEffort() {
      var e = curEntry()
      return (cur && cur.effort) || (e && e.default_effort) || ''
    }
    function updateModelBtn() {
      if (!els.modelbtn) return
      var e = curEntry()
      var label = e ? e.display_name : (curModelId() || '默认模型')
      var eff = curEffort()
      els.modelbtn.textContent = '🧠 ' + label + (eff ? ' · ' + eff : '') + ' ▾'
    }
    function toggleModelPop() {
      if (!els.modelpop.hidden) { els.modelpop.hidden = true; return }
      loadModels().then(function (j) {
        if (!j || !j.items || !j.items.length) { toast('模型清单不可用（本地服务未就绪）'); return }
        // 思考强度 chips
        var e = curEntry()
        var effs = (e && e.support_efforts) || []
        var hasThink = e && e.capabilities && e.capabilities.indexOf('thinking') !== -1
        els.mpEffSec.style.display = (effs.length && hasThink) ? '' : 'none'
        els.mpEfforts.style.display = (effs.length && hasThink) ? '' : 'none'
        var ce = curEffort()
        els.mpEfforts.innerHTML = effs.map(function (f) {
          return '<button class="kc-mp-chip' + (f === ce ? ' on' : '') + '" data-eff="' + esc(f) + '">' + esc(f) + '</button>'
        }).join('')
        // 模型列表
        var html = ''
        j.items.forEach(function (m) {
          var dis = m.usable ? '' : ' disabled'
          var on = m.id === curModelId() ? ' on' : ''
          html += '<button class="kc-mp-item' + on + dis + '" data-mdl="' + esc(m.id) + '"' +
            (m.usable ? '' : ' title="' + esc(m.reason || '不可用') + '"') + '>' +
            '<span class="kc-mp-name">' + esc(m.display_name) + (m.is_default ? ' <em>默认</em>' : '') + '</span>' +
            '<span class="kc-mp-prov">' + esc(m.provider) + '</span></button>'
        })
        els.mpModels.innerHTML = html
        var br = els.modelbtn.getBoundingClientRect()
        var hr = host.getBoundingClientRect()
        els.modelpop.style.bottom = Math.max(hr.height - br.top + 6, 8) + 'px'
        els.modelpop.style.left = Math.min(Math.max(br.left - 40, 8), hr.width - 300) + 'px'
        els.modelpop.hidden = false
      })
    }
    function patchTopicModel(patch) {
      if (!cur) return
      svcJson('/api/topics/' + cur.id, { method: 'PATCH', body: JSON.stringify(patch) })
        .then(function () {
          Object.assign(cur, patch)
          updateModelBtn()
          loadTopics()
        })
        .catch(function (e) { toast('设置失败：' + e.message) })
    }
    function selectModel(id) {
      els.modelpop.hidden = true
      if (!cur || id === curModelId()) return
      var patch = { model: id }
      // 新模型不支持当前强度时回落到它的默认强度
      var entry = null
      if (modelsData) for (var i = 0; i < modelsData.items.length; i++) if (modelsData.items[i].id === id) entry = modelsData.items[i]
      if (entry && entry.support_efforts.length && entry.support_efforts.indexOf(cur.effort || '') === -1) {
        patch.effort = entry.default_effort || entry.support_efforts[0]
      }
      patchTopicModel(patch)
      toast('已切换模型')
    }
    function selectEffort(eff) {
      els.modelpop.hidden = true
      if (!cur || eff === curEffort()) return
      patchTopicModel({ effort: eff })
    }

    // ---------- 引用 / 开展会话 ----------
    function refText(id) {
      var t = findTopic(id) || cur || {}
      return 'kimi-chat 话题「' + (t.title || id) + '」（ID: ' + id + '）\n' +
        '完整记录文件：~/.kimi-code/kimi-chat/topics/' + id + '.json'
    }
    function copyRef(id) { copyText(refText(id), '话题引用已复制，可粘贴到任意会话') }
    // 开展会话：以此话题为上下文，开一个真实的 Kimi Code 会话继续研究
    function promote(id) {
      var t = findTopic(id) || cur || {}
      var text = '我在「kimi-chat 讨论空间」里有一个讨论话题「' + (t.title || id) + '」，想带到会话里深入研究。' +
        '它的完整聊天记录保存在 ~/.kimi-code/kimi-chat/topics/' + id + '.json ，' +
        '请先阅读该文件了解全部上下文，然后简要总结我们讨论到哪了，等我的下一步指令。'
      copyText(refText(id), '引用已复制')
      close()
      // 新建会话 → 等 composer 就绪 → 填入 → 自动发送
      var newBtn = document.querySelector('.btn-new-chat')
      if (newBtn) newBtn.click()
      else location.assign('/')
      var tries = 0
      var timer = setInterval(function () {
        tries++
        var ce = document.querySelector('.composer-card [contenteditable]')
        if (ce) {
          clearInterval(timer)
          if (fillComposer(text)) {
            toast('已开展会话：正在发送话题上下文…')
            setTimeout(clickSend, 400)
          }
        } else if (tries > 24) {
          clearInterval(timer)
          toast('未找到输入框，话题引用已复制到剪贴板')
        }
      }, 500)
    }

    // ---------- 界面偏好 / 右侧信息栏 ----------
    function resolveColorMode() {
      if (uiCfg.color_mode === 'dark' || uiCfg.color_mode === 'light') return uiCfg.color_mode
      var de = document.documentElement
      var ds = (de.dataset.colorScheme || de.dataset.theme || '').toLowerCase()
      if (ds === 'dark' || ds === 'light') return ds
      if (de.classList && de.classList.contains('dark')) return 'dark'
      try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' } catch (e) { return 'light' }
    }
    function applyUiCfg() {
      var showRail = uiCfg.right_rail && !railHidden
      if (els.rightrail) els.rightrail.classList.toggle('kc-rr-off', !showRail)
      var t = root.querySelector('.kc-rail-toggle')
      if (t) t.classList.toggle('kc-on', !!showRail)
    }
    function toggleRail() {
      railHidden = !railHidden
      lsSet('kc.railhidden', railHidden ? '1' : '0')
      applyUiCfg()
    }
    // 答复卡片配色：把 VCPColorEngine 调色板作为 CSS 变量挂到消息容器，
    // 标题/引用/表格/代码等 Markdown 元素的强调色全部跟随所选样式
    function applyMsgStyle(el) {
      if (!uiCfg.card_style) return
      var engine = window.__vcpColor || window.VCPColorEngine
      if (!engine || typeof engine.generate !== 'function') {
        // 配色引擎按需加载，就绪后补一次（防首次渲染时序问题）
        if (!el.__kcStyleWait) {
          el.__kcStyleWait = true
          ensureVendor().then(function () { el.__kcStyleWait = false; applyMsgStyle(el) }).catch(function () { el.__kcStyleWait = false })
        }
        return
      }
      try {
        var pal = engine.generate({ movement: uiCfg.card_style, mode: resolveColorMode() })
        var hex = pal.hex || {}
        for (var k in hex) {
          if (!Object.prototype.hasOwnProperty.call(hex, k)) continue
          var kebab = k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase() })
          el.style.setProperty('--vcp-' + kebab, hex[k])
        }
        el.classList.add('kc-styled')
      } catch (e) {}
    }
    function updateRail() {
      if (!els.rrInfo) return
      if (!cur) { els.rrInfo.innerHTML = ''; els.rrOutline.innerHTML = ''; return }
      var msgs = cur.messages || []
      var users = 0, ais = 0
      for (var i = 0; i < msgs.length; i++) { if (msgs[i].role === 'user') users++; else ais++ }
      var created = cur.created_at ? new Date(cur.created_at).toLocaleString() : '—'
      els.rrInfo.innerHTML =
        '<div class="kc-rr-row"><span>标题</span><b>' + esc(cur.title || '（未命名）') + '</b></div>' +
        '<div class="kc-rr-row"><span>ID</span><b class="kc-rr-mono" title="点击复制" data-copyid="' + esc(cur.id) + '">' + esc(String(cur.id).slice(0, 12)) + '…</b></div>' +
        '<div class="kc-rr-row"><span>创建</span><b>' + esc(created) + '</b></div>' +
        '<div class="kc-rr-row"><span>消息</span><b>' + users + ' 问 / ' + ais + ' 答</b></div>' +
        '<div class="kc-rr-row"><span>模型</span><b>' + esc(cur.model || '默认') + (cur.effort ? ' · ' + esc(cur.effort) : '') + '</b></div>'
      // 自动归纳：取用户提问作为大纲，点击滚动定位到对应消息
      var items = []
      var domIdx = 0
      for (var j = 0; j < msgs.length; j++) {
        if (msgs[j].role === 'user') {
          var txt = String(msgs[j].content || '').replace(/\s+/g, ' ').trim()
          items.push({ t: txt.slice(0, 42) + (txt.length > 42 ? '…' : ''), dom: domIdx })
        }
        domIdx++
      }
      if (!items.length) { els.rrOutline.innerHTML = '<div class="kc-rr-empty">提问后自动生成大纲</div>'; return }
      var h = ''
      for (var q = 0; q < Math.min(items.length, 12); q++) {
        h += '<div class="kc-rr-q" data-dom="' + items[q].dom + '" title="' + esc(items[q].t) + '">' + (q + 1) + '. ' + esc(items[q].t) + '</div>'
      }
      els.rrOutline.innerHTML = h
    }
    // 大纲点击定位 / 信息栏复制 ID（走 onClick 事件委托，元素在 build 后才存在）

    // ---------- 思考过程折叠（不刷屏） ----------
    // 把 <think>…</think>（含未闭合的流式中间态）与正式回答分离
    function splitThink(acc) {
      var think = '', answer = '', rest = acc
      for (;;) {
        var a = rest.indexOf('<think>')
        if (a === -1) { answer += rest; break }
        answer += rest.slice(0, a)
        var b = rest.indexOf('</think>', a)
        if (b === -1) { think += rest.slice(a + 7); rest = ''; break }
        think += rest.slice(a + 7, b)
        rest = rest.slice(b + 8)
      }
      return { think: think.trim(), answer: answer.trim(), streaming: rest === '' && acc.indexOf('<think>') !== -1 && acc.lastIndexOf('</think>') < acc.lastIndexOf('<think>') }
    }
    function thinkDetails(thinkText, live) {
      var d = document.createElement('details')
      d.className = 'kc-think'
      var s = document.createElement('summary')
      s.innerHTML = '💭 思考过程 <em>' + (live ? '进行中… ' : '') + '(' + thinkText.length + ' 字)</em>'
      var pre = document.createElement('div')
      pre.className = 'kc-think-body'
      pre.textContent = thinkText
      d.appendChild(s)
      d.appendChild(pre)
      return d
    }

    // ---------- 插件设置（弹窗 + kimi 设置页签共用） ----------
    var KC_FORM_CSS = '.kc-setform{font-size:13px;line-height:1.5;color:inherit}' +
      '.kc-setform h5{margin:16px 0 8px;font-size:13px;opacity:.7;border-bottom:1px solid rgba(128,128,128,.25);padding-bottom:4px}' +
      '.kc-setform .kc-frow{display:flex;align-items:center;gap:8px;margin:6px 0}' +
      '.kc-setform .kc-frow label{flex:0 0 96px;opacity:.75}' +
      '.kc-setform input[type=text],.kc-setform input[type=password],.kc-setform select,.kc-setform textarea{flex:1;min-width:0;padding:6px 8px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;font:inherit}' +
      // 原生下拉弹层是白底：选项文字必须显式深色，否则深色主题下白字白底看不清
      '.kc-setform select option{color:#1f2937;background:#ffffff}' +
      '.kc-setform textarea{display:block;width:100%;box-sizing:border-box;min-height:110px;resize:vertical;font-size:12px}' +
      '.kc-setform .kc-fhint{opacity:.55;font-size:11px;margin-left:104px}' +
      '.kc-setform .kc-fbtns{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}' +
      '.kc-setform .kc-fbtns button{padding:7px 14px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.08);color:inherit;cursor:pointer;font:inherit}' +
      '.kc-setform .kc-fbtns button.kc-fprimary{background:#10a37f;border-color:#10a37f;color:#fff}' +
      '.kc-setform .kc-fbtns button:hover{filter:brightness(1.08)}' +
      '.kc-setform .kc-fcheck{flex:0 0 auto;width:16px;height:16px}'
    var KC_STYLE_OPTS = [['', '原生（不施加主题）'], ['editorial', 'Editorial · 编辑排版'], ['chiaroscuro', 'Chiaroscuro · 明暗油画'], ['fauvism', 'Fauvism · 野兽派'], ['cyberpunk', 'Cyberpunk · 赛博朋克'], ['wabi_sabi', 'Wabi-sabi · 侘寂']]
    var cfgFormData = null
    function renderSettingsForm(container) {
      container.innerHTML = '<div class="kc-setform">加载中…</div>'
      svcJson('/api/config').then(function (j) {
        cfgFormData = j
        var opts = ''
        for (var i = 0; i < KC_STYLE_OPTS.length; i++) {
          opts += '<option value="' + KC_STYLE_OPTS[i][0] + '"' + (j.ui.card_style === KC_STYLE_OPTS[i][0] ? ' selected' : '') + '>' + KC_STYLE_OPTS[i][1] + '</option>'
        }
        container.innerHTML =
          '<div class="kc-setform">' +
          '<h5>界面</h5>' +
          '<div class="kc-frow"><label>答复样式</label><select data-f="card_style">' + opts + '</select></div>' +
          '<div class="kc-frow"><label>配色模式</label><select data-f="color_mode">' +
            '<option value="auto"' + (j.ui.color_mode === 'auto' ? ' selected' : '') + '>跟随 kimi web</option>' +
            '<option value="light"' + (j.ui.color_mode === 'light' ? ' selected' : '') + '>浅色</option>' +
            '<option value="dark"' + (j.ui.color_mode === 'dark' ? ' selected' : '') + '>深色</option></select></div>' +
          '<div class="kc-frow"><label>思考折叠</label><input class="kc-fcheck" type="checkbox" data-f="think_collapse"' + (j.ui.think_collapse ? ' checked' : '') + '><span class="kc-fhint2">思考过程收进折叠块，不刷屏</span></div>' +
          '<div class="kc-frow"><label>右侧信息栏</label><input class="kc-fcheck" type="checkbox" data-f="right_rail"' + (j.ui.right_rail ? ' checked' : '') + '><span class="kc-fhint2">话题信息 / 自动归纳 / 快捷操作</span></div>' +
          '<h5>生图（image provider）</h5>' +
          '<div class="kc-frow"><label>Base URL</label><input type="text" data-f="image.base_url" value="' + esc(j.image.base_url || '') + '"></div>' +
          '<div class="kc-frow"><label>API Key</label><input type="password" data-f="image.api_key" placeholder="' + (j.image.api_key_set ? '已配置（' + esc(j.image.api_key_mask) + '），留空保持不变' : '未配置') + '"></div>' +
          '<div class="kc-frow"><label>模型</label><input type="text" data-f="image.model" value="' + esc(j.image.model || '') + '"></div>' +
          '<div class="kc-frow"><label>接口路径</label><input type="text" data-f="image.path" value="' + esc(j.image.path || '') + '"></div>' +
          '<h5>语音 TTS（tts provider）</h5>' +
          '<div class="kc-frow"><label>Base URL</label><input type="text" data-f="tts.base_url" value="' + esc(j.tts.base_url || '') + '"></div>' +
          '<div class="kc-frow"><label>API Key</label><input type="password" data-f="tts.api_key" placeholder="' + (j.tts.api_key_set ? '已配置（' + esc(j.tts.api_key_mask) + '），留空保持不变' : '未配置') + '"></div>' +
          '<div class="kc-frow"><label>模型</label><input type="text" data-f="tts.model" value="' + esc(j.tts.model || '') + '"></div>' +
          '<div class="kc-frow"><label>音色</label><input type="text" data-f="tts.voice" value="' + esc(j.tts.voice || '') + '"></div>' +
          '<div class="kc-frow"><label>接口路径</label><input type="text" data-f="tts.path" value="' + esc(j.tts.path || '') + '"></div>' +
          '<h5>高级</h5>' +
          '<div class="kc-frow"><label>聊天模型</label><input type="text" value="' + esc(j.chat.model || '未配置') + '" disabled title="跟随会话默认模型，在 Kimi Code 设置里改"></div>' +
          '<div class="kc-frow"><label>免 token 登录</label><input class="kc-fcheck" type="checkbox" data-f="auto_token"' + (j.auto_token ? ' checked' : '') + '><span class="kc-fhint2">统一入口自动注入当前 token（内网建议开）</span></div>' +
          '<div class="kc-frow"><label>系统提示词</label></div>' +
          '<textarea data-f="system_prompt">' + esc(j.system_prompt || '') + '</textarea>' +
          '<div class="kc-fbtns">' +
          '  <button class="kc-fprimary" data-sact="save">保存</button>' +
          '  <button data-sact="testimg">生图测试</button>' +
          '  <button data-sact="testtts">语音测试</button>' +
          '  <button data-sact="resetprompt">恢复默认提示词</button>' +
          '</div>' +
          '</div>'
      }).catch(function (e) {
        container.innerHTML = '<div class="kc-setform">加载失败：' + esc(e.message) + '</div>'
      })
    }
    function collectSettings(container) {
      var out = { image: {}, tts: {}, ui: {} }
      Array.prototype.forEach.call(container.querySelectorAll('[data-f]'), function (inp) {
        var f = inp.getAttribute('data-f')
        var v = inp.type === 'checkbox' ? inp.checked : inp.value
        if (f === 'card_style' || f === 'color_mode') out.ui[f] = v
        else if (f === 'think_collapse' || f === 'right_rail') out.ui[f] = !!v
        else if (f === 'auto_token') out.auto_token = !!v
        else if (f === 'system_prompt') { if (String(v).trim()) out.system_prompt = v }
        else if (f.indexOf('image.') === 0) { if (v !== '') out.image[f.slice(6)] = v }
        else if (f.indexOf('tts.') === 0) { if (v !== '') out.tts[f.slice(4)] = v }
      })
      return out
    }
    function onSettingsAction(act) {
      if (act === 'save') {
        var body = collectSettings(els.setbody)
        svcJson('/api/config', { method: 'PUT', body: JSON.stringify(body) }).then(function () {
          uiCfg = Object.assign(uiCfg, body.ui)
          applyUiCfg()
          if (cur) renderMessages()
          toast('设置已保存并生效')
        }).catch(function (e) { toast('保存失败：' + e.message) })
      } else if (act === 'testimg') {
        toast('生图测试中…（约十几秒）')
        svcJson('/api/image', { method: 'POST', body: JSON.stringify({ prompt: '一只像素风格的橘猫，坐在键盘上', aspect_ratio: '1:1' }) })
          .then(function (j) { toast('生图成功：' + j.url); window.open(svcUrl(j.url), '_blank') })
          .catch(function (e) { toast('生图失败：' + e.message) })
      } else if (act === 'testtts') {
        toast('语音测试中…')
        svcJson('/api/tts', { method: 'POST', body: JSON.stringify({ text: '你好，这是 kimi-chat 的语音测试。' }) })
          .then(function (j) { toast('语音成功'); try { new Audio(svcUrl(j.url)).play() } catch (e) {} })
          .catch(function (e) { toast('语音失败：' + e.message) })
      } else if (act === 'resetprompt') {
        var ta = els.setbody.querySelector('[data-f="system_prompt"]')
        if (ta) ta.value = ''
        toast('已清空，保存后恢复默认提示词')
      }
    }
    function openSettings() {
      els.setmask.hidden = false
      renderSettingsForm(els.setbody)
    }
    function closeSettings() { els.setmask.hidden = true }

    // ---------- kimi 设置页注入「kimi-chat」页签 ----------
    // kimi web 设置弹窗本身不支持插件注册页，这里用 DOM 注入一个页签（宿主重渲染时自动补回）
    var KC_TAB_MARK = 'kc-settings-tab'
    function ensureKimiTab() {
      var list = document.querySelector('.settings-tab-list')
      if (!list || document.getElementById(KC_TAB_MARK)) return
      if (!document.getElementById('kc-set-style')) {
        var st = document.createElement('style')
        st.id = 'kc-set-style'
        st.textContent = KC_FORM_CSS
        ;(document.head || document.documentElement).appendChild(st)
      }
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'tab'
      btn.id = KC_TAB_MARK
      btn.setAttribute('role', 'tab')
      btn.setAttribute('aria-selected', 'false')
      btn.innerHTML = '<span style="margin-right:6px">💬</span><span>kimi-chat</span>'
      btn.addEventListener('click', function () {
        var tabs = list.querySelectorAll('.tab')
        Array.prototype.forEach.call(tabs, function (t) { t.setAttribute('aria-selected', t === btn ? 'true' : 'false') })
        var body = list.closest('.sd') && list.closest('.sd').querySelector('.ui-dialog__body > :not(nav)')
        var content = body || (list.parentElement && list.parentElement.nextElementSibling)
        if (!content) return
        content.innerHTML = '<div style="padding:4px 8px;overflow:auto;max-height:60vh"></div>'
        renderSettingsForm(content.firstChild)
      })
      list.appendChild(btn)
    }
    var kimiTabObs = new MutationObserver(function () { ensureKimiTab() })
    try { kimiTabObs.observe(document.body, { childList: true, subtree: true }) } catch (e) {}

    // ---------- 聊天视图 ----------
    function openChat(id) {
      svcJson('/api/topics/' + id).then(function (t) {
        cur = t
        els.welcome.hidden = true
        els.chat.hidden = false
        els.chattitle.textContent = t.title || '（未命名）'
        applyUiCfg()
        renderMessages()
        loadModels().then(updateModelBtn)
        setTimeout(function () { els.input.focus() }, 60)
      }).catch(function (e) { toast('打开失败：' + e.message) })
    }
    function showWelcome() {
      cur = null
      if (aborter) { aborter.abort(); aborter = null }
      setBusy(false)
      els.chat.hidden = true
      els.welcome.hidden = false
      loadTopics()
    }
    function renderMessages() {
      els.msgs.innerHTML = ''
      var msgs = (cur && cur.messages) || []
      if (!msgs.length) {
        els.msgs.innerHTML = '<div class="kc-empty">开始讨论吧 —— 可以让我用 HTML / SVG / 图表帮你把问题画出来</div>'
        return
      }
      msgs.forEach(function (m) { appendMsgEl(m) })
      updateRail()
      scrollBottom()
    }
    function appendMsgEl(m) {
      var empty = els.msgs.querySelector('.kc-empty')
      if (empty) empty.remove()
      var row = document.createElement('div')
      row.className = 'kc-msg kc-msg-' + (m.role === 'user' ? 'user' : 'ai')
      var content = document.createElement('div')
      content.className = 'kc-msg-content'
      row.appendChild(content)
      els.msgs.appendChild(row)
      renderInto(content, m)
      if (m.role === 'assistant') {
        applyMsgStyle(content)
        // 思考内容折叠展示（历史消息的 think 混在 content 里，流式结束后显式传入）
        var thinkText = m.think || ''
        if (!thinkText && m.content && m.content.indexOf('<think>') !== -1) {
          var sp = splitThink(m.content)
          thinkText = sp.think
          if (thinkText) renderInto(content, { role: 'assistant', content: sp.answer || '（见思考过程）' })
        }
        if (thinkText && uiCfg.think_collapse) {
          content.insertBefore(thinkDetails(thinkText, false), content.firstChild)
        }
      }
      return content
    }
    function scrollBottom() { els.msgs.scrollTop = els.msgs.scrollHeight }
    // 回读当前话题（自动起名/消息计数变化后刷新标题与右栏）
    function refreshCur() {
      if (!cur) return
      svcJson('/api/topics/' + cur.id).then(function (t) {
        cur = t
        els.chattitle.textContent = t.title || '（未命名）'
        updateRail()
        loadTopics()
      }).catch(function () {})
    }
    function setBusy(v) {
      busy = v
      els.send.hidden = v
      els.stop.hidden = !v
    }

    function sendChat() {
      if (busy || !cur) return
      var text = els.input.value.trim()
      if (!text) return
      els.input.value = ''
      autosize()
      if (text.indexOf('/img ') === 0) return sendImage(text.slice(5).trim())
      if (text.indexOf('/tts ') === 0) return sendTts(text.slice(5).trim())

      appendMsgEl({ role: 'user', content: text })
      var aiEl = appendMsgEl({ role: 'assistant', content: '' })
      aiEl.classList.add('kc-streaming')
      setBusy(true)
      scrollBottom()

      var acc = ''
      var thinkAcc = '' // 独立 reasoning 流（服务端 think 事件）
      // 流式显示：思考只报字数；围栏代码/vcp 源不刷屏，用占位提示代替
      function streamDisplay() {
        if (!uiCfg.think_collapse) { aiEl.textContent = acc; return }
        var sp = splitThink(acc)
        var thinkLen = thinkAcc.length + sp.think.length
        var answer = sp.answer.replace(/```(\w*)[\s\S]*?(```|$)/g, function (m, lang) {
          return '\n⏳ ' + (lang === 'vcp' ? '卡片' : '代码') + '生成中…\n'
        })
        aiEl.textContent = (thinkLen ? '💭 思考中…（' + thinkLen + ' 字）\n\n' : '') + answer
      }
      aborter = new AbortController()
      svcReady.then(function () {
      return fetch(SVC + '/api/topics/' + cur.id + '/chat', {
        method: 'POST',
        headers: svcHeaders(true),
        body: JSON.stringify({ content: text }),
        signal: aborter.signal
      })
      }).then(function (res) {
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
        var reader = res.body.getReader()
        var decoder = new TextDecoder()
        var buf = ''
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return
            buf += decoder.decode(r.value, { stream: true })
            var lines = buf.split('\n')
            buf = lines.pop()
            for (var i = 0; i < lines.length; i++) {
              var ln = lines[i].trim()
              if (!ln.startsWith('data:')) continue
              var payload = ln.slice(5).trim()
              var j
              try { j = JSON.parse(payload) } catch (e) { continue }
              if (j.error) { acc += '\n\n> ⚠️ ' + j.error; aiEl.textContent = acc; scrollBottom(); continue }
              if (j.think) { thinkAcc += j.think; streamDisplay(); scrollBottom(); continue }
              if (j.delta) {
                acc += j.delta
                streamDisplay()
                scrollBottom()
              }
              if (j.done && j.title) {
                cur.title = j.title
                els.chattitle.textContent = j.title
              }
            }
            return pump()
          })
        }
        return pump()
      }).catch(function (e) {
        if (e && e.name === 'AbortError') acc += '\n\n（已停止）'
        else acc += '\n\n> ⚠️ 请求失败：' + ((e && e.message) || '网络错误')
      }).then(function () {
        aborter = null
        setBusy(false)
        // 流式期间是纯文本，结束后做一次完整 Markdown/VCP 渲染；思考内容折叠
        var sp = splitThink(acc)
        var clean = sp.answer || acc.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim()
        renderInto(aiEl, { role: 'assistant', content: clean || acc })
        applyMsgStyle(aiEl)
        var thinkAll = (thinkAcc + (thinkAcc && sp.think ? '\n' : '') + sp.think).trim()
        if (thinkAll && uiCfg.think_collapse) {
          aiEl.insertBefore(thinkDetails(thinkAll, false), aiEl.firstChild)
        }
        aiEl.classList.remove('kc-streaming')
        // 服务端已落盘并自动起名，回读话题刷新右栏（自动归纳/消息计数）
        refreshCur()
        scrollBottom()
      })
    }
    function stopChat() { if (aborter) aborter.abort() }

    function sendImage(prompt) {
      if (!prompt) { toast('用法：/img 图像描述'); return }
      appendMsgEl({ role: 'user', content: '/img ' + prompt })
      var aiEl = appendMsgEl({ role: 'assistant', content: '正在生成图像…' })
      setBusy(true)
      scrollBottom()
      svcJson('/api/topics/' + cur.id + '/messages', {
        method: 'POST', body: JSON.stringify({ role: 'user', content: '/img ' + prompt })
      }).then(function () {
        return svcJson('/api/image', { method: 'POST', body: JSON.stringify({ prompt: prompt, aspect_ratio: '1:1' }) })
      }).then(function (j) {
        return svcJson('/api/topics/' + cur.id + '/messages', {
          method: 'POST',
          body: JSON.stringify({ role: 'assistant', content: '已生成图像：' + prompt, images: [j.url] })
        }).then(function () {
          renderInto(aiEl, { role: 'assistant', content: '已生成图像：' + prompt, images: [j.url] })
        })
      }).catch(function (e) {
        renderInto(aiEl, { role: 'assistant', content: '⚠️ 图像生成失败：' + e.message })
      }).then(function () {
        setBusy(false)
        refreshCur()
        scrollBottom()
      })
    }

    function sendTts(text) {
      if (!text) { toast('用法：/tts 要朗读的文本'); return }
      appendMsgEl({ role: 'user', content: '/tts ' + text })
      var aiEl = appendMsgEl({ role: 'assistant', content: '正在生成语音…' })
      setBusy(true)
      scrollBottom()
      svcJson('/api/topics/' + cur.id + '/messages', {
        method: 'POST', body: JSON.stringify({ role: 'user', content: '/tts ' + text })
      }).then(function () {
        return svcJson('/api/tts', { method: 'POST', body: JSON.stringify({ text: text }) })
      }).then(function (j) {
        return svcJson('/api/topics/' + cur.id + '/messages', {
          method: 'POST',
          body: JSON.stringify({ role: 'assistant', content: '🔊 已生成语音：' + text.slice(0, 40), audios: [j.url] })
        }).then(function () {
          renderInto(aiEl, { role: 'assistant', content: '🔊 已生成语音：' + text.slice(0, 40), audios: [j.url] })
        })
      }).catch(function (e) {
        renderInto(aiEl, { role: 'assistant', content: '⚠️ 语音生成失败：' + e.message })
      }).then(function () {
        setBusy(false)
        refreshCur()
        scrollBottom()
      })
    }

    // ---------- 模块开关（hash 路由） ----------
    function openModule() {
      if (open) return
      open = true
      host.style.display = 'block'
      if (location.hash !== '#' + MODULE_HASH) {
        try { history.replaceState(null, '', '#' + MODULE_HASH) } catch (e) { location.hash = MODULE_HASH }
      }
      var btn = document.getElementById('kc-chat-btn')
      if (btn) btn.style.background = 'var(--kc-btn-bg-hover,rgba(128,128,128,.18))'
      checkAndLoad()
      setTimeout(function () { (cur ? els.input : els.search).focus() }, 60)
    }
    function close() {
      if (!open) return
      open = false
      host.style.display = 'none'
      if (location.hash === '#' + MODULE_HASH) {
        try { history.replaceState(null, '', location.pathname + location.search) } catch (e) { location.hash = '' }
      }
      var btn = document.getElementById('kc-chat-btn')
      if (btn) btn.style.background = 'var(--kc-btn-bg,rgba(128,128,128,.08))'
    }
    function toggle(force) {
      var want = typeof force === 'boolean' ? force : !open
      if (want) openModule(); else close()
    }
    function syncFromHash() {
      if (location.hash === '#' + MODULE_HASH && !open) openModule()
      else if (location.hash !== '#' + MODULE_HASH && open) close()
    }
    window.addEventListener('hashchange', syncFromHash)
    return {
      build: build,
      toggle: toggle,
      open: openModule,
      close: close,
      isOpen: function () { return open },
      bootOpen: function () { if (location.hash === '#' + MODULE_HASH) openModule() }
    }
  })()

  // ---------- 文件夹选择器「新建文件夹」 ----------
  // 应用后端已提供 POST /api/v1/fs:mkdir，但 Web UI 未接入。这里补齐：
  // ① 在「添加工作区」对话框地址栏右侧注入按钮 + 浮层输入；
  // ② 建好后借用应用自身的导航刷新列表。
  var NF_STYLE_ID = 'kc-nf-style'
  var API_MKDIR = '/api/v1/fs:mkdir'
  var NF_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M3.6 6.6a2 2 0 0 1 2-2h3.1l1.8 2h7.9a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z"/><path d="M12 11.6v4.8M9.6 14h4.8"/></svg>'
  var NF_CSS = [
    '.kc-nf-bar{position:relative;margin-left:auto;flex:none}',
    '.kc-nf-btn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:.5px solid var(--color-line,rgba(128,128,128,.3));border-radius:var(--radius-sm,6px);background:none;color:var(--color-text-muted,rgba(128,128,128,.9));font-family:var(--font-ui,inherit);font-size:var(--text-xs,12px);cursor:pointer;white-space:nowrap}',
    '.kc-nf-btn:hover{background:var(--color-hover,rgba(128,128,128,.12));color:var(--color-text,inherit)}',
    '.kc-nf-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:290px;padding:10px;background:var(--color-surface-raised,#fff);border:.5px solid var(--color-line,rgba(128,128,128,.3));border-radius:var(--radius-md,8px);box-shadow:var(--shadow-lg,0 12px 32px rgba(16,24,40,.18));font-family:var(--font-ui,inherit)}',
    '.kc-nf-dir{margin-bottom:7px;font-size:var(--text-xs,12px);color:var(--color-text-muted,rgba(128,128,128,.9));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.kc-nf-dir b{color:var(--color-text,inherit);font-weight:var(--weight-medium,500)}',
    '.kc-nf-row{display:flex;align-items:center;gap:6px}',
    '.kc-nf-input{flex:1;min-width:0;height:28px;padding:0 8px;background:var(--color-bg,#fff);border:.5px solid var(--color-line-strong,rgba(128,128,128,.4));border-radius:var(--radius-sm,6px);color:var(--color-text,inherit);font-family:var(--font-ui,inherit);font-size:var(--text-sm,13px);outline:none}',
    '.kc-nf-input:focus{border-color:var(--color-accent,#1783ff)}',
    '.kc-nf-ok,.kc-nf-cancel{height:28px;padding:0 10px;border-radius:var(--radius-sm,6px);font-family:var(--font-ui,inherit);font-size:var(--text-sm,13px);line-height:1;cursor:pointer;white-space:nowrap}',
    '.kc-nf-ok{background:var(--color-accent,#1783ff);border:.5px solid transparent;color:#fff}',
    '.kc-nf-ok:disabled{opacity:.5;cursor:not-allowed}',
    '.kc-nf-cancel{background:none;border:.5px solid var(--color-line,rgba(128,128,128,.3));color:var(--color-text-muted,rgba(128,128,128,.9))}',
    '.kc-nf-cancel:disabled{opacity:.5;cursor:not-allowed}',
    '.kc-nf-err{margin-top:7px;font-size:var(--text-xs,12px);line-height:1.45;color:var(--color-danger,#c0392b)}',
    '.kc-nf-err:empty{display:none}',
    '.kc-nf-flash{animation:kc-nf-flash 1s var(--ease-out,ease) 2}',
    '@keyframes kc-nf-flash{0%,100%{background:transparent}40%{background:var(--color-accent-soft,rgba(23,131,255,.14))}}'
  ].join('')

  function nfEnsureStyle() {
    if (document.getElementById(NF_STYLE_ID)) return
    var st = document.createElement('style')
    st.id = NF_STYLE_ID
    st.textContent = NF_CSS
    ;(document.head || document.documentElement).appendChild(st)
  }
  function nfCurrentPath(aw) {
    var crumbs = aw.querySelectorAll('.crumbs .crumb')
    var parts = []
    for (var i = 0; i < crumbs.length; i++) parts.push((crumbs[i].textContent || '').trim())
    if (!parts.length) return ''
    var p = parts.join('/')
    if (p.charAt(0) !== '/') p = '/' + p
    return p.replace(/\/{2,}/g, '/')
  }
  function nfJoin(dir, name) {
    if (!dir) return ''
    return dir === '/' ? '/' + name : dir.replace(/\/+$/, '') + '/' + name
  }
  function nfValidate(name) {
    if (!name) return '请输入文件夹名称'
    if (name.length > 255) return '名称过长（最多 255 个字符）'
    if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) return '名称不能包含 / 或 \\'
    if (name === '.' || name === '..') return '名称不能是 . 或 ..'
    if (/[\u0000-\u001f\u007f]/.test(name)) return '名称不能包含控制字符'
    return ''
  }
  function nfErrText(status, body) {
    var msg = (body && body.msg) || ''
    if (/already exists/i.test(msg)) return '该名称已存在（同名文件夹或文件）'
    if (/permission denied/i.test(msg)) return '没有权限在此目录下创建文件夹'
    if (/parent path not found/i.test(msg)) return '上级目录不存在，请刷新后重试'
    if (/must be absolute/i.test(msg)) return '目录路径无效，请重新进入该目录'
    return msg || ('创建失败（HTTP ' + status + '）')
  }
  function nfMkdir(path) {
    var token = getToken()
    var headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = 'Bearer ' + token
    return fetch(API_MKDIR, { method: 'POST', headers: headers, body: JSON.stringify({ path: path }) })
      .then(function (r) {
        return r.json().catch(function () { return {} }).then(function (j) {
          if (r.ok && j && j.code === 0) return { ok: true, path: (j.data && j.data.path) || path }
          return { ok: false, error: nfErrText(r.status, j) }
        })
      })
      .catch(function (e) { return { ok: false, error: '网络错误：' + ((e && e.message) || '请求失败') } })
  }
  function nfRefresh(aw) {
    var last = aw.querySelector('.crumbs .crumb.last')
    if (last) last.click()
  }
  function nfFlash(aw, name) {
    var rows = aw.querySelectorAll('.folder-row')
    for (var i = 0; i < rows.length; i++) {
      var nm = rows[i].querySelector('.folder-name')
      if (nm && (nm.textContent || '').trim() !== name) continue
      var el = rows[i]
      el.classList.add('kc-nf-flash')
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
      setTimeout(function () { el.classList.remove('kc-nf-flash') }, 2100)
      return
    }
  }
  function nfBuild(aw, crumbbar) {
    nfEnsureStyle()
    var bar = document.createElement('div')
    bar.className = 'kc-nf-bar'
    bar.innerHTML =
      '<button type="button" class="kc-nf-btn" aria-expanded="false" title="在当前目录下新建文件夹">' + NF_ICON + '<span>新建文件夹</span></button>' +
      '<div class="kc-nf-pop" hidden>' +
      '  <div class="kc-nf-dir"></div>' +
      '  <div class="kc-nf-row">' +
      '    <input class="kc-nf-input" type="text" placeholder="文件夹名称" autocomplete="off" spellcheck="false">' +
      '    <button type="button" class="kc-nf-ok">创建</button>' +
      '    <button type="button" class="kc-nf-cancel">取消</button>' +
      '  </div>' +
      '  <div class="kc-nf-err" role="alert"></div>' +
      '</div>'
    var btn = bar.querySelector('.kc-nf-btn')
    var pop = bar.querySelector('.kc-nf-pop')
    var dirEl = bar.querySelector('.kc-nf-dir')
    var input = bar.querySelector('.kc-nf-input')
    var okBtn = bar.querySelector('.kc-nf-ok')
    var cancelBtn = bar.querySelector('.kc-nf-cancel')
    var errEl = bar.querySelector('.kc-nf-err')
    var busy = false
    function closePop() { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); input.value = ''; errEl.textContent = '' }
    function openPop() {
      var dir = nfCurrentPath(aw)
      var base = dir === '/' ? '/' : (dir.split('/').filter(Boolean).pop() || dir)
      dirEl.innerHTML = '在 <b>' + esc(base) + '</b> 下新建'
      errEl.textContent = ''
      pop.hidden = false
      btn.setAttribute('aria-expanded', 'true')
      setTimeout(function () { input.focus() }, 0)
    }
    function setBusy2(v) {
      busy = v
      input.disabled = v; okBtn.disabled = v; cancelBtn.disabled = v
      okBtn.textContent = v ? '创建中…' : '创建'
    }
    function submit() {
      if (busy) return
      var name = input.value.trim()
      var bad = nfValidate(name)
      if (bad) { errEl.textContent = bad; input.focus(); return }
      var dir = nfCurrentPath(aw)
      if (!dir) { errEl.textContent = '无法确定当前目录，请重新打开此窗口'; return }
      errEl.textContent = ''
      setBusy2(true)
      nfMkdir(nfJoin(dir, name)).then(function (r) {
        setBusy2(false)
        if (!r.ok) { errEl.textContent = r.error || '创建失败'; return }
        closePop()
        log('新建文件夹：' + r.path)
        nfRefresh(aw)
        setTimeout(function () { nfFlash(aw, name) }, 800)
      })
    }
    function onDocDown(e) {
      if (!bar.isConnected) { document.removeEventListener('mousedown', onDocDown, true); return }
      if (pop.hidden || bar.contains(e.target)) return
      closePop()
    }
    btn.addEventListener('click', function (e) { e.stopPropagation(); if (pop.hidden) openPop(); else closePop() })
    okBtn.addEventListener('click', function (e) { e.stopPropagation(); submit() })
    cancelBtn.addEventListener('click', function (e) { e.stopPropagation(); closePop() })
    input.addEventListener('keydown', function (e) {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); submit() }
      else if (e.key === 'Escape') { e.preventDefault(); closePop() }
    })
    bar.addEventListener('click', function (e) { e.stopPropagation() })
    document.addEventListener('mousedown', onDocDown, true)
    crumbbar.appendChild(bar)
  }
  function nfScan() {
    var list = document.querySelector('.aw > .folder-list')
    if (!list) return
    var aw = list.parentElement
    if (!aw || aw.querySelector('.kc-nf-bar')) return
    var crumbbar = aw.querySelector('.crumbbar')
    if (!crumbbar) return
    try { nfBuild(aw, crumbbar) } catch (e) { log('新建文件夹注入失败:', e && e.message) }
  }

  // ---------- composer 填包 + 发送（VCP 按钮桥 / 开展会话桥） ----------
  function fillComposer(text) {
    var ce = document.querySelector('.composer-card [contenteditable="true"], .composer-card [contenteditable]')
    if (!ce) return false
    ce.focus()
    try {
      var sel = window.getSelection()
      var range = document.createRange()
      range.selectNodeContents(ce)
      sel.removeAllRanges()
      sel.addRange(range)
      if (document.execCommand('insertText', false, text)) return true
    } catch (e) {}
    try {
      var dt = new DataTransfer()
      dt.setData('text/plain', text)
      ce.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return true
    } catch (e2) {}
    return false
  }
  function clickSend() {
    var btn = document.querySelector('.composer-card button.send')
    if (btn && !btn.disabled) { btn.click(); return true }
    return false
  }
  // 委托：会话消息区卡片内 onclick="input('...')" → 填包发送
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[onclick^="input("]') : null
    if (!el) return
    var m = /^input\(\s*(['"])([\s\S]*)\1\s*\)$/.exec(el.getAttribute('onclick') || '')
    if (!m) return
    e.preventDefault()
    e.stopPropagation()
    var text = m[2]
    if (fillComposer(text)) setTimeout(clickSend, 80)
  }, true)

  // ---------- VCP 渲染观察器（会话消息区） ----------
  var scanTimer = null
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = setTimeout(scanVcpBlocks, 400)
  }
  function simpleHash(s) {
    var h = 5381
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return (h >>> 0).toString(36)
  }
  function scanVcpBlocks() {
    if (!window.VCPRender) return
    var pres = document.querySelectorAll('pre[data-language="vcp"]')
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i]
      if (pre.dataset.kcVcpDone === '1') continue
      var container = pre.closest('.code-block-container') || pre.parentElement
      if (!container || container.dataset.kcVcpDone === '1') continue
      var code = pre.querySelector('code') || pre
      var raw = code.textContent || ''
      if (!raw.trim()) continue
      // 稳定性判定：内容 hash 连续不变（未知语言 vcp 会使应用组件报错卡住状态机，故不依赖它）
      var hash = simpleHash(raw)
      var prevHash = container.getAttribute('data-kc-vcp-hash')
      if (prevHash !== hash) {
        container.setAttribute('data-kc-vcp-hash', hash)
        container.setAttribute('data-kc-vcp-since', String(Date.now()))
        continue
      }
      var st = container.getAttribute('data-markstream-code-block-state')
      var since = +container.getAttribute('data-kc-vcp-since') || 0
      if (st !== 'settled' && Date.now() - since < 700) continue
      container.setAttribute('data-kc-vcp-done', '1')
      if (!state.render) continue // 开关关闭：保持代码块展示（优雅降级）
      try {
        var frag = window.VCPRender.render(raw)
        if (!frag) continue
        var wrap = document.createElement('div')
        wrap.className = 'vcp-card'
        wrap.setAttribute('data-vcp-card', '1')
        wrap.appendChild(frag)
        container.replaceWith(wrap)
        ensureVendor().then(function () { window.VCPRender.enhance(wrap) })
        log('VCP 卡片已渲染（' + raw.length + ' 字符）')
      } catch (err) {
        log('渲染失败，保留源码:', err && err.message)
      }
    }
  }
  function startObserver() {
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i]
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j]
          if (n.nodeType === 1 && (n.matches('pre[data-language="vcp"]') || n.querySelector('pre[data-language="vcp"]'))) { scheduleScan(); return }
        }
        if (m.type === 'characterData') { scheduleScan(); return }
      }
    })
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    // 兜底轮询：稳定性判定需要「二次扫描确认」，DOM 安静时观察器不再触发
    setInterval(scanVcpBlocks, 1000)
    var lastUrl = location.pathname
    setInterval(function () {
      if (location.pathname !== lastUrl) { lastUrl = location.pathname; setTimeout(scanVcpBlocks, 1500) }
    }, 1000)
  }

  // ---------- 启动 ----------
  function boot() {
    injectFonts()
    ensureButton()
    setInterval(ensureButton, 1500) // 看门狗：防 Vue 重渲染丢失
    nfScan()
    setInterval(nfScan, 800)
    chatModule.build()
    chatModule.bootOpen() // 从 #kc-chat 进入（刷新/分享链接）时自动展开
    if (window.VCPRender) {
      startObserver()
      scanVcpBlocks()
    } else {
      setTimeout(function () { if (window.VCPRender) { startObserver(); scanVcpBlocks() } }, 1000)
    }
    log('kimi-chat v' + VERSION + ' 已加载')
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
