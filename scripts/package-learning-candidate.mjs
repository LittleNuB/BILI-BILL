import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.argv.length, 5, 'Expected source QA directory, save QA directory, Python executable');
const directories = process.argv.slice(2, 4).map(value => path.resolve(root, value));
const python = path.resolve(process.argv[4]);
execFileSync(python, ['-c', 'import playwright.sync_api'], { cwd: root });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
const reports = directories.map(directory => {
  assert.equal(path.dirname(directory), path.join(root, 'release-artifacts/lg1'));
  const report = JSON.parse(readFileSync(path.join(directory, 'report.json'), 'utf8'));
  assert.equal(report.status, 'pass');
  assert.equal(report.profileRemoved, true);
  assert.equal(report.workingTreeDirty, false);
  assert.equal(report.sourceCommit, commit);
  for (const [file, hash] of Object.entries(report.distSha256)) {
    const actual = createHash('sha256').update(readFileSync(path.join(root, 'dist', file))).digest('hex');
    assert.equal(actual, hash, file);
  }
  return report;
});
const output = path.join(root, 'release-artifacts/interview', `Bili-Bill-candidate-${commit.slice(0, 7)}-${Date.now()}`);
mkdirSync(output, { recursive: true });
cpSync(path.join(root, 'dist'), path.join(output, 'extension'), { recursive: true });
for (const directory of ['scripts', 'tests', 'screenshots']) mkdirSync(path.join(output, directory));
for (const file of ['scripts/learning-candidate-demo.py', 'tests/learning-save.mock.html', 'tests/learning-source-provider.js']) cpSync(path.join(root, file), path.join(output, file));
for (const directory of directories) for (const file of readdirSync(directory).filter(name => name.endsWith('.png'))) cpSync(path.join(directory, file), path.join(output, 'screenshots', file));
writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ commit, reports }, null, 2));
writeFileSync(path.join(output, 'Start-Demo.cmd'), `@echo off\r\n"${python}" -X utf8 -u "%~dp0scripts\\learning-candidate-demo.py" --workspace "${root}" --dist "%~dp0extension"\r\nif errorlevel 1 pause\r\n`);
const readme = `# Bili-Bill 整版功能候选

代码 ${commit}。V0.14 有限学习闭环候选，不是正式版本发布；扩展版本字段仍为既有 0.13。

## 启动

双击 Start-Demo.cmd。准备约 30 秒后打开独立浏览器的两个标签：视频和学习笔记。
启动器通过真实扩展保存个人笔记、书签、字幕原句、摘要、亮点和完整回答，然后关闭整个浏览器并重开读回六条记录。
本包冻结了扩展、启动器、合成素材和固定响应，不随工作分支变化。
需要本机已安装的 Python/Playwright Chromium，以及原项目目录用于短路径临时数据。不要移动本包或项目。
合成视频、字幕、固定 AI 响应均不是用户数据或真实模型质量证明。全程离线，不使用个人账号、密钥或浏览器资料。
关闭这个独立浏览器会清理本次合成数据；需要保留练习笔记时，先导出学习备份。

## 三分钟演示

1. 问题（20 秒）：内容看过和真正留下理解是两回事。Bili-Bill 从个人内容账单出发，让有价值的视频内容能保存、找回和回看。
2. 当前视频（40 秒）：切到视频页。收起助手展示轻量摘要，再展开查看摘要、亮点、问答和字幕。说明只有主动生成才请求模型，时间来自原句证据。这里为了现场稳定使用合成字幕和固定回答。
3. 自己的理解（40 秒）：点击笔记图标，写一句新理解并保存。到学习笔记点击刷新，搜索关键词，打开详情并编辑个人内容；保存时的原句单独保留，不会被个人修改覆盖。
4. 找回来源（30 秒）：打开一个书签，点击回看来源，先预览，再确认打开。只有当前播放器身份核对通过才定位，返回可恢复原位置。离线演示会先接入合成宿主页再打开来源，不依赖真实 B 站网络。
5. 带走成果（30 秒）：展开备份与空间，导出备份，再选择这个文件预览恢复。重复导入不增加条目，冲突保留本地；不要为了展示清空真实数据。
6. 产品判断（20 秒）：我负责需求与范围裁决，让 AI 辅助实现并用关键复核和真实扩展操作验证。当前完成有限规模功能候选；真实站点整体验收及正式发布仍单列，不宣称规模化使用或业务指标。

## 能力与边界

- 已实现：六种保存入口、当前证据核对、保存重开、搜索/筛选、个人层编辑、预览/确认/返回、规范导出、非破坏恢复、删除/清空、容量提示、全局与视频浮层界面统一。
- 有限上限：1000 条、10 MiB，不增加上限、不自动删记录。
- AI 服务使用 OpenAI 兼容接口；实际使用需用户自行配置并明确开启。这个独立演示里的固定响应不等于在线模型能力。
- 没有字幕等可靠原文时不会冒充全文回答。本地音视频转录服务不在此候选中新增。
- 学习数据保存在本机；普通缓存重置保留学习笔记。备份为未加密 JSON，请妥善保管。
- 旧 A2 大规模校准及 #239/#240 不由本候选解锁。
- 真实 B 站兼容性、进程异常/配额等正式故障矩阵仍待整版验收。自动测试和合成播放器截图不替代它们。
- 启动器仅在独立演示环境预置合成新标签页，并替换字幕/模型网络响应；没有修改生产扩展的保存、来源核对和跳转处理器。

## 兜底

Guide.html 与 screenshots 是这份构建的实际操作截图。启动失败时可讲解截图，但明确这是截图演示。
extension 目录是可加载的真实开发扩展。未经准备不要现场导入个人账号或调用在线模型。
verification.json 绑定构建文件摘要和独立合成检查；没有创建 release/tag 或修改正式版本。
`;
writeFileSync(path.join(output, 'README.md'), readme);
const screens = [
  ['完整学习闭环', 'saved-source-detail.png'],
  ['视频浮层与答案保存', 'answer-saved.png'],
  ['总览', 'dashboard-1440-0.png'],
  ['设置', 'dashboard-1440-7.png'],
  ['窄屏学习笔记', 'dashboard-390-8.png'],
];
writeFileSync(path.join(output, 'Guide.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bili-Bill 整版功能候选</title><style>body{margin:0;background:#f6f7f8;color:#18191c;font:15px/1.8 "Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:0}main{max-width:1100px;margin:auto;padding:32px 24px}h1{font-size:30px;margin:0}h2{font-size:20px;margin:20px 0}p{max-width:850px;color:#61666d}section{border-top:1px solid #e3e5e7;padding:20px 0}img{display:block;max-width:100%;height:auto;border:1px solid #e3e5e7}a{color:#0086b3}</style><main><h1>Bili-Bill</h1><p>整版功能候选 · 保存理解，找回原句</p><p>双击同目录 Start-Demo.cmd 启动。真实扩展与 IndexedDB，合成视频/字幕和固定 AI 响应；不是正式发布或真实模型效果证明。</p><p><a href="README.md">启动、三分钟讲解与能力边界</a></p>${screens.map(([title, file]) => `<section><h2>${title}</h2><img src="screenshots/${file}" alt="${title}"></section>`).join('')}<p>构建 ${commit.slice(0, 7)}。正式站点和异常生命周期验收单列。</p></main></html>`);
console.log(JSON.stringify({ output, commit, status: 'packaged-functional-candidate' }));
