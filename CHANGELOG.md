# Changelog

## v0.7.5（2026-09-22）—— 代码审核加固

- **修复 folders 计数递归无防环**：手改 `folders.json` 出现循环嵌套时 `deepCount` 会栈溢出、
  列表整块渲染失败；加 `seen` 守卫后环数据仅跳过异常文件夹，列表照常渲染（已注入环数据实测）。
- **流式期间导航条不再整棵重建**：原实现每收到一个流式 chunk 就重建全部导航行，长对话
  （上百条提问）时每帧 O(n) 重排；现以「话题 id + 提问数」为键，结构没变只刷新当前项高亮。
- 全量回归：v074 47 + v072 20 + v073 12 + regression 14 + unit/service/heal 67，全绿。

## v0.7.4（2026-09-22）—— 话题文件夹分组 + 导航条 1:1 复刻原生 conversation-toc

- **话题文件夹（可嵌套）**：左侧列表支持多级文件夹——新建（📁+）/重命名/删除（其中聊天自动
  上移到父级，不丢数据）/折叠状态持久化；聊天可拖拽入文件夹，也可用「移动到…」菜单；
  文件夹显示包含计数；新增搜索框（按标题/预览过滤，文件夹名命中时其内聊天一并显示）。
  数据落盘 `~/.kimi-code/kimi-chat/folders.json`，REST `/api/folders`（含防循环嵌套校验）。
- **内容导航条 1:1 复刻原生**：实机采样 kimi web conversation-toc 的 DOM 与 computed style
  后重写——收起态为 13px 半透明竖条列（每条提问一根 3×14px 圆角竖条，当前条 18px 高、
  主题蓝不透明）；悬停 75px 热区 + 0.25s 意图延迟后标签滑出（13px/20.8px，右对齐，
  max-width 220px，过渡曲线 cubic-bezier(0.16,1,0.3,1) 与原生一致）；行悬停文字变亮、
  竖条不透明；点击跳转改为显式 `scrollTo`（修复 `scrollIntoView` 在嵌套滚动容器下
  落点偏差 56px、当前项不跟随的 bug），当前项跟随滚动高亮并保持可见。

## v0.7.3（2026-09-22）—— 原生会话观感

- **配色对齐 kimi web 会话窗口**：调色板取自原生 `--ms-*`（dark：背景 7% 黑、气泡 16% 灰、
  文字 93%、边框 20%、强调蓝 215°）；light 同步配套。
- **字体对齐**：正文 Schibsted Grotesk + Noto Sans SC 14px / 行高 calc(22/14)，
  代码 JetBrains Mono，标题梯度 20/18/16/14。
- **用户气泡中性灰**（`--kc-bubble`），文字跟随前景色，不再是绿色。
- **答复默认「原生」**：不套卡片样式，与会话窗口一致；5 种排版预设仍可在设置里选。
- **消息 meta 行**：每条消息下方 ⧉复制（复制原始 Markdown，流式结束后为最终全文）
  + HH:MM 时间戳，用户消息右对齐——复刻原生。

## v0.7.2（2026-09-22）—— 居中栏风格 + 悬停展开大纲 + 隐藏滚动条

- **改回居中栏**：消息/输入框内容栏 860px 居中（复刻 kimi 原生观感），助手卡片拉满
  栏宽、与用户气泡栏内右缘对齐；两侧留空，不再拉宽。1920 / 1280 / zoom 150%
  实测右缘差 0px。
- **大纲改为「平时细指示条，悬停展开」**（原生交互）：平时右缘只有 26px 指示条——
  垂直虚线 + 每条提问小刻度 + 蓝色当前位置滑块（随滚动移动）；鼠标移入指示条范围，
  文字大纲面板从右缘滑出（绝对定位浮层，不推挤布局、不遮滚动条），移开延迟 0.25s
  收回。面板内每条提问一行右对齐总结、当前项主题色 + 竖色条，点击平滑跳转。
- **隐藏滚动条**：消息区、大纲面板、右侧信息栏、话题列表全部 `scrollbar-width:none`
  （滚动照常可用），消除滚动条时隐时现的突兀感，与原生一致。

## v0.7.1（2026-09-22）—— 文字大纲导航（复刻 kimi 原生）

