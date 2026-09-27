# 生产学习 Worker 中断与容量诊断

关联 #314 / #281。命令：设置 `UX014_PLAYWRIGHT_MODULE` 与 `UX014_CHROME_EXECUTABLE` 后执行 `node tests/production-learning-worker.browser-qa.mjs`。先执行 `npm run build`，不要用旧 dist 代替当前构建。

## 测试对象与隔离

加载 dist 中唯一的 `learning-worker-*.js`，报告绑定实际 bundle、测试脚本、备份编码器和控制 wrapper 的 SHA256、Git 提交及 dirty 状态。所有请求只向隔离 loopback 测试页面提供本地字节，其他请求阻断；不读取个人浏览器文件、凭据或用户资料。生产 Worker 字节未修改；本次不是扩展 Service Worker 生命周期测试。

## 中断检查

1. 用生产 Worker 预检和恢复一条合成笔记，导出学习/Wiki 内容，连同 lgMeta 元数据计算完整摘要。
2. 在测试专用 wrapper 中观察原生 IndexedDB 资产 put 成功；连续原生 get 让同一事务保持活动。保留原请求及结果，不用人为抛错假装崩溃。
3. 确认恢复尚未返回结果后，实际终止 dedicated Worker；重新加载无 wrapper 的生产 Worker，摘要必须与中断前完全一致。
4. 重新预检并恢复 100 条笔记，核对数量；再重启 Worker 验证状态摘要不变。

这是有控制暂停点的实际 Worker 终止和事务回滚证据，不是随机关闭整个浏览器、磁盘断电或真实空间耗尽。wrapper 只用于中断部分，容量测量使用无 wrapper 的生产 Worker。

## 定向测量

三个场景各一次：1000 条普通笔记；1000 条合计规范字节恰好 10 MiB；单条恰好 10 MiB。每场景先清空合成库，分别计量生产 preflight 和 restore 消息往返，不将 restore 时间描述为纯 IDB 提交时间。

复用 LG-0 的主线程加 Worker CDP 堆采样器，请求间隔 25ms，不强制 GC；报告包含两侧原始样本、采样耗时与间隙、backing storage。沿用 250ms 采样质量、256 MiB 合计堆采样增长、200ms 主线程长任务与2000ms预检进度间隙约束。未观察到 Worker 堆或采样质量不足，不能判通过。超过约束记 fail，证据质量问题记 insufficient_evidence。

## 开发验证与边界

干净提交 `4b747b6` 上的收据：[Edge](worker-314/edge.json)、[Chrome](worker-314/chrome.json)。两者中断前后摘要完全一致，恢复100条后重启Worker摘要保持一致。三个定向场景均满足所测约束和采样质量；相关回归22/22、typecheck/build及diff-check通过。运行时与版本均未修改。

| 场景 | Edge 预检/恢复 ms | Chrome 预检/恢复 ms | 最大合计堆采样增长 MiB |
| --- | --- | --- | --- |
| 1000 条普通笔记 | 49.6 / 44.0 | 51.6 / 36.8 | 3.82 |
| 1000 条合计 10 MiB | 424.1 / 92.4 | 391.4 / 84.6 | 85.54 |
| 单条 10 MiB | 396.4 / 78.6 | 364.1 / 73.2 | 49.49 |

每个浏览器每场景只有一次，不能用该表计算p95、宣称绝对峰值或承诺所有机器达到此速度。

2026-09-27 Edge 153 上两次开发运行通过，保留 `release-artifacts/production-worker-1790519788950` 和 `production-worker-1790519852364`。第二次加强了 lgMeta 摘要与采样质量检查；两次 dirty 运行不是正式收据。

这不是六场景48次正式矩阵，不计算 p95，也没有测搜索、完整导出性能、敌意输入、真实配额或扩展宿主交互。`formalGateStatus` 固定 `not_evaluated`，#281 不因此关闭。报告的 pass 只覆盖上述中断检查与三个定向场景；不能解释为 V0.14 完整发布验收通过。
