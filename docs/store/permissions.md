# 权限与数据流预审

关联 #308，2026-10-11 对照 public/manifest.json 和体验候选源码。用于准备商店字段，不自动勾选法律声明。

| 权限 | 当前用途 | 代码依据 |
| --- | --- | --- |
| storage | 本地配置、目标偏好、目录句柄等 | src/background/storage/config-store.ts；open-knowledge-repo.ts |
| unlimitedStorage | IndexedDB 中的学习资料、独立图片、来源、历史和待写队列 | src/background/storage/open-knowledge-repo.ts；共享知识格式分别限制正文、来源和图片 |
| alarms | 平台同步、统计和缓存清理 | src/background/sync/scheduler.ts |
| tabs | 定位当前 B 站标签页，核对视频身份，发送消息，打开和返回出处 | current-video-context-resolver.ts；messages/learning-navigation.ts；player-screenshot.ts |
| activeTab | 用户从工具栏主动允许当前页截图，视频帧受限时裁切播放器区域 | src/background/index.ts；src/background/player-screenshot.ts |
| bilibili.com 及子域 | 视频页助手、平台信息读取；平台会话由浏览器按请求使用 | src/background/api；src/content/player-monitor |
| hdslb.com | 经身份校验的字幕正文和平台资源读取 | current-video-transcript-cache.ts |
| api.openai.com / api.deepseek.com | 用户配置的模型请求 | ai/openai-compatible.ts；ai/learning-chat-transport.ts |
| 可选 HTTPS、localhost、127.0.0.1 | 用户选用兼容端点时按来源申请访问 | dashboard/modules/settings/SettingsPage.tsx 的 contains/request |

不申请 cookies、nativeMessaging 或全站截图权限。普通扩展不包含开发验收桥；独立 Codex 本地插件不改变浏览器权限。目录由 File System Access 选择器授权，不能据此声称具有整机文件访问。

## 输入、保存与外发

- 本地保存：平台同步记录、播放记录、笔记/图片、原始和优化字幕、页面/提案/历史、聊天、配置和明确保存的目标偏好。
- 截图：视频帧优先；受限时工具栏授予当前标签页访问，截图临时处理后仅保存播放器裁切区域。绑定实际捕获时刻。
- 目录：在所选父目录的 Bili-Bill 区域写入普通 Markdown、图片、来源及历史；其他选定 Markdown 只读。断连时本地排队，不把未同步标为已写目录。
- 平台请求和封面显示：不受 AI 开关控制，不能宣传成完全离线。
- AI：按任务发送材料；图像只有主动分析才发送，知识检索仅相关片段。字幕纠错可按用户记住的偏好自动处理当前视频，不批量上传收藏。
- 备份：新版包含已保存的页面、图片、来源、提案与版本，不含配置/密钥、草稿、目录权限或外部只读文件。不同旧备份格式不能混称。
- Codex：用户单独安装和配置后可访问指定知识范围；正文写回在发起端差异确认，不重复弹出浏览器确认。

## 送审核对

1. 单一用途围绕学习记录与复用；原有账单、兴趣再平衡和盲盒仍如实披露。如审核要求删减，单独裁决。
2. 对照两店字段披露网页内容、使用活动、用户输入及认证信息。仅本地保存不代表不处理用户数据。
3. 密钥是本地配置，不宣称端到端加密、第三方零留存或系统保险箱。
4. 本次源码关键词检查未发现 eval/new Function/importScripts、常见遥测 SDK 或 sendBeacon；这是静态检查，提交前仍需最终构建的网络观察。
5. 当前固定平台域名和可选端点保持不变。权限进一步收窄需测试支持，不在材料 PR 中直接删除运行所需权限。
