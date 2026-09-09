import { renderCurrentVideoAssistant } from './assistant-status';
import { LearningCaptureStore, learningRuntimeMatches } from './learning-capture.ts';
import { LearningJumpStore } from './learning-jump.ts';
const learningJumps = new LearningJumpStore();
import { collectCurrentVideoContext, isVideoPage, withVideoElementDuration, readPageRuntimeSnapshotFromBridge } from './current-video-context';
import { attachEventListeners, type VideoContext } from './event-capture';
import { startHeartbeat } from './heartbeat';
import {
  performConfirmedTimestampJump,
  performTimestampReturn,
  type CurrentVideoTimestampReturnPoint,
} from './timestamp-jump';
import { detectVideo } from './video-detector';
import type { BiliVizContentMessage } from '../../shared/types/messages';
import type {
  CurrentVideoTimestampJumpContentPayload,
  CurrentVideoTimestampOperationAuthorizationKind,
  CurrentVideoTimestampOperationKind,
  CurrentVideoTimestampOperationLeaseConsumeResult,
  CurrentVideoTimestampReturnContentPayload,
  CurrentVideoTimestampJumpResponse,
  CurrentVideoTimestampReturnResponse,
} from '../../shared/types/current-video-segment-retrieval';
import type { CurrentVideoContextResult } from '../../shared/types/current-video-context';
import { CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY } from '../../shared/current-video-primary-text-selection.ts';

let cleanup: (() => void) | null = null;
let monitoredVideoElement: HTMLVideoElement | null = null;
let lastContextKey = '';
let retryTimer: number | null = null;
let videoRebindTimer: number | null = null;
let latestContext: CurrentVideoContextResult | null = null;
let currentVideoTimestampReturnPoint: CurrentVideoTimestampReturnPoint | null = null;
let lastUrl = location.href;
let navigationEpoch = 0;
const learningCaptures = new LearningCaptureStore();
let timestampOperationEpoch = 0;
const monitorInitializationKeys = new Set<string>();

const RETURN_TOAST_ID = 'bdc-current-video-return';
const NAVIGATION_STABLE_DELAY_MS = 800;
const VIDEO_REBIND_CHECK_INTERVAL_MS = 1000;

interface NavigationSnapshot {
  epoch: number;
  href: string;
}

interface TimestampOperationSnapshot {
  navigation: NavigationSnapshot;
  operationEpoch: number;
}

function scheduleInitialize(
  delay = 0,
  snapshot: NavigationSnapshot = currentNavigationSnapshot(),
): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }

  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (!navigationSnapshotIsCurrent(snapshot)) return;
    void initializeMonitor(snapshot);
  }, delay);
}

async function initializeMonitor(
  snapshot: NavigationSnapshot = currentNavigationSnapshot(),
): Promise<void> {
  if (!navigationSnapshotIsCurrent(snapshot)) return;
  const initializationKey = `${snapshot.epoch}:${snapshot.href}`;
  if (monitorInitializationKeys.has(initializationKey)) return;
  monitorInitializationKeys.add(initializationKey);
  try {
    await initializeMonitorForSnapshot(snapshot);
  } finally {
    monitorInitializationKeys.delete(initializationKey);
  }
}

