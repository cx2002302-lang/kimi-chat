#!/usr/bin/env node
/**
 * kimi-chat 本地服务 —— 独立聊天后端（与 Kimi Code 会话完全解耦）。
 *
 * 职责：
 *   1. 话题 CRUD：JSON 文件存于 ~/.kimi-code/kimi-chat/topics/<id>.json
 *      （纯文本文件，方便备份/管理，也能直接在会话里让 agent Read 讨论）
 *   2. 聊天代理：POST /api/topics/:id/chat  SSE 流式回推；
 *      后端跟随 Kimi Code CLI 模型注册表（与会话同源），凭证只存服务端
 *   3. 生成 provider（与聊天无关的可选能力，端点格式兼容 MiniMax API）：
 *      POST /api/image → 生图 → 下载落盘 images/ → 返回 /images/<file>
 *      POST /api/tts   → 语音 → 落盘 audio/ → 返回 /audio/<file>
 *   4. Markdown 导出：GET /api/topics/:id/export
 *
 * 生命周期：由 watch.cjs 的看门狗进程内启动（同进程常驻），也可独立调试：
 *   node service.cjs [port]     # 前台运行
 *
 * 安全：~/.kimi-code/server.token 存在时所有 /api/* 要求 Bearer 认证并绑 0.0.0.0，
 * 否则只监听 127.0.0.1；请求体限 1MB；/images 与 /audio 防路径穿越。
 */
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const VERSION = '0.6.1'
const HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')
const STATE_DIR = path.join(HOME, 'kimi-chat')
const TOPICS_DIR = path.join(STATE_DIR, 'topics')
const IMAGES_DIR = path.join(STATE_DIR, 'images')
const AUDIO_DIR = path.join(STATE_DIR, 'audio')
const CONFIG_FILE = path.join(STATE_DIR, 'config.json')
const CLI_CONFIG_FILE = path.join(HOME, 'config.toml')
const CLI_TOKEN_FILE = path.join(HOME, 'server.token')
const CLI_CRED_FILE = path.join(HOME, 'credentials', 'kimi-code.json')
const DEFAULT_PORT = 58931
const MAX_BODY = 1024 * 1024
const MAX_CONTEXT_MSGS = 40 // 送入模型的最近消息条数
const MAX_REPLY_TOKENS = 8192

// ---------- 配置 ----------
const DEFAULT_CONFIG = {
  // ---- 生成 provider（通用配置：生图 + 语音，端点格式兼容 MiniMax API；与聊天无关） ----
  image: {
    base_url: 'https://api.minimaxi.com', // 兼容 MiniMax 图像端点的任意服务
    api_key: '',
    model: 'image-01',
    path: '/v1/image_generation'
  },
  tts: {
    base_url: 'https://api.minimaxi.com', // 兼容 MiniMax t2a_v2 端点的任意服务
    api_key: '',
    model: 'speech-02-hd',
    voice: 'male-qn-qingse',
    path: '/v1/t2a_v2'
  },
  port: DEFAULT_PORT,
  // ---- 界面偏好（配置页可改；assistant 答复卡片样式/配色、思考折叠、右栏） ----
  ui: {
    card_style: 'editorial',   // ''=原生 / editorial / chiaroscuro / fauvism / cyberpunk / wabi_sabi
    color_mode: 'auto',        // light / dark / auto（跟随 kimi web 主题）
    think_collapse: true,      // 思考过程折叠，不刷屏
    right_rail: true           // 聊天右侧信息栏（≥1500px 时显示）
  },
  auto_token: true,            // 统一入口自动注入当前 token（false 则需手动带 #token=）
  // ---- 聊天后端：默认跟随 Kimi Code CLI 的 default_model（与会话同源） ----
  // 如需指定别的 OpenAI 兼容端点，填 chat_base_url（+ chat_api_key/chat_model）即可覆盖
  chat_base_url: '',
  chat_api_key: '',
  chat_model: '',
  system_prompt:
    '你是「kimi-chat」讨论助手，运行在用户的 Kimi Code Web UI 里。你的职责是**讨论问题**，不是写代码干活' +
    '（编程任务用户会去开会话）。回答使用中文（除非用户用其他语言）。' +
    '【排版要求】不要输出一整面素文本。默认用 Markdown，但要有结构感：' +
    '先给一两句结论，再用「## 小节标题 + 要点列表」组织主体；重点数字、术语、结论用 **加粗**；' +
    '对比类内容优先用 Markdown 表格；引用他人观点或补充说明用 > 引用块。' +
    '【视觉化】你特别擅长用图形帮助用户理解：当内容适合用图形展示时，主动输出 ```vcp 围栏代码块——' +
    '里面是正常的 HTML/SVG（可带内联 style 和 <style>，根元素 id 用 vcp-root 开头），' +
    '可以用来画示意图、流程图、结构对比、数据卡片；支持 KaTeX 公式（$$...$$）和 mermaid 图表' +
    '（<pre class="language-mermaid">）；还可以放 <button onclick="input(\'文字\')"> 按钮让用户一键追问。' +
    '解释概念、分析架构、对比方案时优先考虑用图辅助；纯闲聊或简单问答可以简短。'
}
let cfgCache = { at: 0, data: null }
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE)
    if (cfgCache.data && cfgCache.at === st.mtimeMs) return cfgCache.data
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    // 兼容旧版扁平 minimax_* 配置 → 映射进通用 image provider
    if (!j.image && (j.minimax_api_key || j.minimax_base_url || j.image_model)) {
      j.image = {
        base_url: j.minimax_base_url || DEFAULT_CONFIG.image.base_url,
        api_key: j.minimax_api_key || '',
        model: j.image_model || DEFAULT_CONFIG.image.model,
        path: DEFAULT_CONFIG.image.path
      }
    }
    const data = Object.assign({}, DEFAULT_CONFIG, j)
    data.image = Object.assign({}, DEFAULT_CONFIG.image, j.image)
    data.tts = Object.assign({}, DEFAULT_CONFIG.tts, j.tts)
    data.ui = Object.assign({}, DEFAULT_CONFIG.ui, j.ui)
    cfgCache = { at: st.mtimeMs, data }
    return data
  } catch {
    return DEFAULT_CONFIG
  }
}

