/**
 * kimi-chat 单元测试 —— VCP 渲染引擎纯函数（无 DOM 依赖，node 直接运行）
 * 运行：node tests/unit.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'web/vcp-render.js'), 'utf8')

// 最小 DOM stub：让引擎在 node 里加载并暴露 _test
const sandbox = {
  console,
  window: {},
  document: undefined,
  DOMParser: undefined,
  setTimeout,
}
sandbox.window.document = undefined
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

const T = sandbox.window.VCPRender._test
let pass = 0, fail = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('  ok -', name) }
  else { fail++; console.log('  FAIL -', name, '\n    got :', g, '\n    want:', w) }
}
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok -', name) }
  else { fail++; console.log('  FAIL -', name) }
}

console.log('fixVcpBlank:')
eq('卡片前补空行', T.fixVcpBlank('前言\n<div id="vcp-root">x</div>'), '前言\n\n<div id="vcp-root">x</div>')
eq('卡片内空行压缩', T.fixVcpBlank('<div id="vcp-root">a\n\nb</div>'), '<div id="vcp-root">a\nb</div>')
eq('无 vcp-root 不动', T.fixVcpBlank('普通文本\n\n第二段'), '普通文本\n\n第二段')
eq('幂等', T.fixVcpBlank(T.fixVcpBlank('前言\n<div id="vcp-root">a\n\nb</div>')), T.fixVcpBlank('前言\n<div id="vcp-root">a\n\nb</div>'))

console.log('scopeVcp:')
{
  const out = T.scopeVcp('<div id="vcp-root" style="color:red"><style>#vcp-root .t{font-size:20px}</style></div>')
  ok('id 改名', /id="vcp-msg-\d+"/.test(out))
  ok('选择器同步改名', /#vcp-msg-\d+ \.t/.test(out))
  ok('字体兜底规则注入', /font-family:inherit !important/.test(out))
}
{
  const out = T.scopeVcp('无容器文本')
  eq('无 vcp-root 原样返回', out, '无容器文本')
}

console.log('closeBracesSmart:')
eq('正常 CSS 不动', T.closeBracesSmart('.a{color:red}'), '.a{color:red}')
eq('末尾补 }', T.closeBracesSmart('.a{color:red'), '.a{color:red}')
eq('漏 } 后新规则独立', T.closeBracesSmart('.a{color:red;.b{font-size:12px}'), '.a{color:red;}.b{font-size:12px}')
eq('@media 嵌套不误伤', T.closeBracesSmart('@media screen{.a{color:red}}'), '@media screen{.a{color:red}}')

console.log('boostTextImportant:')
eq('文字声明加 important', T.boostTextImportant('.a{color:red;font-size:12px}'), '.a{color:red!important;font-size:12px!important}')
eq('背景声明不动', T.boostTextImportant('.a{background:red}'), '.a{background:red}')
eq('已有 important 幂等', T.boostTextImportant('.a{color:red !important}'), '.a{color:red !important}')
eq('@font-face 不受影响', T.boostTextImportant("@font-face{font-family:'X';src:url(a.woff2)}"), "@font-face{font-family:'X';src:url(a.woff2)}")

console.log('constrainImg:')
eq('无 style 的 img 注入', T.constrainImg('<img src="a.png">'), '<img src="a.png" style="max-width:100%;height:auto">')
eq('已有 width 尊重', T.constrainImg('<img src="a.png" style="width:50%">'), '<img src="a.png" style="width:50%">')

console.log('mermaidBlockConvert:')
{
  const out = T.mermaidBlockConvert('<pre class="language-mermaid"><code>graph TD\n  A-->B</code></pre>')
  ok('转 div.mermaid', out.indexOf('<div class="mermaid"') !== -1)
  ok('源码保留', out.indexOf('graph TD') !== -1)
  ok('pre 已移除', out.indexOf('<pre') === -1)
}
eq('无 mermaid 不动', T.mermaidBlockConvert('<pre class="language-bash"><code>ls</code></pre>'), '<pre class="language-bash"><code>ls</code></pre>')

console.log('protectCodeEntities:')
{
  const out = T.protectCodeEntities('<pre><code>&lt;div&gt;已有实体&lt;/div&gt;</code></pre>')
  eq('已转义实体不动', out, '<pre><code>&lt;div&gt;已有实体&lt;/div&gt;</code></pre>')
  const out2 = T.protectCodeEntities('<pre><code><div>裸标签</div></code></pre>')
  ok('裸 < 被转义', out2.indexOf('&lt;div&gt;') !== -1)
  const out3 = T.protectCodeEntities('<pre><code><span class="hl">高亮</span>保留</code></pre>')
  ok('白名单内联标签保留', out3.indexOf('<span class="hl">') !== -1)
}

console.log('looksLikeSafeSingleDollarMath:')
ok('价格不放行', T.looksLikeSafeSingleDollarMath('12.5') === true) // 纯数字是合法数学
ok('$12.5 价格拦截', T.looksLikeSafeSingleDollarMath('12.5 USD') === false)
ok('公式放行', T.looksLikeSafeSingleDollarMath('a^2+b^2') === true)
ok('路径不放行', T.looksLikeSafeSingleDollarMath('/usr/bin') === false)

console.log('convertSafeDollarMath:')
eq('安全公式转换', T.convertSafeDollarMath('值 $x^2$ 结束'), '值 \\(x^2\\) 结束')
eq('价格不转换', T.convertSafeDollarMath('价格 $12.5 元'), '价格 $12.5 元')
eq('词内 $ 不转换', T.convertSafeDollarMath('a$b'), 'a$b')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
