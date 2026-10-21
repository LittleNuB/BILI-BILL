import { useRef, useState } from 'preact/hooks';
import { FolderOpen, RefreshCw } from 'lucide-preact';
import { KnowledgeDialog } from './KnowledgeDialog.tsx';
import { knowledgeRepository as repo } from './runtime.ts';
import { BrowserKnowledgeFiles, pickRecoveryDirectory, type KnowledgeDirectoryHandle } from '../../../src/shared/open-knowledge/browser-files.ts';
import { KnowledgeDirectory } from '../../../src/shared/open-knowledge/directory.ts';
import { previewDirectoryRecovery, applyDirectoryRecovery, validateDirectoryRecovery } from '../../../src/background/storage/open-knowledge-recovery.ts';
import { knowledgeError } from '../../../src/shared/open-knowledge/workspace.ts';

export function KnowledgeDirectoryRecovery({ close, recovered }: { close(): void; recovered(): Promise<void> }) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewDirectoryRecovery>> | null>(null);
  const [paused, setPaused] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const locked = useRef(false);
  const originalHandle = useRef<KnowledgeDirectoryHandle | null>(null);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setNotice('');
    try { await action(); }
    catch (error) { setPreview(null); setPaused(false); setNotice(knowledgeError(error)); }
    finally { locked.current = false; setBusy(false); }
  }
  return <KnowledgeDialog title="恢复到新目录" close={() => { if (!locked.current) close(); }}>
    <p>原目录保持不变。浏览器记录与目录中的有效修改会一起保留。</p>
    <button className="knowledge-button" disabled={busy} onClick={() => void run(async () => {
      setPreview(null); setPaused(false);
      const state = await repo.state();
      if (!state.handle) throw new Error('knowledge_not_connected');
      const files = new BrowserKnowledgeFiles(state.handle);
      if (!await files.permission(true)) throw new Error('knowledge_permission');
      setPreview(await previewDirectoryRecovery(repo, new KnowledgeDirectory(files), state)); originalHandle.current = state.handle;
    })}><RefreshCw size={16} />检查恢复内容</button>
    {preview && <section className="knowledge-restore-preview"><h3>恢复预览</h3>
      <p>{preview.pages} 个页面 · {preview.images} 张图片 · {preview.sources} 份资料 · {preview.versions} 个版本</p>
      <p>补全 {preview.incompleteFiles} 个未写完的文件，保留 {preview.conflicts} 个待合并分支。</p>
      <label><input type="checkbox" checked={paused} disabled={busy} onChange={event => setPaused(event.currentTarget.checked)} />我已暂停其他窗口和 Agent 的目录写入</label>
      <div className="knowledge-actions"><button className="knowledge-button is-primary" disabled={busy || !paused} onClick={() => void run(async () => {
        if (!originalHandle.current) throw new Error('knowledge_recovery_preview');
        const handle = await pickRecoveryDirectory(originalHandle.current, () => validateDirectoryRecovery(repo, preview));
        await applyDirectoryRecovery(repo, preview, new KnowledgeDirectory(new BrowserKnowledgeFiles(handle)), handle);
        setPreview(null); await recovered(); close();
      })}><FolderOpen size={16} />选择新目录并恢复</button></div>
    </section>}
    {(busy || notice) && <p role="status">{busy ? '正在检查或写入，请保留此窗口。' : notice}</p>}
  </KnowledgeDialog>;
}
