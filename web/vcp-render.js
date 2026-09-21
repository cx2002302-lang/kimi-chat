/*!
 * kimi-chat VCP 渲染引擎（DOM 版）
 * 移植自 dsh-raw-html patch/v6-inject.js（MIT © plolpl789），适配 Kimi Code Web UI：
 *   - 去掉 React vdom / 流式状态机 / 增量切片——Kimi 侧由观察器在代码块稳定后整卡渲染
 *   - 保留全部自愈层：消息级作用域化 / 文字声明 !important / 字体链继承 / 花括号平衡 /
 *     根容器防崩 / 子容器防崩 / code 对比度 / SVG 动画中心 / 声明式配色 / 安全过滤 / 可信模式
 * 入口：
 *   VCPRender.render(rawHtml)      → DocumentFragment | null（已净化、已作用域化）
 *   VCPRender.enhance(rootEl)      → 挂载后增强（配色/字体链/SVG/数学/图表/可信脚本）
 *   VCPRender.processMath(rootEl)  → 单独跑 KaTeX + Mermaid
 */
;(function () {
  'use strict'

  // ---------- 常量 ----------
  var VOID_TAGS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 }
  var IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g
  var IMG_TAG_RE = /<img\b([^>]*?)\s*\/?>/gi
  var MERMAID_PRE_RE = /<pre([^>]*\blanguage-mermaid[^>]*)>([\s\S]*?)<\/pre>/gi
  var CODE_TAG_HOLD_RE = /<(\/?(?:span|b|em|i|strong)[^>]*)>/g
  var BOOST_TEXT_DECL_RE = /(color|font-family|font-size|font-weight|font-style|line-height|letter-spacing|text-align|text-shadow)\s*:\s*([^;!}]+?)(!important)?\s*(;|})/gi
  var FACE_PLACEHOLDER_RE = /@font-face\s*\{[^}]*\}/gi
  var FONT_INHERIT_TAGS = 'div,p,span,h1,h2,h3,h4,h5,h6,li,td,th,a,strong,b,em,i,blockquote,pre,code,small,label,figcaption,summary,button'
  var FONT_SYSTEM_CHAIN = "ui-sans-serif,system-ui,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"
  var TEXT_INHERIT_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing']
  var GUARD_TAGS = { div: 1, section: 1, article: 1, header: 1, footer: 1, main: 1, aside: 1, nav: 1, ul: 1, ol: 1, li: 1, table: 1, tr: 1, td: 1, th: 1, form: 1, figure: 1, figcaption: 1, blockquote: 1, pre: 1, p: 1 }
  var SVG_TAGS = { svg: 1, rect: 1, circle: 1, path: 1, g: 1, line: 1, polygon: 1, polyline: 1, ellipse: 1, text: 1, defs: 1, use: 1, filter: 1, mask: 1, linearGradient: 1, radialGradient: 1, stop: 1, clipPath: 1, animate: 1, animateTransform: 1, animateMotion: 1 }
  var MERMAID_CACHE_MAX = 30
  var MERMAID_MAX_HEIGHT = '520px'
  var MERMAID_RETRY_MS = 200
  var KATEX_RETRY_MAX = 30
  var KATEX_RETRY_MS = 200
  var MATH_DEBOUNCE_MS = 600
  var ONCLICK_BRIDGE_RE = /^input\(\s*(['"])[\s\S]*\1\s*\)$/
  var URL_OK_RE = /^(https?:|mailto:|\/|#)/i
  var SRC_OK_RE = /^(https?:|data:image\/|\/|#)/i
  var VENDOR_BASE = '/assets/kimi-chat/vendor/'

  // ---------- 无障碍：减少动态效果 ----------
  try {
    if (typeof document !== 'undefined' && document.head && !document.getElementById('vcp-reduced-motion')) {
      var _rm = document.createElement('style')
      _rm.id = 'vcp-reduced-motion'
      _rm.textContent = '@media (prefers-reduced-motion: reduce){#vcp-root,[id^="vcp-msg-"],#vcp-root *,[id^="vcp-msg-"] *{animation:none !important;transition:none !important}}'
      document.head.appendChild(_rm)
    }
  } catch (e) {}

  // ---------- 可信模式 ----------
  function isTrusted() {
    try { return typeof window.__vcpTrusted === 'function' && window.__vcpTrusted() } catch (e) {}
    return false
  }
  var _trustedQueue = []
  var _trustedSeq = 0
  function extractTrustedScripts(html) {
    if (!isTrusted() || html.indexOf('<script') === -1) return html
    return html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, function (m, code) {
      _trustedQueue.push({ id: 's' + (++_trustedSeq), code: code })
      return ''
    })
  }
  function decodeEntities(s) {
    if (!s || s.indexOf('&') === -1) return s
    if (typeof document === 'undefined') return s
    var ta = document.createElement('textarea')
    ta.innerHTML = s
    return ta.value
  }
  function flushTrustedScripts() {
    if (!_trustedQueue.length) return
    var q = _trustedQueue
    _trustedQueue = []
    var w = window.__vcpTrustedRan || (window.__vcpTrustedRan = [])
    function exec() {
      for (var i = 0; i < q.length; i++) {
        var id = q[i].id
        if (w.indexOf(id) !== -1) continue
        w.push(id)
        try { (0, eval)(decodeEntities(q[i].code)) } catch (e) { if (typeof console !== 'undefined') console.error('[vcp-trusted] script 执行失败:', e) }
      }
    }
    if (typeof setTimeout === 'function') setTimeout(exec, 0)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { setTimeout(exec, 0) })
      requestAnimationFrame(function () { setTimeout(exec, 20) })
    }
    if (typeof setTimeout === 'function') setTimeout(exec, 500)
  }

  // ---------- 源码层工具 ----------
  function imgConvert(text) {
    if (text.indexOf('![') === -1) return text
    return text.replace(IMG_RE, function (m, a, u) {
      u = u.trim()
      if (!SRC_OK_RE.test(u)) return m
      return '<img alt="' + (a || '').replace(/"/g, '&quot;') + '" src="' + u.replace(/"/g, '&quot;') + '">'
    })
  }
  function constrainImg(text) {
    if (!text || text.indexOf('<img') === -1) return text
    return text.replace(IMG_TAG_RE, function (m, attrs) {
      var sm = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs)
      var sv = sm ? sm[2] : ''
      if (/(?:^|[;{])\s*(?:max-width|width)\s*:/i.test(sv)) return m
      var inject = 'max-width:100%;height:auto'
      if (sm) {
        var q = sm[1]
        var ns = sv ? sv + ';' + inject : inject
        return '<img' + attrs.slice(0, sm.index) + 'style=' + q + ns + q + attrs.slice(sm.index + sm[0].length) + '>'
      }
      return '<img' + attrs + ' style="' + inject + '">'
    })
  }
  function sanitizeStyle(text) {
    if (text.indexOf('<style') === -1) return text
    return text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, function (m) {
      return m.replace(/\n\s*\n/g, '\n')
    })
  }
  function boostTextImportant(css) {
    if (!css) return css
    var faces = []
    css = css.replace(FACE_PLACEHOLDER_RE, function (m) {
      faces.push(m)
      return '\u0001F' + (faces.length - 1) + '\u0001'
    })
    css = css.replace(BOOST_TEXT_DECL_RE, function (m, prop, val, imp, term) {
      if (imp) return m
      return prop + ':' + val + '!important' + term
    })
    if (faces.length) css = css.replace(/\u0001F(\d+)\u0001/g, function (m, i) { return faces[+i] })
    return css
  }
  function boostStyle(text) {
    if (!text || text.indexOf('<style') === -1) return text
    return text.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, function (m, open, css, close) {
      return open + boostTextImportant(css) + close
    })
  }
  var FONT_INHERIT_RULE = function (uid) {
    var out = '\n  /* kimi-chat 注入：字体链兜底（根容器锁定 + 未声明字体元素继承）*/\n  #' + uid + '{font-family:' + FONT_SYSTEM_CHAIN + ' !important}\n  '
    var tags = FONT_INHERIT_TAGS.split(',')
    for (var i = 0; i < tags.length; i++) out += '#' + uid + ' ' + tags[i] + '{font-family:inherit !important}\n  '
    return out
  }
  var scopeLast = null
  var scopeSeq = 0
  function scopeVcp(raw) {
    if (!raw || raw.indexOf('vcp-root') === -1) return raw
    var hasRoot = /<div[^>]*\bid=["']vcp-root["']/i.test(raw)
    if (!hasRoot && raw.indexOf('#vcp-root') === -1) return raw
    var uid
    if (scopeLast && raw.indexOf(scopeLast.raw) === 0) uid = scopeLast.uid
    else uid = 'vcp-msg-' + (++scopeSeq)
    scopeLast = { raw: raw, uid: uid }
    var out = raw.replace(/(<div[^>]*\bid=)["']vcp-root["']/i, '$1"' + uid + '"')
    out = out.replace(/#vcp-root/g, '#' + uid)
    var li = out.lastIndexOf('</style>')
    if (li !== -1) out = out.slice(0, li) + FONT_INHERIT_RULE(uid) + out.slice(li)
    return out
  }
  function closeBracesSmart(css) {
    var depth = 0, out = ''
    var stack = []
    for (var i = 0; i < css.length; i++) {
      var ch = css[i]
      if (ch === '{') {
        var cut = out.length
        while (cut > 0 && out[cut - 1] !== ';' && out[cut - 1] !== '{' && out[cut - 1] !== '}') cut--
        var sel = out.slice(cut).trim()
        var isAt = sel.charAt(0) === '@'
        var topIsRule = stack.length > 0 && stack[stack.length - 1] === 'rule'
        if (topIsRule) {
          out = out.slice(0, cut) + '}' + sel
          stack.pop()
          depth--
        }
        stack.push(isAt ? 'at' : 'rule')
        depth++
        out += ch
      } else if (ch === '}') {
        if (depth > 0) { depth--; if (stack.length) stack.pop() }
        out += ch
      } else out += ch
    }
    while (depth-- > 0) out += '}'
    return out
  }
  // 未闭合的 style/script 开标签 → 转义为文本（非流式：文字里的伪标签不应吞掉后续内容）
  function escapeUnclosedRawtext(html) {
    return html.replace(/<(style|script)(\s[^>]*)?>/gi, function (m, name) {
      var after = html.slice(html.indexOf(m) + m.length).toLowerCase()
      if (after.indexOf('</' + name.toLowerCase() + '>') === -1) return '&lt;' + m.slice(1)
      return m
    })
  }
  function mermaidBlockConvert(text) {
    if (!text || text.indexOf('language-mermaid') === -1) return text
    return text.replace(MERMAID_PRE_RE, function (m, attrs, inner) {
      var src = inner.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '$1')
      src = src.replace(/<code[^>]*>/gi, '').replace(/<\/code>/gi, '')
      return '<div class="mermaid" style="position:relative;display:block;width:100%;box-sizing:border-box;margin:14px 0;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 1px 4px rgba(15,23,42,.06);"><div class="vcp-mermaid-view" style="overflow:auto;max-height:' + MERMAID_MAX_HEIGHT + ';padding:16px 14px;text-align:center;">' + src + '</div></div>'
    })
  }
  function protectCodeEntities(text) {
    if (!text || text.indexOf('<pre') === -1) return text
    return text.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/gi, function (m, attrs, inner) {
      var out = inner.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, function (m2, body) {
        var held = []
        var saved = body.replace(CODE_TAG_HOLD_RE, function (mm) {
          held.push(mm)
          return '\u0000C' + (held.length - 1) + '\u0000'
        })
        saved = saved.replace(/</g, '&lt;').replace(/>/g, '&gt;')
        saved = saved.replace(/\u0000C(\d+)\u0000/g, function (mm, i) { return '<' + held[+i] + '>' })
        return m2.replace(body, saved)
      })
      return '<pre' + attrs + '>' + out + '</pre>'
    })
  }
  // 卡片前空行修复 + 卡片内部空行压缩（CommonMark htmlFlow 防撕裂）
  function fixVcpBlank(text) {
    if (!text || text.indexOf('<div id="vcp-root"') === -1) return text
    var t = text.replace(/([^\n])\n(?= *<div id="vcp-root")/g, '$1\n\n')
    t = t.replace(/(<div id="vcp-root"[^>]*>)([\s\S]*)$/, function (m, open, rest) {
      return open + rest.replace(/\n[ \t]*\n+/g, '\n')
    })
    return t
  }

  // ---------- DOM 净化 ----------
  var DROP_TAGS = { script: 1, iframe: 1, object: 1, embed: 1, applet: 1, frame: 1, frameset: 1 }
  function cleanStyleValue(sv) {
    return String(sv || '')
      .replace(/position\s*:\s*fixed\s*;?/gi, '')
      .replace(/z-index\s*:\s*\d{4,}\s*;?/gi, '')
      .replace(/(?<![\w-])content\s*:[^;]*;?/gi, '')
  }
  function sanitizeNode(node, trusted) {
    if (node.nodeType === 3) return // 文本节点
    if (node.nodeType === 8) { node.parentNode && node.parentNode.removeChild(node); return } // 注释
    if (node.nodeType !== 1) return
    var name = (node.localName || node.tagName || '').toLowerCase()
    if (DROP_TAGS[name]) { node.parentNode && node.parentNode.removeChild(node); return }
    // 属性过滤
    var attrs = Array.prototype.slice.call(node.attributes)
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i]
      var n = a.name.toLowerCase()
      var v = a.value
      var drop = false
      if (/^on/i.test(n)) {
        // 仅放行受控桥 onclick="input('...')"；可信模式放行全部 on*
        drop = !(trusted || (n === 'onclick' && ONCLICK_BRIDGE_RE.test(v.trim())))
      } else if (n === 'href' || n === 'action' || n === 'formaction' || n === 'xlink:href') {
        drop = trusted ? /^\s*javascript:/i.test(v) : !URL_OK_RE.test(v.trim())
      } else if (n === 'src' || n === 'poster') {
        drop = trusted ? /^\s*javascript:/i.test(v) : !SRC_OK_RE.test(v.trim())
      } else if (n === 'style') {
        node.setAttribute('style', cleanStyleValue(v))
        continue
      } else if (n === 'srcset') {
        drop = !trusted
      }
      if (drop) node.removeAttribute(a.name)
    }
    // SVG 内 script/事件已由上面统一处理；递归子节点
    var kids = Array.prototype.slice.call(node.childNodes)
    for (var j = 0; j < kids.length; j++) sanitizeNode(kids[j], trusted)
  }

  // ---------- 自愈层（DOM 版） ----------
  function applyRootGuardStyle(el) {
    var id = el.id || ''
    if (!/^vcp-(msg-)?\d+$/.test(id)) return
    var st = el.style
    if (!st.boxSizing) st.boxSizing = 'border-box'
    if (!st.maxWidth && !st.width) st.maxWidth = '920px'
    if (!st.overflowWrap) st.overflowWrap = 'break-word'
    if (!st.fontFamily) st.fontFamily = FONT_SYSTEM_CHAIN
  }
  function guardChildrenDom(root) {
    var els = root.querySelectorAll('*')
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      var tag = (el.localName || el.tagName || '').toLowerCase()
      var st = el.style
      if (SVG_TAGS[tag]) {
        if (tag === 'svg') {
          if (!st.display) st.display = 'block'
          if (!st.maxWidth) st.maxWidth = '100%'
        }
        if (st && (st.animation || st.transform) && !st.transformBox) {
          st.transformBox = 'fill-box'
          if (!st.transformOrigin) st.transformOrigin = 'center'
        }
      }
      if (GUARD_TAGS[tag]) {
        if (tag === 'table') {
          if (!st.display) st.display = 'block'
          if (!st.width) st.width = '100%'
          if (!st.maxWidth) st.maxWidth = '100%'
          if (!st.overflowX) st.overflowX = 'auto'
        } else if (tag === 'pre') {
          if (!st.overflowX) st.overflowX = 'auto'
          if (!st.maxWidth) st.maxWidth = '100%'
        } else if (st && (tag === 'td' || tag === 'th') && (st.whiteSpace === 'nowrap' || st.whiteSpace === 'pre')) {
          if (!st.overflow) st.overflow = 'hidden'
        } else if (st && !st.boxSizing && (st.width || st.minWidth || st.maxWidth || st.display)) {
          st.boxSizing = 'border-box'
        }
      }
    }
  }
  function cssChannel(v) { var c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  function cssLuminance(cssColor) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cssColor || '')
    if (!m) return 1
    return 0.2126 * cssChannel(+m[1]) + 0.7152 * cssChannel(+m[2]) + 0.0722 * cssChannel(+m[3])
  }
  function rgbLuminance(rgb) {
    if (!rgb) return 1
    return 0.2126 * cssChannel(rgb[0]) + 0.7152 * cssChannel(rgb[1]) + 0.0722 * cssChannel(rgb[2])
  }
  function parseColor(cssColor) {
    var m = /rgba?\(([^)]*)\)/.exec(cssColor || '')
    if (!m) return null
    var parts = m[1].split(',').map(function (s) { return parseFloat(s.trim()) })
    if (parts.length < 3) return null
    return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length > 3 && !isNaN(parts[3]) ? parts[3] : 1 }
  }
  function nearestOpaqueBg(el) {
    var n = el.parentElement
    while (n && n.nodeType === 1) {
      var pc = parseColor(window.getComputedStyle(n).backgroundColor)
      if (pc && pc.alpha >= 1) return pc.rgb
      n = n.parentElement
    }
    return null
  }
  function fixCodeContrast(root) {
    if (!root || !root.querySelectorAll || typeof window === 'undefined' || !window.getComputedStyle) return
    var codes = root.querySelectorAll('code')
    for (var i = 0; i < codes.length; i++) {
      var el = codes[i]
      try {
        var cs = window.getComputedStyle(el)
        var color = cs.color
        var bgP = parseColor(cs.backgroundColor)
        if (!bgP || bgP.alpha === 0) continue
        var eff = bgP.rgb
        if (bgP.alpha < 1) {
          var anc = nearestOpaqueBg(el)
          if (anc) {
            var a = bgP.alpha
            eff = [
              Math.round(anc[0] * (1 - a) + bgP.rgb[0] * a),
              Math.round(anc[1] * (1 - a) + bgP.rgb[1] * a),
              Math.round(anc[2] * (1 - a) + bgP.rgb[2] * a)
            ]
          }
        }
        var colorLum = cssLuminance(color)
        var effLum = rgbLuminance(eff)
        var hi = Math.max(colorLum, effLum) + 0.05
        var lo = Math.min(colorLum, effLum) + 0.05
        if (hi / lo < 2.6) el.style.setProperty('color', effLum > 0.5 ? '#111111' : '#f5f4f0', 'important')
      } catch (e) {}
    }
  }
  function finalizeRoot(el) {
    if (!el || el.nodeType !== 1 || !el.style || !el.dataset) return
    if (el.dataset.vcpBgDone === 'true') return
    el.dataset.vcpBgDone = 'true'
    try {
      if (!(el.style.background || el.style.backgroundColor)) {
        var styles = el.querySelectorAll('style')
        var hasBg = false
        for (var i = 0; i < styles.length; i++) {
          if (/#vcp-(?:msg-)?\d+\s*\{[^}]*background/i.test(styles[i].textContent || '')) { hasBg = true; break }
        }
        if (!hasBg) el.style.setProperty('background', '#F5F4F0')
      }
      fixCodeContrast(el)
    } catch (e) {}
  }
  function collectTextSelectors(root) {
    var map = {}
    for (var pi = 0; pi < TEXT_INHERIT_PROPS.length; pi++) map[TEXT_INHERIT_PROPS[pi]] = []
    var styles = root && root.querySelectorAll ? root.querySelectorAll('style') : []
    for (var k = 0; k < styles.length; k++) {
      var css = styles[k].textContent || ''
      var blocks = css.split('}')
      for (var b = 0; b < blocks.length; b++) {
        var block = blocks[b]
        var open = block.lastIndexOf('{')
        if (open === -1) continue
        var decls = block.slice(open + 1)
        var sel = block.slice(0, open)
        var parts = sel.split(',')
        for (var pi2 = 0; pi2 < TEXT_INHERIT_PROPS.length; pi2++) {
          var prop = TEXT_INHERIT_PROPS[pi2]
          if (!new RegExp('(^|[;\\s])' + prop.replace('-', '\\-') + '\\s*:', 'i').test(decls)) continue
          for (var p2 = 0; p2 < parts.length; p2++) {
            var one = parts[p2].trim()
            if (one && map[prop].indexOf(one) === -1) map[prop].push(one)
          }
        }
      }
    }
    return map
  }
  function enforceFontChain(el) {
    if (!el || el.nodeType !== 1 || !el.querySelectorAll || !el.style) return
    if (el.dataset && el.dataset.vcpFontDone === 'true') return
    try {
      var selMap = collectTextSelectors(el)
      function matched(node, prop) {
        var sels = selMap[prop] || []
        for (var s = 0; s < sels.length; s++) {
          try { if (node.matches(sels[s])) return true } catch (e) {}
        }
        return false
      }
      var rootFont = el.style.fontFamily
      if (!(rootFont && rootFont.indexOf('ui-sans-serif') !== 0 && !matched(el, 'font-family'))) {
        if (!matched(el, 'font-family')) el.style.setProperty('font-family', FONT_SYSTEM_CHAIN, 'important')
      }
      var els = el.querySelectorAll(FONT_INHERIT_TAGS)
      for (var i = 0; i < els.length; i++) {
        var node = els[i]
        for (var p = 0; p < TEXT_INHERIT_PROPS.length; p++) {
          var prop = TEXT_INHERIT_PROPS[p]
          if (node.style && node.style[prop]) continue
          if (matched(node, prop)) continue
          node.style.setProperty(prop, 'inherit', 'important')
        }
      }
      if (el.dataset) el.dataset.vcpFontDone = 'true'
    } catch (e) {}
  }
  function healSvgAnimation(root) {
    if (!root || root.nodeType !== 1 || !root.querySelectorAll) return
    if (typeof window === 'undefined' || !window.getComputedStyle) return
    try {
      var els = root.querySelectorAll('svg *')
      for (var i = 0; i < els.length; i++) {
        var el = els[i]
        var cs = window.getComputedStyle(el)
        if (!cs || !cs.animationName || cs.animationName === 'none') continue
        var origin = cs.transformOrigin || ''
        var isDefault = origin === '' || origin === '0px 0px' || origin === '50% 50%'
        if (isDefault) {
          el.style.setProperty('transform-box', 'fill-box', 'important')
          el.style.setProperty('transform-origin', 'center', 'important')
        }
      }
    } catch (e) {}
  }

  // ---------- 数学（KaTeX） ----------
  function looksLikeSafeSingleDollarMath(content) {
    var t = (content || '').trim()
    if (!t) return false
    var hasExplicitMathSignal = /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|text|mathrm|mathbf|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(t)
    var isSimpleNumericMath = /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:%|\\%|‰|°))?$/.test(t)
    var isSimpleIdentifierMath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(t)
    if (/^\d/.test(t) && !hasExplicitMathSignal && !isSimpleNumericMath) return false
    if (t.charAt(0) === '/') return false
    if (t.charAt(0) === '{' && t.charAt(t.length - 1) === '}') return false
    if (t.indexOf('|') !== -1) return false
    return hasExplicitMathSignal || isSimpleNumericMath || isSimpleIdentifierMath
  }
  function convertSafeDollarMath(text) {
    var result = ''
    var index = 0
    while (index < text.length) {
      var openIndex = text.indexOf('$', index)
      if (openIndex === -1) { result += text.slice(index); break }
      result += text.slice(index, openIndex)
      var prev = text.charAt(openIndex - 1)
      var nextOpen = text.charAt(openIndex + 1)
      if (prev === '\\' || prev === '$' || nextOpen === '$' || /\w/.test(prev)) {
        result += '$'; index = openIndex + 1; continue
      }
      var closeIndex = -1
      var cursor = openIndex + 1
      while (cursor < text.length) {
        var dollarIndex = text.indexOf('$', cursor)
        if (dollarIndex === -1) break
        if (text.charAt(dollarIndex - 1) === '\\') { cursor = dollarIndex + 1; continue }
        if (!/\w/.test(text.charAt(dollarIndex + 1))) { closeIndex = dollarIndex; break }
        cursor = dollarIndex + 1
      }
      if (closeIndex === -1) { result += '$'; index = openIndex + 1; continue }
      var content = text.slice(openIndex + 1, closeIndex)
      if (content.length > 1200 || content.indexOf('\n') !== -1 || !looksLikeSafeSingleDollarMath(content)) {
        result += '$'; index = openIndex + 1; continue
      }
      result += '\\(' + content.trim() + '\\)'
      index = closeIndex + 1
    }
    return result
  }
  function normalizeMathTextNodes(root) {
    if (!root || typeof document === 'undefined' || !document.createTreeWalker) return
    try {
      var walker = document.createTreeWalker(root, 4, {
        acceptNode: function (node) {
          var parent = node.parentElement
          if (!parent) return 2
          if (parent.closest && parent.closest('pre, code, script, style, textarea, .katex')) return 2
          return node.nodeValue && node.nodeValue.indexOf('$') !== -1 ? 1 : 2
        }
      })
      var nodes = []
      var node
      while ((node = walker.nextNode())) nodes.push(node)
      for (var i = 0; i < nodes.length; i++) {
        var nv = convertSafeDollarMath(nodes[i].nodeValue)
        if (nv !== nodes[i].nodeValue) nodes[i].nodeValue = nv
      }
    } catch (e) {}
  }
  function renderMathInContent(container) {
    var fn = window.renderMathInElement
    if (typeof fn !== 'function') return false
    try {
      fn(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false }
        ],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        throwOnError: false
      })
      return true
    } catch (e) { return false }
  }
  function katexFontFor(cls) {
    if (!cls) return 'KaTeX_Main_VD'
    if (cls.indexOf('mathbb') !== -1 || cls.indexOf('amsrm') !== -1) return 'KaTeX_AMS_VD'
    if (cls.indexOf('mathcal') !== -1) return 'KaTeX_Caligraphic_VD'
    if (cls.indexOf('mathfrak') !== -1) return 'KaTeX_Fraktur_VD'
    if (cls.indexOf('mathscr') !== -1) return 'KaTeX_Script_VD'
    if (cls.indexOf('mathsf') !== -1 || cls.indexOf('textsf') !== -1) return 'KaTeX_SansSerif_VD'
    if (cls.indexOf('mathtt') !== -1 || cls.indexOf('texttt') !== -1) return 'KaTeX_Typewriter_VD'
    if (cls.indexOf('mathnormal') !== -1 || cls.indexOf('mathit') !== -1 || cls.indexOf('textit') !== -1) return 'KaTeX_Math_VD'
    return 'KaTeX_Main_VD'
  }
  function lockKatexStyles(container) {
    if (!container || !container.querySelectorAll) return
    try {
      var els = container.querySelectorAll('.katex span')
      for (var i = 0; i < els.length; i++) {
        var el = els[i]
        var font = katexFontFor(el.className || '')
        if (font) el.style.setProperty('font-family', font, 'important')
        var inlineColor = el.style.color
        if (inlineColor) el.style.setProperty('color', inlineColor, 'important')
      }
    } catch (e) {}
  }

  // ---------- Mermaid ----------
  function mermaidFixSmartChars(code) { return (code || '').replace(/[—–－]/g, '--') }
  var MERMAID_THEME = {
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      fontFamily: 'PingFang SC, Microsoft YaHei, Segoe UI, sans-serif',
      fontSize: '13px',
      primaryColor: '#f4f8fc', primaryTextColor: '#1e293b', primaryBorderColor: '#94a3b8',
      lineColor: '#475569', textColor: '#1e293b',
      secondaryColor: '#f5f0fa', tertiaryColor: '#f0f4f8',
      clusterBkg: '#f8fafc', clusterBorder: '#cbd5e1', edgeLabelBackground: '#ffffff',
      actorBkg: '#e8f0f8', actorBorder: '#94a3b8', actorTextColor: '#1e293b',
      actorLineColor: '#94a3b8', signalColor: '#475569', signalTextColor: '#1e293b',
      labelBoxBkgColor: '#e2e8f0', labelBoxBorderColor: '#94a3b8', labelTextColor: '#1e293b',
      taskBkgColor: '#dbeafe', taskBorderColor: '#60a5fa', taskTextColor: '#0f172a',
      taskTextOutsideColor: '#475569', activeTaskBkgColor: '#93c5fd', activeTaskBorderColor: '#3b82f6',
      doneTaskBkgColor: '#e2e8f0', doneTaskBorderColor: '#94a3b8',
      sectionBkgColor: '#f0f4f8', sectionTextColor: '#334155'
    }
  }
  function warmupMermaid() {
    if (typeof window.mermaid !== 'object' || window.__mermaidInitialized) return
    try {
      window.mermaid.initialize(MERMAID_THEME)
      window.__mermaidInitialized = true
    } catch (e) {}
  }
  function enhanceMermaid(el) {
    if (!el || el.dataset.vcpMermaidEnhanced === 'true') return
    var outer = el.parentNode
    if (!outer) return
    var svg = el.querySelector('svg')
    if (!svg || svg.dataset.vcpMermaidScaled === 'true') return
    el.dataset.vcpMermaidEnhanced = 'true'
    var rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null
    var vb = (svg.getAttribute('viewBox') || '').split(/\s+/)
    var rawW = (vb.length === 4 ? parseFloat(vb[2]) : 0) || (rect && rect.width) || 400
    var rawH = (vb.length === 4 ? parseFloat(vb[3]) : 0) || (rect && rect.height) || 300
    var state = { scale: 1 }
    var tb = document.createElement('div')
    tb.className = 'vcp-mermaid-toolbar'
    tb.style.cssText = 'position:absolute;top:6px;right:8px;z-index:5;display:flex;gap:4px;align-items:center;background:rgba(255,255,255,.94);border:1px solid #e2e8f0;border-radius:8px;padding:3px;box-shadow:0 1px 3px rgba(15,23,42,.08);'
    var bstyle = 'min-width:30px;height:26px;padding:0 8px;border:1px solid #cbd5e1;border-radius:6px;background:#ffffff !important;color:#475569 !important;cursor:pointer;font-size:13px;line-height:1;font-family:Consolas,monospace;'
    var fitScale = function () {
      var cw = el.clientWidth - 24
      var ch = (el.clientHeight || 400) - 60
      var s = 1
      if (cw > 40 && rawW > 40) s = Math.min(s, cw / rawW)
      if (ch > 40 && rawH > 40) s = Math.min(s, ch / rawH)
      return Math.max(0.2, +(s).toFixed(2))
    }
    var pctBtn
    var apply = function () {
      svg.style.width = Math.max(1, Math.round(rawW * state.scale)) + 'px'
      svg.style.height = Math.max(1, Math.round(rawH * state.scale)) + 'px'
      svg.style.maxWidth = 'none'
      if (pctBtn) {
        pctBtn.textContent = Math.round(state.scale * 100) + '%'
        pctBtn.title = '当前 ' + Math.round(state.scale * 100) + '%，点击还原 100%'
      }
    }
    var mkBtn = function (label, title, fn) {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = title
      b.style.cssText = bstyle
      b.addEventListener('click', fn)
      return b
    }
    tb.appendChild(mkBtn('−', '缩小', function () { state.scale = Math.max(0.3, +(state.scale - 0.2).toFixed(2)); apply() }))
    pctBtn = mkBtn('100%', '原始大小', function () { state.scale = 1; apply() })
    tb.appendChild(pctBtn)
    tb.appendChild(mkBtn('＋', '放大', function () { state.scale = Math.min(4, +(state.scale + 0.2).toFixed(2)); apply() }))
    tb.appendChild(mkBtn('适应', '匹配窗口（宽高最佳）', function () { state.scale = fitScale(); apply() }))
    state.scale = fitScale()
    apply()
    outer.appendChild(tb)
    el.style.cursor = 'grab'
    el.style.touchAction = 'none'
    var pan = { on: false, x0: 0, y0: 0, sl0: 0, st0: 0 }
    el.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('.vcp-mermaid-toolbar')) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      pan.on = true
      pan.x0 = e.clientX; pan.y0 = e.clientY
      pan.sl0 = el.scrollLeft; pan.st0 = el.scrollTop
      el.style.cursor = 'grabbing'
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId) } catch (err) {} }
      if (e.preventDefault) e.preventDefault()
    })
    el.addEventListener('pointermove', function (e) {
      if (!pan.on) return
      el.scrollLeft = pan.sl0 - (e.clientX - pan.x0)
      el.scrollTop = pan.st0 - (e.clientY - pan.y0)
    })
    function endPan() { pan.on = false; el.style.cursor = 'grab' }
    el.addEventListener('pointerup', endPan)
    el.addEventListener('pointercancel', endPan)
  }
  function renderMermaidInContent(container) {
    if (!container || !container.querySelectorAll) return false
    if (typeof window.mermaid !== 'object' || typeof window.mermaid.run !== 'function') return false
    try {
      var blocks = container.querySelectorAll('pre.language-mermaid, pre > code.language-mermaid, div.mermaid')
      var pres = []
      var seen = []
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i]
        if (b.tagName === 'DIV' && b.className.indexOf('mermaid') !== -1) {
          var v0 = b.querySelector(':scope > .vcp-mermaid-view')
          var busy = v0
            ? (v0.dataset.vcpMermaidDone === 'true' || v0.dataset.vcpMermaidPending === 'true')
            : (b.dataset.vcpMermaidDone === 'true' || b.dataset.vcpMermaidPending === 'true')
          if (busy) continue
          if (!b.isConnected) continue
          if (seen.indexOf(b) !== -1) continue
          seen.push(b)
          b.style.position = 'relative'
          b.style.overflow = 'visible'
          b.style.maxHeight = 'none'
          var view = b.querySelector(':scope > .vcp-mermaid-view')
          if (!view) {
            view = document.createElement('div')
            view.className = 'vcp-mermaid-view'
            view.style.cssText = 'overflow:auto;max-height:' + MERMAID_MAX_HEIGHT + ';padding:16px 14px;text-align:center;'
            while (b.firstChild) view.appendChild(b.firstChild)
            b.appendChild(view)
          }
          var cacheSrc = (view.textContent || '').trim()
          var cache = window.__vcpMermaidCache || (window.__vcpMermaidCache = {})
          if (cacheSrc && cache[cacheSrc]) {
            view.innerHTML = cache[cacheSrc]
            view.dataset.vcpMermaidDone = 'true'
            enhanceMermaid(view)
            continue
          }
          pres.push(view)
          continue
        }
        var pre = b.tagName === 'PRE' ? b : b.parentNode
        if (!pre || pre.dataset.vcpMermaidDone === 'true') continue
        if (!pre.isConnected || !pre.parentNode) continue
        if (seen.indexOf(pre) !== -1) continue
        seen.push(pre)
        var codeEl = pre.querySelector('code') || pre
        var src = mermaidFixSmartChars(codeEl.textContent || '')
        if (!src.trim()) continue
        var div = document.createElement('div')
        div.className = 'mermaid'
        div.style.cssText = 'position:relative;display:block;width:100%;box-sizing:border-box;margin:14px 0;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 1px 4px rgba(15,23,42,.06);'
        div.style.position = 'relative'
        var view2 = document.createElement('div')
        view2.className = 'vcp-mermaid-view'
        view2.style.cssText = 'overflow:auto;max-height:' + MERMAID_MAX_HEIGHT + ';padding:16px 14px;text-align:center;'
        view2.textContent = src
        div.appendChild(view2)
        if (pre.parentNode) pre.parentNode.replaceChild(div, pre)
        pres.push(view2)
      }
      if (pres.length === 0) return false
      if (!window.__mermaidInitialized) {
        window.mermaid.initialize(MERMAID_THEME)
        window.__mermaidInitialized = true
      }
      for (var j = 0; j < pres.length; j++) {
        (function (el) {
          try {
            el.dataset.vcpMermaidPending = 'true'
            var runMermaid = function () {
              if (el.isConnected === false) { el.dataset.vcpMermaidPending = ''; return }
              var cacheSrc2 = (el.textContent || '').trim()
              // shadow DOM 内 mermaid 用 document.getElementById 找不到节点会崩，
              // 临时移到 body 的离屏容器渲染，完成后移回原位
              var holder = null, backParent = null, backNext = null
              if (el.getRootNode && el.getRootNode() !== document) {
                backParent = el.parentNode
                backNext = el.nextSibling
                holder = document.createElement('div')
                holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + Math.max(el.clientWidth || 0, 600) + 'px;'
                document.body.appendChild(holder)
                holder.appendChild(el)
              }
              var restore = function () {
                if (!holder) return
                if (backParent) backParent.insertBefore(el, backNext)
                holder.remove()
                holder = null
              }
              window.mermaid.run({ nodes: [el] }).then(function () {
                restore()
                el.dataset.vcpMermaidPending = ''
                if (el.isConnected === false) return
                var svg = el.querySelector('svg')
                if (!svg) { setTimeout(runMermaid, MERMAID_RETRY_MS); return }
                el.dataset.vcpMermaidDone = 'true'
                if (svg) {
                  svg.style.maxWidth = '100%'
                  svg.style.height = 'auto'
                  svg.style.display = 'block'
                  svg.style.margin = '0 auto'
                }
                if (cacheSrc2) {
                  var cache2 = window.__vcpMermaidCache || (window.__vcpMermaidCache = {})
                  cache2[cacheSrc2] = el.innerHTML
                  var ck = Object.keys(cache2)
                  if (ck.length > MERMAID_CACHE_MAX) delete cache2[ck[0]]
                }
                enhanceMermaid(el)
              }).catch(function (err) {
                restore()
                el.dataset.vcpMermaidPending = ''
                console.debug('[vcp-mermaid] 渲染失败，回退源码:', err && err.message)
                var pre2 = document.createElement('pre')
                pre2.className = 'language-mermaid'
                var code2 = document.createElement('code')
                code2.className = 'language-mermaid'
                code2.textContent = el.textContent || ''
                pre2.appendChild(code2)
                if (el.parentNode) el.parentNode.replaceChild(pre2, el)
              })
            }
            setTimeout(runMermaid, 0)
          } catch (e) { console.debug('[vcp-mermaid] run 异常:', e && e.message) }
        })(pres[j])
      }
      return true
    } catch (e) { return false }
  }
  function processMath(container) {
    if (!container || container.nodeType !== 1) return
    if (container.dataset.vcpMathDone === 'true') return
    // 就绪校验加强：auto-render 若在 katex 之前执行会捕获到 undefined，
    // 之后调用抛 ParseError——用 ParseError 存在性识别这种半就绪状态。
    var katexReady = typeof window.katex === 'object' && window.katex && typeof window.katex.ParseError !== 'undefined'
      && typeof window.renderMathInElement === 'function'
    var mermaidReady = typeof window.mermaid === 'object' && typeof window.mermaid.run === 'function'
    if (!katexReady) {
      var tries = parseInt(container.dataset.vcpMathTries || '0', 10) + 1
      container.dataset.vcpMathTries = String(tries)
      if (tries <= KATEX_RETRY_MAX && container.isConnected !== false) {
        setTimeout(function () { processMath(container) }, KATEX_RETRY_MS)
      }
      return
    }
    try {
      normalizeMathTextNodes(container)
      renderMathInContent(container)
      lockKatexStyles(container)
      if (mermaidReady) renderMermaidInContent(container)
      container.dataset.vcpMathDone = 'true'
    } catch (e) {
      // 失败不锁死：清标记 + 短重试，给 vendor 迟就绪/瞬时异常留恢复机会
      container.dataset.vcpMathDone = ''
      var t2 = parseInt(container.dataset.vcpMathTries || '0', 10) + 1
      container.dataset.vcpMathTries = String(t2)
      if (t2 <= KATEX_RETRY_MAX && container.isConnected !== false) {
        setTimeout(function () { processMath(container) }, KATEX_RETRY_MS)
      }
    }
  }

  // ---------- 声明式配色（VCPColorEngine） ----------
  function applyColorVars(el) {
    if (!el || el.nodeType !== 1 || !el.dataset) return
    if (el.dataset.vcpColorDone === 'true') return
    var ds = el.dataset
    var wants = ds.vcpPreset || ds.vcpMovement || ds.vcpSoul || ds.vcpAccent
    if (!wants) return
    var engine = window.__vcpColor || window.VCPColorEngine
    if (!engine || typeof engine.generate !== 'function') return
    try {
      var opts = {}
      if (ds.vcpPreset) opts.movement = ds.vcpPreset
      else if (ds.vcpMovement) opts.movement = ds.vcpMovement
      if (ds.vcpMode) opts.mode = ds.vcpMode
      if (ds.vcpSoul) {
        var sp = ds.vcpSoul.split(',')
        var t = [parseFloat(sp[0]), parseFloat(sp[1]), parseFloat(sp[2]), parseFloat(sp[3])]
        if (!isNaN(t[0])) opts.thermalSoul = t[0]
        if (!isNaN(t[1])) opts.valence = t[1]
        if (!isNaN(t[2])) opts.arousal = t[2]
        if (!isNaN(t[3])) opts.entropy = t[3]
      }
      if (ds.vcpAccent) {
        if (ds.vcpAccent.charAt(0) === '#') opts.accentHex = ds.vcpAccent
        else opts.accentHue = parseFloat(ds.vcpAccent)
      }
      var pal = engine.generate(opts)
      var hex = pal.hex || {}
      for (var k in hex) {
        if (!Object.prototype.hasOwnProperty.call(hex, k)) continue
        var kebab = k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase() })
        el.style.setProperty('--vcp-' + kebab, hex[k])
      }
      var bs = el.style
      var has = function (p) { return !!(bs.getPropertyValue(p) || '') }
      if (!has('background') && !has('background-color')) bs.setProperty('background', 'var(--vcp-base)')
      if (!has('color')) bs.setProperty('color', 'var(--vcp-text-primary)')
      if (!has('padding') && !has('padding-top') && !has('padding-left')) bs.setProperty('padding', '20px')
      if (!has('border-radius')) bs.setProperty('border-radius', '16px')
      if (!has('border') && !has('border-color')) bs.setProperty('border', '1px solid var(--vcp-border)')
      if (!has('box-sizing')) bs.setProperty('box-sizing', 'border-box')
      if (!has('font-family')) bs.setProperty('font-family', FONT_SYSTEM_CHAIN)
      if (!has('line-height')) bs.setProperty('line-height', '1.6')
      if (!has('display')) bs.setProperty('display', 'block')
      if (!has('width')) bs.setProperty('width', '100%')
      el.dataset.vcpColorDone = 'true'
    } catch (e) {}
  }

  // ---------- 主入口：源码 → DocumentFragment ----------
  function render(raw) {
    var v = fixVcpBlank(raw || '')
    v = sanitizeStyle(constrainImg(imgConvert(scopeVcp(v))))
    v = mermaidBlockConvert(v)
    v = protectCodeEntities(v)
    v = escapeUnclosedRawtext(v)
    v = extractTrustedScripts(v)
    if (!v || !v.trim()) return null
    // 花括号平衡兜底（闭合 <style> 内漏 } 时位置感知修复）
    v = v.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, function (m, css) {
      var fixed = closeBracesSmart(css)
      return fixed === css ? m : m.replace(css, fixed)
    })
    v = boostStyle(v)
    // 防认领标记（宿主编译器可能清理未标记 style）
    v = v.replace(/<style(\s[^>]*)?>/gi, '<style$1 data-plugin="vcp-message">')

    var doc = new DOMParser().parseFromString(v, 'text/html')
    var frag = document.createDocumentFragment()
    var trusted = isTrusted()
    var head = doc.head
    if (head) {
      for (var k = 0; k < head.childNodes.length; k++) {
        var hn = head.childNodes[k]
        if (hn.nodeType === 1 && (hn.localName === 'style' || hn.localName === 'link')) {
          frag.appendChild(document.importNode(hn, true))
        }
      }
    }
    var body = doc.body
    for (var j = 0; j < body.childNodes.length; j++) frag.appendChild(document.importNode(body.childNodes[j], true))

    // 净化（在 fragment 上进行）
    var kids = Array.prototype.slice.call(frag.childNodes)
    for (var i = 0; i < kids.length; i++) sanitizeNode(kids[i], trusted)

    // 自愈层：根容器 + 子容器
    var roots = Array.prototype.slice.call(frag.childNodes).filter(function (n) { return n.nodeType === 1 })
    for (var r = 0; r < roots.length; r++) {
      applyRootGuardStyle(roots[r])
      if (roots[r].querySelectorAll) guardChildrenDom(roots[r])
    }
    return frag
  }

  // ---------- 挂载后增强 ----------
  function enhance(rootEl) {
    if (!rootEl || rootEl.nodeType !== 1) return
    try {
      applyColorVars(rootEl)
      enforceFontChain(rootEl)
      healSvgAnimation(rootEl)
      finalizeRoot(rootEl)
      processMath(rootEl)
      flushTrustedScripts()
    } catch (e) { if (typeof console !== 'undefined') console.debug('[vcp-render] enhance 失败:', e) }
  }

  window.VCPRender = {
    render: render,
    enhance: enhance,
    processMath: processMath,
    warmupMermaid: warmupMermaid,
    isTrusted: isTrusted,
    _test: {
      fixVcpBlank: fixVcpBlank,
      scopeVcp: scopeVcp,
      closeBracesSmart: closeBracesSmart,
      boostTextImportant: boostTextImportant,
      looksLikeSafeSingleDollarMath: looksLikeSafeSingleDollarMath,
      convertSafeDollarMath: convertSafeDollarMath,
      constrainImg: constrainImg,
      mermaidBlockConvert: mermaidBlockConvert,
      protectCodeEntities: protectCodeEntities
    }
  }
})();
