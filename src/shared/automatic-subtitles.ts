// A remembered choice identifies a track. Each request still binds its exact current text version.
export function subtitleTrackIdentity(key: string): string | null {
  return /^primary-text:(bilibili_subtitle|local_transcript):[^:]+:\d+:\d+:[^:]+:[a-z0-9]+$/i.test(key)
    ? key.slice(0, key.lastIndexOf(':')) : null;
}

export function preferredTextIdentity(keys: readonly string[], selected: string | null = null): string | null {
  if (selected) {
    if (keys.includes(selected)) return selected;
    const track = subtitleTrackIdentity(selected);
    const candidates = track ? keys.filter(key => subtitleTrackIdentity(key) === track) : [];
    return candidates.length === 1 ? candidates[0] : null;
  }
  if (keys.length === 1) return keys[0];
  const recognized = keys.filter(key => subtitleTrackIdentity(key));
  return recognized.sort((a, b) => textSourcePriority(a) - textSourcePriority(b) || a.localeCompare(b))[0] ?? null;
}

function textSourcePriority(key: string): number {
  const parts = key.split(':');
  if (parts[1] !== 'bilibili_subtitle') return 10;
  return subtitleLanguagePriority(parts[5]);
}

export function subtitleLanguagePriority(language: string | null): number {
  const value = (language ?? '').toLowerCase();
  if (/^zh($|-)/.test(value)) return 0;
  if (/^ai-zh($|-)/.test(value)) return 1;
  return 2;
}

export function readableSubtitle(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/([\u3400-\u9fff]) +(?=[\u3400-\u9fff])/g, '$1').trim();
}

export class AutomaticSubtitlePoll {
  private key = '';
  private attempts = 0;
  private nextAt = 0;
  private running = false;
  private notified = false;
  sync(key: string, now: number): void {
    if (key === this.key) return;
    this.key = key; this.attempts = 0; this.nextAt = now; this.notified = false;
  }
  notify(now: number): void {
    this.notified = true; this.nextAt = Math.min(this.nextAt, now + 800);
  }
  async tick(now: number, options: { visible: boolean; ready: boolean; load: () => Promise<void> }): Promise<void> {
    if (!this.key || !options.visible || this.running || now < this.nextAt) return;
    if (!this.notified && (options.ready || this.attempts >= 6)) return;
    const key = this.key;
    this.running = true; this.notified = false;
    try { await options.load(); } finally {
      this.running = false;
      if (key === this.key) {
        this.attempts++;
        // A player signal can arrive while this read is still pending.
        if (!this.notified) this.nextAt = now + [2500, 8000, 20000, 45000, 60000, 60000][Math.min(this.attempts - 1, 5)];
      }
    }
  }
}
