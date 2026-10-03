import { SUBTITLE_CORRECTION_PREFERENCE, type CorrectionState } from '../../shared/subtitle-correction.ts';
import { readableSubtitle } from '../../shared/automatic-subtitles.ts';
import { h, render } from 'preact';
import { Square } from 'lucide-preact';

export class SubtitleCorrectionUi {
  enabled = false;
  state: CorrectionState | null = null;
  optimized = true;
  private source = '';
  private generation = 0;
  private loaded = false;
  private running = false;
  private paused = false;
  private message = '';
  private hiddenPaused = false;
  private preferenceRevision = 0;
  constructor(private options: { request: (mode: string, retry?: boolean) => Promise<CorrectionState>; render: () => void }) {
    void chrome.storage.local.get(SUBTITLE_CORRECTION_PREFERENCE).then(stored => {
      if (!this.preferenceRevision) this.enabled = stored[SUBTITLE_CORRECTION_PREFERENCE] === true;
      this.loaded = true;
      void this.load();
    }).catch(() => { this.message = '优化偏好读取失败，可重试。'; });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('userConfig' in changes) { this.stop(); this.state = null; this.paused = false; void this.load(); }
      if (!(SUBTITLE_CORRECTION_PREFERENCE in changes)) return;
      this.preferenceRevision++;
      this.enabled = changes[SUBTITLE_CORRECTION_PREFERENCE].newValue === true;
      if (!this.enabled) this.stop(); else { this.paused = false; void this.run(); }
      this.options.render();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.running) { this.hiddenPaused = true; this.stop(); }
      else if (!document.hidden && this.hiddenPaused) { this.hiddenPaused = false; this.paused = false; void this.run(); }
    });
    window.addEventListener('pagehide', () => this.stop(), { once: true });
  }
  setSource(source: string): void {
    if (source === this.source) return;
    this.stop(); this.source = source; this.state = null; this.paused = false; this.message = '';
    if (this.loaded) void this.load();
  }
  text(id: string, original: string): string {
    return readableSubtitle(this.optimized ? this.state?.corrected[id] ?? original : original);
  }
  private async load(): Promise<void> {
    if (!this.source) return;
    const generation = this.generation;
    try {
      const state = await this.options.request('read');
      if (generation !== this.generation || state.sourceIdentityKey !== this.source) return;
      this.state = state;
      if (this.enabled && !this.paused && !document.hidden) void this.run();
    } catch { if (generation === this.generation) this.message = '优化缓存暂不可用，原字幕仍可阅读。'; }
    if (generation === this.generation) this.options.render();
  }
  private stop(): void {
    this.generation++; this.running = false; this.paused = true;
    if (this.source) void this.options.request('stop').catch(() => {});
  }
  private async run(retry = false): Promise<void> {
    if (!this.enabled || !this.loaded || !this.source || this.running || document.hidden) return;
    const generation = this.generation; this.running = true; this.paused = false; this.message = '';
    this.options.render();
    try {
      do {
        const state = await this.options.request('step', retry); retry = false;
        if (generation !== this.generation || state.sourceIdentityKey !== this.source) return;
        this.state = state; this.options.render();
        if (state.status !== 'running') break;
        await new Promise(resolve => window.setTimeout(resolve, 250));
      } while (generation === this.generation && this.enabled && !document.hidden);
    } catch { if (generation === this.generation) this.message = '优化暂未完成，原文和已完成部分仍保留。'; }
    finally { if (generation === this.generation) { this.running = false; this.options.render(); } }
  }
  append(parent: HTMLElement): void {
    const controls = document.createElement('div'); controls.className = 'bdc-subtitle-correction';
    const label = document.createElement('label'), check = document.createElement('input');
    check.type = 'checkbox'; check.checked = this.enabled;
    label.title = '开启后会记住偏好，将当前视频字幕分批发送到你配置的 AI。原文保持不变。';
    label.append(check, ' AI 纠错');
    check.addEventListener('change', () => {
      void chrome.storage.local.set({ [SUBTITLE_CORRECTION_PREFERENCE]: check.checked }).catch(() => {
        this.message = '偏好保存失败，请重试。'; this.options.render();
      });
    });
    controls.append(label);
    const button = (text: string, action: () => void) => {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'bdc-assistant-button bdc-assistant-button-quiet';
      node.textContent = text; node.addEventListener('click', action); controls.append(node); return node;
    };
    if (this.state?.done) {
      const modes = document.createElement('div'); modes.className = 'bdc-assistant-segmented-control'; modes.setAttribute('role', 'radiogroup');
      modes.setAttribute('aria-label', '字幕版本');
      for (const [text, value] of [['原文', false], ['AI 优化', true]] as const) {
        const node = button(text, () => { this.optimized = value; this.options.render(); });
        node.className = 'bdc-assistant-segmented-option' + (this.optimized === value ? ' bdc-assistant-segmented-option-active' : '');
        node.setAttribute('role', 'radio'); node.setAttribute('aria-checked', String(this.optimized === value)); modes.append(node);
      }
      controls.append(modes);
    }
    if (this.running) {
      const stop = button('停止', () => { this.stop(); this.options.render(); });
      stop.textContent = ''; stop.setAttribute('aria-label', '停止'); stop.title = '停止';
      render(h(Square, { size: 16, 'aria-hidden': true }), stop);
    }
    else if (this.enabled && this.state?.status !== 'complete') button(this.state?.failed.length ? '重试未完成部分' : '继续优化', () => { void this.run(true); });
    parent.append(controls);
    const status = document.createElement('div'); status.className = 'bdc-assistant-subtitle-detail'; status.setAttribute('role', 'status');
    status.textContent = this.message || (this.running ? `正在优化 ${this.state?.done ?? 0} / ${this.state?.total ?? 0}`
      : this.paused && this.enabled ? '已停止，完成部分仍保留。' : this.state?.message ?? '原字幕已自动排版；AI 纠错只处理当前视频。');
    parent.append(status);
  }
}
