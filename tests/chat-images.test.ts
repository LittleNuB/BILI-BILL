import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { imageAttachment } from '../src/shared/open-knowledge/sources.ts';
import { videoPageId } from '../src/shared/open-knowledge/format.ts';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { askLearningChat } from '../src/background/learning-chat.ts';
import { prepareChatImages } from '../src/background/chat-images.ts';
import { getCurrentVideoQaSessionsView } from '../src/background/storage/current-video-qa-session-repo.ts';
const originalFetch = globalThis.fetch;
test('image requests are explicit, use actual bytes and vision model, persist refs, support followups, and fail honestly', async () => {
  db.close(); await db.delete(); await db.open();
  const listeners = new Set<Function>();
  const storage: Record<string, any> = { userConfig: { ...structuredClone(DEFAULT_CONFIG), ai: { baseURL: 'https://example.invalid', apiKey: 'synthetic', chatModel: 'text-only' },
    assistant: { ...DEFAULT_CONFIG.assistant, currentVideoAiAssistantEnabled: true } } };
  globalThis.chrome = { storage: { local: { get: async () => structuredClone(storage), set: async values => { Object.assign(storage, values); } }, onChanged: { addListener: (fn: Function) => listeners.add(fn), removeListener: (fn: Function) => listeners.delete(fn) } } } as any;
  try {
    const repo = new KnowledgeRepository(db), image = await imageAttachment(Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfoAAAAASUVORK5CYII=', 'base64')));
    const page = await repo.save({ pageId: videoPageId('BV1234567890'), kind: 'video', bvid: 'BV1234567890', title: '合成图文', body: '测试', aiNotes: '', topics: [], legacyIds: [], sourceIds: [], attachmentIds: [image.id], createdAt: 1 }, [], { attachments: [image] });
    const refs = [{ pageId: page.pageId, id: image.id, videoKey: 'BV1234567890:42:1' }];
    assert.equal((await prepareChatImages(refs, refs[0].videoKey)).images.length, 1);
    const payloads: any[] = [];
    globalThis.fetch = async (_url, options) => { payloads.push(JSON.parse(String(options?.body))); return new Response(JSON.stringify({ choices: [{ message: { content: '画面观察：合成图片。' } }] })); };
    const input = { requestId: 'a', turnId: 'a', sessionId: 'image-chat', question: '说明这张图', tabId: 1, imageReferences: refs,
      resolveSource: async () => ({ source: null, text: '', videoKey: refs[0].videoKey, stillCurrent: async () => true }) };
    const blocked = await askLearningChat(input); assert.equal(payloads.length, 0); assert.match(blocked.message, /未发送图片/);
    storage.learningVisionModel = { enabled: true, model: 'synthetic-vision' };
    const first = await askLearningChat(input); assert.equal(first.ai.status, 'generated');
    assert.equal(payloads[0].model, 'synthetic-vision'); assert.ok(payloads[0].messages.at(-1).content[1].image_url.url.startsWith('data:image/png;base64,'));
    assert.deepEqual((await getCurrentVideoQaSessionsView('image-chat')).activeSession?.turns[0].imageReferences, refs);
    await askLearningChat({ ...input, requestId: 'b', turnId: 'b', imageReferences: undefined, question: '再解释一下' });
    assert.ok(payloads[1].messages.at(-1).content[1].image_url.url);
    await askLearningChat({ ...input, requestId: 'c', turnId: 'c', imageReferences: [] });
    assert.equal(typeof payloads[2].messages.at(-1).content, 'string'); assert.equal(payloads[2].model, 'text-only');
    globalThis.fetch = async () => new Response('{}', { status: 400 });
    const refused = await askLearningChat({ ...input, requestId: 'd', turnId: 'd' });
    assert.equal(refused.answer, ''); assert.match(refused.message, /未接受图片/);
    let start!: () => void; const ready = new Promise<void>(resolve => { start = resolve; });
    globalThis.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) {
      options?.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))); start();
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const pending = askLearningChat({ ...input, requestId: 'e', turnId: 'e' }); await ready;
    storage.learningVisionModel.enabled = false;
    for (const fn of listeners) fn({ learningVisionModel: { newValue: storage.learningVisionModel } }, 'local');
    assert.equal((await pending).status, 'cancelled'); assert.equal(listeners.size, 0);
  } finally { globalThis.fetch = originalFetch; db.close(); await db.delete(); }
});