- **导航改为文字大纲**：v0.7.0 的刻度 minimap 压在滚动条上、总结只能悬停看，体验与
  kimi 原生差距大。现复刻原生形态——大纲独立 dock 在聊天区右缘（212px），每条提问
  一行右对齐总结、超长省略号，当前项主题色 + 左侧竖色条，点击平滑跳转、跟随滚动，
  大纲栏自身滚动保持当前项可见；<1100px 自动隐藏。
- **布局重构**：`kc-col` = `kc-main`（消息 + 输入框）+ `kc-outline`，消息列与输入框
  始终同栏宽，大纲不遮挡内容、不压滚动条；1920 / 1280 / zoom 150% 实测对齐差 0px。
- 修复大纲显隐改变消息区宽度后「贴底」失效、当前项定位漂移的问题（重建前记忆、
  重建后恢复）。

## v0.7.0（2026-09-22）—— 消息栏拉通对齐 + 内容概括导航条

- **对齐修复**：消息行改为共享流动栏（最大 1500px 居中、24px 侧距）——助手卡片拉满栏宽，
  右缘与用户气泡、底部 composer 完全对齐；窗口缩放、浏览器 zoom 下保持一致
  （1920 / 1280 / zoom 150% 实测右缘差 0px）。此前卡片被限宽 780/900px 居中，
  气泡却顶到屏幕右缘，画面「各聊各的」。
- **内容概括导航条**：消息区右缘新增 minimap 刻度（复刻会话窗口形态）——每条消息一个
  刻度、按位置比例排布，用户消息带主题染色；悬停显示自动概括（优先取首个小标题），
  点击平滑跳转，当前刻度跟随滚动高亮（rAF 节流重建，滚到底部自动高亮末条）。
- 补记：v0.6.1 修复深色主题下设置页下拉选项看不清；v0.6.2 修复系统提示词输入框被压窄。

## v0.6.0（2026-09-22）—— 配置页、界面复刻、思考折叠、卡片样式

- **插件配置页**：kimi web「设置」里新增 **kimi-chat** 页签（DOM 注入，宿主重渲染自动补回），
  聊天面板左下角也有 ⚙️ 齿轮弹窗，两处共用同一表单。可配置：答复样式/配色/思考折叠/右栏、
  **生图与 TTS 独立 provider**（base_url / api_key / model / voice / path）、免 token 开关、
  系统提示词；带生图/语音测试按钮。后端新增 `GET/PUT /api/config`（key 脱敏回显、留空保持不变）。
- **界面复刻会话窗口**：中栏消息列（1920 下 900px 宽）+ **右侧信息栏**——话题信息
  （标题/ID/创建/消息数/模型）、**自动归纳**（按提问生成大纲，点击定位）、快捷操作；
  可开关，<1500px 自动隐藏。
- **思考折叠**：`reasoning_content` 以独立 `think` SSE 事件转发，与正文分离；
  流式时只显示「💭 思考中…（n 字）」，结束后收进折叠块；正文里的 `<think>` 同样折叠。
  流式期间围栏代码/vcp 源码不再刷屏，显示「⏳ 生成中…」占位，结束后统一渲染。
- **答复样式/配色**：5 种 VCPColorEngine 预设（editorial/chiaroscuro/fauvism/cyberpunk/
  wabi_sabi）+ 原生，配色模式跟随 kimi web 或手动明暗；调色板以 CSS 变量驱动整条答复的
  标题/强调/引用/表格/代码配色。新增 Markdown **表格** 与分割线渲染支持。
- 新默认系统提示词：结论先行、小节+要点组织、重点加粗、对比用表格、主动视觉化。
- `MAX_REPLY_TOKENS` 4096 → 8192（长卡片不再被截断）。

## v0.5.4（2026-09-22）—— 统一入口免 token：打开即登录

- **自动登录**：反代 HTML 时注入 `/kc-api/inject-token.js`，服务端实时读取当前
  `server.token` 写入 kimi web 的 localStorage 凭证位。直接打开
  `http://<主机>:58931/` 即可使用，token 每次轮换也无感（`config.json` 设
  `"auto_token": false` 可关闭）。
- 修复 kimi web 自家 `/api/v1/*`、`/api/v2/*` 被本服务 API 路由截胡返回 404
  （导致无 token 打开时卡在启动屏 "Checking sign-in"）。
- 修复 WS 隧道 403：上游校验 Origin，转发时 Host/Origin/Referer 统一改写为
  `127.0.0.1:<上游端口>`。
- 无 token 全新浏览器实测：启动屏通过、0 个 4xx/5xx、WS 长连接正常、
  聊天面板话题/流式/模型/生图/语音全部可用。

