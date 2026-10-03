import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FileText, Video, Search, Plus, FolderOpen, RefreshCw, Pencil, History, Archive, X, Save, RotateCcw, ExternalLink, GitMerge, Upload, Image as ImageIcon } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { knowledgeRepository as repo, connectKnowledge, syncKnowledge } from './runtime.ts';
import { knowledgeError, listKnowledge, personalPage, restoreKnowledge, favoriteSourceFolder, type KnowledgeEntry } from '../../../src/shared/open-knowledge/workspace.ts';
import { digest, textBytes, type KnowledgePage as Page, type KnowledgeRevision } from '../../../src/shared/open-knowledge/format.ts';
import { createSource, type KnowledgeSource } from '../../../src/shared/open-knowledge/sources.ts';
import { renderKnowledgeMarkdown, safeKnowledgeLink } from '../../../src/shared/open-knowledge/markdown.ts';
import './knowledge.css';

type Edit = { page: Page; parents: string[]; epoch: number; draftId: string; topicsText?: string };
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const stamp = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
function sourceText(source: KnowledgeSource): string {
  if (favoriteSourceFolder(source)) {
    try { const data = JSON.parse(source.text); return `${data.video.title}\nUP 主：${data.video.authorName}\n收藏夹：${data.folder.title}`; } catch { return '收藏信息暂不可读。'; }
  }
  if (source.label === '迁移前的主题与关联' && source.capturedAt === 0) {
    try { const data = JSON.parse(source.text); return `主题：${data.topics.map((topic: { name: string }) => topic.name).join('、') || '无'}\n已保留 ${data.relations.length} 条主题关联。`; } catch { return '原有主题记录已保留。'; }
  }
  return source.text;
}
function Markdown({ text, openLink }: { text: string; openLink(link: string): void }) {
  const html = useMemo(() => renderKnowledgeMarkdown(text), [text]);
  return <div className="knowledge-prose" dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
    const anchor = (event.target as Element).closest('a[data-knowledge-link]');
    if (anchor) { event.preventDefault(); const link = anchor.getAttribute('data-knowledge-link'); if (link) openLink(link); }
  }} />;
}
function Modal({ title, close, children }: { title: string; close(): void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="knowledge-dialog" onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>{title}</h2><button className="bb-icon-action" title="关闭" aria-label="关闭" onClick={close}><X size={18} /></button></header>{children}
  </dialog>;
}
function ImagePreview({ id }: { id: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true, objectUrl = '';
    void repo.readAttachment(id).then(image => {
      if (!active) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: `image/${image.extension === 'jpg' ? 'jpeg' : image.extension}` })); setUrl(objectUrl);
    }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return url ? <img src={url} alt="已保存的学习图片" loading="lazy" /> : <span className="knowledge-image-missing"><ImageIcon size={20} />图片暂不可用</span>;
}
export function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]), [selectedId, setSelectedId] = useState('');
  const [searchResults, setSearchResults] = useState<KnowledgeEntry[]>([]);
  const [revisions, setRevisions] = useState<KnowledgeRevision[]>([]), [heads, setHeads] = useState<KnowledgeRevision[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]), [query, setQuery] = useState(''), [topic, setTopic] = useState('');
  const [archived, setArchived] = useState(false), [allSources, setAllSources] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('加载中');
  const [pending, setPending] = useState(0), [connected, setConnected] = useState(false), [writable, setWritable] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null), [historyOpen, setHistoryOpen] = useState(false), [restore, setRestore] = useState<KnowledgeRevision | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false), [previewSource, setPreviewSource] = useState<KnowledgeSource | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [externalLink, setExternalLink] = useState('');
  const operation = useRef(false), draftWrites = useRef(Promise.resolve()), editRef = useRef(edit), loadId = useRef(0);
  const draftFailure = useRef<unknown>(null);
  const selectedRef = useRef(selectedId), fileInput = useRef<HTMLInputElement>(null), mounted = useRef(true);
  editRef.current = edit; selectedRef.current = selectedId;
  const current = heads[0];
  const topics = useMemo(() => [...new Set(entries.flatMap(entry => entry.head.topics))].sort(), [entries]);
  const visible = useMemo(() => (query.trim() ? searchResults : entries).filter(entry => (allSources || !entry.metadataOnly)
    && (!topic || entry.head.topics.includes(topic))), [entries, searchResults, allSources, topic, query]);
  useEffect(() => {
    let active = true; setSearchResults([]);
    const timer = setTimeout(() => {
      if (query.trim()) void listKnowledge(repo, { query, includeMetadata: true, archived }).then(rows => { if (active) setSearchResults(rows); }).catch(error => { if (active) setError(knowledgeError(error)); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [query, entries, archived]);
  async function refresh() {
    const ticket = ++loadId.current;
    const rows = await listKnowledge(repo, { includeMetadata: true, archived });
    const status = await repo.status();
    if (ticket !== loadId.current || !mounted.current) return;
    setEntries(rows); setPending(status.pending); setConnected(status.hasHandle);
    const id = selectedRef.current || new URLSearchParams(location.search).get('knowledgePage') || '';
    if (id) await select(id, false);
  }
  async function run(label: string, action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (error) { if (mounted.current) setError(knowledgeError(error)); }
    finally { operation.current = false; if (mounted.current) setBusy(''); }
  }
  async function synchronize(request = false) {
    try { setWritable(await syncKnowledge(request)); }
    catch (error) { setWritable(false); setError(knowledgeError(error)); }
    await refresh();
  }
  async function select(id: string, restoreDraft = true) {
    if (editRef.current && editRef.current.page.pageId !== id) { setNotice('请先保存或关闭当前编辑。'); return; }
    const state = await repo.readPage(id), collected: KnowledgeSource[] = [];
    for (const sourceId of [...new Set(state.heads.flatMap(row => row.sourceIds))]) collected.push(await repo.readSource(sourceId));
    if (!mounted.current) return;
    setSelectedId(id); selectedRef.current = id; setRevisions(state.revisions); setHeads(state.heads); setSources(collected);
    if (restoreDraft && !editRef.current) {
      const drafts = await repo.database.okDrafts.where('id').startsWith(`edit:${id}:`).toArray();
      const latest = drafts.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) { try { const draft = JSON.parse(latest.body) as Edit; if (draft.page.pageId === id && Array.isArray(draft.parents)) { setEdit(draft); setNotice('已恢复未完成的草稿。'); } } catch { setError('草稿无法读取，已保留原始记录。'); } }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void run('加载中', async () => { try { await repo.migrateLegacy(); } catch (error) { setError(knowledgeError(error)); } await refresh(); await synchronize(); });
    const focus = () => { if (!editRef.current) void run('同步中', () => synchronize()); };
    const navigate = (event: Event) => { if (editRef.current) { event.preventDefault(); setNotice('请先保存或关闭当前编辑，草稿会保留。'); } };
    const unload = (event: BeforeUnloadEvent) => { if (editRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const timer = setInterval(focus, 30000);
    window.addEventListener('focus', focus); window.addEventListener('bb-before-navigate', navigate); window.addEventListener('beforeunload', unload);
    return () => { mounted.current = false; loadId.current++; clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('bb-before-navigate', navigate); window.removeEventListener('beforeunload', unload); };
  }, [archived]);
  async function beginEdit(merge = false) {
    if (!current) return;
    const state = await repo.state();
    const page = merge ? { ...current, body: heads.map((row, i) => `## 版本 ${i + 1}\n\n${row.body}`).join('\n\n'),
      aiNotes: heads.map(row => row.aiNotes).filter(Boolean).join('\n\n'), sourceIds: [...new Set(heads.flatMap(row => row.sourceIds))],
      attachmentIds: [...new Set(heads.flatMap(row => row.attachmentIds))], topics: [...new Set(heads.flatMap(row => row.topics))], legacyIds: [...new Set(heads.flatMap(row => row.legacyIds))] } : current;
    const draft = { page, parents: heads.map(row => row.id), epoch: state.epoch, draftId: `edit:${current.pageId}:${crypto.randomUUID()}` };
    draftFailure.current = null; setEdit(draft); editRef.current = draft; queueDraft(draft);
  }
  function queueDraft(draft: Edit) {
    draftWrites.current = draftWrites.current.then(async () => { await repo.saveDraft(draft.draftId, JSON.stringify(draft), draft.epoch); draftFailure.current = null; }).catch(error => { draftFailure.current = error; setError(knowledgeError(error)); });
  }
  function changePage(change: Partial<Page>) {
    if (!edit) return; const next = { ...edit, page: { ...edit.page, ...change } }; setEdit(next); editRef.current = next; queueDraft(next);
  }
  async function saveEdit() {
    if (!edit) return;
    await draftWrites.current;
    const topics = edit.topicsText === undefined ? edit.page.topics : [...new Set(edit.topicsText.split(/[,，]/).map(value => value.trim()).filter(Boolean))];
    const row = await repo.save({ ...edit.page, topics }, edit.parents);
    await repo.database.okDrafts.delete(edit.draftId);
    setEdit(null); editRef.current = null;
    setNotice('已保存到本地。'); await select(row.pageId, false); await refresh();
    try { setWritable(await syncKnowledge()); } catch { setWritable(false); setNotice('已保存到本地，目录恢复后继续写入。'); }
    setPending((await repo.status()).pending);
  }
  async function closeEditor(closePage = false) {
    await draftWrites.current;
    if (draftFailure.current) throw draftFailure.current;
    setEdit(null); editRef.current = null;
    if (closePage) { setHeads([]); setSelectedId(''); selectedRef.current = ''; }
  }
  async function importMarkdown(file: File) {
    if (!/\.md$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error('knowledge_capacity');
    const text = await file.text(), version = `markdown:${await digest(textBytes(text))}`;
    const source = await createSource({ kind: 'external', video: null, label: file.name, language: null, version,
      capturedAt: Date.now(), text, segments: [], derivedFrom: null, legacyAsset: null });
    const page = personalPage(file.name.replace(/\.md$/i, ''));
    await repo.save({ ...page, sourceIds: [source.id] }, [], { sources: [source] }); await select(page.pageId); await refresh();
  }
  function openLink(link: string) {
    if (!safeKnowledgeLink(link)) return;
    const sourceId = /^\.\.\/\.\.\/sources\/([a-f0-9]{64})\.json$/.exec(link)?.[1];
    if (sourceId) { const source = sources.find(row => row.id === sourceId); if (source) setPreviewSource(source); }
    else setExternalLink(link);
  }
  return <div className="knowledge-workspace">
    <div className="knowledge-toolbar">
      <label className="knowledge-search"><Search size={18} /><input aria-label="搜索知识库" placeholder="搜索页面与笔记" value={query} onInput={event => setQuery(event.currentTarget.value)} /></label>
      <button className="knowledge-sync knowledge-text-button" onClick={() => setStorageOpen(true)}>{pending ? `已存本地 · ${pending} 项待写入` : connected && writable ? '目录已同步' : connected ? '本地可用 · 目录待连接' : '本地保存'}</button>
      <button className="knowledge-button" disabled={!!busy} onClick={() => void run('连接中', async () => { await connectKnowledge(); setWritable(true); await refresh(); })}><FolderOpen size={17} />{connected ? '重新连接' : '连接目录'}</button>
      <button className="bb-icon-action" title="刷新知识库" aria-label="刷新知识库" disabled={!!busy} onClick={() => void run('同步中', () => synchronize(true))}><RefreshCw size={18} /></button>
      <button className="knowledge-button is-primary" disabled={!!busy || !!edit} onClick={() => void run('新建中', async () => { const page = personalPage(); await repo.save(page, []); await select(page.pageId); await refresh(); })}><Plus size={17} />新建页面</button>
    </div>
    <div className="knowledge-filters">
      <select aria-label="主题筛选" value={topic} onChange={event => setTopic(event.currentTarget.value)}><option value="">全部主题</option>{topics.map(value => <option key={value} value={value}>{value}</option>)}</select>
      <label><input type="checkbox" checked={allSources} onChange={event => setAllSources(event.currentTarget.checked)} />包含仅收藏资料</label>
      <label><input type="checkbox" checked={archived} disabled={!!edit || !!busy} onChange={event => { setSelectedId(''); selectedRef.current = ''; setHeads([]); setArchived(event.currentTarget.checked); }} />已归档</label>
      <button className="knowledge-text-button" disabled={!!busy || !!edit} onClick={() => fileInput.current?.click()}><Upload size={16} />导入 Markdown 副本</button>
      <input ref={fileInput} type="file" accept=".md,text/markdown" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void run('读取中', () => importMarkdown(file)); }} />
    </div>
    {error && <p className="knowledge-alert is-error" role="alert">{error}</p>}{notice && <p className="knowledge-alert" role="status">{notice}</p>}
    <div className={`knowledge-layout ${current ? 'has-selection' : ''}`}>
      <section className="knowledge-library" aria-label="知识页面">
        <div className="knowledge-section-title"><h2>{archived ? '已归档' : topic || '全部页面'}</h2><span>{visible.length} 个页面</span></div>
        {busy === '加载中' ? <p className="knowledge-empty">正在读取本地页面…</p> : !visible.length ? <div className="knowledge-empty"><FileText size={32} /><h3>{query ? '没有匹配的页面' : '还没有知识页面'}</h3><button className="knowledge-button" onClick={() => { location.hash = 'smart-favorites'; }}>查看资料来源</button></div> :
          <div className="knowledge-grid">{visible.map(entry => <button className={`knowledge-card ${selectedId === entry.head.pageId ? 'is-selected' : ''}`} key={entry.head.pageId}
            onClick={() => void run('读取中', () => select(entry.head.pageId))}>
            <div className="knowledge-card-kind">{entry.head.kind === 'video' ? <Video size={20} /> : <FileText size={20} />}<span>{entry.metadataOnly ? '仅收藏资料' : entry.head.kind === 'video' ? '视频笔记' : '个人页面'}</span>{entry.conflicts > 0 && <strong>待合并</strong>}</div>
            {entry.head.attachmentIds[0] && <div className="knowledge-cover"><ImagePreview id={entry.head.attachmentIds[0]} /></div>}
            <h3>{entry.head.title}</h3><p>{entry.excerpt || '暂无笔记'}</p><footer>{entry.head.topics.slice(0, 2).map(value => <span key={value}>{value}</span>)}<time>{time(entry.head.updatedAt)}</time></footer>
          </button>)}</div>}
      </section>
      {current && <section className="knowledge-detail" aria-label="页面详情">
        <header><span>{current.kind === 'video' ? '视频页面' : '个人页面'}</span><div className="knowledge-actions">
          <button className="bb-icon-action" title="版本历史" aria-label="版本历史" disabled={!!edit} onClick={() => setHistoryOpen(true)}><History size={18} /></button>
          <button className="bb-icon-action" title={current.archived ? '取消归档' : '归档页面'} aria-label={current.archived ? '取消归档' : '归档页面'} disabled={!!edit || heads.length > 1} onClick={() => setArchiveOpen(true)}><Archive size={18} /></button>
          <button className="bb-icon-action" title="关闭页面" aria-label="关闭页面" disabled={!!busy} onClick={() => void run('保存草稿', () => closeEditor(true))}><X size={18} /></button></div></header>
        {heads.length > 1 && <div className="knowledge-alert"><p>检测到 {heads.length} 个并发版本，双方内容均已保留。</p><button className="knowledge-button" disabled={!!edit} onClick={() => void beginEdit(true)}><GitMerge size={16} />查看并合并</button></div>}
        {edit ? <form className="knowledge-editor" onSubmit={event => { event.preventDefault(); void run('保存中', saveEdit); }}>
          <input aria-label="页面标题" value={edit.page.title} maxLength={1000} onInput={event => changePage({ title: event.currentTarget.value })} required />
          <label>正文<textarea aria-label="页面正文" value={edit.page.body} onInput={event => changePage({ body: event.currentTarget.value })} /></label>
          <label>主题<input aria-label="页面主题" value={edit.topicsText ?? edit.page.topics.join('，')} onInput={event => { const next = { ...edit, topicsText: event.currentTarget.value }; setEdit(next); editRef.current = next; queueDraft(next); }} /></label>
          <label>AI 补充<textarea aria-label="AI补充" value={edit.page.aiNotes} onInput={event => changePage({ aiNotes: event.currentTarget.value })} /></label>
          <div className="knowledge-actions"><button className="knowledge-button is-primary" type="submit" disabled={!!busy}><Save size={16} />保存</button><button type="button" className="knowledge-button" disabled={!!busy} onClick={() => void run('保存草稿', () => closeEditor())}>关闭编辑</button></div>
        </form> : <>
          <h2>{current.title}</h2><div className="knowledge-detail-meta"><time>{time(current.updatedAt)}</time><button className="knowledge-text-button" disabled={heads.length > 1 || !!busy} onClick={() => void beginEdit()}><Pencil size={16} />编辑</button></div>
          {current.body && <Markdown text={current.body} openLink={openLink} />}
          {!current.body && !current.attachmentIds.length && <p className="knowledge-muted">暂无笔记</p>}
          {current.attachmentIds.map(id => <div className="knowledge-attachment" key={id}><ImagePreview id={id} /></div>)}
          {!!current.aiNotes && <section className="knowledge-ai"><h3>AI 补充</h3><Markdown text={current.aiNotes} openLink={openLink} /></section>}
          {!!sources.length && <section className="knowledge-sources"><h3>原始资料</h3>{sources.map(source => <details key={source.id}>
            <summary>{source.label}{source.video?.page ? ` · P${source.video.page}` : ''}{favoriteSourceFolder(source) ? ' · 收藏信息' : ''}</summary>
            <pre>{sourceText(source)}</pre>{source.video && <button className="knowledge-text-button" onClick={() => setPreviewSource(source)}><ExternalLink size={15} />预览来源视频</button>}
          </details>)}</section>}
        </>}
      </section>}
    </div>
    {historyOpen && <Modal title="版本历史" close={() => { setHistoryOpen(false); setRestore(null); }}>
      <div className="knowledge-history">{[...revisions].sort((a, b) => b.updatedAt - a.updatedAt).map(row => <button key={row.id} className="knowledge-history-row" onClick={() => setRestore(row)}><time>{time(row.updatedAt)}</time><span>{({ browser: '浏览器', codex: 'Codex', migration: '旧资料迁入', restore: '历史恢复' })[row.actor]}</span>{heads.some(head => head.id === row.id) && <strong>当前版本</strong>}</button>)}</div>
      {restore && <><div className="knowledge-diff"><section><h3>当前内容</h3><pre>{current?.body}</pre></section><section><h3>选中版本</h3><pre>{restore.body}</pre><h3>AI 补充</h3><pre>{restore.aiNotes}</pre></section></div>
        <button className="knowledge-button" disabled={!!busy} onClick={() => void run('恢复中', async () => { await restoreKnowledge(repo, restore, heads.map(row => row.id)); setHistoryOpen(false); setRestore(null); await refresh(); })}><RotateCcw size={16} />恢复为新版本</button></>}
    </Modal>}
    {archiveOpen && current && <Modal title={current.archived ? '取消归档' : '归档页面'} close={() => setArchiveOpen(false)}><p>{current.title}</p><p>正文、原始资料和版本历史都会保留。</p><button className="knowledge-button is-primary" disabled={!!busy} onClick={() => void run('保存中', async () => { await repo.save({ ...current, archived: !current.archived }, heads.map(row => row.id)); setArchiveOpen(false); setHeads([]); setSelectedId(''); selectedRef.current = ''; await refresh(); })}>确认</button></Modal>}
    {storageOpen && <Modal title="本地目录" close={() => setStorageOpen(false)}><p>{connected ? 'Bili-Bill · 已连接' : '尚未连接目录'}</p><p>{pending} 项待写入目录</p><div className="knowledge-actions"><button className="knowledge-button" disabled={!!busy} onClick={() => void run('连接中', async () => { await connectKnowledge(); setWritable(true); await refresh(); })}><FolderOpen size={16} />连接目录</button>{connected && <button className="knowledge-button" disabled={!!busy || !!edit} onClick={() => void run('断开中', async () => { await repo.disconnect(); setConnected(false); setWritable(false); await refresh(); })}>断开连接</button>}</div></Modal>}
    {previewSource && <Modal title="来源预览" close={() => setPreviewSource(null)}><h3>{previewSource.video?.title ?? previewSource.label}</h3><p>{previewSource.label}{previewSource.video?.page ? ` · P${previewSource.video.page}` : ''}</p>
      <pre className="knowledge-source-preview">{sourceText(previewSource)}</pre>
      {!!previewSource.segments.length && <p>{stamp(previewSource.segments[0].fromMs)} 起的原始字幕，共 {previewSource.segments.length} 条</p>}
      {previewSource.video && <a className="knowledge-button" href={`https://www.bilibili.com/video/${previewSource.video.bvid}/?p=${previewSource.video.page ?? 1}`} target="_blank" rel="noopener noreferrer" onClick={() => setPreviewSource(null)}>确认打开来源视频</a>}
    </Modal>}
    {externalLink && <Modal title="链接预览" close={() => setExternalLink('')}><p>{externalLink}</p><a className="knowledge-button" href={externalLink} target="_blank" rel="noopener noreferrer" onClick={() => setExternalLink('')}>确认在新标签页打开</a></Modal>}
  </div>;
}
