import { moveAssistantWindow, resetAssistantWindow } from './assistant-resize';
const KEY = 'currentVideoAssistantCompactPosition';
let compact: { left: number; top: number } | null = null;
let loaded = false; let revision = 0;
let cancel: (() => void) | null = null;
let saveQueue = Promise.resolve();
let root: HTMLElement | null = null;
const fit = (left: number, top: number, width: number, height: number) => ({
  left: Math.max(12, Math.min(left, innerWidth - width - 12)),
  top: Math.max(12, Math.min(top, innerHeight - height - 12)),
});
function applyCompact(): void {
  if (!root?.classList.contains('bdc-assistant-collapsed') || !compact) return;
  compact = fit(compact.left, compact.top, root.offsetWidth, root.offsetHeight);
  Object.assign(root.style, { left: `${compact.left}px`, top: `${compact.top}px`, right: 'auto', bottom: 'auto' });
}
export function resetAssistantPosition(): void {
  cancel?.(); revision += 1; compact = null; resetAssistantWindow();
  saveQueue = saveQueue.then(() => chrome.storage.local.remove(KEY)).catch(() => {});
}
export function syncAssistantDrag(element: HTMLElement, expanded: boolean): void {
  cancel?.(); root = element;
  if (!loaded) {
    loaded = true;
    const before = revision;
    void chrome.storage.local.get(KEY).then(values => {
      const value = values[KEY];
      if (revision === before && value && typeof value === 'object' && 'left' in value && 'top' in value
        && typeof value.left === 'number' && typeof value.top === 'number' && Number.isFinite(value.left) && Number.isFinite(value.top)) {
        compact = { left: value.left, top: value.top }; applyCompact();
      }
    }).catch(() => {});
    window.addEventListener('resize', () => { cancel?.(); applyCompact(); });
  }
  if (!expanded) applyCompact();
  const handle = element.querySelector<HTMLElement>(expanded ? '.bdc-assistant-header' : '.bdc-assistant-compact');
  if (!handle) return;
  handle.style.cursor = 'grab'; handle.style.touchAction = 'none';
  handle.tabIndex = 0; handle.setAttribute('aria-label', '移动助手窗口');
  const move = (left: number, top: number, persist = false) => {
    revision += 1;
    if (expanded) moveAssistantWindow(left, top, persist);
    else {
      compact = fit(left, top, element.offsetWidth, element.offsetHeight); applyCompact();
      if (persist) { const saved = { ...compact }; saveQueue = saveQueue.then(() => chrome.storage.local.set({ [KEY]: saved })).catch(() => {}); }
    }
  };
  handle.addEventListener('keydown', event => {
    if (event.target !== handle) return;
    const step = event.shiftKey ? 40 : 10;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const box = element.getBoundingClientRect(); move(box.left + delta[0], box.top + delta[1], true);
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('button,a,input,textarea,summary,select')) return;
    const start = element.getBoundingClientRect();
    const id = event.pointerId; const x = event.clientX; const y = event.clientY;
    let moved = false;
    const controller = new AbortController();
    const finish = (rollback: boolean) => {
      controller.abort(); cancel = null; handle.style.cursor = 'grab';
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
      if (moved) { const box = element.getBoundingClientRect(); move(rollback ? start.left : box.left, rollback ? start.top : box.top, !rollback); }
    };
    cancel = () => finish(true);
    window.addEventListener('pointermove', e => {
      if (e.pointerId !== id || Math.hypot(e.clientX - x, e.clientY - y) < 4 && !moved) return;
      if (!moved) { moved = true; handle.setPointerCapture(id); }
      e.preventDefault(); handle.style.cursor = 'grabbing'; move(start.left + e.clientX - x, start.top + e.clientY - y);
    }, { signal: controller.signal });
    window.addEventListener('pointerup', e => { if (e.pointerId === id) finish(false); }, { signal: controller.signal });
    window.addEventListener('pointercancel', e => { if (e.pointerId === id) finish(true); }, { signal: controller.signal });
    window.addEventListener('blur', () => finish(true), { signal: controller.signal });
    handle.addEventListener('lostpointercapture', () => finish(true), { signal: controller.signal });
    window.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(true); } }, { capture: true, signal: controller.signal });
  });
}