## v0.5.3（2026-09-22）—— 修复统一入口健康检查路由 + 自动跳转统一入口

- `/kc-api/health` 剥离前缀后变成 `/health`，落不到 `/api/health` 被反代到 kimi web，
  导致统一入口下健康检查永远失败、聊天面板误报「本地服务未运行」。已修正映射。
- 在旧端口页面检测到服务不可达时，**自动携带 token 跳转到统一入口** `:58931`，无需手动改地址。
- heal 标记版本号不再硬编码，跟随插件版本。

## v0.5.2（2026-09-22）—— 修复新版 kimi web CSP 导致的「本地服务未运行」

**根因**：新版 kimi web 给所有响应（含插件 JS、甚至 Service Worker 脚本）都带
`Content-Security-Policy: default-src 'self'`，页面里 fetch 到 `:58931`（跨端口）被浏览器
直接拦截。先后排除了两条路：SW 同源桥（SW 脚本自身也带同样 CSP，桥内 fetch 一样被拦）、
SSH 隧道依赖（用户走内网 IP 直访）。

**方案：统一入口反向代理**。本地服务除了 API，现在还会把其余所有请求**反代到 kimi web**
（含 WebSocket 隧道、Host 改写绕过 DNS-rebinding 检查、上游端口自动探测）：

- 用 **`http://<主机>:58931/`**（带上 token）打开 Kimi Code，页面与聊天 API（`/kc-api/*`）
  天然同源，CSP `default-src 'self'` 下一切正常——本机/内网 IP/远程浏览器通吃。
- 前端三级回退：同源 `/kc-api`（严格校验 JSON，防 SPA 兜底误判）→ 直连 `:58931`（旧版无 CSP）
  → 都不行时给出明确指引（直接告诉你该用哪个统一入口地址）。
- `config.json` 新增 `web_port`（上游 kimi web 端口，默认自动探测 58627/58642/58643）。
- 连不上时的提示文案更新：从「去启动服务」改为「CSP 说明 + 统一入口地址 + 服务状态命令」。

## v0.5.0（2026-09-21）—— 通用生成 provider（生图 + 语音），去除 MiniMax 品牌绑定

**需求**：生图/语音不应锁死在 MiniMax——做成**通用 provider 配置**（可配 MiniMax，也可配任何兼容端点）。

- **配置结构重构**：`minimax_api_key` / `minimax_base_url` / `image_model` 三个扁平字段 →
  `image{base_url,api_key,model,path}` 与 `tts{base_url,api_key,model,voice,path}` 两个独立 provider；
  旧配置自动兼容映射（无需手动迁移）。安装器首装配置同步改为新结构，
  key 环境变量改为 `KIMI_CHAT_GEN_KEY`（旧 `KIMI_CHAT_MINIMAX_KEY` 仍可读）。
- **新增语音生成**：`POST /api/tts`（端点格式兼容 MiniMax `t2a_v2`，hex 音频解码落盘
  `audio/`，`/audio/<file>` 静态路由防路径穿越）；聊天里 **`/tts 文本`** 命令生成语音，
  消息内联 `<audio>` 播放器；导出 Markdown 含音频链接。
- **UI 状态行**：`生图✓` / `语音✓` 分别按 provider 配置显示；输入框提示更新。
- **去品牌化**：插件描述、README、UI 文案不再出现 MiniMax——它只是可配置的 provider 之一。

## v0.4.2（2026-09-21）—— 修复讨论空间内 mermaid / KaTeX / 图表工具栏渲染

发布页截图实测发现的三个真实 bug（均在全屏模块的 shadow DOM 内触发）：

- **mermaid 必崩**：mermaid.run 内部用 `document.getElementById` 找节点，shadow root 里找不到 →
  `getBoundingClientRect of null` → 回退为源码。修复：渲染前临时把节点移入 body 的离屏容器，
  渲染完成（或失败）后移回原位（`vcp-render.js`）。
- **KaTeX 公式下方多一行纯文本**：`katex.min.css` 从未被加载（主文档与 shadow root 都没有），
  `.katex-mathml` 未隐藏。修复：ensureVendor 时注入主文档；模块 shadow root 构建时注入。
- **mermaid 缩放工具栏按钮「空白」**：卡片 `<style>` 经引擎重写后带 `!important`，
  覆盖了工具栏按钮的内联颜色（白字白底）。修复：工具栏按钮颜色加 `!important`（`vcp-render.js`）。

