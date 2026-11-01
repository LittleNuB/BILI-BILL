import type { ComposerQuote } from './quick-note.ts';
import type { NoteAnchor, NoteReceipt, CapturedNote } from '../../shared/open-knowledge/captures.ts';
type RemoteNote = Omit<CapturedNote, 'images' | 'quote'> & { quote: string; images: { id: string; data: string }[];
  captions: { overlapping: { text: string }[]; nearby: { text: string; fromMs: number }[] } };
export interface OpenQuickNote {
  id: string; text: string; timeMs: number | null; quote: ComposerQuote | null; anchor: NoteAnchor;
  busy: boolean; status: string; pending: boolean; prepared?: never;
  remote?: RemoteNote; image?: string; selected?: string; queue?: Promise<void>; epoch?: number;
}
type Request = <T>(params: Record<string, unknown>) => Promise<T>;
export class OpenQuickNotes {
  private rows = new Map<string, OpenQuickNote>();
  private loading = new Map<string, Promise<void>>();
  private isolatedCaptures = new Set<string>();
  private request: Request;
  private anchor: () => NoteAnchor | null;
  private changed: () => void;
  constructor(request: Request, anchor: () => NoteAnchor | null, changed: () => void) { this.request = request; this.anchor = anchor; this.changed = changed; }
  get(key: string) { return this.rows.get(key); }
  begin(key: string, timeMs: number | null, quote: ComposerQuote | null): OpenQuickNote {
    const prior = this.rows.get(key); if (prior) return prior;
    const anchor = this.anchor(); if (!anchor) throw Error('请等待视频就绪后再记录。');
    if (this.rows.size >= 32) throw Error('草稿已满，请先保存已有记录。');
    const row: OpenQuickNote = { id: crypto.randomUUID(), anchor: { ...anchor, timeMs: quote?.timeMs ?? timeMs },
      timeMs: quote?.timeMs ?? timeMs, text: '', quote, busy: false, pending: false, status: '正在保留草稿…' };
    this.rows.set(key, row); this.persist(key); return row;
  }
  private fromRemote(remote: RemoteNote): OpenQuickNote {
    return { id: remote.id, text: remote.text, timeMs: remote.anchor.timeMs, quote: null, anchor: remote.anchor,
      busy: false, pending: false, status: remote.savedRevision ? '图片/记录已保存，文字可继续补充。' : '草稿已恢复', remote, epoch: remote.epoch };
  }
  async restore(key: string): Promise<void> {
    if (!key || this.rows.has(key) || this.isolatedCaptures.has(key)) return;
    if (this.loading.has(key)) return this.loading.get(key);
    const pending = this.request<RemoteNote | null>({ mode: 'load', key }).then(row => {
      if (row && !this.rows.has(key)) { this.rows.set(key, this.fromRemote(row)); this.changed(); }
    }).catch(() => {}).finally(() => this.loading.delete(key));
    this.loading.set(key, pending); return pending;
  }
  async select(key: string, id: string): Promise<void> {
    await this.flush(key);
    const row = await this.request<RemoteNote | null>({ mode: 'get', id });
    if (row?.key === key) { this.rows.set(key, this.fromRemote(row)); this.changed(); }
  }
  list(key: string) { return this.request<{ id: string; timeMs: number | null; saved: boolean; text: string }[]>({ mode: 'list', key }); }
  persist(key: string): void {
    const row = this.rows.get(key); if (!row) return;
    this.persistRow(row);
  }
  private persistRow(row: OpenQuickNote): void {
    row.queue = (row.queue ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (row.epoch === undefined) row.epoch = await this.request<number>({ mode: 'epoch' });
      if (!row.remote) row.remote = await this.request<RemoteNote>({ mode: 'begin', id: row.id, epoch: row.epoch,
        anchor: row.anchor, selectedSourceIdentityKey: row.selected, quote: row.quote?.source, image: row.image });
      if (row.remote.text !== row.text) row.remote = await this.request<RemoteNote>({ mode: 'edit', id: row.id,
        epoch: row.epoch, version: row.remote.version, text: row.text });
      row.status = row.remote.savedRevision ? '已保存，补充文字后可再次保存。' : '草稿已保留';
    });
    void row.queue.catch(error => { row.status = error instanceof Error ? error.message : '草稿尚未写入，请重试。'; this.changed(); });
  }
  async flush(key: string): Promise<void> { this.persist(key); await this.rows.get(key)?.queue; }
  async save(key: string, _unused?: unknown, keep = false): Promise<void> {
    const row = this.rows.get(key); if (!row || row.busy) return;
    await this.saveRow(key, row, keep);
  }
  private async saveRow(key: string, row: OpenQuickNote, keep: boolean): Promise<void> {
    row.busy = true; row.status = '保存中…';
    try {
      this.persistRow(row); await row.queue; row.pending = true;
      const receipt = await this.request<NoteReceipt>({ mode: 'save', id: row.id, epoch: row.epoch, version: row.remote!.version });
      row.remote!.savedRevision = receipt.revision;
      row.status = receipt.status === 'directory' ? '已保存并写入目录' : '已保存到浏览器，等待写入目录';
      if (!keep) {
        await this.request({ mode: 'finish', id: row.id, epoch: row.epoch, version: row.remote!.version });
        if (this.rows.get(key) === row) this.rows.delete(key);
      }
      row.pending = false;
    } catch (error) { row.status = error instanceof Error ? error.message : '保存未完成，草稿仍保留。'; }
    finally { row.busy = false; }
  }
  async image(key: string, anchor: NoteAnchor, data: string, selected?: string, preserveDraft = false): Promise<OpenQuickNote> {
    if (preserveDraft) await this.restore(key);
    await this.flush(key);
    const row: OpenQuickNote = { id: crypto.randomUUID(), anchor, timeMs: anchor.timeMs, text: '', quote: null,
      busy: false, pending: false, status: '正在保存图片…', image: data, selected };
    // Chat captures own their saved image without replacing the active note draft.
    if (preserveDraft) this.isolatedCaptures.add(key); else this.rows.set(key, row);
    try {
      this.changed();
      // Saved chat pictures live in the knowledge page; finish only their temporary editor.
      await this.saveRow(key, row, !preserveDraft); return row;
    } finally { this.isolatedCaptures.delete(key); this.changed(); }
  }
}
