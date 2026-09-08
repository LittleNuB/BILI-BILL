# 页内助手缩放 #284

2026-09-08，基线 main 16bffdf。

支持四边、四角指针拖拽；宽高下限 320/360px，小视口以下限可用空间为准；窗口保留 12px 安全边距。拖动不重建正文。Esc、指针取消、失焦会恢复拖动前尺寸。键盘方向键可调整边缘。

仅持久化 `currentVideoAssistantWindowSize` 的宽高两个数字到扩展本地设置。不读写个人资产、不发送 AI 请求、不修改跳转。收起恢复原紧凑布局，重新展开保持尺寸；新页面恢复已保存尺寸并限制到可视范围。窗口位置只保留在当前页面。

## 验证

- 三项几何单测：八方向、相对固定边、最小尺寸、大幅越界和小视口。
- 新增 `tests/assistant-resize.mock-qa.mjs`：真实 content 构建配合合成宿主页，八方向拖拽、Esc 回滚、草稿保留、收起重开、保存尺寸重载、键盘与三个窄视口通过。
- 既有 UX 五视口、亮暗主题、原生全屏遮挡、待响应重入、字幕预览/确认/返回回归通过。
- typecheck/build/release-dist/diff-check 通过。布局改动不重跑存储矩阵。
- 截图和构建绑定记录：`release-artifacts/resize-284/`。真实站点整版验收仍由 #281 跟进；本记录不冒充真实站点 PASS。

本地候选更新至此前的 `release-artifacts/popup-282/extension`，原构建备份在 `release-artifacts/resize-284/previous-extension`，面试冻结包不变。无版本号、tag 或正式发布变动；未读取 Cookie、个人浏览器文件、登录态或凭据。
