# Bili-Bill 本地知识库插件

把视频学习记录用于项目实践，再把新结论经确认写回同一份知识库。文件保存在本机，不依赖云端服务或常驻连接器。

## 连接

1. 在浏览器知识工作台连接个人目录，确认待写队列已完成。目录内会有 `Bili-Bill/library.json`。
2. 在插件目录中将 `config.example.json` 作为 `config.json`，填写 `libraryPath` 和该 `library.json` 的 `id`。不要连接整个用户目录。
3. 在 Codex 的本地插件安装入口选择本插件包；需要 Node.js 24 或更新版本。包同时包含便携格式及 Codex 兼容声明。
4. 先检索一条记录，再查看来源。修改先展示差异，由宿主发起确认；恢复也创建新版本。

当前宿主如果没有本地插件入口，可使用其 MCP 设置界面注册 stdio 进程：命令 `node`，参数为插件内的 `server/index.mjs`、`--config`、`config.json` 的绝对路径。需要同时启用本包 Skill 里的使用规则。

外部资料可在 `readOnlyMarkdown` 配置为 `{"id":"project-notes","path":"C:\\YourNotes\\project.md"}`。仅明确列出的 Markdown 可读取，不递归扫描，也没有改写这些文件的工具。

`allowAiNotesWrites` 默认关闭。打开后只允许独立 AI 补充区免确认应用，个人正文仍需人类确认。配置更新后重新加载插件。

## 边界

- 没有模型密钥配置；推理由正在使用的 Codex 完成。插件仅返回相关片段，不主动上传知识库。
- 目录身份必须匹配；不读符号链接、目录联接、硬链接、网络共享或敏感目录。
- 原始资料与历史不可变，修改绑定基础版本；并发更新会中止旧提案或保留冲突，不使用最后写入覆盖。
- 宿主不支持 MCP 用户确认时，检索、阅读、提案仍可用，但个人正文不能应用。不能把“工具协议通过”当成当前 Codex 桌面安装已验收。
- 当前可新建个人页面、修改正文/标题/主题/AI 区、确认应用及恢复。来源快照和附件由浏览器保存；外部 Markdown 原文件只读。

## 开发验证

在仓库根目录安装主依赖，再执行 `npm ci --prefix packages/codex-knowledge`、`npm test --prefix packages/codex-knowledge`、`npm run build --prefix packages/codex-knowledge`。
构建输出到新的 `release-artifacts/codex-plugin-*/bili-bill-knowledge`，不覆盖旧验收包。正式版本发布与插件市场提交另行处理。
