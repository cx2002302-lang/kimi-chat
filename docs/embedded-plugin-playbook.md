# 嵌入式 Web 插件 playbook：统一入口反代 + 免 token 自动登录

> 适用场景：你要给一个**已有的 Web 应用**（有登录 token、有 CSP、可能带 WebSocket）
> 做嵌入式插件——往它的页面里注入自己的 UI，并且你的插件有自己的本地后端服务。
> 把这份文档丢给 AI，让它照着架构做，可以避开我们踩过的所有坑。
>
> 本文以 kimi-chat（嵌入 Kimi Code Web 的讨论插件）为实例，但模式是通用的。

---

## 1. 问题全景：为什么"插件页面调自己的后端"这么难

设宿主应用跑在 `http://<host>:58627`，插件本地服务跑在 `http://<host>:58931`。
最直觉的做法是插件 JS 里直接 `fetch('http://<host>:58931/api/...')`——会连环撞上五堵墙：

| # | 坑 | 现象 |
|---|----|------|
| 1 | **宿主 CSP** `default-src 'self'` | 浏览器直接拦截跨端口 fetch，页面报"连不上服务"，但 curl 完全正常 |
| 2 | **localStorage 按源隔离** | 宿主端口记住的 token，插件端口读不到，用户每次都要重新带 token |
| 3 | **token 会轮换** | 宿主每次重启 token 都变，书签/记住登录全部失效 |
| 4 | **WS 的 Origin 校验** | 反代 WebSocket 时只改 Host 不改 Origin，握手 403 |
| 5 | **API 命名空间冲突** | 插件服务把 `/api/*` 当自家路由，把宿主的 `/api/v1/*` 也截胡了，返回 404 |

还有两个假的"出路"，别浪费时间：

- **Service Worker 同源桥**：想过在宿主源下注册 SW 转发请求。但如果宿主给**所有**响应
  （包括 SW 脚本本身）都带 `default-src 'self'`，SW 里的 fetch 一样被拦。此路不通。
- **让用户开 SSH 隧道 / 改 hosts**：用户用内网 IP 直访时根本不成立，且体验极差。

## 2. 解法架构：统一入口反向代理

**核心思想：不让页面跨源，而是让流量同源。**

插件本地服务除了自己的 API，再兼职做**宿主应用的反向代理**：

```
浏览器 ──► http://<host>:58931/  （插件服务，统一入口）
              │
              ├── /kc-api/*          → 插件自己的 API（前缀剥离后路由）
              ├── /kc-api/inject-token.js → 动态 JS：写入当前有效 token（见 §3）
              ├── /api/vN/*          → 反代给宿主（宿主的版本化 API）
              ├── 其余所有路径         → 反代给宿主（HTML/JS/CSS/字体……）
              └── WebSocket upgrade  → 原始 TCP 隧道给宿主（改写 Host/Origin/Referer）

宿主应用 http://127.0.0.1:58627 ◄── 反代上游
```

用户只用 `http://<host>:58931/` 一个地址：页面和插件 API 天然同源，CSP `default-src 'self'`
下一切正常。本机、内网 IP、远程浏览器通吃。

### 2.1 路由顺序（重要，错一步全盘皆输）

```js
async function route(req, res) {
  let p = new URL(req.url, 'http://x').pathname

  // ① 插件 API 前缀剥离：/kc-api/foo → /foo（再走自家路由）
  if (p.startsWith('/kc-api/')) { p = stripAndRewrite(p) }

  // ② 宿主的版本化 API 必须先放走，否则被自家 /api/* 截胡（坑 #5）
  if (/^\/api\/v\d+\//.test(p)) return proxyToHost(req, res)

  // ③ 自家 API（命名空间必须不带版本号，与宿主错开）
  if (p.startsWith('/api/') || p.startsWith('/images/') || ...) return handleOwnApi(req, res)

  // ④ 其余全部反代给宿主
  return proxyToHost(req, res)
}
```

配套约定：**插件自己的 API 永远不要用 `/api/v数字/` 形式**，否则和宿主撞车。

### 2.2 前端服务探测：严格校验，防 SPA 兜底误判

宿主 SPA 通常对任意路径返回 `200 + text/html`（前端路由兜底）。前端探测插件服务
是否在线时，**必须同时校验 content-type 和响应体特征字段**：

```js
const r = await fetch('/kc-api/health')
const ct = r.headers.get('content-type') || ''
if (!ct.includes('application/json')) return false      // SPA 兜底的 HTML，不是插件服务
const j = await r.json()
return j.ok === true && !!j.version                      // 特征字段，防其它 JSON 巧合
```

### 2.3 上游端口发现

宿主端口可能变化。按优先级探测并缓存（如 60s）：
`config.web_port`（用户显式配置）→ 候选端口轮询探测（请求 `/api/v1/meta` 之类
有响应即认定）。

### 2.4 WebSocket 隧道：三个头都要改（坑 #4）

`server.on('upgrade')` 里做原始 TCP 转发。宿主**会校验 Origin**，只改 Host 会 403：

