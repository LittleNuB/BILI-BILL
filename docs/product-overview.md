# 产品能力与实现索引

[返回首页](../README.md)

核对日期：2026-10-04。开放知识库实现范围：#316，已合并 #326 至 #333；集成验收跟踪 #325。用于 README 的事实核对，不代替真实站点、真实模型或当前 Codex 宿主验收。历史发布合同仍独立。

## 产品价值

Bili-Bill 连接浏览器里的学习记录与项目中的知识复用：B站是首个做深的来源，普通 Markdown 与图片是共享资料，Codex 插件负责取用、追溯和确认更新。知识库为主工作台，收藏夹归资料来源，内容账单是次级工具。

- **少搬运上下文**：在原视频页看概览、读字幕、继续提问，减少手动复制字幕到另一个聊天工具。
- **留下自己的思考**：笔记、摘录与时间点关联原视频和实际分 P，之后可以回到来源核对。
- **让积累可复用**：一视频一页，相关视频按主题归组；主动提问时可引用授权的相关个人材料。
- **控制什么被使用**：保存内容在本地；模型请求、知识材料和目标偏好有明确授权边界，不自动形成个人画像。
- **看清内容消费**：观看账单和兴趣再平衡保留，不将产品简化成纯摘要工具，也不改成推荐排名系统。

以上描述的是工作流与能力，不宣称学习效率提升百分比、真实用户规模、模型准确率或理解程度。

## 当前实现对照

| 首页描述 | 可核对的实现或合同 | 不应扩大的承诺 |
| --- | --- | --- |
| 本地目录与版本 | [文件合同](architecture/open-knowledge-files-v1.md)；[#327](https://github.com/LittleNuB/BILI-BILL/pull/327) | 云同步、直接覆盖旧版本、目录断连也已写入文件 |
| 知识工作台、个人页与收藏来源 | [验证记录](qa-open-knowledge-workspace.md)；[#328](https://github.com/LittleNuB/BILI-BILL/pull/328)、[#329](https://github.com/LittleNuB/BILI-BILL/pull/329) | 收藏即知识、自动持续导入、远端删除同步删除笔记 |
| 自动字幕与可取消纠错 | [纠错服务](../src/background/ai/subtitle-correction.ts)；[#331](https://github.com/LittleNuB/BILI-BILL/pull/331) | 不授权也调用模型、批量获取收藏字幕、AI 纠错必然正确 |
| 截图与图文笔记 | [验证记录](qa-open-knowledge-images.md)；[#332](https://github.com/LittleNuB/BILI-BILL/pull/332) | 连续分析视频画面、无图片能力也声称看过图片 |
| 新手路径与提示词 | [验证记录](qa-open-knowledge-prompts.md)；[#333](https://github.com/LittleNuB/BILI-BILL/pull/333) | 先配 AI 才能记录、自定义提示词可关闭隐私和确认规则 |
| Codex 检索与写回 | [插件说明](../packages/codex-knowledge/README.md)；[#330](https://github.com/LittleNuB/BILI-BILL/pull/330) | 已安装验收、任意磁盘访问、模型替人确认个人修改 |
| 图文备份、共享目录读回与相关引用 | [整合验证](qa-open-knowledge-integration.md)；[#325](https://github.com/LittleNuB/BILI-BILL/issues/325) | 备份含所有浏览器数据、合成流程等于真实端到端验收 |
| 开放学习与连续追问 | [聊天实现](../src/background/learning-chat.ts)；[#295](https://github.com/LittleNuB/BILI-BILL/pull/295) | 缺字幕也能还原视频结论、所有回答均有视频依据 |
| 长对话与长字幕管理 | [上下文管理](../src/background/learning-chat-context.ts)；[#296](https://github.com/LittleNuB/BILI-BILL/pull/296) | 无限上下文、无需辅助请求、覆盖缺失却声称完整 |
| 概览 / 字幕 / 对话与共用输入框 | [浮层界面](../src/content/player-monitor/assistant-status.ts)；[#298](https://github.com/LittleNuB/BILI-BILL/pull/298) | 只有聊天、字幕被移除、普通切页也发请求 |
| 授权知识引用 | [知识问答验证](qa-knowledge-chat-291.md)；[#300](https://github.com/LittleNuB/BILI-BILL/pull/300) | 全库上传、语义向量检索、引用存在即证明答案正确 |
| 旧视频 Wiki 与主题迁移 | [旧 schema](video-wiki-schema-292.md)、[新范围](scope-open-knowledge.md) | 一次观看就自动入库、迁移删除原记录、主题变为综述 |
| 显式目标偏好 | [实施合同](implementation-explicit-memory-293.md)；[#302](https://github.com/LittleNuB/BILI-BILL/pull/302) | 自动记住一切、自动画像、现有备份包含记忆 |
| 未核实模型正文可读 | [范围合同](scope-chatbot-wiki-increment.md)、`AGENTS.md` 的输出展示规则 | 展示即通过核验、任意返回均可作为已验证资产保存 |
| 兴趣再平衡 | `CONTEXT.md` 的动态账单术语与 `AGENTS.md` 的产品定位 | 猜你喜欢、点击概率排名、自动修改 B站关系 |

## 发布与证据

- 本轮仍是功能候选。`package.json` 与 Manifest 沿用 `0.13.0-alpha` / `0.13.0`，本次不改版本、tag 或发布资产。
- GitHub Releases 最新为 `v0.13.0-alpha`，它不包含上述新增学习闭环。首页不能用该旧包作为新功能的一键下载入口。
- 截图来自生产界面与合成内容，见[来源记录](readme/README.md)。它们证明界面形态，不是实际用户视频、真实模型效果或数据迁移验收。
- [#325](https://github.com/LittleNuB/BILI-BILL/issues/325) 记录新闭环验收，旧 [#281](https://github.com/LittleNuB/BILI-BILL/issues/281) 和 A2 不自动通过。指定 Terra/xhigh 复核当前不可调用，不能用主 Agent 自检冒充。
- 仓库 About 建议使用：**在 B站边学边记，用开放本地知识库沉淀图文资料，与 Codex 共同取用、追溯和更新。**
