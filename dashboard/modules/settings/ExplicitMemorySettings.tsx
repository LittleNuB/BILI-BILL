import { useEffect, useState } from 'preact/hooks';
import { requestSW } from '../../utils/messaging';
import { memoryGrant, memoryError, type MemoryState, type MemoryDraft, type MemoryOperation } from '../../../src/shared/explicit-memory.ts';
import { learningIconPaths } from '../../../src/shared/learning-icons.ts';
import './explicit-memory.css';

function Icon({ name }: { name: keyof typeof learningIconPaths }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{learningIconPaths[name].map(d => <path d={d} />)}</svg>;
}
const initialDraft = (): MemoryDraft => ({ kind: 'preference', text: '', selected: false });
export function ExplicitMemorySettings() {
  const [state, setState] = useState<MemoryState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<MemoryDraft | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const op = (input: MemoryOperation) => requestSW<MemoryState>('MEMORY_OPERATION', input);
  async function refresh() {
    setBusy(true);
    try { setState(await op({ op: 'read' })); }
    catch (error) { setNotice(memoryError(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let live = true; let changed = false;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.memoryAiAuthorization) { changed = true; setEnabled(memoryGrant(changes.memoryAiAuthorization.newValue) !== null); }
    };
    chrome.storage.onChanged.addListener(listener);
    void chrome.storage.local.get('memoryAiAuthorization').then(value => { if (live && !changed) setEnabled(memoryGrant(value.memoryAiAuthorization) !== null); }).catch(() => { if (live) setNotice('记忆授权状态暂不可读取。'); });
    void refresh();
    return () => { live = false; chrome.storage.onChanged.removeListener(listener); };
  }, []);
  useEffect(() => {
    const guard = (event: Event) => { if (draft) event.preventDefault(); };
    const unload = (event: BeforeUnloadEvent) => { if (draft) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('bb-before-navigate', guard); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('bb-before-navigate', guard); window.removeEventListener('beforeunload', unload); };
  }, [draft]);
  async function toggle(value: boolean) {
    if (value && !window.confirm('主动提问时，选中的目标和偏好会发送到你配置的 AI 服务。开启本身不发送内容。是否开启？')) return;
    setBusy(true); setNotice('');
    try {
      await chrome.storage.local.set({ memoryAiAuthorization: { enabled: value, generation: crypto.randomUUID() } });
      setEnabled(memoryGrant((await chrome.storage.local.get('memoryAiAuthorization')).memoryAiAuthorization) !== null);
    } catch { setNotice('授权设置未保存，请重试。'); }
    finally { setBusy(false); }
  }
  async function mutate(input: MemoryOperation, closeDraft = false) {
    setBusy(true); setNotice('');
    try { setState(await op(input)); if (closeDraft) setDraft(null); setNotice('已保存。'); }
    catch (error) { setNotice(memoryError(error)); }
    finally { setBusy(false); }
  }
  const start = (value: MemoryDraft) => { setDraft(value); setDraftRevision(state!.revision); setNotice(''); };
  return <section className="explicit-memory" id="explicit-memory" aria-labelledby="explicit-memory-title">
    <div className="memory-heading"><h3 id="explicit-memory-title">目标与偏好</h3>
      <button type="button" title="刷新记忆" aria-label="刷新记忆" className="memory-icon" disabled={busy} onClick={() => { void refresh(); }}><Icon name="refresh" /></button>
    </div>
    <label className={`settings-toggle ${enabled ? 'is-on' : 'is-off'}`}>
      <input type="checkbox" checked={enabled} disabled={busy} onChange={event => { void toggle(event.currentTarget.checked); }} />
      <span className="settings-toggle-control" aria-hidden="true" />
      <span className="settings-toggle-copy"><strong>在对话中使用选中记忆</strong><small>只在主动提问时发送。关闭后不再带入相关旧讨论，本地记录保留；已发送内容无法收回。</small></span>
    </label>
    <p className="memory-meta">{state ? `${state.items.length} / 32 项 · 已选 ${state.items.filter(item => item.selected).length} / 6 项` : '正在读取记忆'}</p>
    <ul className="memory-list">{state?.items.map(item => <li key={item.id}>
      <input type="checkbox" aria-label={`选用：${item.text}`} checked={item.selected} disabled={busy || !!draft} onChange={event => { void mutate({ op: 'save', revision: state.revision, draft: { ...item, selected: event.currentTarget.checked } }); }} />
      <div className="memory-copy"><span>{item.kind === 'goal' ? '学习目标' : '回答偏好'}</span><p>{item.text}</p></div>
      <button type="button" className="memory-icon" title="编辑记忆" aria-label="编辑记忆" disabled={busy || !!draft} onClick={() => start({ ...item })}><Icon name="note" /></button>
      <button type="button" className="memory-icon" title="删除记忆" aria-label="删除记忆" disabled={busy || !!draft} onClick={() => { if (window.confirm('删除这条记忆？后续提问不再使用相关旧讨论，本地聊天仍保留。')) void mutate({ op: 'remove', revision: state.revision, id: item.id }); }}><Icon name="trash" /></button>
    </li>)}</ul>
    {state && !state.items.length && <p className="memory-meta">尚未保存目标或偏好。</p>}
    {draft ? <form className="memory-form" onSubmit={event => { event.preventDefault(); void mutate({ op: 'save', revision: draftRevision, draft }, true); }}>
      <label>类型<select value={draft.kind} disabled={busy} onChange={event => setDraft({ ...draft, kind: event.currentTarget.value as MemoryDraft['kind'] })}><option value="preference">回答偏好</option><option value="goal">学习目标</option></select></label>
      <label>记忆内容<textarea value={draft.text} maxLength={512} required disabled={busy} onInput={event => setDraft({ ...draft, text: event.currentTarget.value })} /></label>
      <label className="memory-choice"><input type="checkbox" checked={draft.selected} disabled={busy} onChange={event => setDraft({ ...draft, selected: event.currentTarget.checked })} />选用于后续对话</label>
      <p className="memory-meta">最多 512 字节，约 170 个汉字。不要保存密码、密钥或登录信息。</p>
      <div className="memory-actions"><button type="submit" disabled={busy}>确认记住</button><button type="button" disabled={busy} onClick={() => { if (window.confirm('放弃当前记忆草稿？')) { setDraft(null); setNotice(''); } }}>取消</button></div>
    </form> : <div className="memory-actions"><button type="button" disabled={busy || !state || state.items.length >= 32} onClick={() => start(initialDraft())}>添加目标或偏好</button>
      <button type="button" disabled={busy || !state?.items.length} onClick={() => { if (state && window.confirm('清空全部记忆？本地聊天与学习笔记保留。')) void mutate({ op: 'clear', revision: state.revision }); }}>清空记忆</button></div>}
    {notice && <p role="status">{notice}{notice.includes('刷新后') && draft && <button type="button" disabled={busy} onClick={async () => { const latest = await op({ op: 'read' }).catch(() => null); if (latest) { setState(latest); setDraftRevision(latest.revision); setNotice('已刷新，请核对内容后重新确认。'); } }}>刷新并保留草稿</button>}</p>}
    <details><summary>保存与删除范围</summary><p>记忆独立保存在本机，不随学习笔记、视频 Wiki 或聊天备份导出。第一版不支持记忆导入与导出。删除聊天默认保留记忆；可在删除时一并删除关联记忆。普通聊天不会自动建立用户画像。</p></details>
  </section>;
}