// ---------- 聊天后端解析（跟随 Kimi Code CLI 默认模型，可被 config.json 覆盖） ----------
// ---------- Kimi Code CLI 注册表（providers + models，与会话同源） ----------
let registryCache = { at: 0, result: undefined }
function loadCliRegistry() {
  try {
    const st = fs.statSync(CLI_CONFIG_FILE)
    if (registryCache.result !== undefined && registryCache.at === st.mtimeMs) return registryCache.result
    const toml = fs.readFileSync(CLI_CONFIG_FILE, 'utf8')
    const result = parseCliRegistry(toml)
    registryCache = { at: st.mtimeMs, result }
    return result
  } catch {
    return { error: '读取 Kimi Code 配置失败（' + CLI_CONFIG_FILE + '）' }
  }
}
function parseCliRegistry(toml) {
  const dm = /default_model\s*=\s*"([^"]+)"/.exec(toml)
  const providers = {}
  const provRe = /\[providers\."?([^"\]]+?)"?\]([\s\S]*?)(?=\n\[|$)/g
  let pm
  while ((pm = provRe.exec(toml))) {
    const name = pm[1]
    if (/\.(oauth|custom_headers)$/.test(name)) continue
    const body = pm[2]
    providers[name] = {
      type: (/type\s*=\s*"([^"]+)"/.exec(body) || [])[1] || '',
      base_url: ((/base_url\s*=\s*"([^"]+)"/.exec(body) || [])[1] || '').replace(/\/+$/, ''),
      api_key: (/api_key\s*=\s*"([^"]*)"/.exec(body) || [])[1] || '',
    }
  }
  const models = []
  const modRe = /\[models\."([^"]+)"\]([\s\S]*?)(?=\n\[|$)/g
  let mm
  while ((mm = modRe.exec(toml))) {
    const id = mm[1]
    const body = mm[2]
    const str = (k) => (new RegExp(k + '\\s*=\\s*"([^"]*)"').exec(body) || [])[1]
    const arr = (k) => {
      const m2 = new RegExp(k + '\\s*=\\s*\\[([^\\]]*)\\]').exec(body)
      if (!m2) return []
      return (m2[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, ''))
    }
    models.push({
      id,
      provider: str('provider') || id.split('/')[0],
      model: str('model') || id.split('/').slice(1).join('/'),
      display_name: str('display_name') || id,
      capabilities: arr('capabilities'),
      support_efforts: arr('support_efforts'),
      default_effort: str('default_effort') || '',
    })
  }
  return { default_model: dm ? dm[1] : null, providers, models }
}
// kimi-code 订阅的 oauth 凭证（CLI 会定期刷新并重写该文件，按 mtime 缓存）
let credCache = { at: 0, token: null }
function loadOAuthToken() {
  try {
    const st = fs.statSync(CLI_CRED_FILE)
    if (credCache.token !== null && credCache.at === st.mtimeMs) return credCache.token
    const j = JSON.parse(fs.readFileSync(CLI_CRED_FILE, 'utf8'))
    // 过期 30s 内视为不可用（CLI 会刷新；过期时返回 null 让上层报明确错误）
    if (j.expires_at && j.expires_at * 1000 < Date.now() + 30000) {
      credCache = { at: st.mtimeMs, token: null }
      return null
    }
    credCache = { at: st.mtimeMs, token: j.access_token || null }
    return credCache.token
  } catch {
    return null
  }
}
function invalidateOAuthCache() { credCache = { at: 0, token: null } }

