---
name: vcp-design
description: VCP 视觉通感设计规范库：字体清单、色板、中文排版、安全铁律、12 套风格库与装帧技法。输出 ```vcp 视觉卡片前按需加载。
type: prompt
whenToUse: 当需要输出 HTML/SVG 视觉卡片、装帧封面、数据可视化，或需要查阅 VCP 字体/色板/排版/安全规范时
---

# VCP 视觉通感设计规范（vcp-design）

本 Skill 是 VCP 视觉卡片的**知识层**：SYSTEM.md 里的协议负责「何时画、怎么不崩」，本目录负责「怎么不丑、哪里有素材」。按需取用，不必一次读全。

## 文档地图（一规则一权威）

| 文档 | 职责 | 何时读 |
|---|---|---|
| `docs/DESIGN.md` | 字体库 / 色板 / 中文排版 / **安全铁律 §4（落笔后唯一确认点）** | 动手前必读 |
| `docs/EDITORIAL.md` | 编辑感 / 数据可视化语法：四色系 / 卡片四件套 / 明度契约 / 视觉词汇库 | 做信息图/杂志风卡片时 |
| `docs/BREATH.md` | 三步呼吸法 / 规则三层 / 破规时机 / 动笔前三问 | 创作任务开工前 |
| `docs/FRAMING.md` | SVG 顶栏封面技术要点 / 骨架 / 风格示例 | 做封面/装帧时 |
| `docs/VCP-INTERACTIONS.md` | 交互元素 + 渲染层安全白名单 | 卡片内要放按钮/选项卡/轮播时 |
| `styles/_INDEX.md` | 12 套风格库索引（一行一风格：场景/标签） | 检索第一步 |
| `styles/<slug>.md` | 单套风格完整语法 | 索引命中后读对应文档 |
| `styles/_FONTS.md` | 字体选择指南（哪些场景用哪款） | 选字体时 |
| `styles/_BASELINE.md` | 风格库未命中时的兜底基线 | 检索失败时 |

## 快速路径

- 常规卡片：读 `docs/DESIGN.md` → 直接开画。
- 信息图/报刊/数据：`docs/DESIGN.md` + `docs/EDITORIAL.md`。
- 封面/装帧：`docs/DESIGN.md` + `docs/FRAMING.md`。
- 追求风格化：先读 `styles/_INDEX.md` 命中风格 → 读对应风格文档。
- 所有文档路径相对于本 Skill 目录（`${KIMI_SKILL_DIR}`）。

## 输出格式提醒（Kimi 版特有）

视觉卡片必须输出为 ` ```vcp ` 围栏代码块（不是裸 HTML、不是 ` ```html `），根容器 `<div id="vcp-root">`，内部无空行——详见 SYSTEM.md 的输出纪律，此处不重复。
