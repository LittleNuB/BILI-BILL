# 开发验收自动化 #345

状态：开发实现，设备安装和真实测试待授权。[Issue #345](https://github.com/LittleNuB/BILI-BILL/issues/345) 同时包含本合同和实现。

## 基线与边界

从2026-10-06实时核对的 main `8c7f3149b2063c483eca18266917b23d6b491aa1` 新建分支；显式合入 #342 的 `b29dabe`，其中含 #340 的生产提示词。未合入 #344 的截图入口布局，本工具复用已有播放器帧捕获，不宣称覆盖其UI。

普通构建的 manifest、版本和知识库 MCP 不变。开发包单独增加 `nativeMessaging`、专用后台/页面和有界播放器帧消息。开发页必须精确匹配本扩展 `acceptance/index.html`，无 `externally_connectable`，无网页付费入口。公共开发身份固定，后续原位加载可保留扩展账本；不能读取或复制其他浏览器配置。

## 工具合同

固定计划最多2个指定视频/分P、16个步骤；只接受概览、多轮对话、字幕优化、图片解读。问题与前序对话依赖在批准前确定，不接受运行时新prompt、任意JS、导航地址或文件路径。批准后只采集选定视频标签；存在多个同目标标签即要求消歧。未开启原声AI字幕时请用户先在页面手动开启；获取失败明确停止，不以标题/简介代替。

字幕复用生产获取和规范化函数，仅替换保存位置，冻结完整当前P的字幕，不写生产笔记或会话。材料绑定视频/P/CID/采集版本/源码/时间/SHA-256；上限20000行、256KB。模型文本消息最多64KB，生产对话构造器还有自己的上下文限制，超限如实报错，不静默截掉主体。字幕不是真值，关键数字和否定仍须对照音视频核验。

图片复用生产 `videoFrame`，仅当前播放器帧，绑定实际捕获时刻及前后15秒讲解。无activeTab整页截图后备，不主动seek，失败停止。选择当前帧应在实际测试计划审查时知悉。

概览复用生产payload/JSON transport/validator；聊天复用生产历史构造器/transport；字幕复用生产32行/4000字符分批和解析；图片复用生产图片payload和供应商分支。使用扩展**当前有效的可编辑提示词与模型**，不读取配置文件或导出密钥。输出上限显式记录，字幕6000，其他2048/8192/16384。字幕每步骤只处理一个预选批次，不隐藏更多调用。

`capture(target)`冻结一次；`run(step)`最多发起一次；相同命令重放只读已有结果。回测使用新计划ID/版本，旧样本/回答/审阅保留。`report(offset,limit,hash)`每段最多12000字符，完整SHA-256防止混合报告版本。`grade(row,grade)`追加评分历史；五维0–2，硬约束和严重失败单列；正文完整保留。无正文归生成失败，不推断不诚实。当前Codex审阅不是独立人工团队或盲审。

## 连接、会话与计量

Native Messaging host 是浏览器启动的4字节长度帧进程，MCP是Codex启动的JSON-RPC stdio进程；中间使用带192位配对码的Windows命名管道，不开HTTP端口。浏览器源必须匹配安装包限定扩展ID。会话仅批准页可授予，30分钟有效；MCP/CLI没有授权工具。页面关闭/刷新、配置变化、主机断连均撤销；只读页不抢owner。显式重连只读旧记录，不恢复生成。命名管道同一时间只允许一个主机实例。

新批次调用额度单独确认，旧总48次不扩容。共享累计1,000,000 token，已知旧32次/58,493；如果旧记录有新增，必须先核对而不能把它清零。每次先预留100,000，扩展账本落盘后再由主机账本落盘确认，才发送模型请求。未知用量占用预留并暂停；鉴权、余额、超预留立即停；无重试。账本不提供清空按钮。新版本累计此前所有计划收费；主机拒绝新浏览器档案、删除历史和费用回滚。启动新包不能绕过计数。

初次收费实例需确认旧计量仍适用，并不在其他扩展并行测试。旧评测工具本身仍保留原合同，不会被新工具接管或获得额外权限。

用户级安装脚本默认preview，仅显式`-Apply`注册HKCU下的Chrome/Edge专用主机键，不改HKLM/策略。卸载仅移除该包拥有的注册，账本与报告保留。独立账本位于用户审阅的工作区 `release-artifacts/acceptance-state`。未安装前不能声称设备Native Messaging连通。

## 验收

定向：`npm run test:acceptance`；安装后无网络页面：`node tests/acceptance.extension-qa.mjs <extension>`；普通构建：`npm run typecheck`、`npm test`、`npm run build`、`git diff --check`。开发打包检查每个JS/MJS<=500000字节，绑定commit/tree/计划摘要和逐文件哈希，独立输出不覆盖旧包。真实清单保存在忽略的本地文件，不提交视频材料或回答。

四种证据分别记：mock协议/引擎；实际Chrome/Edge隔离安装但无网络；真实材料/模型；真实站点UI。当前首版提供前两层的自动验证，以及后两层所需工具。生产界面的字幕开关、分P、截图入口、对话保存恢复及视觉可用性还需真实页面验收；后台/DOM响应不替代它。旧A2和历史发布门禁保持独立。

本次不调用收费评分模型。只有拿到真实回答后才针对质量缺陷修提示词并建立回测版本；不宣称已修好旧3次空正文或语义重复等问题。

官方协议依据：[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)、[MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。协议支持不代表当前设备安装验证通过。
