import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { personalPage } from '../src/shared/open-knowledge/workspace.ts';
import { createRevision, videoPageId } from '../src/shared/open-knowledge/format.ts';
import { createSource } from '../src/shared/open-knowledge/sources.ts';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import { MemoryKnowledgeFiles } from './helpers/knowledge-files.ts';
import { retrieveOpenKnowledge, handleKnowledgeReference } from '../src/background/open-knowledge-chat.ts';
import { prepareKnowledge } from '../src/background/knowledge-chat.ts';
import { serializedBytes } from '../src/shared/learning-chat-context.ts';

test.beforeEach(async () => { db.close(); await db.delete(); await db.open(); });
test.afterEach(async () => { db.close(); await db.delete(); });
test('browser retrieves Codex-updated pages and source snippets, excludes metadata/archives and detects stale citations', async () => {
  const repo = new KnowledgeRepository(db), remote = new KnowledgeDirectory(new MemoryKnowledgeFiles());
  const first = await repo.save({ ...personalPage('接口实践'), body: '稳定交付需要限制变更。' }, []);
  await repo.connect(remote); await repo.sync(remote);
  const updated = await createRevision({ ...first, body: '稳定交付之后，Codex 实践得到新结论。项目独有词。' }, [first.id], 'codex');
  await remote.append(updated); await repo.sync(remote);
  let found = await retrieveOpenKnowledge('稳定交付'); assert.match(found.refs[0].excerpt, /项目独有词/);
  assert.equal(found.refs[0].location?.kind, 'page'); assert.equal(found.refs[0].digest, updated.id);
  const source = await createSource({ kind: 'subtitles', video: { bvid: 'BV1234567890', title: '合成讲解', cid: '9', page: 2 },
    label: 'B站字幕', language: 'zh', version: 'one', capturedAt: 1, text: '契约测试需要核对版本边界。',
    segments: [{ fromMs: 100, toMs: 2000, text: '契约测试需要核对版本边界。' }], derivedFrom: null, legacyAsset: null });
  await repo.save({ ...personalPage(), kind: 'video', bvid: 'BV1234567890', pageId: videoPageId('BV1234567890'), body: '已经记下内容', sourceIds: [source.id] }, [], { sources: [source] });
  found = await retrieveOpenKnowledge('契约测试'); assert.equal(found.refs[0].page, 2); assert.match(found.refs[0].excerpt, /版本边界/);
  assert.ok(serializedBytes(found.refs) <= 8192);
  await repo.save({ ...updated, archived: true }, [updated.id]);
  assert.deepEqual((await retrieveOpenKnowledge('稳定交付')).refs, []);
  assert.equal((await handleKnowledgeReference({ kind: 'page', pageId: first.pageId, revisionId: updated.id, digest: updated.id })).data?.available, false);
});
test('a directory update invalidates dependent history and aborts an active knowledge request', async () => {
  const repo = new KnowledgeRepository(db), row = await repo.save({ ...personalPage(), body: '上下文管理要控制相关片段。' }, []);
  const listeners = new Set<Function>();
  globalThis.chrome = { storage: { local: { get: async () => ({ knowledgeAiAuthorization: { enabled: true, generation: 'grant' } }) },
    onChanged: { addListener: (f: Function) => listeners.add(f), removeListener: (f: Function) => listeners.delete(f) } } } as any;
  const controller = new AbortController(), prepared = await prepareKnowledge('上下文管理', null, controller);
  try {
    assert.equal(prepared.refs.length, 1); assert.match(prepared.stamp!, /open/);
    await repo.save({ ...row, body: '上下文管理的新实践' }, [row.id]);
    await assert.rejects(prepared.check(), /CHAT_CANCELLED/); assert.equal(controller.signal.aborted, true);
  } finally { prepared.dispose(); }
  assert.equal(listeners.size, 0);
});
