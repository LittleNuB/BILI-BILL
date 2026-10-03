import { createRevision, digest, exact, hashId, ids, jsonBytes, pageId, requireKnowledge, shortText,
  validatePage, type KnowledgePage } from './format.ts';

export interface KnowledgeProposal {
  format: 1;
  id: string;
  libraryId: string;
  pageId: string;
  base: string[];
  next: KnowledgePage;
  kind: 'create' | 'edit' | 'restore' | 'ai';
  restoreId: string | null;
  reason: string;
  createdAt: number;
}
export async function createProposal(input: Omit<KnowledgeProposal, 'format' | 'id'>): Promise<KnowledgeProposal> {
  const { id: _id, format: _format, parents: _parents, updatedAt: _time, actor: _actor, proposalId: _proposal, ...page } =
    await createRevision(input.next, input.base, 'codex', input.createdAt);
  const payload = { ...input, next: page, base: [...input.base].sort(), format: 1 as const };
  const proposal = { ...payload, id: await digest(jsonBytes(payload)) };
  await validateProposal(proposal); return proposal;
}
export async function validateProposal(input: unknown): Promise<void> {
  exact(input, ['format', 'id', 'libraryId', 'pageId', 'base', 'next', 'kind', 'restoreId', 'reason', 'createdAt']);
  const row = input as unknown as KnowledgeProposal;
  requireKnowledge(row.format === 1 && /^[a-f0-9-]{36}$/.test(row.libraryId), 'proposal');
  hashId(row.id); pageId(row.pageId); ids(row.base, 32); validatePage(row.next);
  requireKnowledge(row.pageId === row.next.pageId && ['create', 'edit', 'restore', 'ai'].includes(row.kind), 'proposal');
  requireKnowledge((row.kind === 'create') === (row.base.length === 0), 'proposal');
  requireKnowledge((row.kind === 'restore') === (row.restoreId !== null), 'proposal');
  if (row.restoreId) hashId(row.restoreId);
  shortText(row.reason, 4096); requireKnowledge(row.reason.trim(), 'proposal');
  requireKnowledge(Number.isSafeInteger(row.createdAt) && row.createdAt >= row.next.createdAt, 'date');
  requireKnowledge(jsonBytes(row).length <= 2 * 1024 * 1024, 'capacity');
  const { id, ...payload } = row; requireKnowledge(id === await digest(jsonBytes(payload)), 'integrity');
}