async function initializeMonitorForSnapshot(snapshot: NavigationSnapshot): Promise<void> {
  if (!navigationSnapshotIsCurrent(snapshot)) return;
  const context = await collectAndPublishCurrentVideoContext(snapshot);
  if (!navigationSnapshotIsCurrent(snapshot)) return;

  if (!isVideoPage()) {
    cleanupMonitor();
    lastContextKey = '';
    return;
  }

  if (context.kind !== 'video') {
    console.warn('[BiliViz] No BVID found on video page');
    scheduleInitialize(1500, snapshot);
    return;
  }

  const contextKey = `${context.bvid}:${context.cid || `p${context.currentPart.page}`}`;
  const currentVideo = currentReadyVideoElement();
  if (contextKey === lastContextKey && currentVideo === monitoredVideoElement) return;
  if (!currentVideo) {
    cleanupMonitor();
    lastContextKey = '';
    scheduleVideoRebindCheck(snapshot, contextKey);
    return;
  }

  try {
    const video = await detectVideo();
    if (!navigationSnapshotIsCurrent(snapshot)) return;
    if (contextKey === lastContextKey && video === monitoredVideoElement) return;
    const contextWithDuration = withVideoElementDuration(context, video);
    if (!navigationSnapshotIsCurrent(snapshot)) return;
    cleanupMonitor();
    latestContext = contextWithDuration;
    renderCurrentVideoAssistant(contextWithDuration);
    sendCurrentVideoContext(contextWithDuration);
    lastContextKey = contextKey;
    console.log(
      `[BiliViz] Monitoring: ${contextWithDuration.title} (${contextWithDuration.bvid}, cid=${contextWithDuration.cid || 'unknown'}, p=${contextWithDuration.currentPart.page})`,
    );

    const videoCtx: VideoContext = {
      bvid: contextWithDuration.bvid,
      cid: contextWithDuration.cid ?? 0,
      title: contextWithDuration.title ?? '',
      duration: contextWithDuration.durationSeconds ?? 0,
      authorMid: contextWithDuration.authorMid ?? 0,
      authorName: contextWithDuration.authorName ?? '',
    };

    if (!navigationSnapshotIsCurrent(snapshot)) return;
    const removeEvents = attachEventListeners(video, videoCtx, (msg) => {
      chrome.runtime.sendMessage(msg).catch(() => {
        // SW may be inactive; the next heartbeat/action can wake it again.
      });
    });

    const removeHeartbeat = startHeartbeat(video, videoCtx, (msg) => {
      chrome.runtime.sendMessage(msg).catch(() => {});
    });

    cleanup = () => {
      removeEvents();
      removeHeartbeat();
    };
    monitoredVideoElement = video;
    scheduleVideoRebindCheck(snapshot, contextKey);
  } catch {
    if (!navigationSnapshotIsCurrent(snapshot)) return;
    cleanupMonitor();
    lastContextKey = '';
    scheduleVideoRebindCheck(snapshot, contextKey);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === 'CAPTURE_LEARNING_CONTEXT' || message?.action === 'CHECK_LEARNING_CONTEXT' || ['PREPARE_LEARNING_JUMP', 'EXECUTE_LEARNING_JUMP', 'RETURN_LEARNING_JUMP'].includes(message?.action)) {
    void handleLearningCapture(message).then(capture => sendResponse({ capture })).catch(() => sendResponse({ capture: null }));
    return true;
  }
  if (message?.action === 'CURRENT_VIDEO_TIMESTAMP_JUMP') {
    handleCurrentVideoTimestampJump(message.payload).then(sendResponse).catch(() => {
      sendResponse({
        ok: false,
        message: '跳转失败，请确认当前视频页和播放器仍然可用后重试。',
        candidateId: String(message.payload?.candidateId ?? ''),
        targetSeconds: null,
        targetTimeLabel: null,
        returnPointSeconds: null,
        sourceLabel: null,
        confidence: null,
      } satisfies CurrentVideoTimestampJumpResponse);
    });
    return true;
  }

  if (message?.action === 'CURRENT_VIDEO_TIMESTAMP_RETURN') {
    handleCurrentVideoTimestampReturn(message.payload).then(sendResponse).catch(() => {
      sendResponse({
        ok: false,
        message: '返回失败，请确认当前视频页和播放器仍然可用后重试。',
        candidateId: null,
        returnPointSeconds: null,
        targetSeconds: null,
      } satisfies CurrentVideoTimestampReturnResponse);
    });
    return true;
  }

  if (message?.action === 'COLLECT_CURRENT_VIDEO_CONTEXT') {
    const snapshot = currentNavigationSnapshot();
    collectAndPublishCurrentVideoContext(snapshot).then(sendResponse).catch(() => {
      sendResponse({
        kind: 'no_context',
        url: location.href,
        collectedAt: Date.now(),
        reason: 'video_context_unavailable',
        pageType: isVideoPage() ? 'video' : 'non_video',
      } satisfies CurrentVideoContextResult);
    });
    return true;
  }

  return false;
});