```js
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(hostPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (const k of Object.keys(req.headers)) {
      const lk = k.toLowerCase()
      if (lk === 'host' || lk === 'origin' || lk === 'referer') continue  // 全部重写
      lines.push(`${k}: ${req.headers[k]}`)
    }
    lines.push(`host: 127.0.0.1:${hostPort}`,
               `origin: http://127.0.0.1:${hostPort}`, '', '')
    up.write(lines.join('\r\n'))
    if (head?.length) up.write(head)
    up.pipe(socket); socket.pipe(up)
  })
})
```

Host 改写为 `127.0.0.1:<port>` 同时绕开宿主可能的 DNS-rebinding 检查。

## 3. 免 token 自动登录（坑 #2、#3 的根治）

**洞察：token 会轮换没关系——服务端永远读得到当前 token，让它每次页面加载时亲手注入。**

### 3.1 注入点

反代 HTML 响应时，在 `<head>` 后插入一个**外部脚本标签**：

```html
<script src="/kc-api/inject-token.js"></script>
```

注意 CSP `default-src 'self'` 下 **inline script 会被拦**（这正是宿主把 boot 逻辑放
`/boot.js` 外部文件的原因），所以必须用同源外部脚本。反代时要缓冲 HTML body、
插入标签、修正 `Content-Length`。content-type 不含 `text/html` 的响应直接管道转发，不要缓冲。

### 3.2 注入脚本（每次请求实时生成）

```js
// GET /kc-api/inject-token.js —— 每次读当前 token 文件，轮换无感
const token = readCurrentToken()  // 从宿主的 token 文件/环境实时读，带 mtime 缓存
res.end(
  'try{localStorage.setItem("kimi-web.server-credential",JSON.stringify({' +
  'version:1,credential:' + JSON.stringify(token) + ',expiresAt:Date.now()+6048e5' +
  '}))}catch(e){}\n'
)
```

要点：

- localStorage 的 **key 和值的结构必须和宿主自己写的一模一样**——先用真实浏览器登一次，
  在 DevTools 里把宿主写的凭证 dump 出来照抄（含 `version`、`expiresAt` 等字段）。
- 该端点**不需要认证**（它就是登录本身），但要给配置开关：`"auto_token": false` 时
  返回空脚本，供有安全要求的用户关闭。
- 注入发生在页面每次加载时，所以 token 轮换、重启，用户完全无感。

### 3.3 安全说明

统一入口 + auto_token 意味着"能访问这个端口的人就能进入宿主应用"。内网/单机场景
可接受；有暴露风险时：关 `auto_token`、插件服务绑定 `127.0.0.1`、或交给用户自行携带
`#token=`。

## 4. 旧页面自动迁移

用户书签里可能还是宿主原端口。在插件前端检测到服务不可达且当前端口不是统一入口时，
**自动带 token 跳转**（hash 里没 token 就从 localStorage 读出来捎上）：

```js
if (!serviceOk && location.port !== String(PLUGIN_PORT)) {
  let hash = location.hash || ''
  if (!hash.includes('token=')) {
    const t = readHostCredential()   // 从宿主 localStorage 凭证位读
    if (t) hash = '#token=' + encodeURIComponent(t)
  }
  setTimeout(() => location.replace(
    location.protocol + '//' + location.hostname + ':' + PLUGIN_PORT + '/' + hash
  ), 1200)
}
```

## 5. 资产分发与缓存（容易翻车的工程细节）

1. **版本标记文件**：插件 JS 注入到宿主的静态目录后，放一个 `.plugin-version` 文件。
   安装/修复脚本（heal）比对版本号决定是否重拷——**开发期同版本号反复改文件不会刷新**，
   调试时记得删标记文件强制重拷。
2. **index.html 补丁标记**：向宿主 index.html 注入 loader 标签时写带版本号的注释标记
   （`<!-- my-plugin v1.2.3 (healed) -->`），版本号从插件 manifest 读，别硬编码。
3. **浏览器缓存**：发了新版要让用户硬刷新（Ctrl+Shift+R），或给资产 URL 加版本参数。
4. **残留 Service Worker 清理**：如果历史上注册过 SW 方案，loader 里统一注销：

   ```js
   navigator.serviceWorker?.getRegistrations().then(rs => rs.forEach(r => r.unregister()))
   ```

## 6. 验证清单（Playwright 实测，不要只 curl）

curl 全通 ≠ 浏览器能用（CSP 就是 curl 测不出来的）。最低限度验证这些：

- [ ] **全新无痕浏览器、不带任何参数**打开统一入口 → 应用正常加载（不卡启动屏/登录屏）
- [ ] 网络面板 **0 个 4xx/5xx**（重点盯 `/api/v*` 是否被自家服务截胡）
- [ ] localStorage 凭证已写入，且格式与宿主原生一致
- [ ] **WebSocket 握手成功**（`page.on('websocket')` 无 socketerror）——单独测，HTTP 全绿不代表 WS 通
- [ ] 插件 UI 打开、自家 API 正常、健康检查不被 SPA 兜底骗过
- [ ] 旧端口打开 → 自动跳转统一入口且登录态保留
- [ ] 用**用户真实的访问方式**测（内网 IP / 域名），不要只测 127.0.0.1

## 7. 一句话总结

> 宿主 CSP 禁止跨源？那就消灭跨源：插件服务反代宿主做统一入口，
> 自家 API 走 `/kc-api/` 前缀，宿主的 `/api/vN/` 先放走，WS 隧道改三个头，
> token 由服务端每次实时注入——用户记一个地址，永远免登录。

---

### 附：本文涉及的真实代码位置（kimi-chat 仓库）

| 机制 | 文件 |
|------|------|
| 统一入口路由、`/kc-api` 剥离、`/api/vN` 放行 | `installer/service.cjs` → `route()` |
| 反代 + HTML 注入 inject-token.js | `installer/service.cjs` → `proxyToWeb()` |
| WS 隧道三头改写 | `installer/service.cjs` → `tunnelUpgrade()` |
| token 实时读取（mtime 缓存） | `installer/service.cjs` → `serviceToken()` |
| 健康检查严格校验、自动跳转 | `web/vcp-chat.js` → `svcOk()`、`checkAndLoad()` |
| 资产版本标记/heal | `installer/heal.cjs` |
