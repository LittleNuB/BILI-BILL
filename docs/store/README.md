# Chrome / Edge 上架工作台

关联 #308、[#365](https://github.com/LittleNuB/BILI-BILL/issues/365)；核对日期 2026-10-19。Edge 首发准备中，尚未提交，Chrome 暂缓。

## 当前状态

- 用户已完成 Edge 开发者注册；首发版本为 0.14.0，公开发布者 LittleNuB。Chrome 上架暂不处理。
- 新口径材料：[商店文案](listing-zh-CN.md)、[权限数据流](permissions.md)、[隐私政策草案](privacy-policy-draft.md)、[审核清单](review-checklist.md)。
- #365 从最新 main 26155a9 建立，显式合入 Draft #363 的完整体验候选 93b2f54。上游链保留，不把原实现冒充本次新增。
- 用户已批准将 package 和 manifest 统一到 0.14.0；版本号变化不代表商店已上线。
- LittleNuB 的[隐私政策正文](../privacy-policy.md)已准备；公开政策 URL 要在提交前核对可达，旧草案保留为历史材料，不提交草案。
- 新检查使用 scripts/store-review-qa.mjs；9 月的 store-candidate-qa.mjs 和 candidate-20260927.md 保留为历史，不再作为当前上架检查入口。
- 普通体验包中的 browser ZIP 是 dist-only；外层验收合集、开发评测包、Codex 插件包均不可上传为浏览器商店包。
- 本轮实际结果与候选截图见 [体验检查与送审准备](candidate-20261011.md)。

## 可并行推进

1. 使用已注册的 Edge 账号完成首次送审；法律承诺、新协议和安全权限在实际操作时确认。Chrome 暂缓，不要求先注册。
2. 发布者已确认为 LittleNuB；支持入口使用项目 GitHub Issues。不从 Git 邮箱推断私人联系方式。
3. 发布者确认隐私政策后，提供稳定公开 HTTPS 地址，并验证未登录可读。
4. 完成发布所需真实站点/模型检查、候选代码合入和版本批准；重新构建普通发行包，记录源码与文件 SHA256。
5. 两店分别建立草稿，上传验证过的普通 ZIP、截图、图标与文案，填写用途、权限、数据和审核说明。
6. 展示最终提交预览，确认送审和发布时间；默认建议审核后再手动公开。记录各店不同 ID，准备开发加载版到商店版的备份迁移说明。

## 官方规格

- Chrome：128×128 PNG 图标、440×280 小宣传图、至少一张截图；当前选用 1280×800。[图片要求](https://developer.chrome.com/docs/webstore/images)
- Edge：方形 Logo 至少 128×128、推荐 300×300；截图最多六张，当前选用同规格 1280×800；440×280 宣传图可选。[Edge 提交](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- 两店用途、权限、数据和政策字段仍需填全。[Chrome 隐私字段](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

## 待提交清单

- Edge 账号已完成；后台字段与支持渠道仍需核对。
- 正式隐私政策 URL、地区/价格口径。
- 最终功能候选、版本批准及普通发行 ZIP。
- 真实视频与模型的最低发布验收。
- 送审截图和图标最终确认、两店提交预览。
