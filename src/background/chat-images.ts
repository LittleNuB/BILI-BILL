import type { ChatImageReference } from '../shared/chat-images.ts';
import { hashId, pageId, requireKnowledge } from '../shared/open-knowledge/format.ts';
import { imageDataUrl } from '../shared/open-knowledge/images.ts';
import { KnowledgeRepository } from './storage/open-knowledge-repo.ts';
import { db } from './storage/db.ts';
export async function prepareChatImages(input: unknown, videoKey?: string) {
  requireKnowledge(Array.isArray(input) && input.length <= 4, 'image_reference');
  if (!input.length) return { refs: [] as ChatImageReference[], images: [] as string[], check: async () => {} };
  const repo = new KnowledgeRepository(db), epoch = (await repo.state()).epoch;
  const refs: ChatImageReference[] = [], images: string[] = [];
  let bytes = 0;
  for (const item of input) {
    requireKnowledge(item && item.videoKey === videoKey, 'image_reference');
    hashId(item.id); pageId(item.pageId);
    const page = await repo.readPage(item.pageId);
    requireKnowledge(page.heads.some(row => !row.archived && row.attachmentIds.includes(item.id)), 'image_reference');
    requireKnowledge(page.heads.some(row => row.bvid === videoKey?.split(':')[0]), 'image_reference');
    const image = await repo.readAttachment(item.id); bytes += image.bytes.length;
    requireKnowledge(bytes <= 16 * 1024 * 1024, 'image_size');
    refs.push({ id: item.id, pageId: item.pageId, videoKey: item.videoKey }); images.push(imageDataUrl(image));
  }
  return { refs, images, check: async () => {
    requireKnowledge((await repo.state()).epoch === epoch, 'stale_operation');
    for (const ref of refs) requireKnowledge((await repo.readPage(ref.pageId)).heads.some(row => !row.archived && row.attachmentIds.includes(ref.id)), 'image_reference');
  } };
}
