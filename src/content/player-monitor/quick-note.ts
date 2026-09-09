import { newLearningId, learningTime, type LearningAsset, type LearningPrepared, type LearningSourceRequest } from '../../shared/learning.ts';

export interface ComposerQuote { text: string; timeMs: number; source: LearningSourceRequest }
export interface QuickNote {
  text: string; timeMs: number | null; quote: ComposerQuote | null;
  prepared?: LearningPrepared; pending?: LearningAsset; busy: boolean; status: string;
}
type Request = <T>(action: 'LEARNING_PREPARE' | 'LEARNING_PREPARE_SOURCE' | 'LEARNING_SAVE', params: Record<string, unknown>) => Promise<T>;

// Keep uncertain writes byte-identical for idempotent retry; never silently evict an unsaved note.
export class QuickNotes {
  private rows = new Map<string, QuickNote>();
  get(key: string): QuickNote | undefined { return this.rows.get(key); }
  begin(key: string, timeMs: number | null, quote: ComposerQuote | null): QuickNote {
    const prior = this.rows.get(key);
    if (prior) {
      if (prior.timeMs === null && timeMs !== null && !prior.quote && !prior.pending && !prior.busy) { prior.timeMs = timeMs; prior.status = ''; }
      return prior;
    }
    if (this.rows.size >= 16) throw Error('草稿已满，请先保存已有笔记。');
    const note: QuickNote = { text: '', timeMs: quote?.timeMs ?? timeMs, quote, busy: false, status: '' };
    this.rows.set(key, note); return note;
  }
  async save(key: string, request: Request): Promise<void> {
    const note = this.rows.get(key);
    if (!note || note.busy) return;
    if (!note.quote && note.timeMs === null) { note.status = '未能读取时间点，请等待播放器就绪后重试。'; return; }
    note.busy = true; note.status = '保存中…';
    try {
      if (!note.prepared) note.prepared = await request<LearningPrepared>(note.quote ? 'LEARNING_PREPARE_SOURCE' : 'LEARNING_PREPARE',
        note.quote ? { source: note.quote.source } : { kind: 'bookmark', positionMs: note.timeMs });
      const prepared = note.prepared;
      if (key !== `${prepared.capture.video.bvid}:${prepared.capture.part?.cid}:${prepared.capture.part?.page}`) throw Error('视频已变化，笔记仍保留在原视频。');
      if (!note.pending) {
        const now = Date.now();
        note.pending = { id: newLearningId(), kind: note.quote ? 'excerpt' : 'bookmark', createdAt: now, updatedAt: now,
          video: prepared.capture.video, part: prepared.capture.part,
          personal: { title: note.text.trim().slice(0, 48) || `${learningTime(note.timeMs ?? 0)} 的笔记`, note: note.text, tags: [] },
          snapshot: prepared.snapshot ?? null, bookmarkMs: prepared.capture.bookmarkMs, importedFrom: null };
      }
      await request('LEARNING_SAVE', { epoch: prepared.epoch, token: prepared.capture.token, asset: note.pending });
      this.rows.delete(key); note.status = '已保存';
    } catch (error) {
      note.status = error instanceof Error ? error.message : '保存结果待确认，请重试。';
      // Expired capture can be renewed with the original timestamp/selection, not the current playback time.
      if (note.status.includes('已变化')) note.prepared = undefined;
    } finally { note.busy = false; }
  }
}