/**
 * 解析某个模型 id 的可用后端。
 * 优先级：config.json 的 chat_base_url 覆盖 > CLI 注册表（openai provider 直连 /
 * kimi oauth provider 用 credentials/kimi-code.json 的 access_token）。
 */
function resolveModelBackend(cfg, modelId) {
  if (cfg.chat_base_url) {
    return {
      base_url: cfg.chat_base_url.replace(/\/+$/, ''),
      api_key: cfg.chat_api_key || 'none',
      model: cfg.chat_model || (modelId ? modelId.split('/').slice(1).join('/') : ''),
      source: 'kimi-chat config.json',
      entry: null,
    }
  }
  const reg = loadCliRegistry()
  if (reg.error) return { error: reg.error }
  const id = modelId || reg.default_model
  if (!id) return { error: 'Kimi Code 未配置 default_model；请在 kimi-chat config.json 设置 chat_base_url/chat_api_key/chat_model' }
  const entry = reg.models.find((m) => m.id === id) || null
  const provName = entry ? entry.provider : id.split('/')[0]
  const modelName = entry ? entry.model : id.split('/').slice(1).join('/')
  const prov = reg.providers[provName]
  if (!prov) return { error: 'config.toml 中找不到 provider「' + provName + '」' }
  if (!prov.base_url) return { error: 'provider「' + provName + '」缺少 base_url' }
  if (prov.type === 'openai') {
    return { base_url: prov.base_url, api_key: prov.api_key || 'none', model: modelName, source: provName, entry, oauth: false }
  }
  if (provName === 'managed:kimi-code' || prov.type === 'kimi') {
    const token = loadOAuthToken()
    if (!token) {
      return { error: 'kimi-code 订阅凭证不可用（可能已过期，请在 TUI 里随便跑一句让 CLI 刷新登录态），' +
        '或在 config.json 设置 chat_base_url/chat_api_key/chat_model' }
    }
    return { base_url: prov.base_url, api_key: token, model: modelName, source: 'kimi-code 订阅', entry, oauth: true }
  }
  return { error: 'provider「' + provName + '」类型为 ' + (prov.type || '未知') + '，暂不支持直连；' +
    '请在 kimi-chat config.json 设置 chat_base_url/chat_api_key/chat_model 指向一个 OpenAI 兼容端点' }
}
// 兼容旧调用（默认模型）
function resolveChatBackend(cfg) { return resolveModelBackend(cfg, null) }

// ---------- 本地服务认证（与 kimi web 同一 bearer token；无 token 文件则仅本机可用） ----------
let tokenCache = { at: 0, token: undefined }
function serviceToken() {
  try {
    const st = fs.statSync(CLI_TOKEN_FILE)
    if (tokenCache.token !== undefined && tokenCache.at === st.mtimeMs) return tokenCache.token
    tokenCache = { at: st.mtimeMs, token: fs.readFileSync(CLI_TOKEN_FILE, 'utf8').trim() }
    return tokenCache.token
  } catch {
    return null
  }
}
function checkAuth(req, u) {
  const token = serviceToken()
  if (!token) return true // 无 token 文件：视为纯本机场景，不强制认证
  const h = req.headers.authorization || ''
  if (h === 'Bearer ' + token) return true
  if (req.method === 'GET' && u.searchParams.get('access_token') === token) return true // <img>/下载等无法带头的场景
  return false
}

// ---------- 话题存储 ----------
function ensureDirs() {
  fs.mkdirSync(TOPICS_DIR, { recursive: true })
  fs.mkdirSync(IMAGES_DIR, { recursive: true })
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
}
function newId() {
  return 't' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')
}
function topicPath(id) {
  // 防路径穿越：id 只允许安全字符
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
  return path.join(TOPICS_DIR, id + '.json')
}
function readTopic(id) {
  const p = topicPath(id)
  if (!p) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
function writeTopic(t) {
  const p = topicPath(t.id)
  if (!p) return false
  t.updated_at = new Date().toISOString()
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2))
  fs.renameSync(tmp, p) // 原子写，防流式中断写坏文件
  return true
}
function listTopics() {
  ensureDirs()
  const out = []
  for (const f of fs.readdirSync(TOPICS_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TOPICS_DIR, f), 'utf8'))
      const last = t.messages && t.messages.length ? t.messages[t.messages.length - 1] : null
      out.push({
        id: t.id, title: t.title, icon: t.icon || '', pinned: !!t.pinned,
        model: t.model || '', effort: t.effort || '',
        created_at: t.created_at, updated_at: t.updated_at,
        message_count: (t.messages || []).length,
        preview: last ? String(last.content || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').slice(0, 80) : ''
      })
    } catch { /* 损坏文件跳过 */ }
  }
  out.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.updated_at) - new Date(a.updated_at)))
  return out
}
function stripThink(s) {
  return String(s || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim()
}

// ---------- 生成 provider 上游（通用：base_url + api_key + 路径，兼容 MiniMax 端点格式） ----------
function genUpstream(gen, urlPath, body) {
  return fetch(gen.base_url.replace(/\/+$/, '') + urlPath, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + gen.api_key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
}

// ---------- HTTP 工具 ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
}
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(s)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid json')) }
    })
    req.on('error', reject)
  })
}
function sseSend(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

// ---------- 聊天（SSE 代理 + 落盘 + 自动起名） ----------
// 上游调用：带 effort 重试（上游不接受 reasoning_effort 时降级去掉）与 oauth 401 重读凭证重试
async function callChatUpstream(backend, payload, effort) {
  const body = Object.assign({}, payload)
  if (effort && backend.entry && backend.entry.capabilities.indexOf('thinking') !== -1) {
    body.reasoning_effort = effort
  }
  async function attempt(withEffort) {
    const b = Object.assign({}, body)
    if (!withEffort) delete b.reasoning_effort
    return fetch(backend.base_url + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + backend.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(b)
    })
  }
  let up = await attempt(true)
  if (up.status === 400 && body.reasoning_effort) up = await attempt(false) // 上游不认识 effort 参数
  if (up.status === 401 && backend.oauth) {
    invalidateOAuthCache()
    const token = loadOAuthToken()
    if (token && token !== backend.api_key) {
      backend.api_key = token
      up = await attempt(true)
      if (up.status === 400 && body.reasoning_effort) up = await attempt(false)
    }
  }
  return up
}

