import type { BiliAnalyticsDB } from './db.ts';
import { emptyMemory, memoryAssert, memoryBytes, validateMemoryDraft, MEMORY_MAX_ITEMS, MEMORY_MAX_SELECTED, MEMORY_MAX_BYTES,
  type MemoryDraft, type MemoryOperation, type MemoryState } from '../../shared/explicit-memory.ts';

export class ExplicitMemoryRepository {
  private database: BiliAnalyticsDB;
  constructor(database: BiliAnalyticsDB) { this.database = database; }
  async read(): Promise<MemoryState> { return (await this.database.explicitMemory.get('state')) ?? emptyMemory(); }
  async save(revision: number, draft: MemoryDraft): Promise<MemoryState> {
    const input = validateMemoryDraft(draft); const db = this.database;
    return db.transaction('rw', db.explicitMemory, db.currentVideoQaSessions, async () => {
      const state = await this.read(); this.assertRevision(state, revision);
      const old = input.id ? state.items.find(item => item.id === input.id) : undefined;
      memoryAssert(!input.id || old, 'MEMORY_STALE');
      const originSessionId = old ? old.originSessionId : input.originSessionId ?? null;
      if (!old && originSessionId) memoryAssert(await db.currentVideoQaSessions.where({ sessionId: originSessionId }).count(), 'MEMORY_SESSION_GONE');
      const now = Date.now();
      const next = { id: old?.id ?? crypto.randomUUID(), kind: input.kind, text: input.text, selected: input.selected,
        originSessionId, createdAt: old?.createdAt ?? now, updatedAt: now };
      state.items = [...state.items.filter(item => item.id !== next.id), next];
      memoryAssert(state.items.length <= MEMORY_MAX_ITEMS && state.items.filter(item => item.selected).length <= MEMORY_MAX_SELECTED && memoryBytes(state) <= MEMORY_MAX_BYTES, 'MEMORY_CAPACITY');
      return this.commit(state);
    });
  }
  async remove(revision: number, id: string) {
    return this.database.transaction('rw', this.database.explicitMemory, async () => {
      const state = await this.read(); this.assertRevision(state, revision);
      memoryAssert(state.items.some(item => item.id === id), 'MEMORY_STALE');
      state.items = state.items.filter(item => item.id !== id); return this.commit(state);
    });
  }
  async clear(revision?: number) {
    return this.database.transaction('rw', this.database.explicitMemory, async () => {
      const state = await this.read(); if (revision !== undefined) this.assertRevision(state, revision);
      state.items = []; return this.commit(state);
    });
  }
  // Called by session deletion inside its existing transaction, so neither side can survive alone.
  async removeSessionInTransaction(sessionId: string) {
    const state = await this.read(); state.items = state.items.filter(item => item.originSessionId !== sessionId);
    return this.commit(state);
  }
  async operate(input: MemoryOperation): Promise<MemoryState> {
    memoryAssert(input && typeof input === 'object');
    if (input.op === 'read') return this.read();
    if (input.op === 'save') return this.save(input.revision, input.draft);
    if (input.op === 'remove') return this.remove(input.revision, input.id);
    if (input.op === 'clear') { this.assertRevision(await this.read(), input.revision); return this.clear(input.revision); }
    throw Error('MEMORY_INVALID');
  }
  private assertRevision(state: MemoryState, revision: number) { memoryAssert(Number.isSafeInteger(revision) && state.revision === revision, 'MEMORY_STALE'); }
  private async commit(state: MemoryState) { state.revision++; await this.database.explicitMemory.put(state); return state; }
}