## v0.4.1（2026-09-21）—— 看门狗资产版本戳

- 修复插件升级后浏览器仍运行旧版资产的问题：`heal.cjs` 写入 `assets/kimi-chat/.kc-version`，
  与 `kimi.plugin.json` 版本不一致即重拷资产（原先只在资产缺失时拷贝）。

## v0.4.0（2026-09-21）—— 模型/思考强度选择器 + 远程访问修复（认证 + LAN 绑定）

**问题**：用户远程浏览器访问 `kimi web` 时聊天报「本地服务未运行」——旧版前端把服务地址写死
`127.0.0.1:58931`，且服务只绑回环；同时用户要求「聊天模型选择与会话一致」（可选不同模型与思考强度）。

**改动**：
- **前端服务地址相对化**：`SVC = location.protocol + '//' + location.hostname + ':58931'`，
  本机/远程访问都能连到正确的服务。
- **token 认证**：服务读取 `~/.kimi-code/server.token`（kimi web 的访问令牌，mtime 缓存）；
  存在时所有 `/api/*` 要求 `Authorization: Bearer <token>`（GET 可用 `?access_token=`，供 <img> 用），
  无 token 返回 401；token 文件不存在（未开认证的旧场景）则不强制，向后兼容。
- **绑定地址**：`config.json` 的 `bind` 可覆盖；默认有 token 时绑 `0.0.0.0`（配合认证对局域网开放），
  无 token 时仍只绑 `127.0.0.1`。
- **模型注册表**：服务启动解析 `~/.kimi-code/config.toml` 的 `[providers.*]`/`[models.*]`
  （display_name/capabilities/support_efforts/default_effort），`GET /api/models` 返回可用模型清单；
  `resolveModelBackend()` 支持 `type=openai` 直连与 `managed:kimi-code`（读
  `~/.kimi-code/credentials/kimi-code.json` 的 OAuth access_token，mtime 缓存、临期拒用、401 重读重试一次）。
- **思考强度**：模型 capabilities 含 `thinking` 时请求带 `reasoning_effort`（400 自动降级去掉重试）；
  优先级：请求体 > 话题字段 > 模型 default_effort。
- **UI 模型选择器**：composer 左侧新增模型按钮，弹出层含思考强度 chips 与模型列表
  （与会话同一注册表，不可用的灰显）；选择按话题持久化（`model`/`effort` 字段），
  不改 CLI 全局默认。
- 前端所有服务请求统一带 Bearer（fetch）/ `access_token`（<img>）。

## v0.3.0（2026-09-21）—— 全屏「讨论空间」模块 + 聊天后端跟随 CLI 默认模型

**需求澄清**（推翻 v0.2 的两处设计）：
1. 用户要的不是侧边抽屉小窗，而是**和会话窗口形态相当的全屏聊天模块**——以讨论问题为主，
   助手应能生成 HTML/SVG 视觉辅助；聊天与会话（编程）有本质区别。
2. **MiniMax 只是开发期的图像资产工具**（图标/图片/背景），不参与聊天——聊天后端改为
   **跟随 Kimi Code CLI 的 default_model**（与会话同源；本机实测为 local-quasar 的
   OpenAI 兼容端点，服务启动时解析 `config.toml` 的 provider base_url/api_key，缓存随 mtime 失效）。

**架构调整**：
- `service.cjs`：新增 `resolveChatBackend()`——`config.json` 的 `chat_base_url` 覆盖优先，
  否则解析 CLI `config.toml`（仅支持 `type=openai` 的 provider，其他类型给出明确报错与配置指引）；
  MiniMax 收缩为只做 `/api/image`（生图）与话题图标；新增 `DELETE /api/topics/:id/messages`（清空）；
  `/api/health` 上报 `chat{model,source}` 与 `image` 两路状态；移除运行时插件图标生成（改为打包内置）。
- **UI 全屏化**：抽屉 → 全屏模块（`#kc-chat` hash 路由，刷新/分享链接可恢复，Esc 退出）；
  布局复刻会话窗口：左侧话题栏（新建/搜索/列表/开关/模型状态）+ 主区（用户右气泡、助手全宽
  Markdown、composer 卡片 + 提示行）；空态欢迎页（MiniMax 生成的插图与模块图标，打包进
  `web/img/`）；话题菜单新增「⇗ 开展会话」「⧉ 复制聊天 ID」「🧹 清空消息」。
