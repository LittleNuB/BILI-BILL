import { cacheCurrentVideoTranscriptEvidence } from '../../background/current-video-transcript-cache.ts';
import type { CurrentVideoTranscriptEvidenceWrite } from '../../shared/types/current-video-transcript.ts';
import type { CurrentVideoContext } from '../../shared/types/current-video-context.ts';
import { digest, matchesTarget, requireValue, type Build, type Material, type Target } from './contract.ts';

export async function captureTarget(target: Target, frame: boolean, signal: AbortSignal, build: Build): Promise<Material> {
  // Query only the exact selected video; no inventory of history, favorites or unrelated tabs.
  const tabs = (await chrome.tabs.query({ url: `https://www.bilibili.com/video/${target.bvid}*` })).filter(t => matchesTarget(t.url, target));
  requireValue(tabs.length === 1 && tabs[0].id !== undefined, 'ACCEPTANCE_OPEN_ONE_TARGET_TAB');
  const tabId = tabs[0].id!;
  const current = async () => {
    requireValue(!signal.aborted && matchesTarget((await chrome.tabs.get(tabId)).url, target), 'ACCEPTANCE_TARGET_CHANGED');
    const context = await chrome.tabs.sendMessage(tabId, { action: 'COLLECT_CURRENT_VIDEO_CONTEXT', payload: {} }) as CurrentVideoContext;
    requireValue(context?.kind === 'video' && context.bvid === target.bvid && context.currentPart.page === target.page && !!context.cid, 'ACCEPTANCE_IDENTITY');
    return context;
  };
  const before = await current();
  let captured: CurrentVideoTranscriptEvidenceWrite | null = null;
  // Reuse production acquisition and normalisation, replacing only its persistence sink.
  const state = await cacheCurrentVideoTranscriptEvidence(before, { upsertEvidence: async evidence => {
    requireValue(!signal.aborted, 'ACCEPTANCE_REVOKED');
    captured = evidence;
    return { ...evidence.sourceRecord, active: evidence.sourceRecord.status === 'cached', checkedAt: Date.now(), staleSegmentCount: 0 };
  } });
  const write = captured as CurrentVideoTranscriptEvidenceWrite | null;
  requireValue(state.status === 'cached' && write?.segments.length, 'ACCEPTANCE_SUBTITLES_UNAVAILABLE');
  const after = await current(); requireValue(after.cid === before.cid, 'ACCEPTANCE_TARGET_CHANGED');
  const body: Omit<Material, 'hash'> = { version: 1, target, cid: before.cid!, title: before.title ?? target.bvid,
    capturedAt: new Date().toISOString(), build, source: 'bilibili_subtitle', sourceType: write.sourceRecord.sourceType as Material['sourceType'],
    language: write.sourceRecord.language, evidence: 'real_material',
    lines: write.segments.map((s, i) => ({ lineNo: i + 1, startSeconds: s.startSeconds, endSeconds: s.endSeconds, text: s.text })) };
  if (frame) {
    const result = await chrome.tabs.sendMessage(tabId, { action: 'BILI_BILL_ACCEPTANCE_FRAME_V1', target });
    requireValue(result && !result.error && typeof result.data === 'string', 'ACCEPTANCE_FRAME_UNAVAILABLE');
    requireValue((await current()).cid === before.cid && !signal.aborted, 'ACCEPTANCE_TARGET_CHANGED');
    body.frame = { data: result.data, timeMs: result.timeMs, capturedAt: result.capturedAt, sha256: await digest(result.data) };
  }
  return { ...body, hash: await digest(JSON.stringify(body)) };
}
