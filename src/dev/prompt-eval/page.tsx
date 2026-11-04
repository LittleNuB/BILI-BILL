import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Play, Square, Download, RotateCw, X, Check } from 'lucide-preact';
import { CASES } from './cases.ts';
import { verdict, type Grade, type Report, type Row } from './engine.ts';
import manifest from '../../../tests/fixtures/prompt-eval/manifest.json';
import './page.css';
import { OUTPUT_LIMITS, TOKEN_RESERVATION, tokenBudget } from './budget.ts';

const errors: Record<string, string> = {
  EVAL_TOKEN_BUDGET: '剩余额度不足以预留下一次请求，已停止。',
  EVAL_USAGE_UNKNOWN: '接口未返回完整用量，已暂停，并保留本次10万 token 预留。请核对后再继续。',
  EVAL_USAGE_EXCEEDED: '本次用量超出预留，已停止，请先核对接口用量。',
  EVAL_INPUT_BUDGET: '测试输入超出本轮固定材料大小限制，未发起请求。',
  EVAL_SEED_CONFLICT: '历史记录不匹配，已停止；请保留并导出原记录，不要清空数据。',
  EVAL_BUSY: '已有评测正在运行或另一评测页仍打开。', EVAL_NOT_CONFIGURED: '请先在扩展设置中连接文字模型。',
  EVAL_VISION_DISABLED: '请先在扩展设置中启用并配置图片模型。', EVAL_CONFIG_CHANGED: '模型配置发生变化，已停止。同一轮对照必须使用相同配置。',
  EVAL_BUILD_CHANGED: '现有记录属于另一构建。请先导出旧评测记录，使用独立测试扩展进行新一轮评测。',
  EVAL_ENDPOINT: '评测仅支持无嵌入凭据的 HTTPS 接口。', EVAL_LIMIT: '本轮最多48次生成，补测需填写原因。',
  EVAL_ROW: '先完成待运行案例，再选择已有记录补测。', EVAL_GRADE: '请完成五项评分、事实核对、归因和评语。',
  EVAL_OPERATION_FAILED: '操作未完成，已有记录保留。', EVAL_DISCONNECTED: '评测页已断开，重新打开后可查看已保存结果。',
  EVAL_CONNECTION_TIMEOUT: '连接评测后台超时，未发起模型请求。请重新连接；仍失败时请重新加载扩展。',
};
const stateNames = { queued: '待运行', running: '生成中', complete: '已返回', failed: '请求失败', cancelled: '已停止', interrupted: '已中断' };
const verdictNames = { pass: '通过', fail: '未通过', unreviewed: '待评分' };
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function GradeForm({ row, disabled, submit }: { row: Row; disabled: boolean; submit: (grade: Grade) => void }) {
  const [scores, setScores] = useState(row.grade?.scores ?? [-1, -1, -1, -1, -1]);
  const [facts, setFacts] = useState(row.grade ? String(row.grade.hardFactsPass) : '');
  const [severe, setSevere] = useState(row.grade?.severe ?? false);
  const [cause, setCause] = useState(row.grade?.cause ?? 'none');
  const [notes, setNotes] = useState(row.grade?.notes ?? '');
  const [reviewer, setReviewer] = useState(row.grade?.reviewer ?? '');
  return <form onSubmit={event => { event.preventDefault(); submit({ scores: scores as Grade['scores'], hardFactsPass: facts === 'true', severe, cause, notes, reviewer }); }}>
    <div className="score-grid">{['正确性', '来源诚实', '任务完成度', '可读性', '简洁性'].map((label, index) => <label>{label}<select aria-label={label} value={scores[index]} required disabled={disabled} onChange={e => setScores(scores.map((n, i) => i === index ? Number(e.currentTarget.value) : n))}>
      <option value={-1} disabled>未评分</option><option value={0}>0 · 不合格</option><option value={1}>1 · 有缺陷</option><option value={2}>2 · 符合</option></select></label>)}</div>
    <label>事实与禁止项<select aria-label="事实与禁止项" value={facts} required disabled={disabled} onChange={e => setFacts(e.currentTarget.value)}><option value="" disabled>未核对</option><option value="true">全部符合</option><option value="false">存在问题</option></select></label>
    <label className="check"><input type="checkbox" checked={severe} disabled={disabled} onChange={e => setSevere(e.currentTarget.checked)} />严重失败：伪造来源、改变关键事实或冒充看图</label>
    <label>问题归因<select value={cause} disabled={disabled} onChange={e => setCause(e.currentTarget.value as Grade['cause'])}>{Object.entries({ none: '无明显问题', prompt: '提示词', model: '模型能力', transport: '接口或传输', parser: '解析规则' }).map(([value, label]) => <option value={value}>{label}</option>)}</select></label>
    <label>评分人<input value={reviewer} maxLength={80} required disabled={disabled} onInput={e => setReviewer(e.currentTarget.value)} /></label>
    <label>评语与依据<textarea value={notes} maxLength={4000} required disabled={disabled} onInput={e => setNotes(e.currentTarget.value)} /></label>
    <button disabled={disabled || scores.includes(-1) || !facts}><Check size={16} />保存评分</button>
  </form>;
}
function App() {
  const [port, setPort] = useState<chrome.runtime.Port | null>(null), [report, setReport] = useState<Report | null>(null);
  const [settings, setSettings] = useState<any>(null), [running, setRunning] = useState(false), [error, setError] = useState('');
  const [connection, setConnection] = useState<'connecting' | 'ready' | 'failed'>('connecting'), [connectionAttempt, setConnectionAttempt] = useState(0);
  const [selected, setSelected] = useState('overview-normal:baseline'), [view, setView] = useState('answer'), [reason, setReason] = useState('');
  useEffect(() => {
    let disposed = false;
    setConnection('connecting'); setError(''); setSettings(null);
    if (!globalThis.chrome?.runtime?.connect) { setConnection('failed'); setError('请从已加载的评测扩展打开此页，不能直接双击 HTML 运行。'); return; }
    let connected: chrome.runtime.Port;
    try { connected = chrome.runtime.connect({ name: 'bili-bill-prompt-evaluation-v1' }); }
    catch { setConnection('failed'); setPort(null); setError(errors.EVAL_DISCONNECTED); return; }
    setPort(connected);
    const timeout = setTimeout(() => { setConnection('failed'); setError(errors.EVAL_CONNECTION_TIMEOUT); connected.disconnect(); setPort(null); }, 12000);
    connected.onMessage.addListener(message => {
      if (disposed) return;
      if (message.report) { clearTimeout(timeout); setConnection('ready'); setReport(message.report); }
      if (typeof message.running === 'boolean') setRunning(message.running);
      if (message.error) { clearTimeout(timeout); setConnection('failed'); setError(errors[message.error] ?? '操作未完成，已保留现有记录。'); }
      if (message.settings) { setSettings(message.settings); if (message.settings.error) setError(errors[message.settings.error] ?? '请检查扩展模型设置。'); }
    });
    connected.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (disposed) return; clearTimeout(timeout); setPort(null); setRunning(false); setConnection('failed'); setError(current => current || errors.EVAL_DISCONNECTED); });
    const heartbeat = setInterval(() => { try { connected.postMessage({ action: 'ping' }); } catch { clearInterval(heartbeat); } }, 15000);
    return () => { disposed = true; clearInterval(heartbeat); clearTimeout(timeout); connected.disconnect(); };
  }, [connectionAttempt]);
  const send = (message: unknown) => { setError(''); if (!port) { setError(errors.EVAL_DISCONNECTED); return; } try { port.postMessage(message); } catch { setError(errors.EVAL_DISCONNECTED); } };
  const row = report?.rows.find(row => row.id === selected), item = CASES.find(item => item.id === row?.caseId);
  const attempted = report?.rows.filter(row => row.attempted).length ?? 0;
  const budget = tokenBudget(report?.rows ?? []);
  const budgetReady = budget.remaining >= TOKEN_RESERVATION;
  const partialInitial = !!report?.rows.slice(0, 32).some(r => r.attempted) && !!report?.rows.slice(0, 32).some(r => !r.attempted);
  const exportJson = () => { if (report) download(`bili-bill-evaluation-${report.sourceCommit.slice(0, 7)}.json`, JSON.stringify({ ...report, frozenManifest: manifest, cases: CASES }, null, 2), 'application/json'); };
  return <main>
    <header><div><strong>Bili-Bill</strong><h1>提示词评测</h1></div><span>开发验收 · 合成资料 / 真实接口</span></header>
    <section className="toolbar"><span>文字：{settings?.model ?? '未连接'} · 图片：{settings?.imageModel ?? '未连接'}<br />已尝试 {report ? attempted : '未读取'} / 48 次 · {settings && !settings.error ? settings.stream ? '流式对话' : '非流式对话' : '配置待确认'}</span>
      <div className="actions">{connection === 'failed' && <button onClick={() => setConnectionAttempt(n => n + 1)}><RotateCw size={16} />重新连接</button>}<button disabled={!port || !report || !settings?.model || running || !budgetReady || !report.rows.some(r => r.state === 'queued')} onClick={() => send({ action: 'run' })}><Play size={16} />{attempted ? '继续待运行项' : '开始32次对照'}</button>
        <button disabled={!running} onClick={() => send({ action: 'stop' })}><Square size={16} />停止</button>
        <button disabled={!report} onClick={exportJson}><Download size={16} />导出结果</button></div></section>
    <section className="toolbar" aria-label="评测预算"><span>累计预算 {budget.limit.toLocaleString()} token<br />已计量 {report ? budget.measured.toLocaleString() : '未读取'} · 未结算预留 {report ? budget.reserved.toLocaleString() : '未读取'} · 可用 {report ? budget.remaining.toLocaleString() : '未读取'}</span>
      <label>单次输出上限<select aria-label="单次输出上限" value={report?.outputTokens ?? 8192} disabled={!port || !report || running || partialInitial} onChange={e => send({ action: 'outputTokens', value: Number(e.currentTarget.value) })}>{OUTPUT_LIMITS.map(n => <option value={n}>{n.toLocaleString()}</option>)}</select></label></section>
    <details className="boundary"><summary>预算与补测口径</summary><p>包含历史请求。摘要、对话和图片使用所选输出上限；字幕保持6,000。每次发送前预留100,000 token，收到完整用量后按实际结算。预留是保守估算，并非服务商计费保证；缺失用量保留预留并暂停，不按零计费。参数调整后的补测属于回归，不替代原32次同参数对照。</p></details>
    {error && <div role="alert" className="notice"><span>{error}</span><button aria-label="关闭提示" title="关闭提示" onClick={() => setError('')}><X size={16} /></button></div>}
    <p className="boundary">仅发送固定测试资料，不读取个人知识库。点击开始将调用已配置模型并产生相应用量。格式通过不等于回答合格。</p>
    <div className="layout"><nav aria-label="评测案例">{report?.rows.map(r => <button className={r.id === selected ? 'selected' : ''} onClick={() => { setSelected(r.id); setView('answer'); }}>
      <span>{CASES.find(c => c.id === r.caseId)?.title} · {r.variant === 'baseline' ? '旧版' : '候选'}{r.retryOf ? ' · 补测' : ''}</span>
      <small>{stateNames[r.state]} · {verdictNames[verdict(r)]}</small></button>)}</nav>
      <article>{row && item ? <>
        <h2>{item.title} · {row.variant === 'baseline' ? '旧版提示词' : '候选提示词'}</h2>
        <details><summary>测试材料与评分依据</summary><p>{item.format}</p><p>必须满足：{item.facts.join('；')}</p><p>禁止：{item.forbidden.join('；')}</p>
          <pre>{item.text.join('\n')}</pre>{item.question && <p>{item.question}</p>}{item.history && <pre>{JSON.stringify(item.history, null, 2)}</pre>}{item.knowledge && <p>{item.knowledge}</p>}
          {item.image && <img className="fixture" src={`images/${item.image}`} alt={item.title} />}</details>
        <div role="tablist" className="tabs">{[['answer', '模型回答'], ['request', '请求与检查'], ['grade', '质量评分']].map(([value, label]) => <button role="tab" aria-selected={view === value} onClick={() => setView(value)}>{label}</button>)}</div>
        {view === 'answer' && <><p className="meta">{stateNames[row.state]}{row.elapsedMs !== undefined ? ` · ${(row.elapsedMs / 1000).toFixed(1)} 秒` : ''} · {verdictNames[verdict(row)]}</p>
          {row.error && <p className="notice">请求未完成：{row.error}</p>}<pre className="answer">{row.text || (row.state === 'queued' ? '尚未运行' : '尚无回答正文')}</pre></>}
        {view === 'request' && <><p>格式检查：{row.checks ? row.checks.format ? '通过，仍需质量评分' : row.checks.failures.join('、') : '未执行'}</p><p>{row.retryOf ? '补测回归（不替代原对照）' : '初始对照'}</p><pre>{JSON.stringify({ model: row.model, parameters: row.parameters ?? report?.parameters, response: row.observation, promptHash: row.promptHash, inputHash: row.inputHash, messages: row.messages }, null, 2)}</pre></>}
        {view === 'grade' && <GradeForm key={row.id} row={row} disabled={running || !row.attempted || !port} submit={grade => send({ action: 'grade', id: row.id, grade })} />}
        <details className="retry"><summary>补测此案例</summary><label>补测原因<input value={reason} maxLength={500} onInput={e => setReason(e.currentTarget.value)} /></label>
          <button disabled={!port || !settings?.model || running || !budgetReady || !row.attempted || attempted >= 48 || !reason.trim() || report?.rows.some(r => r.state === 'queued')} onClick={() => send({ action: 'retry', id: row.id, reason })}><RotateCw size={16} />追加一次生成</button></details>
      </> : <p>{connection === 'connecting' ? '正在读取评测记录…' : '评测记录尚未加载，请重新连接。'}</p>}</article></div>
    <footer>源码 {report?.sourceCommit.slice(0, 7) ?? '未连接'} · 本轮不会自动改写提示词，也不会清除失败记录。</footer>
  </main>;
}
render(<App />, document.getElementById('app')!);
