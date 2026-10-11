# Chrome / Edge 上架工作台

关联 #308；核对日期 2026-10-11。材料准备中，尚未提交。

## 当前状态

- 用户于 2026-10-11 确认两个开发者账号均未注册。
- 新口径材料：[商店文案](listing-zh-CN.md)、[权限数据流](permissions.md)、[隐私政策草案](privacy-policy-draft.md)、[审核清单](review-checklist.md)。
- 当前准备基于体验候选 1d71107，依赖 Draft #360；最新 main 为 26155a9。此分支显式合入候选，不改变正式版本。
- 当前 manifest 的产品描述已更新，版本仍为 0.13.0 / 0.13.0-alpha。0.14.0 版本批准与最终发布独立处理。
- 新检查使用 scripts/store-review-qa.mjs；9 月的 store-candidate-qa.mjs 和 candidate-20260927.md 保留为历史，不再作为当前上架检查入口。
- 普通体验包中的 browser ZIP 是 dist-only；外层验收合集、开发评测包、Codex 插件包均不可上传为浏览器商店包。
- 本轮实际结果与候选截图见 [体验检查与送审准备](candidate-20261011.md)。

## 可并行推进

1. 用户注册两店账号并完成身份/联系信息、条款与支付操作。Edge 扩展开发者注册没有注册费；Chrome 需一次性注册费，以账户页面为准。[Edge 注册](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)，[Chrome 注册](https://developer.chrome.com/docs/webstore/register/)。
2. 确认公开发布者名称、私密支持渠道、首发地区和价格策略；这些内容不从个人 Git 邮箱推断。
3. 发布者确认隐私政策后，提供稳定公开 HTTPS 地址，并验证未登录可读。
4. 完成发布所需真实站点/模型检查、候选代码合入和版本批准；重新构建普通发行包，记录源码与文件 SHA256。
5. 两店分别建立草稿，上传验证过的普通 ZIP、截图、图标与文案，填写用途、权限、数据和审核说明。
6. 展示最终提交预览，确认送审和发布时间；默认建议审核后再手动公开。记录各店不同 ID，准备开发加载版到商店版的备份迁移说明。

## 官方规格

- Chrome：128×128 PNG 图标、440×280 小宣传图、至少一张截图；当前选用 1280×800。[图片要求](https://developer.chrome.com/docs/webstore/images)
- Edge：方形 Logo 至少 128×128、推荐 300×300；截图最多六张，当前选用同规格 1280×800；440×280 宣传图可选。[Edge 提交](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- 两店用途、权限、数据和政策字段仍需填全。[Chrome 隐私字段](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

## 待提交清单

- 开发者账号、身份与支持渠道。
- 正式隐私政策 URL、地区/价格口径。
- 最终功能候选、版本批准及普通发行 ZIP。
- 真实视频与模型的最低发布验收。
- 送审截图和图标最终确认、两店提交预览。
