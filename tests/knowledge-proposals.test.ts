import assert from 'node:assert/strict';
import test from 'node:test';
import { personalPage } from '../src/shared/open-knowledge/workspace.ts';
import { createProposal, validateProposal } from '../src/shared/open-knowledge/proposals.ts';

test('knowledge proposals bind library, base, content and reason to immutable identities', async () => {
  const next = personalPage('合成实践页', 1);
  const proposal = await createProposal({ libraryId: crypto.randomUUID(), pageId: next.pageId, base: [], next,
    kind: 'create', restoreId: null, reason: '新建实践记录', createdAt: 2 });
  await validateProposal(proposal);
  await assert.rejects(validateProposal({ ...proposal, next: { ...proposal.next, body: '未经展示的修改' } }), /integrity/);
  await assert.rejects(validateProposal({ ...proposal, libraryId: crypto.randomUUID() }), /integrity/);
  await assert.rejects(validateProposal({ ...proposal, approved: true }), /format/);
  await assert.rejects(createProposal({ ...proposal, kind: 'restore', restoreId: null }), /proposal/);
});
