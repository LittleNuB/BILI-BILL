import { useEffect, useRef, useState } from 'preact/hooks';
import { FileText, Plus, RefreshCw, Unlink } from 'lucide-preact';
import { KnowledgeDialog } from './KnowledgeDialog.tsx';
import { knowledgeRepository as repo } from './runtime.ts';
import { addReadonlyReferences, refreshReadonlyReferences, removeReadonlyReference } from '../../../src/background/storage/open-knowledge-references.ts';
import { pickReadonlyMarkdown, type KnowledgeReadonlyReference } from '../../../src/shared/open-knowledge/references.ts';
import { knowledgeError } from '../../../src/shared/open-knowledge/workspace.ts';

export function ReadonlyReferences({ query = '', manage = false }: { query?: string; manage?: boolean }) {
  const [rows, setRows] = useState<KnowledgeReadonlyReference[]>([]), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<KnowledgeReadonlyReference | null>(null), lock = useRef(false);
  async function refresh(request = false) {
    const next = await refreshReadonlyReferences(repo, request); setRows(next);
    const linked = new URLSearchParams(location.search).get('knowledgeReference');
    if (manage && linked) setSelected(next.find(row => row.id === linked && row.available) ?? null);
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(knowledgeError(error)); } finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { const update = () => void run(() => refresh()); update(); window.addEventListener('focus', update); return () => window.removeEventListener('focus', update); }, []);
  const search = query.trim().toLocaleLowerCase(), visible = rows.filter(row => manage || row.available && search && `${row.name}\n${row.text}`.toLocaleLowerCase().includes(search));
  if (!manage && !visible.length) return null;
  return <section className="knowledge-readonly" aria-label="只读 Markdown 资料">
    <div className="knowledge-section-title"><h2>外部 Markdown</h2>{manage && <div className="knowledge-actions">
      <button className="knowledge-button" disabled={busy} onClick={() => { const selection = pickReadonlyMarkdown(); void run(async () => { await addReadonlyReferences(repo, await selection); await refresh(); }); }}><Plus size={16} />接入文件</button>
      <button className="bb-icon-action" title="刷新只读资料" aria-label="刷新只读资料" disabled={busy} onClick={() => void run(() => refresh(true))}><RefreshCw size={17} /></button></div>}</div>
    {manage && <p className="knowledge-muted">只检索和引用，不改写原文件。</p>}
    {!rows.length && manage && <p className="knowledge-muted">尚未选择文件</p>}
    <div className="knowledge-reference-list">{visible.map(row => <div key={row.id}><FileText size={18} /><button className="knowledge-text-button" disabled={!row.available} onClick={() => setSelected(row)}>{row.name}</button>
      <span>{row.available ? '只读' : '待重新授权'}</span>{manage && <button className="bb-icon-action" title={`移除 ${row.name} 的引用`} aria-label={`移除 ${row.name} 的引用`} disabled={busy} onClick={() => void run(async () => { await removeReadonlyReference(repo, row.id); await refresh(); })}><Unlink size={16} /></button>}</div>)}</div>
    {notice && <p role="status">{notice}</p>}
    {selected && <KnowledgeDialog title={selected.name} close={() => setSelected(null)}><p>外部只读资料</p><pre className="knowledge-source-preview">{selected.text}</pre></KnowledgeDialog>}
  </section>;
}
