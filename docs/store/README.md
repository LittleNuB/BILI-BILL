# Chrome / Edge 上架工作台

关联 #308；核对日期 2026-09-27。状态：材料草案，未提交商店、未上线。#281 的正式验收继续独立跟踪。

## 当前交付与缺口

- 已准备：[中文商店文案](listing-zh-CN.md)、[权限与数据流说明](permissions.md)、[隐私政策草案](privacy-policy-draft.md)、[审核与素材清单](review-checklist.md)。
- 待确认：两个开发者账号状态、公开发布者名称及支持联系渠道、首发地区、价格策略、最终版本号、最终送审批准。
- 待完成：公开且无需登录的正式隐私政策 URL、最终构建的商店截图/宣传图、权限最小化复核、实际 Chrome 和 Edge 安装测试、在线模型及 B 站真实流程最低验收。
- 尚未生成或上传正式商店 ZIP。现有 acceptance ZIP 是验收材料合集，不能直接当作商店包上传。

## 两店执行顺序

1. 用户在 Google Chrome Developer Dashboard、Microsoft Partner Center 分别确认开发者身份；不向 Agent 提供密码、验证码、证件或支付信息。
2. 核对发布者、支持渠道、市场和收费口径。Chrome 需注册开发者账号并处理注册费，以账户页面为准，不替用户付款或接受条款。
3. 按实际代码完成最小权限和数据披露，确认隐私政策后发布到稳定公开 HTTPS 地址，再以未登录环境验证可访问。
4. #281 的发布必需项完成或由用户明确接受剩余限制后，批准版本号，构建、验证、生成 manifest 位于根目录的 dist-only ZIP。保存 commit、SHA256、许可证及文件清单。
5. 两店分别建立草稿、填写文案/披露、上传同一经过各自安装验证的构建和素材，记录各自扩展 ID。不能假定 ID 相同或旧本地数据自动迁移。
6. 展示最终提交预览，由用户明确批准送审及是否审核后自动上线。默认建议 Chrome 采用延迟发布，Edge 按实际后台选项确认发布时间，不擅自勾选自动公开。
7. 在 #308 记录提交号、审核结果、修订原因和实际公开链接；审核通过不等同用户真实流程验收完成。

## 官方依据

- [Chrome 发布流程](https://developer.chrome.com/docs/webstore/publish)：上传 ZIP、填写商店/隐私/分发/测试说明；审核与上线可分开。
- [Chrome 隐私字段](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)：单一用途、权限依据与数据使用披露。
- [Chrome 图片要求](https://developer.chrome.com/docs/webstore/images)：图标、截图和小宣传图。
- [Edge 提交流程](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)：Partner Center 的包、语言、用途、权限、隐私和审核说明。

以上是本轮核对的实施参考，不保证审核结果或时间。后续以提交后台现行要求为准，不通过隐藏现有功能或不实披露绕过审核。
