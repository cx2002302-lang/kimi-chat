# kimi-chat 部署指引（AI 一键部署版）

> 本文写给 AI agent 执行：目标机器上已装好 Kimi Code CLI（`kimi web` 可用），要把本插件
> 部署上线并验证可用。照步骤顺序执行，每步都带**验证关卡**，不过关不要继续。
> 全程无需交互输入；遇到决策点按文中规则判断。

---

## 0. 前置条件（先逐项检查，缺了就停并报告）

| # | 检查 | 命令 | 通过标准 |
|---|---|---|---|
| 1 | Linux + Node ≥ 18（service 依赖内置 fetch） | `node -v` | `v18` 或更高 |
| 2 | Kimi Code CLI 已安装 | `kimi --version` 2>/dev/null 或 `ls ~/.kimi-code` | 目录/版本存在 |
| 3 | `kimi web` 至少启动过一次 | `ls ~/.cache/kimi-code/web/*/linux-x64/*/dist-web/index.html` | 能找到 index.html |
| 4 | 端口 58931 空闲（或准备改端口，见 §5） | `ss -ltn \| grep 58931` | 无输出 |
| 5 | 有仓库代码 | `git clone https://github.com/cx2002302-lang/kimi-chat.git`（或已有本地副本） | 目录含 `kimi.plugin.json` |

## 1. 安装插件本体

**方式 A（标准，需要在 Kimi Code TUI 里执行一次）**：

```
/plugins install /path/to/kimi-chat
/reload
```

**方式 B（非交互 / 纯脚本，AI 优先用这个）**：直接放入 managed 目录——

```bash
SRC=/path/to/kimi-chat
DST=~/.kimi-code/plugins/managed/kimi-chat
mkdir -p "$DST"
rsync -a --delete --exclude '.git' --exclude 'tests' "$SRC"/ "$DST"/
```

> 区别：方式 A 会注册 `kimi.plugin.json` 里的 SessionStart/SessionHeartbeat 钩子（自愈备份层）；
> 方式 B 不注册钩子，但看门狗（主自愈层，见 §2）独立于钩子工作，功能完整。

**验证关卡 1**：`ls ~/.kimi-code/plugins/managed/kimi-chat/installer/install.cjs` 存在。

## 2. 注入 Web UI + 启动本地服务

```bash
node ~/.kimi-code/plugins/managed/kimi-chat/installer/install.cjs
# 幂等：重复执行安全；kimi 升级后重跑也安全（会自动备份 index.html）
```

install.cjs 做三件事（AI 需知原理以便排障）：
1. 把插件 `web/`、`assets/fonts/` 拷到 `<dist-web>/assets/kimi-chat/`
2. 在 `index.html` 的 boot.js 之后插入 `<script src="/assets/kimi-chat/vcp-loader.js">`（带 `kimi-chat-patch` 标记）
3. 启动看门狗 + 本地服务（`watch.cjs`，单例）

> Kimi Code 启动 `kimi web` 时会按 hash 清单**还原** index.html，所以补丁会被回滚——
> 看门狗每 3 秒自愈重打；钩子是备份层。这是设计内行为，不是故障。

**验证关卡 2**：

```bash
node ~/.kimi-code/plugins/managed/kimi-chat/installer/watch.cjs status
# 期望输出：watchdog running pid=<数字>
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:58931/
# 期望 200（本地服务在反代 kimi web）
```

## 3. 浏览器入口（重要，别用错端口）

- ✅ **统一入口：`http://<host>:58931/`**——本地服务反代整个 Web UI（含 WebSocket），
  页面与聊天 API 同源；带 `~/.kimi-code/server.token` 时自动免登录注入，token 轮换无感，
  内网 IP 远程访问同样成立。
- ❌ **不要**直接开 `kimi web` 原端口（如 58627）：新版 CSP 会拦跨端口 API，页面报
  「连不上本地服务」。

**验证关卡 3**（服务端最终自检）：

```bash
TOKEN=$(cat ~/.kimi-code/server.token 2>/dev/null)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58931/api/health
# 期望：{"ok":true,"version":"0.7.x","auth":true,...}（无 token 文件时 auth:false 且仅监听 127.0.0.1）
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58931/api/topics
# 期望：{"items":[...]}
```

**验证关卡 4**（UI 自检，可选，需 playwright）：浏览器开统一入口，
`localStorage.setItem('kimi-web.onboarded','1')` 跳过引导，确认侧边栏出现
`#kc-chat-btn`「聊天」按钮；点击进入模块后左栏可新建话题、发一条消息能收到流式回复。
（仓库 `tests/regression-browser.cjs` 即此流程的自动化版本，可参考其写法。）

