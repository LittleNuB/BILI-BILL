# 产品能力与实现索引

[返回首页](../README.md)

核对日期：2026-09-19。功能基线：`main@10257f380657fe47aeb4cc52a2694a4264a92402`。用于 README 与 GitHub 简介的事实核对，不代替版本验收或改变历史范围合同。

## 产品价值

Bili-Bill 是面向 B站视频学习的本地优先助手，也是用户的个人内容账单。它把视频页的理解、追问和记录，与后续的整理、回看和知识复用接起来。

- **少搬运上下文**：在原视频页看概览、读字幕、继续提问，减少手动复制字幕到另一个聊天工具。
- **留下自己的思考**：笔记、摘录与时间点关联原视频和实际分 P，之后可以回到来源核对。
- **让积累可复用**：一视频一页，相关视频按主题归组；主动提问时可引用授权的相关个人材料。
- **控制什么被使用**：保存内容在本地；模型请求、知识材料和目标偏好有明确授权边界，不自动形成个人画像。
- **看清内容消费**：观看账单和兴趣再平衡保留，不将产品简化成纯摘要工具，也不改成推荐排名系统。

以上描述的是工作流与能力，不宣称学习效率提升百分比、真实用户规模、模型准确率或理解程度。

## 当前实现对照

| 首页描述 | 可核对的实现或合同 | 不应扩大的承诺 |
| --- | --- | --- |
| 开放学习与连续追问 | [聊天实现](../src/background/learning-chat.ts)；[#295](https://github.com/LittleNuB/BILI-BILL/pull/295) | 缺字幕也能还原视频结论、所有回答均有视频依据 |
| 长对话与长字幕管理 | [上下文管理](../src/background/learning-chat-context.ts)；[#296](https://github.com/LittleNuB/BILI-BILL/pull/296) | 无限上下文、无需辅助请求、覆盖缺失却声称完整 |
| 概览 / 字幕 / 对话与共用输入框 | [浮层界面](../src/content/player-monitor/assistant-status.ts)；[#298](https://github.com/LittleNuB/BILI-BILL/pull/298) | 只有聊天、字幕被移除、普通切页也发请求 |
| 授权知识引用 | [知识问答验证](qa-knowledge-chat-291.md)；[#300](https://github.com/LittleNuB/BILI-BILL/pull/300) | 全库上传、语义向量检索、引用存在即证明答案正确 |
| 视频 Wiki 与主题 | [实施合同](implementation-video-wiki-292.md)、[schema](video-wiki-schema-292.md)；[#301](https://github.com/LittleNuB/BILI-BILL/pull/301) | 自动写 Wiki、生成综述、自动留存全字幕或另存笔记副本 |
| 显式目标偏好 | [实施合同](implementation-explicit-memory-293.md)；[#302](https://github.com/LittleNuB/BILI-BILL/pull/302) | 自动记住一切、自动画像、现有备份包含记忆 |
| 未核实模型正文可读 | [范围合同](scope-chatbot-wiki-increment.md)、`AGENTS.md` 的输出展示规则 | 展示即通过核验、任意返回均可作为已验证资产保存 |
| 兴趣再平衡 | `CONTEXT.md` 的动态账单术语与 `AGENTS.md` 的产品定位 | 猜你喜欢、点击概率排名、自动修改 B站关系 |

## 发布与证据

- 上述学习增量已合并到 main，可从源码构建体验。`package.json` 与 Manifest 仍沿用 `0.13.0-alpha` / `0.13.0`，本次文档更新不改版本。
- GitHub Releases 最新为 `v0.13.0-alpha`，它不包含上述新增学习闭环。首页不能用该旧包作为新功能的一键下载入口。
- 截图来自生产界面与合成内容，见[来源记录](readme/README.md)。它们证明界面形态，不是实际用户视频、真实模型效果或数据迁移验收。
- [#281](https://github.com/LittleNuB/BILI-BILL/issues/281) 仍跟踪真实站点、模型与个人数据的正式验收。旧完整知识库路线与 A2 也未因本轮功能开发或文案更新而通过。
- 仓库 About 建议使用：**面向 B站视频学习的本地优先助手：边看边问、随手记笔记，用视频 Wiki 沉淀与复用知识；保留观看账单与兴趣再平衡。**
