import { AutomaticSubtitlePoll } from '../../shared/automatic-subtitles.ts';

export function observeAutomaticSubtitles(options: { key: () => string; ready: () => boolean; load: () => Promise<void> }): void {
  const poll = new AutomaticSubtitlePoll();
  const signal = () => poll.notify(Date.now());
  const tick = () => {
    poll.sync(options.key(), Date.now());
    void poll.tick(Date.now(), { visible: !document.hidden, ready: options.ready(), load: options.load }).catch(() => {});
  };
  // Resource timing is a signal only. URLs and session material never leave the page.
  try {
    new PerformanceObserver(list => {
      if (list.getEntries().some(entry => {
        try {
          const url = new URL(entry.name);
          return (url.hostname === 'api.bilibili.com' && /^\/x\/player\/(wbi\/)?v2$/.test(url.pathname))
            || (/(^|\.)hdslb\.com$/.test(url.hostname) && /subtitle/i.test(url.pathname));
        } catch { return false; }
      })) signal();
    }).observe({ type: 'resource', buffered: false });
  } catch { /* Text-track and player interaction signals also work without resource timing. */ }
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[class*="bpx-player-ctrl-subtitle"], [class*="bpx-player-subtitle"], [class*="bilibili-player-video-btn-subtitle"]')) signal();
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) signal(); });
  const observed = new WeakSet<HTMLVideoElement>();
  const timer = window.setInterval(() => {
    const video = document.querySelector('video');
    if (video && !observed.has(video)) {
      observed.add(video); video.textTracks?.addEventListener('change', signal);
      video.textTracks?.addEventListener('addtrack', signal); signal();
    }
    tick();
  }, 1000);
  window.addEventListener('pagehide', event => { if (!event.persisted) window.clearInterval(timer); });
  tick();
}