async function handleLearningCapture(message: { action: string; kind: 'note' | 'bookmark'; token: string; positionMs?: number; target?: { bvid: string; cid: string; page: number; positionMs: number } }) {
  handlePossibleNavigation();
  const snapshot = currentNavigationSnapshot();
  const video = currentUsableVideoElement();
  // Same-URL player updates do not advance the navigation epoch. Read the live bridge for every capture/check.
  const runtime = await readPageRuntimeSnapshotFromBridge();
  if (!runtime || !navigationSnapshotIsCurrent(snapshot)) return null;
  const context = await collectCurrentVideoContext({ readPageRuntime: async () => runtime, fetchViewInfo: async () => null });
  if (!navigationSnapshotIsCurrent(snapshot) || video !== currentUsableVideoElement() || !learningRuntimeMatches(context, runtime)) return null;
  const state = { context, navigationKey: `${snapshot.epoch}:${snapshot.href}`, video, url: snapshot.href };
  if (message.action === 'PREPARE_LEARNING_JUMP') return { token: learningJumps.prepare(message.target!, state) };
  if (message.action === 'EXECUTE_LEARNING_JUMP' || message.action === 'RETURN_LEARNING_JUMP') return { ok: learningJumps.execute(message.token, state, message.action === 'RETURN_LEARNING_JUMP') };
  return message.action === 'CAPTURE_LEARNING_CONTEXT'
    ? learningCaptures.capture(message.kind, state, message.positionMs) : learningCaptures.check(message.token, state);
}

async function collectAndPublishCurrentVideoContext(
  snapshot: NavigationSnapshot = currentNavigationSnapshot(),
): Promise<CurrentVideoContextResult> {
  const context = await collectCurrentVideoContext();
  if (!navigationSnapshotIsCurrent(snapshot)) {
    return currentNavigationNoContext();
  }
  latestContext = context;
  renderCurrentVideoAssistant(context);
  sendCurrentVideoContext(context);
  return context;
}

async function handleCurrentVideoTimestampJump(
  payload: CurrentVideoTimestampJumpContentPayload,
): Promise<CurrentVideoTimestampJumpResponse> {
  handlePossibleNavigation();
  const operation = beginTimestampOperation(true);
  const operationLeaseAuthorized = await consumeCurrentVideoTimestampOperationLease('jump', payload);
  if (!timestampOperationIsCurrent(operation)) {
    return invalidatedTimestampJumpResponse(payload);
  }
  const result = await performConfirmedTimestampJump({
    payload,
    latestContext,
    video: currentUsableVideoElement(),
    operationLeaseAuthorized,
  });
  if (!timestampOperationIsCurrent(operation)) {
    return invalidatedTimestampJumpResponse(payload);
  }
  if (result.returnPoint) {
    currentVideoTimestampReturnPoint = result.returnPoint;
    showReturnToast(
      result.response.returnPointSeconds,
      () => requestCurrentVideoTimestampReturnFromBackground(payload.returnAuthorizationKind),
    );
  }
  return result.response;
}

async function handleCurrentVideoTimestampReturn(
  payload: CurrentVideoTimestampReturnContentPayload | null = null,
): Promise<CurrentVideoTimestampReturnResponse> {
  handlePossibleNavigation();
  const operation = beginTimestampOperation(false);
  const returnPoint = currentVideoTimestampReturnPoint;
  const operationLeaseAuthorized = payload
    ? await consumeCurrentVideoTimestampOperationLease('return', payload)
    : false;
  if (!timestampOperationIsCurrent(operation)) {
    return invalidatedTimestampReturnResponse(returnPoint);
  }
  const result = await performTimestampReturn({
    payload,
    returnPoint,
    latestContext,
    video: currentUsableVideoElement(),
    operationLeaseAuthorized,
  });
  if (!timestampOperationIsCurrent(operation)) {
    return invalidatedTimestampReturnResponse(returnPoint);
  }
  if (result.clearReturnPoint && currentVideoTimestampReturnPoint === returnPoint) {
    currentVideoTimestampReturnPoint = null;
    document.getElementById(RETURN_TOAST_ID)?.remove();
  }
  return result.response;
}

async function consumeCurrentVideoTimestampOperationLease(
  operationKind: CurrentVideoTimestampOperationKind,
  payload: CurrentVideoTimestampJumpContentPayload | CurrentVideoTimestampReturnContentPayload,
): Promise<boolean> {
  if (!payload.operationLeaseId || !payload.sourceIdentityKey) return false;
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'CONSUME_CURRENT_VIDEO_TIMESTAMP_OPERATION_LEASE',
      params: {
        operationLeaseId: payload.operationLeaseId,
        operationKind,
        contextBvid: payload.contextBvid,
        contextCid: payload.contextCid,
        contextPage: payload.contextPage,
        sourceIdentityKey: payload.sourceIdentityKey,
      },
    }) as {
      success?: boolean;
      data?: CurrentVideoTimestampOperationLeaseConsumeResult;
    };
    return response?.success === true && response.data?.authorized === true;
  } catch {
    return false;
  }
}

