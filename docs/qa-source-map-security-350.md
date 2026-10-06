# source-map-js 安全补丁 #350

基于 main `8c7f3149b2063c483eca18266917b23d6b491aa1`，仅更新锁文件中的构建依赖 `source-map-js` 1.2.1 → 1.2.2。引入路径为 Vite / PostCSS；PostCSS 8.5.25 的 `^1.2.1` 范围允许该补丁。不新增顶层依赖、override，不改其他包、版本号或审计门槛。

依据：[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、[上游补丁](https://github.com/7rulnik/source-map-js/commit/cf7658058ceeaa8619d5ae0ec90be6905209d016)、[1.2.2 发布](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)。修复在映射展开前验证 section 偏移，并约束嵌套行偏移总量。

## 验证

- 修改前锁文件审计：1 项 high，命中该公告。
- `npm update source-map-js --package-lock-only --ignore-scripts --no-audit --no-fund`：仅版本、下载地址及 integrity 三行变化。
- `npm ci --ignore-scripts --no-audit --no-fund`：按更新后锁文件重建成功。
- `npm audit --audit-level=high`：0 vulnerabilities。
- `node --test tests/source-map-security.test.ts`：异常偏移、嵌套累计偏移、普通映射 round-trip 三项回归；恶意输入只做构造器拒绝检查，不在旧版本中执行可能阻塞的展开。
- `npm run typecheck`、`npm test`（858/858）、`npm run build`、`git diff --check` 通过。最大 JS chunk 481.09 kB，保留原 500,000 字节合同。

未验证本产品生产环境的可利用路径，不将构建依赖公告描述成用户数据泄漏。未读取 npm debug logs、凭据、浏览器 profile、Cookie、登录态或个人数据库。PR 合入前不会替其他分支消除审计失败；这些分支需同步补丁后重跑 CI。