async function handleChat(req, res, id, body) {
  const cfg = loadConfig()
  const topic = readTopic(id)
  if (!topic) return sendJson(res, 404, { error: '话题不存在' })
  const content = String(body.content || '').trim()
  if (!content) return sendJson(res, 400, { error: '内容为空' })

  // 模型/思考强度：请求体 > 话题设置 > CLI 默认
  const wantModel = String(body.model || topic.model || '')
  const backend = resolveModelBackend(cfg, wantModel)
  if (!backend || backend.error) {
    return sendJson(res, 400, { error: (backend && backend.error) || '聊天后端不可用；请在 config.json 设置 chat_base_url/chat_api_key/chat_model' })
  }
  const effort = String(body.effort || topic.effort || (backend.entry && backend.entry.default_effort) || '')

  const isFirst = !topic.messages || topic.messages.length === 0
  topic.messages = topic.messages || []
  topic.messages.push({ role: 'user', content, ts: new Date().toISOString() })
  writeTopic(topic)

  const history = topic.messages.slice(-MAX_CONTEXT_MSGS).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.role === 'assistant' ? (stripThink(m.content) || m.content) : m.content
  }))

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })

  let full = ''
  let upstreamOk = false
  try {
    const up = await callChatUpstream(backend, {
      model: backend.model,
      messages: [{ role: 'system', content: cfg.system_prompt }].concat(history),
      stream: true,
      max_tokens: MAX_REPLY_TOKENS
    }, effort)
    if (!up.ok || !up.body) {
      const txt = await up.text().catch(() => '')
      sseSend(res, { error: '聊天上游错误 HTTP ' + up.status + '：' + txt.slice(0, 300) })
      res.end()
      return
    }
    upstreamOk = true
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of up.body) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (payload === '[DONE]') continue
        let j
        try { j = JSON.parse(payload) } catch { continue }
        const delta = j && j.choices && j.choices[0] && j.choices[0].delta
        // 正文进消息流；reasoning 单独以 think 事件转发（前端折叠展示，不落盘）
        const piece = delta && delta.content
        if (piece) { full += piece; sseSend(res, { delta: piece }) }
        const reasoning = delta && (delta.reasoning_content || delta.reasoning)
        if (reasoning) sseSend(res, { think: reasoning })
      }
    }
  } catch (e) {
    sseSend(res, { error: '上游请求失败：' + e.message })
    res.end()
    return
  }

  // 落盘 assistant 消息（去掉 think 部分，节省存储；原文已流给浏览器）
  const clean = stripThink(full)
  topic.messages.push({ role: 'assistant', content: clean || full, ts: new Date().toISOString() })

  // 首轮对话后自动起名
  let newTitle = null
  if (isFirst && upstreamOk && clean) {
    try {
      newTitle = await genTitle(backend, content, clean)
      if (newTitle) topic.title = newTitle
    } catch { /* 起名失败保留默认标题 */ }
  }
  writeTopic(topic)
  sseSend(res, { done: true, title: newTitle || undefined, model: backend.model, effort: effort || undefined })
  res.end()
}