async function requestCurrentVideoTimestampReturnFromBackground(
  authorizationKind: CurrentVideoTimestampOperationAuthorizationKind,
): Promise<CurrentVideoTimestampReturnResponse> {
  const returnPoint = currentVideoTimestampReturnPoint;
  if (!returnPoint?.sourceIdentityKey) {
    return {
      ok: false,
      message: '当前视频状态已变化，请重新预览并确认跳转后再返回。',
      candidateId: returnPoint?.candidateId ?? null,
      returnPointSeconds: null,
      targetSeconds: null,
    };
  }

  try {
    const subtitleView = authorizationKind === 'subtitle_view';
    const response = await chrome.runtime.sendMessage({
      action: subtitleView
        ? 'RETURN_CURRENT_VIDEO_SUBTITLE_JUMP'
        : 'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
      params: subtitleView
        ? { sourceIdentityKey: returnPoint.sourceIdentityKey }
        : {
            primaryTextSelectionsReady: true,
            selectedSourceIdentityKey: returnPoint.sourceIdentityKey,
          },
    }) as { success?: boolean; data?: CurrentVideoTimestampReturnResponse };
    if (response?.success && response.data) return response.data;
  } catch {
    // Fall through to the controlled response below.
  }

  return {
    ok: false,
    message: '返回失败，请确认当前 B 站视频页仍然打开后重试。',
    candidateId: returnPoint.candidateId,
    returnPointSeconds: null,
    targetSeconds: null,
  };
}

function beginTimestampOperation(clearExistingReturnPoint: boolean): TimestampOperationSnapshot {
  timestampOperationEpoch += 1;
  if (clearExistingReturnPoint) {
    currentVideoTimestampReturnPoint = null;
    document.getElementById(RETURN_TOAST_ID)?.remove();
  }
  return {
    navigation: currentNavigationSnapshot(),
    operationEpoch: timestampOperationEpoch,
  };
}

function timestampOperationIsCurrent(operation: TimestampOperationSnapshot): boolean {
  return operation.operationEpoch === timestampOperationEpoch
    && navigationSnapshotIsCurrent(operation.navigation);
}

function invalidateTimestampOperations(clearReturnPoint = true): void {
  timestampOperationEpoch += 1;
  if (!clearReturnPoint) return;
  currentVideoTimestampReturnPoint = null;
  document.getElementById(RETURN_TOAST_ID)?.remove();
}

function invalidatedTimestampJumpResponse(
  payload: CurrentVideoTimestampJumpContentPayload,
): CurrentVideoTimestampJumpResponse {
  return {
    ok: false,
    message: '当前视频状态已变化，请重新预览并确认跳转。',
    candidateId: payload.candidateId,
    targetSeconds: null,
    targetTimeLabel: null,
    returnPointSeconds: null,
    sourceLabel: null,
    confidence: null,
  };
}

function invalidatedTimestampReturnResponse(
  returnPoint: CurrentVideoTimestampReturnPoint | null,
): CurrentVideoTimestampReturnResponse {
  return {
    ok: false,
    message: '当前视频状态已变化，请重新跳转后再返回。',
    candidateId: returnPoint?.candidateId ?? null,
    returnPointSeconds: null,
    targetSeconds: null,
  };
}

function currentVideoElement(): HTMLVideoElement | null {
  return document.querySelector('video');
}

function currentUsableVideoElement(): HTMLVideoElement | null {
  const video = currentVideoElement();
  if (!video) return null;
  return video;
}

function currentReadyVideoElement(): HTMLVideoElement | null {
  const video = currentVideoElement();
  if (!video || !document.documentElement.contains(video)) return null;
  if (!Number.isFinite(video.duration) || video.duration <= 0) return null;
  return video;
}

