# 双浏览器扩展离线验收

关联 #311 / #308。测试使用真实生产 dist、独立合成测试目录及不可用的本地代理，不依赖 B 站登录，不读取个人浏览器数据。

## 运行

```powershell
$env:UX014_PLAYWRIGHT_MODULE = '<Playwright index.mjs 绝对路径>'
$env:UX014_BROWSER_EXECUTABLE = '<Chrome 或 Edge 可执行文件绝对路径>'
$env:UX014_EXTENSION_LOADER = 'cdp'
$env:OFFLINE_QA_OUTPUT = 'release-artifacts/<本次唯一目录>'
node tests/explicit-memory.extension-qa.mjs
```

默认加载器为 cdp：仅对新建隔离测试进程启用扩展调试，通过管道调用 `Extensions.loadUnpacked`。不会打开远程调试 TCP 端口或连接日常浏览器。每次重启均重新加载，核对返回的扩展身份。需要复核旧浏览器时可显式设为 `legacy`；不自动降级掩盖错误。

报告记录每次启动的浏览器版本、加载器、源码提交、工作树状态、默认权限和 dist 文件哈希。可选全站 HTTPS、自定义示例域名和 localhost 权限必须默认未授予；不得含 cookies 权限。权限对象只来自测试扩展本身。

## 本轮结果与边界

开发验证：Chrome 153.0.8010.54 和 Edge 153.0.4234.48 均通过原 8 项业务检查和新增默认权限检查；`npm run build`（含 typecheck、许可证及分包检查）通过。开发运行报告分别为 `release-artifacts/qa311-chrome-development/report.json` 和 `release-artifacts/qa311-edge-development/report.json`，工作树为开发中，不能作为干净提交收据。

提交后另跑 `release-artifacts/qa311-chrome-final` 与 `release-artifacts/qa311-edge-final`；以报告实际状态为准。本脚本不会替用户注册、送审或修改插件版本。

本检查不覆盖真实权限弹窗的允许/拒绝/撤回，不把未授予权限误称撤回成功；也不覆盖商店安装、真实模型服务、字幕获取和视频跳转。测试截图不是已批准商店素材。测试目录保留，不读取其 profile 文件、不打包。
