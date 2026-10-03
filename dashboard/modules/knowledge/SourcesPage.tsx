import { useEffect, useRef, useState } from 'preact/hooks';
import { FolderClosed, Download, RefreshCw, Square, ArrowUpRight, Video } from 'lucide-preact';
import { fetchFavoriteFolders, fetchFavoriteItems } from '../../../src/background/api/favorites.ts';
import type { FavoriteFolder } from '../../../src/shared/types/favorite.ts';
import { importFavoriteItems, favoriteSourceFolder, knowledgeError, listKnowledge, type KnowledgeEntry } from '../../../src/shared/open-knowledge/workspace.ts';
import { knowledgeRepository as repo, syncKnowledge } from './runtime.ts';
import './knowledge.css';
import { ReadonlyReferences } from './ReadonlyReferences.tsx';

export function SourcesPage() {
  const [folders, setFolders] = useState<FavoriteFolder[]>([]), [selected, setSelected] = useState<number[]>([]);
  const [items, setItems] = useState<(KnowledgeEntry & { folders: string[] })[]>([]);
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  async function refresh() {
    const result = [];
    for (const entry of await listKnowledge(repo, { includeMetadata: true })) {
      const names = [];
      for (const id of entry.head.sourceIds) { const source = await repo.readSource(id); if (favoriteSourceFolder(source)) names.push(source.label); }
      if (names.length) result.push({ ...entry, folders: names });
    }
    setItems(result);
  }
  useEffect(() => { void refresh().catch(error => setError(knowledgeError(error))); return () => controller.current?.abort(); }, []);
  async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current; setBusy(label); setError(''); setNotice('');
    try { await action(current.signal); }
    catch (error) { setError(knowledgeError(error)); }
    finally { controller.current = null; setBusy(''); await refresh().catch(error => setError(knowledgeError(error))); }
  }
  async function importSelected(signal: AbortSignal) {
    let count = 0, unchanged = 0, incomplete = 0;
    for (const folder of folders.filter(row => selected.includes(row.mediaId))) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      setBusy(`读取 ${folder.title}`);
      const data = await fetchFavoriteItems(folder, signal, 50);
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const result = await importFavoriteItems(repo, folder, data.items, signal);
      count += result.imported; unchanged += result.unchanged;
      if (data.diagnostic.completenessState !== 'complete') incomplete++;
      setNotice(`已新增或更新 ${count} 条资料，${unchanged} 条未变化。`);
    }
    setNotice(`已新增或更新 ${count} 条资料，${unchanged} 条未变化。${incomplete ? `${incomplete} 个收藏夹未完整读取，已有笔记均保留。` : ''}`);
    try { await syncKnowledge(); } catch { setNotice(previous => `${previous} 已存本地，目录恢复后继续写入。`); }
  }
  function openPage(id: string) {
    const url = new URL(location.href); url.searchParams.set('knowledgePage', id); url.hash = 'video-wiki';
    history.replaceState(null, '', url); window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
  return <div className="knowledge-workspace">
    <div className="knowledge-toolbar"><FolderClosed size={22} /><h2 className="knowledge-sources-title">B站收藏夹</h2><span className="knowledge-sync">{items.length} 条本地资料</span>
      <button className="knowledge-button" disabled={!!busy} onClick={() => void run('读取收藏夹', async signal => { const values = await fetchFavoriteFolders(signal); setFolders(values); setSelected(previous => previous.filter(id => values.some(folder => folder.mediaId === id))); })}><RefreshCw size={17} />读取收藏夹</button>
      {!!busy && <button className="knowledge-button" onClick={() => controller.current?.abort()}><Square size={14} />停止</button>}
    </div>
    {error && <p role="alert" className="knowledge-alert is-error">{error}</p>}{notice && <p role="status" className="knowledge-alert">{notice}</p>}
    {!!folders.length && <section className="knowledge-import" aria-label="选择收藏夹">
      <div className="knowledge-section-title"><h3>选择本次导入的收藏夹</h3><button className="knowledge-button is-primary" disabled={!selected.length || !!busy} onClick={() => void run('导入中', importSelected)}><Download size={16} />导入所选</button></div>
      <div className="knowledge-folder-grid">{folders.map(folder => <label key={folder.mediaId}><input type="checkbox" disabled={!!busy} checked={selected.includes(folder.mediaId)} onChange={event => setSelected(previous => event.currentTarget.checked ? [...previous, folder.mediaId] : previous.filter(id => id !== folder.mediaId))} /><FolderClosed size={20} /><span>{folder.title}</span><small>{folder.mediaCount} 条</small></label>)}</div>
    </section>}
    <section className="knowledge-library" aria-label="已导入资料"><div className="knowledge-section-title"><h2>已导入资料</h2><span>{busy || '手动导入'}</span></div>
      {!items.length ? <div className="knowledge-empty"><FolderClosed size={32} /><h3>尚未接入收藏夹</h3></div> :
        <div className="knowledge-source-list">{items.map(item => <button key={item.head.pageId} onClick={() => openPage(item.head.pageId)}><Video size={20} /><span><strong>{item.head.title}</strong><small>{item.folders.join(' · ')}</small></span><em>{item.metadataOnly ? '仅收藏资料' : '已有笔记'}</em><ArrowUpRight size={16} /></button>)}</div>}
    </section>
    <ReadonlyReferences manage />
  </div>;
}
