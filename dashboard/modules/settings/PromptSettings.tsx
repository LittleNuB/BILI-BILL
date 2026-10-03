import { useEffect, useRef, useState } from 'preact/hooks';
import { Save, Undo2, RotateCcw, WandSparkles, X, RefreshCw, Check } from 'lucide-preact';
import { requestSW } from '../../utils/messaging';
import { DEFAULT_PROMPTS, PROMPT_FEATURES, PROMPT_LABELS, promptText, type PromptFeature, type PromptSnapshot } from '../../../src/shared/ai-prompts';
import './prompt-settings.css';

export function PromptSettings() {
  const [snapshot, setSnapshot] = useState<PromptSnapshot | null>(null), [feature, setFeature] = useState<PromptFeature>('overview');
  const [text, setText] = useState(DEFAULT_PROMPTS.overview), [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState<string | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const drafts = useRef<Partial<Record<PromptFeature, string>>>({}), operation = useRef(false), pending = useRef(''), mounted = useRef(true);
  const ask = <T,>(params: Record<string, unknown>) => requestSW<T>('AI_PROMPT_SETTINGS', params);
  useEffect(() => {
    mounted.current = true;
    void ask<PromptSnapshot>({ mode: 'get' }).then(value => { if (mounted.current) { setSnapshot(value); setText(promptText(value, 'overview')); } })
      .catch(() => { if (mounted.current) setNotice('读取失败，请重新读取；仍可先保留草稿。'); });
    return () => { mounted.current = false; if (pending.current) void ask({ mode: 'cancel', requestId: pending.current }).catch(() => {}); };
  }, []);
  async function run(action: () => Promise<void>) {
    if (operation.current) return; operation.current = true; setBusy(true); setNotice('');
    try { await action(); }
    catch (error) { if (mounted.current) setNotice(error instanceof Error && /^[\u4e00-\u9fff]/.test(error.message) ? error.message : '操作未完成，草稿仍保留。'); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function apply(mode: 'save' | 'reset' | 'undo', value = text) {
    if (!snapshot) return;
    const next = await ask<PromptSnapshot>({ mode, feature, text: value, revision: snapshot.revision, configRevision: snapshot.configRevision });
    if (!mounted.current) return;
    setSnapshot(next); setText(promptText(next, feature)); drafts.current[feature] = promptText(next, feature); setPreview(null); setNotice('已应用');
  }
  return <section className="settings-panel prompt-settings" aria-label="提示词配置">
    <header><h2>提示词</h2><select aria-label="提示词功能" disabled={busy} value={feature} onChange={event => {
      drafts.current[feature] = text; const next = event.currentTarget.value as PromptFeature; setFeature(next);
      setText(drafts.current[next] ?? (snapshot ? promptText(snapshot, next) : DEFAULT_PROMPTS[next])); setPreview(null); setNotice('');
    }}>{PROMPT_FEATURES.map(value => <option value={value} key={value}>{PROMPT_LABELS[value]}</option>)}</select></header>
    <label>当前配置<textarea aria-label="当前提示词" rows={6} maxLength={4000} value={text} disabled={busy} onInput={event => { setText(event.currentTarget.value); setPreview(null); }} /></label>
    <div className="prompt-actions">
      <button className="settings-action settings-action-primary" disabled={busy || !snapshot || !text.trim()} onClick={() => void run(() => apply('save'))}><Save size={16} />保存</button>
      <button className="settings-action" disabled={busy || snapshot?.previous[feature] === undefined} title="撤销上次应用" onClick={() => void run(() => apply('undo'))}><Undo2 size={16} />撤销</button>
      <button className="settings-action" disabled={busy || !snapshot} onClick={() => void run(() => apply('reset'))}><RotateCcw size={16} />恢复默认</button>
      <button className="settings-action" disabled={busy} title="读取最新配置，保留当前草稿" onClick={() => void run(async () => { setSnapshot(await ask({ mode: 'get' })); setNotice('已读取最新配置，当前编辑内容保留。'); })}><RefreshCw size={16} />重新读取</button>
    </div>
    <label>让 AI 改写<input aria-label="提示词改写要求" placeholder="例如：先用初学者能理解的语言解释，再给一个例子" value={instruction} maxLength={2000} disabled={busy} onInput={event => setInstruction(event.currentTarget.value)} /></label>
    <div className="prompt-actions"><button className="settings-action" disabled={busy || !snapshot || !instruction.trim() || !text.trim()} onClick={() => void run(async () => {
      const requestId = crypto.randomUUID(); pending.current = requestId;
      try { const result = await ask<{ text: string }>({ mode: 'rewrite', feature, text, instruction, requestId, revision: snapshot!.revision, configRevision: snapshot!.configRevision }); if (mounted.current) setPreview(result.text); }
      finally { pending.current = ''; }
    })}><WandSparkles size={16} />生成预览</button>{busy && pending.current && <button className="settings-action" onClick={() => { void ask({ mode: 'cancel', requestId: pending.current }); }}><X size={16} />停止</button>}</div>
    {preview !== null && <div className="prompt-preview"><div className="prompt-comparison"><section><h3>应用前</h3><pre>{text}</pre></section><section><h3>建议内容</h3><pre>{preview}</pre></section></div>
      <div className="prompt-actions"><button className="settings-action settings-action-primary" disabled={busy} onClick={() => void run(() => apply('save', preview))}><Check size={16} />应用改写</button><button className="settings-action" disabled={busy} onClick={() => setPreview(null)}><X size={16} />放弃</button></div></div>}
    {notice && <p role="status">{notice}</p>}
    <small>来源、权限和输出格式规则始终保留。改写只发送当前提示词与要求，不发送知识库内容。</small>
  </section>;
}
