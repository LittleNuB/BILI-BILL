import { PORT, type Plan } from './contract.ts';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let connection: chrome.runtime.Port | null = null, planHash = '', ready = false, connecting = false;
let timeout: ReturnType<typeof setTimeout>, heartbeat: ReturnType<typeof setInterval>;
const errors: Record<string, string> = {
  ACCEPTANCE_NOT_CONFIGURED: '请先在本扩展设置中配置文字模型。密钥仅留在扩展后台。',
  ACCEPTANCE_HOST_DISCONNECTED: '本地主机未连接或已断开。已停止本会话；请先完成用户级安装，再重新批准。',
  ACCEPTANCE_HOST_TIMEOUT: '本地主机连接超过12秒，已撤销会话，未发起生成。请检查安装后重新批准。',
  ACCEPTANCE_LEGACY_CHANGED: '检测到旧批次记录已有变化，请先核对完整计量。已有数据保留。',
  ACCEPTANCE_BUSY: '已有会话占用执行权。其他页面仍可查看状态。',
  ACCEPTANCE_REVOKED: '授权已撤销或已到期。已有结果保留。',
  ACCEPTANCE_PLAN_VERSION: '计划内容已变化，请使用新的计划版本；不能覆盖旧计划。',
  ACCEPTANCE_REFRESH_TARGET_PAGE: '请刷新选定的视频页，让新加载的扩展连接该页面，再继续采集。此错误未发起模型请求。',
  ACCEPTANCE_FROZEN_PLAN_REQUIRED: '当前验收账本缺少本计划依赖的上一轮记录。正在检查随包备份；如出现恢复入口，请先恢复记录再批准。',
  ACCEPTANCE_LEDGER_INVALID: '已有验收记录未通过完整性校验。已停止运行，请保留记录并排查，不要清空账本。',
  ACCEPTANCE_RECOVERY_INVALID: '备份未通过完整性校验，未恢复记录。',
  ACCEPTANCE_RECOVERY_CONFLICT: '当前已有记录或活动会话，恢复已停止，未覆盖现有记录。',
};
function notice(text: string) { element('notice').textContent = text; }
function update() {
  element<HTMLButtonElement>('approve').disabled = !ready || connecting || !element<HTMLInputElement>('consent').checked || !element<HTMLInputElement>('legacy').checked;
}
function connect() {
  connection?.disconnect(); ready = false; update(); notice('正在连接开发验收后台…');
  clearTimeout(timeout); clearInterval(heartbeat);
  if (!globalThis.chrome?.runtime?.connect) { notice('请从已加载的开发扩展打开本页。'); return; }
  const port = chrome.runtime.connect({ name: PORT }); connection = port;
  timeout = setTimeout(() => { notice('连接超过12秒，未发起生成。可以点击重新连接。'); port.disconnect(); }, 12000);
  port.onMessage.addListener(message => {
    if (port !== connection) return;
    if (message.plan) renderPlan(message.plan);
    if (message.build) element('build').textContent = `开发包：${message.build.sourceCommit.slice(0, 12)}`;
    if (message.diagnostic) element('results').textContent = JSON.stringify(message.diagnostic, null, 2);
    if ('recovery' in message) {
      element('recovery').hidden = !message.recovery;
      element<HTMLButtonElement>('recover').disabled = false;
      if (message.recovery) element('recovery-note').textContent = `此开发包带有已核对的历史备份：${message.recovery.planId}，${message.recovery.calls}次调用，累计${message.recovery.measured.toLocaleString()} token。恢复只补齐缺失的验收历史；已有记录必须完全匹配，差异记录不会被覆盖。保留冻结材料、回答和收费记录；不修改模型设置，不授权生成。连接时还会核对独立费用账本。`;
    }
    if (message.recovered) { element('recovery').hidden = true; connect(); return; }
    if (message.settings) element('models').textContent = message.settings.error ? (errors[message.settings.error] ?? '模型配置暂不可用，请检查设置后重新连接。') : `文字模型：${message.settings.model}；图片模型：${message.settings.imageModel || '未启用'}。`;
    if (message.summary) {
      clearTimeout(timeout); ready = true; planHash = message.summary.planHash;
      const b = message.summary.budget;
      element('budget').textContent = `累计上限 ${b.limit.toLocaleString()} token；已计量 ${b.measured.toLocaleString()}，未知预留 ${b.reserved.toLocaleString()}。旧批次已知 ${b.legacyCalls}/${b.legacyCallLimit} 次；本计划 ${b.newCalls}/${b.newCallLimit} 次。每次按输入和输出预留至少100,000、最多200,000；未知用量暂停。`;
      element('results').textContent = JSON.stringify(message.summary, null, 2);
      connecting = message.authorized;
      element('pairing').textContent = message.pairing ? `扩展 ID：${chrome.runtime.id}\n配对码：${message.pairing.code}\n有效至：${new Date(message.pairing.expiresAt).toLocaleString()}` : '';
      notice(message.authorized ? (message.pairing ? '已配对就绪。Codex 可按本页固定计划运行；关闭授权页或撤销会停止。' : '授权已建立，正在连接本地主机…') : '已读取记录。尚未授权本次会话。');
      update();
    }
    if (message.error) { clearTimeout(timeout); connecting = false; notice(errors[message.error] ?? '操作未完成，已有记录保留。请查看报告或重新连接。'); update(); }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; if (port !== connection) return;
    clearTimeout(timeout); clearInterval(heartbeat); connection = null; ready = false; connecting = false;
    notice('开发页面已断开，活动会话已停止。重新连接只读取记录。'); element('pairing').textContent = ''; update();
  });
  heartbeat = setInterval(() => { try { port.postMessage({ action: 'ping' }); } catch { clearInterval(heartbeat); } }, 15000);
}
function renderPlan(plan: Plan) {
  element('manual-note').textContent = plan.reuseFrom ? '；本次复用已冻结材料，无需重新打开视频采集' : '，并已在视频页面手动开启原声 AI 字幕';
  const labels = { overview: '概览（摘要与亮点）', chat: '对话', subtitles: '字幕优化', image: '图片解读' };
  element('plan').textContent = JSON.stringify({ 计划: plan.id, 视频: plan.targets.map(t => `${t.bvid} 第${t.page}P`),
    操作: plan.steps.map(s => `${s.id} · ${labels[s.feature]} · ${s.target}${s.question ? ' · ' + s.question : ''}${s.feature === 'subtitles' ? ` · 第${(s.subtitleBatch ?? 0) + 1}个生产批次` : ''}`),
    材料来源: plan.reuseFrom ? `复用已冻结计划 ${plan.reuseFrom}` : '批准后采集当前分P字幕和当前帧',
    对话上下文: plan.contextBytes ? `本计划显式使用 ${plan.contextBytes} UTF-8字节；不更改日常对话设置` : '沿用扩展当前设置',
    单次输出上限: plan.outputTokens, 字幕输出上限: 6000 }, null, 2);
}
element('reconnect').addEventListener('click', connect);
element('recover').addEventListener('click', event => {
  if (!event.isTrusted || !connection) return;
  element<HTMLButtonElement>('recover').disabled = true;
  notice('正在校验并恢复首轮记录，未发起模型请求…');
  connection.postMessage({ action: 'recover' });
});
for (const id of ['consent', 'legacy']) element(id).addEventListener('change', update);
element('approve').addEventListener('click', event => {
  if (!event.isTrusted || !ready || !connection) return;
  connecting = true; update(); notice('正在批准固定计划并连接本地主机…');
  connection.postMessage({ action: 'authorize', planHash });
});
element('stop').addEventListener('click', () => connection?.postMessage({ action: 'stop' }));
element('revoke').addEventListener('click', () => connection?.postMessage({ action: 'revoke' }));
connect();
