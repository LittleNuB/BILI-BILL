import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.resolve(root, process.argv[2] ?? '');
assert.equal(path.dirname(qa), path.join(root, 'release-artifacts', 'lg1'));
const report = JSON.parse(readFileSync(path.join(qa, 'report.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(report.status, 'pass');
assert.equal(report.profileRemoved, true);
assert.equal(report.workingTreeDirty, false);
assert.equal(report.sourceCommit, commit);
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
for (const [file, hash] of Object.entries(report.distSha256)) {
  const actual = createHash('sha256').update(readFileSync(path.join(root, 'dist', file))).digest('hex');
  assert.equal(actual, hash, file);
}
const output = path.join(root, 'release-artifacts', 'interview', `Bili-Bill-${commit.slice(0, 7)}-${Date.now()}`);
mkdirSync(output, { recursive: true });
cpSync(path.join(root, 'dist'), path.join(output, 'extension'), { recursive: true });
mkdirSync(path.join(output, 'screenshots'));
for (const file of readdirSync(qa).filter(name => name.endsWith('.png'))) {
  cpSync(path.join(qa, file), path.join(output, 'screenshots', file));
}
cpSync(path.join(qa, 'report.json'), path.join(output, 'verification.json'));
writeFileSync(path.join(output, 'Start-Demo.cmd'), `@echo off\r\npython -X utf8 -u "${path.join(root, 'scripts', 'learning-demo.py')}" --dist "%~dp0extension"\r\nif errorlevel 1 pause\r\n`);
const guide = `# Bili-Bill 面试演示

这是有限学习闭环的开发演示，不是 V0.14.0 正式发布。代码提交：${commit}。

## 启动

双击本目录的 Start-Demo.cmd，约 20 秒后打开两个标签页：视频与学习笔记。
使用当前机器已安装的 Python、Playwright Chromium。启动器依赖原项目目录，不要移动或删除项目。
每次创建独立的离线浏览器，自动保存两条合成样例，再完整重启浏览器验证读回。
这是真实扩展和真实 IndexedDB；视频宿主页与视频素材是合成演示，不代表真实 B 站适配验收。
演示不需要网络、账号或 AI 密钥；不会读取个人浏览器数据。关闭独立浏览器后清理本次演示数据。

## 三分钟顺序

1. 20 秒讲问题：B 站有大量有价值的内容，但看过、收藏和真正留下自己的理解是不同的动作。我做的是个人内容账单，并逐步补齐学习沉淀能力。
2. 60 秒展示保存：打开视频标签页，点击页内助手的笔记图标，输入自己的理解并保存。再存一个时间书签，说明位置来自实际播放器，不让模型猜时间。
3. 40 秒展示重开：切到学习笔记，刷新列表，打开刚才保存的内容。启动器已先完成整个浏览器重启后的读回；需要时可关闭视频标签页再重新打开学习笔记。删除一条样例并刷新确认。
4. 40 秒讲开发方法：我负责问题定义、范围裁决和验收，把任务拆为可检查的切片；AI 辅助实现，我用关键评审、边界测试和真实扩展交互验证结果。保存成功不仅要有提示，还要重开后能读到。
5. 20 秒讲边界：这次展示的是笔记、真实位置书签与保存重开。原文/答案保存、搜索与来源回看、备份恢复以及整版验收仍是后续工作，V0.14.0 尚未全部完成。

## 现场兜底

- 如果启动失败，打开 Guide.html，按真实操作截图讲解，不宣称它是正在运行的演示。
- 不进入真实账号同步或 AI 设置，不在现场依赖在线模型生成。
- 这份包没有合入仍独立审查中的 UX-014 PR #274，不把设计稿当成已发布界面。
- 扩展文件在 extension 目录，仅作为开发演示包；版本字段沿用现有 0.13，未创建 tag 或 release。
- verification.json 记录同一构建的文件摘要及合成浏览器检查，不能当作真实用户规模或业务效果。
`;
writeFileSync(path.join(output, 'README.md'), guide);
writeFileSync(path.join(output, 'Guide.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bili-Bill 面试演示</title><style>body{margin:0;background:#f6f7f8;color:#18191c;font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif;letter-spacing:0}main{max-width:1100px;margin:auto;padding:36px 24px}h1{font-size:32px;margin:0}h2{font-size:22px;margin-top:36px}p{max-width:850px;color:#61666d}img{display:block;width:100%;height:auto;border:1px solid #e3e5e7}section{padding:18px 0;border-top:1px solid #e3e5e7}a{color:#0086b3}</style><main><h1>Bili-Bill</h1><p>面试演示准备包 · 保存理解，重开仍在</p><p>开发切片，不是 V0.14.0 正式发布。以下均为真实扩展在合成宿主页的操作截图。双击同目录 Start-Demo.cmd 可操作；无需联网或登录。</p><p><a href="README.md">完整讲解顺序与能力边界</a></p><section><h2>01 记下自己的理解</h2><img src="screenshots/note-editor-desktop.png" alt="真实笔记编辑弹窗"></section><section><h2>02 保存后重开仍可读到</h2><img src="screenshots/learning-desktop.png" alt="学习笔记列表与详情"></section><section><h2>03 窄屏详情</h2><img style="max-width:390px" src="screenshots/learning-mobile-detail.png" alt="窄屏学习笔记详情"></section><p>代码 ${commit.slice(0, 7)}。来源绑定、取消、容量与无损升级通过相关测试；真实 B 站宿主和整版发布验收不由这些截图替代。</p></main></html>`);
console.log(JSON.stringify({ output, commit, status: 'packaged-local-development-demo' }));
