import { access, mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function verdict(row) {
  if (!row.grade) return '待审阅';
  return row.state === 'complete' && row.checks?.format && row.grade.hardFactsPass && !row.grade.severe
    && row.grade.scores.reduce((a, b) => a + b, 0) >= 8 ? '通过' : '未通过';
}
export function htmlReport(report) {
  const rows = report.rows.map(row => `<section><h2>${escape(row.id)} · ${verdict(row)}</h2><p>状态：${escape(row.state)}；材料：${escape(row.materialHash)}；模型：${escape(row.model)}</p>
    <p>程序检查：${escape(JSON.stringify(row.checks ?? null))}</p><p>用量：${escape(JSON.stringify(row.observation ?? null))}</p>
    <p>审阅与归因：${escape(JSON.stringify(row.grade ?? '待 Codex 审阅；并非独立人工盲审'))}</p>${row.state === 'complete' && row.checks?.format && row.displayText
      ? `<p>结构已检查，事实仍以材料审阅为准。</p><pre>${escape(row.displayText)}</pre><details><summary>原始模型输出</summary><pre>${escape(row.text)}</pre></details>`
      : `${row.checks?.format === false ? '<p>结构未通过；以下保留原始模型输出，未经核实。</p>' : ''}<pre>${escape(row.text || '未生成正文')}</pre>`}</section>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bili-Bill 验收报告</title>
  <style>body{max-width:980px;margin:32px auto;padding:0 20px;font:16px/1.7 system-ui}section{border-top:1px solid #ccc;padding:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f8;padding:16px}</style>
  <h1>开发验收报告</h1><p>计划 ${escape(report.plan.id)} · ${escape(report.planHash)}</p><p>证据类型：${escape(JSON.stringify(report.evidence))}</p>
  <p>字幕是待核验材料；后台调用不证明真实站点 UI 可用。无正文属于生成失败。关键事实、引用或时间错误不能被平均分抵消。</p>
  <p>已知旧用量 ${escape(report.legacy.tokens)} token，旧调用 ${escape(report.legacy.calls)}/${escape(report.legacy.callLimit)}；本计划已尝试 ${report.rows.length}/${report.plan.steps.length} 次。未知用量不能按零计。</p>
  <p>暂停原因：${escape(report.pause ?? '无')}</p>${rows}<p>完整材料、消息、原始回答与历史审阅保存在同目录 report.json。报告仅保存在本地。</p></html>`;
}
export async function checkOutputRoot(root) {
  const absolute = path.resolve(root);
  let resolved, stat;
  try { resolved = await realpath(absolute); stat = await lstat(absolute); }
  catch { throw Error('ACCEPTANCE_OUTPUT_DIRECTORY_REQUIRED'); }
  if (!stat.isDirectory()) throw Error('ACCEPTANCE_OUTPUT_DIRECTORY_REQUIRED');
  if (resolved.toLowerCase() !== absolute.toLowerCase() || stat.isSymbolicLink()) throw Error('ACCEPTANCE_OUTPUT_SCOPE');
  try { await access(absolute, constants.W_OK); } catch { throw Error('ACCEPTANCE_OUTPUT_UNWRITABLE'); }
  return absolute;
}
export async function saveReport(report, root) {
  const absolute = await checkOutputRoot(root);
  const directory = path.join(absolute, `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  await writeFile(path.join(directory, 'Report.html'), htmlReport(report), { flag: 'wx' });
  return { directory, rows: report.rows.length, evidence: report.evidence };
}
