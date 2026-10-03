import type { KnowledgeDirectoryHandle } from './browser-files.ts';
export interface KnowledgeLocalFile { path: string; bytes: Uint8Array; pending: 0 | 1; sequence: number }
export interface KnowledgeLocalMeta {
  key: 'state';
  epoch: number;
  sequence: number;
  connectionRevision?: number;
  libraryId: string | null;
  handle: KnowledgeDirectoryHandle | null;
  migration: string | null;
}
export interface KnowledgeDraft { id: string; body: string; updatedAt: number }
export const initialKnowledgeMeta = (): KnowledgeLocalMeta => ({ key: 'state', epoch: 0, sequence: 0, libraryId: null, handle: null, migration: null });