async function genTitle(backend, userMsg, assistantMsg) {
  const up = await fetch(backend.base_url + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + backend.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: backend.model,
      messages: [{
        role: 'user',
        content: '给下面的对话起一个 12 字以内的中文标题，只输出标题本身，不要标点、不要引号：\n用户：' +
          userMsg.slice(0, 300) + '\n助手：' + assistantMsg.slice(0, 300)
      }],
      max_tokens: 1024 // 推理模型会先输出思考内容，需留足 token 才能拿到标题正文
    })
  })
  if (!up.ok) return null
  const j = await up.json()
  const raw = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  const title = stripThink(raw || '').split('\n')[0].replace(/["'「」《》\s]+$/g, '').trim().slice(0, 24)
  return title || null
}

// ---------- 图像生成（通用 provider） ----------
async function handleImage(req, res, body) {
  const cfg = loadConfig()
  const gen = cfg.image || {}
  if (!gen.api_key) return sendJson(res, 400, { error: '未配置生图 provider（config.json 的 image.api_key）' })
  const prompt = String(body.prompt || '').trim()
  if (!prompt) return sendJson(res, 400, { error: 'prompt 为空' })
  const aspect = /^[0-9]+:[0-9]+$/.test(body.aspect_ratio || '') ? body.aspect_ratio : '1:1'
  try {
    const up = await genUpstream(gen, gen.path || '/v1/image_generation', {
      model: gen.model,
      prompt,
      aspect_ratio: aspect,
      response_format: 'url',
      n: 1
    })
    const j = await up.json().catch(() => null)
    const url = j && j.data && j.data.image_urls && j.data.image_urls[0]
    if (!url) {
      const msg = (j && j.base_resp && j.base_resp.status_msg) || ('HTTP ' + up.status)
      return sendJson(res, 502, { error: '图像生成失败：' + msg })
    }
    // 签名 URL 会过期，立即下载落盘
    const imgRes = await fetch(url)
    if (!imgRes.ok) return sendJson(res, 502, { error: '图像下载失败 HTTP ' + imgRes.status })
    const buf = Buffer.from(await imgRes.arrayBuffer())
    ensureDirs()
    const name = crypto.createHash('sha1').update(url + Date.now()).digest('hex').slice(0, 16) + '.jpg'
    fs.writeFileSync(path.join(IMAGES_DIR, name), buf)
    sendJson(res, 200, { url: '/images/' + name, bytes: buf.length })
  } catch (e) {
    sendJson(res, 502, { error: '图像生成异常：' + e.message })
  }
}

// ---------- 语音生成 TTS（通用 provider，端点格式兼容 MiniMax t2a_v2） ----------
async function handleTts(req, res, body) {
  const cfg = loadConfig()
  const gen = cfg.tts || {}
  if (!gen.api_key) return sendJson(res, 400, { error: '未配置语音 provider（config.json 的 tts.api_key）' })
  const text = String(body.text || '').trim()
  if (!text) return sendJson(res, 400, { error: 'text 为空' })
  if (text.length > 2000) return sendJson(res, 400, { error: '文本过长（>2000 字）' })
  try {
    const up = await genUpstream(gen, gen.path || '/v1/t2a_v2', {
      model: gen.model,
      text,
      stream: false,
      voice_setting: { voice_id: gen.voice, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 }
    })
    const j = await up.json().catch(() => null)
    const hex = j && j.data && j.data.audio
    if (!hex) {
      const msg = (j && j.base_resp && j.base_resp.status_msg) || ('HTTP ' + up.status)
      return sendJson(res, 502, { error: '语音生成失败：' + msg })
    }
    const buf = Buffer.from(hex, 'hex')
    ensureDirs()
    const name = crypto.createHash('sha1').update(text + Date.now()).digest('hex').slice(0, 16) + '.mp3'
    fs.writeFileSync(path.join(AUDIO_DIR, name), buf)
    sendJson(res, 200, { url: '/audio/' + name, bytes: buf.length })
  } catch (e) {
    sendJson(res, 502, { error: '语音生成异常：' + e.message })
  }
}

// ---------- Markdown 导出 ----------
function exportMarkdown(topic) {
  const lines = ['# ' + (topic.title || '未命名话题'), '']
  lines.push('- 话题 ID：' + topic.id)
  lines.push('- 创建：' + topic.created_at + '　更新：' + topic.updated_at)
  lines.push('')
  for (const m of topic.messages || []) {
    lines.push('## ' + (m.role === 'user' ? '用户' : '助手') + '（' + (m.ts || '') + '）')
    lines.push('')
    lines.push(m.content || '')
    for (const img of m.images || []) lines.push('![](' + img + ')')
    for (const au of m.audios || []) lines.push('🔊 [' + au + '](' + au + ')')
    lines.push('')
  }
  return lines.join('\n')
}

// ---------- 路由 ----------
// kimi web 上游端口发现（同源反代用）：config.web_port 优先，其次常见端口探测
let webPortCache = { at: 0, port: 0 }
async function findWebPort(cfg) {
  if (webPortCache.port && Date.now() - webPortCache.at < 60000) return webPortCache.port
  const candidates = []
  if (cfg.web_port) candidates.push(cfg.web_port)
  for (const p of [58627, 58642, 58643]) if (!candidates.includes(p)) candidates.push(p)
  for (const port of candidates) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 800)
      const r = await fetch('http://127.0.0.1:' + port + '/api/v1/meta', { signal: ctl.signal })
      clearTimeout(t)
      if (r.status) { webPortCache = { at: Date.now(), port }; return port }
    } catch { /* 下一个 */ }
  }
  return 0
}
// 反向代理：把非本服务 API 的请求转给 kimi web（Host 改写绕开 DNS-rebinding 检查）
// HTML 页面会注入 <script src="/kc-api/inject-token.js">：服务端把当前有效 token 写进
// localStorage，用户直接打开 http://<host>:58931/ 即已登录，token 轮换也无感。
// 可在 config.json 设 "auto_token": false 关闭（关闭后需手动带 #token=）。
async function proxyToWeb(req, res) {
  const port = await findWebPort(loadConfig())
  if (!port) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('未找到运行中的 kimi web（可在 config.json 配置 web_port）')
    return
  }
  const headers = Object.assign({}, req.headers, { host: '127.0.0.1:' + port })
  const cfg = loadConfig()
  const inject = req.method === 'GET' && cfg.auto_token !== false && !!serviceToken()
  const preq = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (pres) => {
    const ctype = String((pres.headers || {})['content-type'] || '')
    if (!inject || !ctype.includes('text/html')) {
      res.writeHead(pres.statusCode || 502, pres.headers)
      pres.pipe(res)
      return
    }
    const chunks = []
    pres.on('data', (c) => chunks.push(c))
    pres.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8')
      const tag = '<script src="/kc-api/inject-token.js"></script>'
      if (!body.includes('/kc-api/inject-token.js')) {
        body = body.replace(/<head[^>]*>/i, (m) => m + tag)
      }
      const outHeaders = Object.assign({}, pres.headers)
      outHeaders['content-length'] = Buffer.byteLength(body)
      res.writeHead(pres.statusCode || 502, outHeaders)
      res.end(body)
    })
  })
  preq.on('error', () => { try { res.writeHead(502); res.end() } catch { /* 已断 */ } })
  req.pipe(preq)
}
// WebSocket 隧道（kimi web 的实时连接）：原始转发 + Host 改写
function tunnelUpgrade(req, socket, head) {
  findWebPort(loadConfig()).then((port) => {
    if (!port) { socket.destroy(); return }
    const up = net.connect(port, '127.0.0.1', () => {
      const lines = [req.method + ' ' + req.url + ' HTTP/' + req.httpVersion]
      for (const k of Object.keys(req.headers)) {
        const lk = k.toLowerCase()
        if (lk === 'host' || lk === 'origin' || lk === 'referer') continue
        lines.push(k + ': ' + req.headers[k])
      }
      // Host/Origin/Referer 统一改写为上游本机地址（上游会校验 Origin，与页面端口不一致会 403）
      lines.push('host: 127.0.0.1:' + port, 'origin: http://127.0.0.1:' + port, '', '')
      up.write(lines.join('\r\n'))
      if (head && head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
}

async function route(req, res) {
  let u = new URL(req.url, 'http://127.0.0.1')
  let p = u.pathname
  // 同源入口：/kc-api/* 是本服务 API（新版 kimi web 的 CSP `default-src 'self'` 拦跨端口 fetch，
  // 通过 http://<host>:58931/ 反代入口打开 UI 时，页面与 API 天然同源）
  if (p.startsWith('/kc-api/')) {
    let rest = p.slice('/kc-api'.length)
    if (rest === '/health') rest = '/api/health'
    req.url = rest + (u.search || '')
    u = new URL(req.url, 'http://127.0.0.1')
    p = u.pathname
    // 统一入口自动登录助手：把当前有效 token 写入 kimi web 的 localStorage 凭证位
    // （每次请求实时读 server.token，token 轮换也无感；config.auto_token=false 可关）
    if (p === '/inject-token.js') {
      const cfg = loadConfig()
      const token = cfg.auto_token === false ? null : serviceToken()
      const js = token
        ? 'try{localStorage.setItem("kimi-web.server-credential",JSON.stringify({version:1,credential:' +
          JSON.stringify(token) + ',expiresAt:Date.now()+6048e5}))}catch(e){}\n'
        : '/* kimi-chat auto_token disabled */\n'
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(js)
      return
    }
  }
  // kimi web 自家的 /api/vN/* 一律反代（本服务 API 命名空间不带版本号，不与之重叠）
  if (/^\/api\/v\d+\//.test(p)) return proxyToWeb(req, res)
  const isApi = p.startsWith('/api/') || p.startsWith('/images/') || p.startsWith('/audio/')
  if (!isApi) return proxyToWeb(req, res)
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (!checkAuth(req, u)) return sendJson(res, 401, { error: '未认证：请通过 kimi web 页面访问（bearer token）' })

  if (p === '/api/health') {
    const cfg = loadConfig()
    const backend = resolveChatBackend(cfg)
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      auth: !!serviceToken(),
      chat: backend && !backend.error ? { model: backend.model, source: backend.source } : null,
      chat_error: backend && backend.error ? backend.error : undefined,
      image: !!(cfg.image && cfg.image.api_key),
      tts: !!(cfg.tts && cfg.tts.api_key),
    })
  }

  // 模型清单（与会话同源：CLI config.toml 的 [models.*] 注册表）
  if (p === '/api/models' && req.method === 'GET') {
    const reg = loadCliRegistry()
    if (reg.error) return sendJson(res, 200, { default_model: null, items: [], error: reg.error })
    const items = reg.models.map((m) => {
      const prov = reg.providers[m.provider]
      let usable = false, reason = ''
      if (!prov || !prov.base_url) reason = 'provider 不可用'
      else if (prov.type === 'openai') usable = true
      else if (m.provider === 'managed:kimi-code' || prov.type === 'kimi') {
        usable = !!loadOAuthToken()
        if (!usable) reason = '订阅凭证过期'
      } else reason = 'provider 类型 ' + (prov.type || '未知') + ' 不支持'
      return {
        id: m.id, display_name: m.display_name, provider: m.provider,
        capabilities: m.capabilities, support_efforts: m.support_efforts,
        default_effort: m.default_effort, usable, reason,
        is_default: m.id === reg.default_model,
      }
    })
    return sendJson(res, 200, { default_model: reg.default_model, items })
  }

  // ---------- 插件配置（设置页用）：GET 脱敏读出 / PUT 合并写回 ----------
  if (p === '/api/config' && req.method === 'GET') {
    const cfg = loadConfig()
    const backend = resolveChatBackend(cfg)
    const mask = (s) => s ? String(s).slice(0, 6) + '…' + String(s).slice(-4) : ''
    return sendJson(res, 200, {
      chat: backend && !backend.error
        ? { model: backend.model, source: backend.source, override: !!(cfg.chat_base_url || cfg.chat_model) }
        : { model: null, source: null, error: backend && backend.error },
      image: { base_url: cfg.image.base_url, model: cfg.image.model, path: cfg.image.path, api_key_set: !!cfg.image.api_key, api_key_mask: mask(cfg.image.api_key) },
      tts: { base_url: cfg.tts.base_url, model: cfg.tts.model, voice: cfg.tts.voice, path: cfg.tts.path, api_key_set: !!cfg.tts.api_key, api_key_mask: mask(cfg.tts.api_key) },
      ui: cfg.ui,
      auto_token: cfg.auto_token !== false,
      system_prompt: cfg.system_prompt,
    })
  }
  if (p === '/api/config' && req.method === 'PUT') {
    const j = await readBody(req)
    let cur
    try { cur = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { cur = {} }
    const pick = (src, keys) => { const o = {}; for (const k of keys) if (src[k] !== undefined && src[k] !== '') o[k] = src[k]; return o }
    if (j.image && typeof j.image === 'object') cur.image = Object.assign({}, cur.image, pick(j.image, ['base_url', 'api_key', 'model', 'path']))
    if (j.tts && typeof j.tts === 'object') cur.tts = Object.assign({}, cur.tts, pick(j.tts, ['base_url', 'api_key', 'model', 'voice', 'path']))
    if (j.ui && typeof j.ui === 'object') cur.ui = Object.assign({}, cur.ui, pick(j.ui, ['card_style', 'color_mode']), {
      think_collapse: j.ui.think_collapse !== undefined ? !!j.ui.think_collapse : (cur.ui || {}).think_collapse,
      right_rail: j.ui.right_rail !== undefined ? !!j.ui.right_rail : (cur.ui || {}).right_rail,
    })
    if (j.auto_token !== undefined) cur.auto_token = !!j.auto_token
    if (typeof j.system_prompt === 'string' && j.system_prompt.trim()) cur.system_prompt = j.system_prompt
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), { mode: 0o600 })
    } catch (e) { return sendJson(res, 500, { error: '写入失败：' + e.message }) }
    cfgCache = { at: 0, data: null } // 立即生效
    return sendJson(res, 200, { ok: true })
  }

  // 图片静态服务
  if (p.startsWith('/images/')) {
    const name = p.slice('/images/'.length)
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) { res.writeHead(403); res.end(); return }
    const fp = path.join(IMAGES_DIR, name)
    if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return }
    const ext = path.extname(name).toLowerCase()
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' })
    fs.createReadStream(fp).pipe(res)
    return
  }
  if (p.startsWith('/audio/')) {
    const name = p.slice('/audio/'.length)
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) { res.writeHead(403); res.end(); return }
    const fp = path.join(AUDIO_DIR, name)
    if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return }
    const ext = path.extname(name).toLowerCase()
    const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[ext] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' })
    fs.createReadStream(fp).pipe(res)
    return
  }

  if (p === '/api/topics' && req.method === 'GET') return sendJson(res, 200, { items: listTopics() })
  if (p === '/api/topics' && req.method === 'POST') {
    const body = await readBody(req)
    ensureDirs()
    const now = new Date().toISOString()
    const t = {
      id: newId(),
      title: String(body.title || '新话题').slice(0, 60),
      icon: String(body.icon || ''),
      pinned: false,
      created_at: now, updated_at: now,
      messages: []
    }
    writeTopic(t)
    return sendJson(res, 200, t)
  }

  const mTopic = /^\/api\/topics\/([A-Za-z0-9_-]+)(\/chat|\/messages|\/export)?$/.exec(p)
  if (mTopic) {
    const id = mTopic[1]
    const sub = mTopic[2] || ''
    if (sub === '/chat' && req.method === 'POST') {
      const body = await readBody(req)
      return handleChat(req, res, id, body)
    }
    if (sub === '/export' && req.method === 'GET') {
      const t = readTopic(id)
      if (!t) return sendJson(res, 404, { error: '话题不存在' })
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + id + '.md"'
      })
      res.end(exportMarkdown(t))
      return
    }
    if (sub === '/messages' && req.method === 'POST') {
      const t = readTopic(id)
      if (!t) return sendJson(res, 404, { error: '话题不存在' })
      const body = await readBody(req)
      const role = body.role === 'assistant' ? 'assistant' : 'user'
      t.messages = t.messages || []
      t.messages.push({
        role, content: String(body.content || ''),
        images: Array.isArray(body.images) ? body.images.map(String) : undefined,
        audios: Array.isArray(body.audios) ? body.audios.map(String) : undefined,
        ts: new Date().toISOString()
      })
      writeTopic(t)
      return sendJson(res, 200, { ok: true, message_count: t.messages.length })
    }
    if (sub === '/messages' && req.method === 'DELETE') {
      const t = readTopic(id)
      if (!t) return sendJson(res, 404, { error: '话题不存在' })
      t.messages = []
      writeTopic(t)
      return sendJson(res, 200, { ok: true })
    }
    if (!sub && req.method === 'GET') {
      const t = readTopic(id)
      return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: '话题不存在' })
    }
    if (!sub && req.method === 'PATCH') {
      const t = readTopic(id)
      if (!t) return sendJson(res, 404, { error: '话题不存在' })
      const body = await readBody(req)
      if (typeof body.title === 'string' && body.title.trim()) t.title = body.title.trim().slice(0, 60)
      if (typeof body.icon === 'string') t.icon = body.icon.slice(0, 200)
      if (typeof body.pinned === 'boolean') t.pinned = body.pinned
      if (typeof body.model === 'string') t.model = body.model.slice(0, 120)
      if (typeof body.effort === 'string') t.effort = body.effort.slice(0, 20)
      writeTopic(t)
      return sendJson(res, 200, { ok: true })
    }
    if (!sub && req.method === 'DELETE') {
      const tp = topicPath(id)
      if (tp && fs.existsSync(tp)) fs.unlinkSync(tp)
      return sendJson(res, 200, { ok: true })
    }
  }

  if (p === '/api/image' && req.method === 'POST') {
    const body = await readBody(req)
    return handleImage(req, res, body)
  }

  if (p === '/api/tts' && req.method === 'POST') {
    const body = await readBody(req)
    return handleTts(req, res, body)
  }

  sendJson(res, 404, { error: 'not found' })
}

