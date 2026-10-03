# 首页截图来源

[返回首页](../../README.md)

## 开放知识库候选

2026-10-04 新首页主图 `open-knowledge.png` 原样复制自 `release-artifacts/knowledge-integration-1791044459149/Chrome-1280.png`。由 `tests/knowledge-integration.browser-qa.mjs` 在 Chrome 154 中渲染生产组件与 IndexedDB，使用合成图像、字幕和笔记，经过共享目录写回、冲突与备份恢复流程。

它是实际组件截图，不是 imagegen 视觉稿；但宿主页、目录 IO 桥和确认均为测试环境，不能代表真实 B站或原生目录权限验收。图片里的色块是明确的合成截图夹具，不是实际课程画面。旧主图保留作历史资料。

## 历史浮层截图

本轮页面更新于 2026-09-19。使用 2026-09-10 验收准备过程中已有的生产 UI 截图，输入来自仓库合成夹具。未接入个人浏览器、未读取账号或凭据，未调用真实模型，也没有以 AI 绘图替代产品画面。

| 首页文件 | 原截图（本地忽略目录） | 生成流程 |
| --- | --- | --- |
| `video-wiki.png` | `release-artifacts/acceptance-20260910/screenshots/video-wiki.png` | `tests/video-wiki.mock-qa.mjs`，生产 dashboard 与合成学习资产 |
| `ask.png` | `release-artifacts/ui-297/chat-390x700.png` | `tests/unified-composer.mock-qa.mjs`，生产 content bundle 与合成视频页 |
| `note.png` | `release-artifacts/ui-297/note-390x700.png` | 同上，切换为笔记输入状态 |

三张图片均原样复制，没有涂改产品控件或回答文字。对话截图中的固定回复用于验证 UI；不能据此推断真实模型质量。图中的 Shell Mock、合成 BV、时间点与笔记不是个人数据。

复现这些 UI 流程：先构建当前源码，再按对应脚本设置 `UX014_PLAYWRIGHT_MODULE` 与 `UX014_CHROME_EXECUTABLE` 并运行。测试会生成合成截图，不读取实际用户浏览器数据。

旧 `bili-bill-dashboard.png` 与 `bili-bill-current-video.png` 保留供历史引用，已不作为新版首页截图。后续如替换画面，应同步记录来源，不把设计稿标成已实现界面。