- **开展会话**：一键新建真实会话并自动发送话题上下文（引用 + 记录文件路径），agent 直接
  Read 话题 JSON 接着研究——讨论（聊天）→ 深入研究/编程（会话）的桥。
- CSS 修复：`.kc-module [hidden]{display:none!important}`（自定义 display 会覆盖 hidden 属性，
  导致发送/停止按钮同框）。

**测试**：regression 第 4-5 节重写（CLI 默认模型流式 + 开展会话端到端跳真实 /sessions/<id>）；
service.test 适配新 health 结构与清空接口（15 项）；六套全绿：
unit 32 + service 15 + heal 10 + regression 14 + security 13 + newfolder 26。

## v0.2.0（2026-09-21）—— 独立聊天系统（架构重构）

**需求变更**：v0.1 的「聊天」是 Kimi Code 会话历史的入口（与会图强相关）。用户实际想要的是
**独立的聊天界面**：自己的话题库，慢慢创建、方便管理，与会话解耦；需要时能把话题 ID/内容
粘贴或带进新会话讨论。图标/图像用 MiniMax API 生成。

**架构**（新增本地服务层，看门狗进程同进程托管）：
- 新增 `installer/service.cjs`：只监听 127.0.0.1:58931 的本地后端——
  - 话题 CRUD：JSON 文件存 `~/.kimi-code/kimi-chat/topics/<id>.json`（tmp+rename 原子写）；
  - MiniMax 聊天代理：`POST /api/topics/:id/chat` SSE 流式回推，**API key 只存服务端
    `config.json`（600 权限），不下发浏览器**；首轮对话后自动起标题（M2 会先输出
    `<think>`，起名 max_tokens 需留足，初版 60 拿不到标题正文）；
  - 图像生成代理：`POST /api/image` → MiniMax `image-01` → 立即下载落盘
    `images/`（原始签名 URL 24h 过期）→ 返回本地 `/images/<file>` 地址；
  - Markdown 导出、`/api/health` 健康检查、路径穿越防护、1MB 请求体上限；
  - 首次启动后台自动生成插件图标（MiniMax，失败静默，前端有 SVG 兜底）。
- `installer/watch.cjs`：看门狗 loop 内启动本地服务（端口被占自动降级为纯看门狗）。
- `installer/install.cjs`：首装引导创建 `config.json`（`--key=` / `KIMI_CHAT_MINIMAX_KEY`）。

**Web UI 重构**（`web/vcp-chat.js` v0.2.0）：
- 面板双视图：话题列表 ↔ 聊天视图；移除会话历史列表与 `/sessions/<id>` 跳转；
- 话题管理：新建/搜索/置顶/重命名（双击标题）/删除/生成图标/导出 Markdown（⋯ 浮层菜单）；
- 聊天视图：fetch + ReadableStream 读 SSE，流式期间纯文本（带光标），结束后做一次完整
  Markdown/VCP 渲染；`/img 描述` 聊天内生图；停止按钮（AbortController）；