// ---------- 启动 ----------
let server = null
function start(port) {
  if (server) return server
  const cfg = loadConfig()
  const listenPort = port || cfg.port || DEFAULT_PORT
  ensureDirs()
  server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      try { sendJson(res, 500, { error: '内部错误：' + e.message }) } catch { /* 连接已断 */ }
    })
  })
  server.on('upgrade', tunnelUpgrade)
  server.on('error', (e) => {
    // 端口被占用等：只记录，看门狗职能不受影响
    try { fs.appendFileSync(path.join(STATE_DIR, 'watch.log'), new Date().toISOString() + ' service error: ' + e.message + '\n') } catch {}
    server = null
  })
  // 绑定地址：config.bind 覆盖；默认——有 token 文件则绑 0.0.0.0（远程浏览器经 token 认证可用），
  // 无 token 文件则退回纯本机 127.0.0.1
  const bindHost = cfg.bind || (serviceToken() ? '0.0.0.0' : '127.0.0.1')
  server.listen(listenPort, bindHost, () => {
    try { fs.appendFileSync(path.join(STATE_DIR, 'watch.log'), new Date().toISOString() + ' service listening on ' + bindHost + ':' + listenPort + '\n') } catch {}
  })
  return server
}

if (require.main === module) {
  const port = parseInt(process.argv[2], 10) || undefined
  start(port)
  console.log('[kimi-chat:service] listening on port ' + (port || loadConfig().port || DEFAULT_PORT))
}
module.exports = { start, loadConfig, listTopics, readTopic, writeTopic, stripThink, exportMarkdown, resolveChatBackend, resolveModelBackend, loadCliRegistry, STATE_DIR, CONFIG_FILE, DEFAULT_PORT, VERSION }
