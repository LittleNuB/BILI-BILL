export interface AssistantRect { left: number; top: number; width: number; height: number }
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const KEY = 'currentVideoAssistantWindowSize';
const GAP = 12;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function fitAssistantRect(rect: AssistantRect, vw: number, vh: number): AssistantRect {
  const width = clamp(rect.width, Math.min(320, vw - GAP * 2), Math.max(1, vw - GAP * 2));
  const height = clamp(rect.height, Math.min(360, vh - GAP * 2), Math.max(1, vh - GAP * 2));
  return { width, height, left: clamp(rect.left, GAP, Math.max(GAP, vw - GAP - width)), top: clamp(rect.top, GAP, Math.max(GAP, vh - GAP - height)) };
}

export function resizeAssistantRect(start: AssistantRect, edge: ResizeEdge, dx: number, dy: number, vw: number, vh: number): AssistantRect {
  const rect = fitAssistantRect(start, vw, vh);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const minWidth = Math.min(320, vw - GAP * 2);
  const minHeight = Math.min(360, vh - GAP * 2);
  if (edge.includes('w')) { rect.left = clamp(rect.left + dx, GAP, right - minWidth); rect.width = right - rect.left; }
  if (edge.includes('e')) rect.width = clamp(rect.width + dx, minWidth, vw - GAP - rect.left);
  if (edge.includes('n')) { rect.top = clamp(rect.top + dy, GAP, bottom - minHeight); rect.height = bottom - rect.top; }
  if (edge.includes('s')) rect.height = clamp(rect.height + dy, minHeight, vh - GAP - rect.top);
  return rect;
}

let preferred: { width: number; height: number; left?: number; top?: number } | null = null;
let rect: AssistantRect | null = null;
let root: HTMLElement | null = null;
let initialized = false;
let revision = 0;
let cancelDrag: (() => void) | null = null;
let saveQueue = Promise.resolve();

function applyRect(): void {
  if (!root?.isConnected || !root.classList.contains('bdc-assistant-expanded') || !rect) return;
  rect = fitAssistantRect(rect, window.innerWidth, window.innerHeight);
  Object.assign(root.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, right: 'auto', bottom: 'auto' });
}

function saveSize(): void {
  if (!rect) return;
  revision += 1;
  const size = { width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left), top: Math.round(rect.top) };
  preferred = size;
  saveQueue = saveQueue.then(() => chrome.storage.local.set({ [KEY]: size })).catch(() => {});
}

export function moveAssistantWindow(left: number, top: number, persist = false): void {
  if (!rect) return;
  revision += 1;
  rect = { ...rect, left, top }; applyRect();
  if (persist) saveSize();
}

export function resetAssistantWindow(): void {
  cancelDrag?.(); revision += 1; rect = null; preferred = null;
  if (root) for (const property of ['left', 'top', 'width', 'height', 'right', 'bottom']) root.style.removeProperty(property);
  saveQueue = saveQueue.then(() => chrome.storage.local.remove(KEY)).catch(() => {});
}

export function syncAssistantResize(element: HTMLElement, expanded: boolean): void {
  cancelDrag?.();
  root = element;
  if (!initialized) {
    initialized = true;
    const loadRevision = revision;
    void chrome.storage.local.get(KEY).then(values => {
      const value = values[KEY];
      if (revision !== loadRevision || !value || typeof value !== 'object' || !('width' in value) || !('height' in value)
        || typeof value.width !== 'number' || typeof value.height !== 'number'
        || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width < 1 || value.height < 1) return;
      preferred = { width: value.width, height: value.height };
      if ('left' in value && 'top' in value && typeof value.left === 'number' && Number.isFinite(value.left) && typeof value.top === 'number' && Number.isFinite(value.top)) {
        preferred.left = value.left; preferred.top = value.top;
      }
      if (rect) {
        rect = { ...rect, left: rect.left + rect.width - value.width, top: rect.top + rect.height - value.height, ...preferred };
        applyRect();
      }
    }).catch(() => {});
    window.addEventListener('resize', () => { cancelDrag?.(); applyRect(); });
  }
  if (!expanded) {
    for (const property of ['left', 'top', 'width', 'height', 'right', 'bottom']) element.style.removeProperty(property);
    return;
  }
  if (!rect) {
    const initial = element.getBoundingClientRect();
    rect = { left: initial.left, top: initial.top, width: initial.width, height: initial.height };
    if (preferred) rect = { ...rect, left: initial.right - preferred.width, top: initial.bottom - preferred.height, ...preferred };
  }
  applyRect();
  const names: Record<ResizeEdge, string> = { n: '上', s: '下', e: '右', w: '左', ne: '右上', nw: '左上', se: '右下', sw: '左下' };
  for (const edge of Object.keys(names) as ResizeEdge[]) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = `bdc-assistant-resize bdc-assistant-resize-${edge}`;
    handle.dataset.edge = edge;
    handle.setAttribute('aria-label', `调整窗口${names[edge]}边缘`);
    handle.title = `拖动调整窗口${names[edge]}边缘`;
    handle.addEventListener('keydown', event => {
      const step = event.shiftKey ? 40 : 10;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!delta || !rect) return;
      event.preventDefault(); event.stopPropagation();
      rect = resizeAssistantRect(rect, edge, delta[0], delta[1], innerWidth, innerHeight);
      applyRect(); saveSize();
    });
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !rect) return;
      event.preventDefault(); event.stopPropagation();
      cancelDrag?.();
      revision += 1;
      const start = { ...rect };
      const x = event.clientX; const y = event.clientY; const id = event.pointerId;
      const controller = new AbortController();
      handle.setPointerCapture(id);
      element.dataset.resizing = 'true';
      const finish = (cancel: boolean) => {
        controller.abort(); cancelDrag = null; delete element.dataset.resizing;
        if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
        if (cancel) { rect = start; applyRect(); } else saveSize();
      };
      cancelDrag = () => finish(true);
      window.addEventListener('pointermove', move => {
        if (move.pointerId !== id) return;
        rect = resizeAssistantRect(start, edge, move.clientX - x, move.clientY - y, innerWidth, innerHeight);
        applyRect();
      }, { signal: controller.signal });
      window.addEventListener('pointerup', up => { if (up.pointerId === id) finish(false); }, { signal: controller.signal });
      window.addEventListener('pointercancel', cancelled => { if (cancelled.pointerId === id) finish(true); }, { signal: controller.signal });
      handle.addEventListener('lostpointercapture', () => finish(true), { signal: controller.signal });
      window.addEventListener('blur', () => finish(true), { signal: controller.signal });
      window.addEventListener('keydown', key => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(true); } }, { capture: true, signal: controller.signal });
    });
    element.appendChild(handle);
  }
}