- 内置安全 Markdown 渲染器（先转义再套格式；```vcp 块抽离后走 VCPRender 引擎）；
- 聊天面板内 VCP 卡片的 `input('...')` 按钮填入聊天输入框（shadow DOM 内独立委托）；
- 「⇗ 在会话讨论」：复制话题引用 + 填 kimi composer（不自动发送，建议新会话）；
- 服务离线时显示引导页（含启动命令与重试按钮）。

**测试**：新增 `tests/service.test.mjs`（13 项，临时 KIMI_CODE_HOME 下起独立服务进程）；
`regression-browser.cjs` 第 3-6 节重写为独立话题流（含一次真实 MiniMax 流式调用，14 项）；
`newfolder-browser.cjs` 的「提示当前目录」断言改为对比末级面包屑（原先硬编码 /kimi|root/，
依赖浏览历史，属环境脆弱断言）。全部套件：unit 32 + service 13 + heal 10 + regression 14 +
security 13 + newfolder 26，全绿。

## v0.1.2（2026-09-21）—— 「添加工作区」支持新建文件夹

**背景**：新建会话 → 选择文件夹 → 添加工作区（`Add workspace` 对话框）里只能浏览已有目录，
没法就地建目录。Kimi Code 后端其实**已有** `POST /api/v1/fs:mkdir`
（路由描述：`folder-picker "new folder" backend`，非递归、父目录需存在），只是 Web UI 没接入。

**实现**（`web/vcp-chat.js`，不碰 bundle、不改组件内部状态）：
- 在 `.aw` 对话框地址栏（`.crumbbar`）右侧注入「新建文件夹」按钮 + 浮层输入；
- 当前目录由面包屑反推（组件由 `browseFs().path` 按 `/` 切分生成，可逆）；
- 名称前端校验：空 / 含 `/`、`\` / `.`、`..` / 控制字符 / 超长；
- 后端错误翻中文：同名（`fs.already_exists`）、无权限、上级目录不存在；
- 建好后**借用应用自身的导航刷新**列表（点末级面包屑 → 组件重新 `browseFs`），并高亮新目录；
- 交互：`Enter` 创建、`Esc` 收起、点浮层外收起、创建中置灰防重复提交；
- 注入点选 `.crumbbar` 末尾：Vue 无 key 子节点按索引 diff，追加节点不会被组件重渲染清掉。

**测试**：新增 `tests/newfolder-browser.cjs`（26 项，真建目录 /tmp 后自清）；回归与单测全绿。

## v0.1.1（2026-09-21）—— 补丁持久性修复（重要）

**问题**：v0.1.0 假设「index.html 加一行」是持久的。实测发现 Kimi Code CLI 在**每次启动
`kimi web` 时**会按内嵌 hash 清单校验 Web UI 静态目录，**把被改动的原始文件还原**
（`index.html` 经 tmp+rename 重写，`boot.js` 与主 bundle 同样被还原）；只有新增文件
（`assets/kimi-chat/`）不在清单内、可存活。因此 v0.1.0 的按钮/渲染能力**每次重启服务都会失效**。

**修复**：
- 新增 `installer/heal.cjs`：检测补丁标记缺失即重新注入（含资产缺失时重拷），幂等、静默
- 新增 `installer/watch.cjs`：常驻看门狗，每 3 秒自愈；单例（pidfile + 存活探测），支持 start/stop/status
- 插件 manifest 增加 hook：`SessionStart` / `SessionHeartbeat` → `heal.cjs`（作为看门狗被杀后的兜底，并顺带拉起看门狗）
- `install.cjs` 安装后自动启动看门狗；`uninstall.cjs` 先停看门狗再还原
- README 更正安装步骤（**不再要求重启 `kimi web`**）并补充「补丁回滚与自愈」说明

**验证**：重启 `kimi web` → 看门狗 ~3 秒内自愈 → **首次页面加载**即带「聊天」按钮（抽屉 70 条话题）。

## v0.1.0（2026-09-21）

首个 Kimi Code 适配版（移植自 dsh-raw-html v0.6.0 · v6.38）。

### 新功能
- 侧边栏「聊天」按钮 + 右侧历史话题抽屉（按工作区分组、搜索、点击续聊、新建会话、30s 轮询）
- VCP 视觉通感：agent 按 `SYSTEM.md` 协议输出 ` ```vcp ` 块 → 消息区渲染为 HTML/SVG 卡片
- Mermaid 图表（缩放/平移工具栏）+ KaTeX 公式（安全单美元识别）
- 卡片内 `onclick="input('...')"` 桥 → 自动填包并发送（ProseMirror 兼容）
- 7 款内置 OFL 字体全局注册；声明式配色 data-vcp-preset（VCPColorEngine）
- Skill `vcp-design`：DESIGN/EDITORIAL/BREATH/FRAMING/VCP-INTERACTIONS + 12 套风格库
- 三开关：渲染 HTML（默认开）/ 美学注入（默认开）/ 可信模式（默认关）
- 安装器/卸载器：幂等、自动备份、kimi 升级后可重跑

### 测试
- unit.test.mjs：32 项纯函数断言（node 直跑）
- security-browser.cjs：13 项安全断言（script/iframe/on*/javascript: 过滤 + 可信模式放行）
- regression-browser.cjs：7 项回归（开关降级/抽屉跳转/搜索）

### 相对 dsh 原版的关键差异
- 触发方式：裸 HTML → ` ```vcp ` 围栏块（关闭时退化为代码显示）
- 注入方式：破解压缩 bundle → 外部脚本 + index.html 一行（不碰 bundle 内部）
- Host 半侧（cordis/路由/RPC）→ kimi.plugin.json systemPromptPath + localStorage 开关
- 渲染触发：消息渲染器接管 → DOM 观察器（内容 hash 稳定判定，不依赖应用内部状态）
- 字体库：25+ 款 → 7 款核心（docs 已标注差异）
