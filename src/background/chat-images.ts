import type { ChatImageReference } from '../shared/chat-images.ts';
import { hashId, pageId, requireKnowledge } from '../shared/open-knowledge/format.ts';
import { imageDataUrl } from '../shared/open-knowledge/images.ts';
import { KnowledgeRepository } from './storage/open-knowledge-repo.ts';
import { db } from './storage/db.ts';
export async function prepareChatImages(input: unknown, videoKey?: string) {
  requireKnowledge(Array.isArray(input) && input.length <= 4, 'image_reference');
  if (!input.length) return { refs: [] as ChatImageReference[], images: [] as string[], check: async () => {} };
  const repo = new KnowledgeRepository(db), epoch = (await repo.state()).epoch;
  const belongs = async (pageId: string, imageId: string) => {
    const [bvid, cid, part] = (videoKey ?? '').split(':');
    const page = await repo.readPage(pageId);
    for (const head of page.heads) if (!head.archived && head.bvid === bvid && head.attachmentIds.includes(imageId)) {
      for (const id of head.sourceIds) {
        const source = await repo.readSource(id);
        if (source.version?.startsWith('capture:') && source.video?.bvid === bvid && source.video.cid === cid
          && source.video.page === Number(part) && source.text.includes(`../../attachments/${imageId}.`)) return true;
      }
    }
    return false;
  };
  const refs: ChatImageReference[] = [], images: string[] = [];
  let bytes = 0;
  for (const item of input) {
    requireKnowledge(item && item.videoKey === videoKey, 'image_reference');
    hashId(item.id); pageId(item.pageId);
    requireKnowledge(await belongs(item.pageId, item.id), 'image_reference');
    const image = await repo.readAttachment(item.id); bytes += image.bytes.length;
    requireKnowledge(bytes <= 16 * 1024 * 1024, 'image_size');
    refs.push({ id: item.id, pageId: item.pageId, videoKey: item.videoKey }); images.push(imageDataUrl(image));
  }
  return { refs, images, check: async () => {
    requireKnowledge((await repo.state()).epoch === epoch, 'stale_operation');
    for (const ref of refs) requireKnowledge(await belongs(ref.pageId, ref.id), 'image_reference');
  } };
}
