import type { ChatImageReference } from '../../shared/chat-images.ts';
import { quickIcon } from './quick-capture.ts';
import { showImagePreview } from './image-preview.ts';

export function chatAttachments(refs: ChatImageReference[], load: () => Promise<string[]>, remove?: (id: string) => void): HTMLElement {
  const row = document.createElement('div'); row.className = 'bdc-chat-attachments';
  row.setAttribute('role', 'group'); row.setAttribute('aria-label', remove ? '待发送图片' : '已发送图片');
  const previews: HTMLButtonElement[] = [];
  let revision = 0;
  for (const [index, ref] of refs.entries()) {
    const tile = document.createElement('div'); tile.className = 'bdc-chat-attachment';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'bdc-chat-attachment-preview';
    open.title = `查看${remove ? '待发' : '已发送'}图片 ${index + 1}`; open.setAttribute('aria-label', open.title);
    previews.push(open); open.textContent = '载入中…'; open.disabled = true; tile.append(open);
    if (remove) {
      const close = document.createElement('button'); close.type = 'button'; close.className = 'bdc-chat-attachment-remove';
      close.title = `移除待发图片 ${index + 1}`; close.setAttribute('aria-label', close.title); close.append(quickIcon('close'));
      close.onclick = () => remove(ref.id); tile.append(close);
    }
    row.append(tile);
  }
  const failed = (open: HTMLButtonElement) => {
    open.disabled = false; open.textContent = '重新载入'; open.onclick = read;
  };
  const read = () => {
    const current = ++revision;
    previews.forEach(open => { open.disabled = true; open.textContent = '载入中…'; });
    void load().then(data => {
      if (!row.isConnected || current !== revision) return;
      previews.forEach((open, index) => {
        const url = data[index];
        if (!url || !/^data:image\/(png|jpeg|webp);base64,/.test(url)) {
          failed(open); return;
        }
        const picture = document.createElement('img'); picture.alt = `图片 ${index + 1}`;
        picture.onload = () => {
          if (!row.isConnected || current !== revision) return;
          open.disabled = false; open.replaceChildren(picture);
          open.onclick = () => showImagePreview([url], open);
        };
        picture.onerror = () => { if (row.isConnected && current === revision) failed(open); };
        picture.src = url;
      });
    }).catch(() => {
      if (!row.isConnected || current !== revision) return;
      previews.forEach(failed);
    });
  };
  // Defer until the caller has attached the strip to the current render.
  queueMicrotask(read);
  return row;
}
