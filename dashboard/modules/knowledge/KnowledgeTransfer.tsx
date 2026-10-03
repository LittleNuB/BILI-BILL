import { useRef, useState } from 'preact/hooks';
import { Archive, Download, Upload, Check } from 'lucide-preact';
import { KnowledgeDialog } from './KnowledgeDialog.tsx';
import { knowledgeRepository as repo } from './runtime.ts';
import { applyKnowledgeRestore, exportKnowledgeBackup, previewKnowledgeRestore } from '../../../src/background/storage/open-knowledge-backup.ts';
import { KNOWLEDGE_BACKUP_MAX_BYTES } from '../../../src/shared/open-knowledge/backup.ts';
import { knowledgeError } from '../../../src/shared/open-knowledge/workspace.ts';

export function KnowledgeTransfer({ disabled, changed }: { disabled: boolean; changed(): Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewKnowledgeRestore>> | null>(null);
  const input = useRef<HTMLInputElement>(null), locked = useRef(false);
  async function run(action: () => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(knowledgeError(error)); }
    finally { locked.current = false; setBusy(false); }
  }
  return <><button className="bb-icon-action" title="知识库备份与恢复" aria-label="知识库备份与恢复" disabled={disabled} onClick={() => setOpen(true)}><Archive size={18} /></button>
    {open && <KnowledgeDialog title="知识库备份与恢复" close={() => { if (!locked.current) { setOpen(false); setPreview(null); } }}>
      <p>备份已保存的页面、图片、原始资料和版本历史。不包含未保存草稿、目录权限、外部只读文件或模型配置。</p>
      <div className="knowledge-actions"><button className="knowledge-button" disabled={busy} onClick={() => void run(async () => {
        const text = await exportKnowledgeBackup(repo), url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `bili-bill-knowledge-${new Date().toISOString().slice(0, 10)}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000); setNotice('备份已准备下载。');
      })}><Download size={16} />导出备份</button>
        <button className="knowledge-button" disabled={busy} onClick={() => input.current?.click()}><Upload size={16} />选择备份</button></div>
      <input ref={input} type="file" accept=".json,application/json" hidden aria-label="选择知识库备份文件" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; setPreview(null);
        if (file) void run(async () => { if (file.size > KNOWLEDGE_BACKUP_MAX_BYTES) throw Error('knowledge_capacity'); setPreview(await previewKnowledgeRestore(repo, await file.text())); });
      }} />
      {preview && <section className="knowledge-restore-preview"><h3>恢复预览</h3><p>{preview.pages} 个页面 · {preview.images} 张图片 · {preview.sources} 份原始资料 · {preview.versions} 个版本</p>
        <p>新增 {preview.added} 份文件，保留已有内容。恢复后共有 {preview.conflicts} 个待合并分支，不会用备份覆盖当前版本。</p>
        <button className="knowledge-button is-primary" disabled={busy} onClick={() => void run(async () => { await applyKnowledgeRestore(repo, preview); setPreview(null); setNotice('已恢复到本地，目录连接后继续写入。'); await changed(); })}><Check size={16} />确认恢复</button>
      </section>}
      {(notice || busy) && <p role="status">{busy ? '正在处理，请保留此窗口。' : notice}</p>}
    </KnowledgeDialog>}
  </>;
}
