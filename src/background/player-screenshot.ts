import { screenshotCrop, type PlayerRectangle } from '../shared/player-screenshot.ts';
import { requireKnowledge } from '../shared/open-knowledge/format.ts';
import { imageDataUrl } from '../shared/open-knowledge/images.ts';
import { imageAttachment } from '../shared/open-knowledge/sources.ts';
const pending = new Map<number, { url: string; until: number }>();
let capturing = false;
export async function resumeToolbarScreenshot(tab: chrome.tabs.Tab): Promise<boolean> {
  const row = tab.id === undefined ? null : pending.get(tab.id);
  if (!row || row.until < Date.now() || row.url !== tab.url || !tab.active) return false;
  pending.delete(tab.id!);
  await chrome.tabs.sendMessage(tab.id!, { action: 'BILI_BILL_TOOLBAR_CAPTURE' }, { frameId: 0 }).catch(() => {});
  return true;
}
export async function capturePlayerScreenshot(tabId: number | null) {
  let tab: chrome.tabs.Tab | undefined;
  let owned = false;
  try {
    requireKnowledge(tabId !== null && !capturing, 'capture_busy');
    tab = await chrome.tabs.get(tabId); const url = new URL(tab.url ?? 'about:blank');
    requireKnowledge(url.protocol === 'https:' && url.hostname === 'www.bilibili.com' && /^\/video\/BV[a-zA-Z0-9]{10}\/?$/.test(url.pathname) && tab.active, 'capture');
    capturing = true; owned = true;
    const before = await chrome.tabs.sendMessage(tabId, { action: 'BILI_BILL_CAPTURE_RECT', hide: true }, { frameId: 0 }) as PlayerRectangle;
    const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    requireKnowledge(active[0]?.id === tabId, 'stale_capture');
    let data: string;
    try { data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); }
    catch {
      pending.set(tabId, { url: tab.url!, until: Date.now() + 120000 });
      throw Error('toolbar_required');
    }
    const after = await chrome.tabs.sendMessage(tabId, { action: 'BILI_BILL_CAPTURE_RECT', hide: false }, { frameId: 0 }) as PlayerRectangle;
    const current = await chrome.tabs.get(tabId);
    requireKnowledge(current.active && current.url === tab.url && current.windowId === tab.windowId, 'stale_capture');
    const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), char => char.charCodeAt(0));
    requireKnowledge(bytes.length <= 32 * 1024 * 1024, 'capture_size');
    const bitmap = await createImageBitmap(new Blob([bytes]));
    try {
      const crop = screenshotCrop(before, after, bitmap.width, bitmap.height);
      requireKnowledge(crop.width * crop.height <= 24_000_000, 'capture_size');
      const scale = Math.min(1, 4096 / Math.max(crop.width, crop.height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.floor(crop.width * scale)), Math.max(1, Math.floor(crop.height * scale)));
      canvas.getContext('2d')!.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
      const image = await imageAttachment(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/webp', quality: 0.94 })).arrayBuffer()));
      return { success: true, data: { image: imageDataUrl(image), anchor: { ...after.anchor, method: 'page-crop', timeMs: before.anchor.timeMs, endMs: after.anchor.timeMs } } };
    } finally { bitmap.close(); }
  } catch (error) {
    return { success: false, error: error instanceof Error && error.message === 'toolbar_required'
      ? '视频帧受限，请点击浏览器工具栏中的 Bili-Bill，启用当前页截图。届时会重新捕获画面与时间。'
      : '截图未保存，请让播放器完整可见、保持当前页面后重试；也可上传图片。' };
  } finally {
    if (owned) {
      capturing = false;
      if (tab?.id !== undefined) await chrome.tabs.sendMessage(tab.id, { action: 'BILI_BILL_CAPTURE_RESTORE' }, { frameId: 0 }).catch(() => {});
    }
  }
}
