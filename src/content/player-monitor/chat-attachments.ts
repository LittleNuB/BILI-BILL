import type { ChatImageReference } from '../../shared/chat-images.ts';
import { quickIcon } from './quick-capture.ts';
import { showImagePreview } from './image-preview.ts';

export function chatAttachments(refs: ChatImageReference[], load: () => Promise<string[]>, remove?: (id: string) => void): HTMLElement {
  const row = document.createElement('div'); row.className = 'bdc-chat-attachments';
  row.setAttribute('role', 'group'); row.setAttribute('aria-label', remove ? '待发送图片' : '已发送图片');
  const pictures: HTMLImageElement[] = [], previews: HTMLButtonElement[] = [];
  let images: string[] = [];
  for (const [index, ref] of refs.entries()) {
    const tile = document.createElement('div'); tile.className = 'bdc-chat-attachment';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'bdc-chat-attachment-preview';
    open.title = `查看${remove ? '待发' : '已发送'}图片 ${index + 1}`; open.setAttribute('aria-label', open.title);
    const image = document.createElement('img'); image.alt = `图片 ${index + 1}`; pictures.push(image); previews.push(open);
    open.append(image); open.disabled = true;
    open.onclick = () => showImagePreview([images[index]], open); tile.append(open);
    if (remove) {
      const close = document.createElement('button'); close.type = 'button'; close.className = 'bdc-chat-attachment-remove';
      close.title = `移除待发图片 ${index + 1}`; close.setAttribute('aria-label', close.title); close.append(quickIcon('close'));
      close.onclick = () => remove(ref.id); tile.append(close);
    }
    row.append(tile);
  }
  const read = () => { void load().then(data => {
    if (!row.isConnected) return;
    images = data;
    previews.forEach((open, index) => {
      const url = data[index];
      open.disabled = false;
      if (!url || !/^data:image\/(png|jpeg|webp);base64,/.test(url)) {
        open.textContent = '重新载入'; open.onclick = read; return;
      }
      pictures[index].src = url; open.replaceChildren(pictures[index]);
      open.onclick = () => showImagePreview([images[index]], open);
    });
  }).catch(() => {
    if (!row.isConnected) return;
    previews.forEach(open => { open.disabled = false; open.textContent = '重新载入'; open.onclick = read; });
  }); };
  // Defer until the caller has attached the strip to the current render.
  queueMicrotask(read);
  return row;
}