function showReturnToast(
  seconds: number | null,
  onReturn?: () => Promise<CurrentVideoTimestampReturnResponse>,
): void {
  const existing = document.getElementById(RETURN_TOAST_ID);
  existing?.remove();

  const toast = document.createElement('div');
  toast.id = RETURN_TOAST_ID;
  toast.style.cssText = [
    'position:fixed',
    'right:18px',
    'bottom:150px',
    'z-index:2147483647',
    'box-sizing:border-box',
    'max-width:min(300px,calc(100vw - 36px))',
    'padding:10px',
    'border:1px solid rgba(255,179,71,0.36)',
    'border-radius:8px',
    'background:rgba(26,26,46,0.97)',
    'color:#f2f2f6',
    'box-shadow:0 8px 28px rgba(0,0,0,0.28)',
    'font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  ].join(';');

  const label = document.createElement('div');
  label.textContent = seconds === null
    ? '手动跳转完成。你可以返回上一页。'
    : `手动跳转完成。上一播放位置：${formatDuration(seconds)}。`;
  toast.appendChild(label);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;margin-top:8px';
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = '返回';
  back.style.cssText = 'flex:1;border:0;border-radius:6px;background:#ffb347;color:#1a1a2e;font-weight:700;font-size:12px;padding:6px 8px;cursor:pointer';
  back.addEventListener('click', async () => {
    if (onReturn) {
      await onReturn();
      toast.remove();
      return;
    }
    if (seconds !== null) {
      const video = await detectVideo();
      video.currentTime = Math.max(0, seconds);
    }
    toast.remove();
  });

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = '关闭';
  dismiss.style.cssText = 'border:1px solid rgba(255,255,255,0.16);border-radius:6px;background:transparent;color:#c8c8d8;font-size:12px;padding:6px 8px;cursor:pointer';
  dismiss.addEventListener('click', () => toast.remove());
  actions.append(back, dismiss);
  toast.appendChild(actions);
  document.body.appendChild(toast);
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function cleanupMonitor(): void {
  clearVideoRebindTimer();
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  monitoredVideoElement = null;
}

function scheduleVideoRebindCheck(
  snapshot: NavigationSnapshot,
  contextKey: string,
): void {
  clearVideoRebindTimer();
  videoRebindTimer = window.setTimeout(() => {
    videoRebindTimer = null;
    if (!navigationSnapshotIsCurrent(snapshot)) return;
    const currentVideo = currentReadyVideoElement();
    if (currentVideo !== monitoredVideoElement) {
      if (monitoredVideoElement) {
        cleanupMonitor();
        lastContextKey = '';
      }
      void initializeMonitor(snapshot);
      scheduleVideoRebindCheck(snapshot, contextKey);
      return;
    }
    scheduleVideoRebindCheck(snapshot, contextKey);
  }, VIDEO_REBIND_CHECK_INTERVAL_MS);
}

function clearVideoRebindTimer(): void {
  if (videoRebindTimer === null) return;
  window.clearTimeout(videoRebindTimer);
  videoRebindTimer = null;
}

function currentNavigationSnapshot(): NavigationSnapshot {
  return {
    epoch: navigationEpoch,
    href: location.href,
  };
}

function navigationSnapshotIsCurrent(snapshot: NavigationSnapshot): boolean {
  return snapshot.epoch === navigationEpoch && snapshot.href === location.href;
}

function currentNavigationNoContext(): CurrentVideoContextResult {
  return {
    kind: 'no_context',
    url: location.href,
    collectedAt: Date.now(),
    reason: isVideoPage() ? 'video_context_unavailable' : 'non_video_page',
    pageType: isVideoPage() ? 'video' : 'non_video',
  };
}

function handlePossibleNavigation(): void {
  const href = location.href;
  if (href === lastUrl) return;

  lastUrl = href;
  navigationEpoch += 1;
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  clearVideoRebindTimer();
  cleanupMonitor();
  lastContextKey = '';
  invalidateTimestampOperations();
  const pendingContext = currentNavigationNoContext();
  latestContext = pendingContext;
  renderCurrentVideoAssistant(pendingContext);
  scheduleInitialize(NAVIGATION_STABLE_DELAY_MS, currentNavigationSnapshot());
}

function registerTimestampSelectionInvalidation(): void {
  const storageChanges = chrome.storage?.onChanged;
  if (!storageChanges?.addListener) return;
  storageChanges.addListener((changes, areaName) => {
    if (
      areaName !== 'local'
      || !Object.prototype.hasOwnProperty.call(
        changes,
        CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY,
      )
    ) {
      return;
    }
    invalidateTimestampOperations();
  });
}

function sendCurrentVideoContext(context: CurrentVideoContextResult): void {
  const message: BiliVizContentMessage = {
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: context,
  };

  chrome.runtime.sendMessage(message).catch(() => {
    // SW may be inactive; the next page update or player event will retry.
  });
}

scheduleInitialize();
registerTimestampSelectionInvalidation();

const navObserver = new MutationObserver(() => {
  handlePossibleNavigation();
});
navObserver.observe(document.body, { childList: true, subtree: true });

setInterval(() => {
  handlePossibleNavigation();
}, 2000);

console.log('[BiliViz] Player monitor loaded');
