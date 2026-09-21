/*!
 * kimi-chat 引导器（同步执行，必须在应用模块之前加载）
 * 职责：① 兜底捕获 Bearer token（主源是 localStorage kimi-web.server-credential）
 *       ② 异步加载主模块 vcp-chat.js（不阻塞渲染）
 */
;(function () {
  'use strict'
  var __kcToken = null
  function cap(h) {
    try {
      if (!h) return
      var v = h.get ? h.get('Authorization') : h['Authorization']
      if (v) __kcToken = String(v).replace(/^Bearer\s+/i, '')
    } catch (e) {}
  }
  var of = window.fetch
  if (typeof of === 'function') {
    window.fetch = function () {
      try { cap(arguments[1] && arguments[1].headers) } catch (e) {}
      return of.apply(this, arguments)
    }
  }
  var xo = XMLHttpRequest.prototype.open
  var xsh = XMLHttpRequest.prototype.setRequestHeader
  if (typeof xsh === 'function') {
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (/^authorization$/i.test(k)) cap(v) } catch (e) {}
      return xsh.apply(this, arguments)
    }
  }
  if (typeof xo === 'function') {
    XMLHttpRequest.prototype.open = function () {
      try { if (typeof arguments[1] === 'string' && arguments[1].indexOf('token=') !== -1) { var m = /token=([^&]+)/.exec(arguments[1]); if (m) __kcToken = decodeURIComponent(m[1]) } } catch (e) {}
      return xo.apply(this, arguments)
    }
  }
  window.__kcGetToken = function () {
    try {
      var c = JSON.parse(localStorage.getItem('kimi-web.server-credential') || 'null')
      if (c && c.credential) return c.credential
    } catch (e) {}
    return __kcToken
  }
  // 2) 依次加载渲染引擎与主模块（引擎先行，主模块依赖 window.VCPRender）
  function loadSeq(urls, i) {
    if (i >= urls.length) return
    var s = document.createElement('script')
    s.src = urls[i]
    s.async = true
    s.onload = function () { loadSeq(urls, i + 1) }
    s.onerror = function () { if (typeof console !== 'undefined') console.warn('[kimi-chat] 加载失败:', urls[i]) }
    ;(document.head || document.documentElement).appendChild(s)
  }
  loadSeq(['/assets/kimi-chat/vcp-render.js', '/assets/kimi-chat/vcp-chat.js'], 0)
})()