## 4. 配置（全部可选，聊天开箱即用）

配置文件 `~/.kimi-code/kimi-chat/config.json`（首次运行自动生成，权限 600）。
默认：聊天后端跟随 CLI `default_model`；生图/语音未配 key 时对应功能禁用。
要启用 `/img`、`/tts` 才需要填 `image` / `tts` 的 `base_url + api_key`（字段见
`config.json.example`，端点格式兼容 MiniMax API）。

**红线**：任何 API key 只进 `config.json`（600 权限），**绝不写进仓库/文档/截图**。

## 5. 决策点速查

| 情形 | 动作 |
|---|---|
| 58931 被占用 | 改 `config.json` 的 `"port"`，重跑 `watch.cjs stop && watch.cjs start`，入口换新端口 |
| 只想本机用、拒绝局域网访问 | `config.json` 设 `"bind": "127.0.0.1"`（默认：有 token 文件即绑 0.0.0.0，靠 Bearer 认证保护） |
| kimi web 换了新版本/新 hash | 重跑 `install.cjs`（幂等）；看门狗通常已自动处理 |
| 升级插件版本 | 覆盖 `$DST`（§1 方式 B 重跑 rsync）→ 重跑 `install.cjs`（它会自动判断是否需要重启服务）→ `rm -f ~/.cache/kimi-code/web/*/linux-x64/*/dist-web/assets/kimi-chat/.kc-version`（清资产版本缓存，否则浏览器可能用旧文件）→ 浏览器 Ctrl+Shift+R |
| 需要回滚/卸载 | `node ~/.kimi-code/plugins/managed/kimi-chat/installer/uninstall.cjs`（从 `*.bak-kimichat-*` 备份还原 index.html、删除资产目录），再 `watch.cjs stop`，删除 `$DST` |

## 6. 常见故障 → 根因 → 处置

| 症状 | 根因 | 处置 |
|---|---|---|
| 侧边栏没有「聊天」按钮 | index.html 被 kimi 还原、看门狗没跑 | `watch.cjs status`；没跑就 `node install.cjs`；3 秒内自动补丁 |
| 页面提示「连不上本地服务」 | 用了 web 原端口直开（CSP 拦截） | 改用 `http://<host>:58931/` 统一入口 |
| 浏览器行为像旧版本 | dist-web 资产版本缓存（`.kc-version`）未清 | `rm -f ~/.cache/kimi-code/web/*/linux-x64/*/dist-web/assets/kimi-chat/.kc-version` + 强刷 |
| `/api/health` 401 | 请求没带 Bearer token | 读 `~/.kimi-code/server.token`，加 `Authorization: Bearer <token>` |
| 升级后 API 报 404/行为怪 | service.cjs 变了但服务没重启 | `watch.cjs stop` → `node install.cjs` |
| 双击打开了两个服务 | 端口被旧进程占 | `watch.cjs stop` → 确认 `ss -ltn | grep 58931` 为空 → `watch.cjs start` |

## 7. 一键脚本（把 <SRC> 换成仓库路径后整体执行）

```bash
set -e
SRC=/path/to/kimi-chat
DST="$HOME/.kimi-code/plugins/managed/kimi-chat"
mkdir -p "$DST" && rsync -a --delete --exclude '.git' --exclude 'tests' "$SRC"/ "$DST"/
node "$DST/installer/install.cjs"
node "$DST/installer/watch.cjs status"
rm -f "$HOME"/.cache/kimi-code/web/*/linux-x64/*/dist-web/assets/kimi-chat/.kc-version
TOKEN=$(cat "$HOME/.kimi-code/server.token" 2>/dev/null || true)
curl -sf -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58931/api/health
echo
echo "OK — 打开统一入口: http://<host>:58931/  然后浏览器 Ctrl+Shift+R"
```

执行到 `curl -sf` 失败即视为部署失败：按 §6 排障后从 §2 重试。

## 8. 数据与安全备忘

- 话题/文件夹数据：`~/.kimi-code/kimi-chat/topics/*.json`、`folders.json`（纯 JSON，可备份、可被 agent 直接读）
- 日志：`~/.kimi-code/kimi-chat/watch.log`
- 认证模型：有 `server.token` → 全 API 走 Bearer + 绑 `0.0.0.0`；无 token → 仅 `127.0.0.1`
- 部署完成后**人工**在浏览器做一次最终验收：开聊天 → 建话题 → 发消息 → 出现流式回复
