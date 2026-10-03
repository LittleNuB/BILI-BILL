import { IMAGE_MAX_BYTES, requireKnowledge } from './format.ts';
import { imageAttachment, type KnowledgeAttachment } from './sources.ts';

export function imageDataUrl(image: KnowledgeAttachment): string {
  let binary = '';
  for (let offset = 0; offset < image.bytes.length; offset += 16384) binary += String.fromCharCode(...image.bytes.subarray(offset, offset + 16384));
  return `data:image/${image.extension === 'jpg' ? 'jpeg' : image.extension};base64,${btoa(binary)}`;
}
export async function normalizedImage(value: unknown): Promise<KnowledgeAttachment> {
  requireKnowledge(typeof value === 'string' && value.length <= Math.ceil(IMAGE_MAX_BYTES * 4 / 3) + 128, 'image_size');
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  requireKnowledge(match, 'image_type');
  const bytes = Uint8Array.from(atob(match[1]), char => char.charCodeAt(0));
  await imageAttachment(bytes);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    requireKnowledge(bitmap.width > 0 && bitmap.height > 0 && bitmap.width * bitmap.height <= 24_000_000, 'image_dimensions');
    const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.94 });
    return imageAttachment(new Uint8Array(await blob.arrayBuffer()));
  } finally { bitmap.close(); }
}
