import { h, render } from 'preact';
import { Camera, NotebookPen, ImagePlus, MessageCircle, Copy, Plus, History, Settings2, Square, X } from 'lucide-preact';

export function quickIcon(name: 'camera' | 'note' | 'image' | 'chat' | 'copy' | 'plus' | 'history' | 'settings' | 'stop' | 'close'): HTMLElement {
  const node = document.createElement('span'); node.style.display = 'inline-flex';
  render(h({ camera: Camera, note: NotebookPen, image: ImagePlus, chat: MessageCircle, copy: Copy, plus: Plus, history: History, settings: Settings2, stop: Square, close: X }[name], { size: 18, strokeWidth: 1.8, 'aria-hidden': true }), node);
  return node;
}
export function videoFrame(): { data: string; timeMs: number; capturedAt: number } {
  const video = document.querySelector<HTMLVideoElement>('video');
  if (!video?.isConnected || !video.videoWidth || !video.videoHeight || video.readyState < 2 || !Number.isFinite(video.currentTime)) throw Error('播放器画面还未就绪。');
  if (video.videoWidth * video.videoHeight > 24_000_000) throw Error('画面分辨率过大，请使用较低分辨率。');
  const scale = Math.min(1, 4096 / Math.max(video.videoWidth, video.videoHeight)), canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  const timeMs = Math.floor(video.currentTime * 1000), capturedAt = Date.now();
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { data: canvas.toDataURL('image/webp', 0.94), timeMs, capturedAt };
}
export function imageFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) return Promise.reject(Error('请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片。'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(Error('图片未读取成功。')); reader.readAsDataURL(file);
  });
}
export function playerQuickTools(note: () => void, capture: () => void): void {
  const root = document.createElement('div'); root.id = 'bdc-player-quick-tools'; root.setAttribute('aria-label', 'Bili-Bill 快速记录');
  Object.assign(root.style, { position: 'absolute', right: '16px', top: '16px', display: 'flex', gap: '6px', zIndex: '100', pointerEvents: 'auto' });
  for (const [label, icon, run] of [['记笔记', 'note', note], ['保存截图', 'camera', capture]] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.title = `Bili-Bill · ${label}`; button.setAttribute('aria-label', button.title); button.append(quickIcon(icon));
    Object.assign(button.style, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '34px', height: '34px', padding: '0', border: '1px solid #dfe1e5', borderRadius: '6px', background: '#ffffff', color: '#61666d', cursor: 'pointer' });
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); run(); }); root.append(button);
  }
  const place = () => {
    const video = document.querySelector('video');
    const target = video?.closest<HTMLElement>('.bpx-player-video-wrap, .bilibili-player-video-wrap') ?? video?.parentElement;
    if (!target || !location.pathname.startsWith('/video/')) { root.remove(); return; }
    if (root.parentElement !== target) { if (getComputedStyle(target).position === 'static') target.style.position = 'relative'; target.append(root); }
  };
  place(); const timer = setInterval(place, 1000);
  document.addEventListener('fullscreenchange', place);
  window.addEventListener('pagehide', event => { if (!(event as PageTransitionEvent).persisted) clearInterval(timer); });
}
