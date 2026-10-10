import { videoFrame } from '../../content/player-monitor/quick-capture.ts';
import { matchesTarget } from './contract.ts';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.action !== 'BILI_BILL_ACCEPTANCE_FRAME_V1') return;
  try {
    if (!matchesTarget(location.href, message.target)) throw Error('identity');
    const frame = videoFrame();
    if (!matchesTarget(location.href, message.target) || frame.data.length > 4000000) throw Error('capture');
    respond(frame);
  } catch { respond({ error: 'ACCEPTANCE_FRAME_UNAVAILABLE' }); }
});
