import { learningIcon } from '../../shared/learning-icons.ts';

export function showImagePreview(images: string[], returnFocus: HTMLElement): void {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', '图片预览');
  dialog.style.cssText = 'padding:16px;border:1px solid #e3e5e7;border-radius:8px;background:#fff;color:#18191c;max-width:92vw;width:960px;max-height:90vh;box-sizing:border-box;';
  const close = document.createElement('button'); close.type = 'button';
  close.title = '关闭图片预览'; close.setAttribute('aria-label', close.title); close.append(learningIcon('close'));
  close.style.cssText = 'display:flex;margin:0 0 12px auto;padding:8px;border:1px solid #e3e5e7;border-radius:4px;background:#fff;color:#18191c;cursor:pointer;';
  close.addEventListener('click', () => dialog.close()); dialog.append(close);
  for (const [index, data] of images.entries()) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(data)) continue;
    const image = document.createElement('img'); image.src = data; image.alt = `已保存图片 ${index + 1}`;
    image.style.cssText = 'display:block;width:100%;height:auto;max-height:70vh;object-fit:contain;margin:0 auto 12px;';
    dialog.append(image);
  }
  dialog.addEventListener('click', event => { if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  } });
  dialog.addEventListener('close', () => { dialog.remove(); if (returnFocus.isConnected) returnFocus.focus(); }, { once: true });
  (document.fullscreenElement ?? document.body).append(dialog); dialog.showModal(); close.focus();
}
