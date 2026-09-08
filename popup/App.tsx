import { useEffect, useRef, useState } from 'preact/hooks';
import { quickStats, loading, error, lastSyncResult, syncInProgress, syncProgress, syncPageLimit } from './signals';
import { requestSW } from './utils/messaging';
import type { QuickStats } from '../src/shared/types/analytics';
import type { SyncNowResult } from '../src/shared/types/messages';
import type { HistoryTailProbeReport } from '../src/shared/types/history-tail-probe';
import type { HistorySyncProgress, HistorySyncStatus } from '../src/shared/types/history-sync';
import type {
  CurrentVideoContextResult,
} from '../src/shared/types/current-video-context';
import type { CurrentVideoTranscriptEvidenceState } from '../src/shared/types/current-video-transcript';
import type {
  CurrentVideoSegmentRerankExplanation,
  CurrentVideoSegmentRetrievalCandidate,
  CurrentVideoSegmentRetrievalResult,
  CurrentVideoTimestampJumpResponse,
  CurrentVideoTimestampReturnResponse,
} from '../src/shared/types/current-video-segment-retrieval';
import type {
  CurrentVideoSummaryHighlight,
  CurrentVideoSummaryHighlightBinding,
  CurrentVideoSummaryHighlightsResult,
} from '../src/shared/types/current-video-summary';
import type {
  CurrentVideoFullTextQaCitation,
  CurrentVideoFullTextQaCitationBinding,
  CurrentVideoFullTextQaResult,
} from '../src/shared/types/current-video-full-text-qa';
import type {
  CurrentVideoQaSessionRecord,
  CurrentVideoQaSessionsView,
  CurrentVideoQaSessionTurn,
  CurrentVideoQaSourceSnapshot,
} from '../src/shared/types/current-video-qa-session';
import type { VideoKnowledgeNode, VideoKnowledgeResult } from '../src/shared/types/video-knowledge';
import {
  asPriorGeneratedCurrentVideoSummaryHighlights,
  cancelledCurrentVideoSummaryHighlights,
  currentVideoSummaryHighlightBindingFromResult,
  formatTextSize,
  loadingCurrentVideoSummaryHighlights,
} from '../src/shared/current-video-summary-highlights';
import { createCurrentVideoFullTextRequestId } from '../src/shared/current-video-primary-text';
import {
  buildCurrentVideoSubtitleDiagnostics,
  type CurrentVideoSubtitleDiagnostics,
} from '../src/shared/current-video-subtitle-diagnostics';
import {
  CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY,
  readCurrentVideoPrimaryTextSelections,
  resolveCurrentVideoPrimaryTextAuthorization,
  type CurrentVideoPrimaryTextAuthorization,
} from '../src/shared/current-video-primary-text-selection.ts';
import { ProgressRing } from './components/ProgressRing';
import { QuickStats as QuickStatsPanel } from './components/QuickStats';
import { OpenDashboard } from './components/OpenDashboard';

interface PopupCurrentVideoScopeSnapshot {
  contextKey: string;
  selectionRevision: number;
  operationRevision: number;
}

interface PopupCurrentVideoActionSnapshot extends PopupCurrentVideoScopeSnapshot {
  requestId: number;
}

interface PopupActiveSummaryHighlightsRequest {
  requestId: string;
  params: Record<string, unknown>;
  contextKey: string;
  selectionRevision: number;
  selectedSourceIdentityKey: string | null;
  previousReady: CurrentVideoSummaryHighlightsResult | null;
}

const USER_CONFIG_STORAGE_KEY = 'userConfig';

function popupCurrentVideoContextKey(context: CurrentVideoContextResult | null): string {
  if (!context) return 'no_context:pending';
  if (context.kind !== 'video') return `no_context:${context.pageType}:${context.reason}`;
  return `video:${context.bvid}:${context.cid ?? 'missing'}:${context.currentPart.page}`;
}

function popupCurrentVideoExactIdentityMatches(
  left: CurrentVideoContextResult | null,
  right: CurrentVideoContextResult | null,
): boolean {
  return left?.kind === 'video'
    && right?.kind === 'video'
    && left.bvid === right.bvid
    && left.cid !== null
    && left.cid === right.cid
    && left.currentPart.page === right.currentPart.page;
}

function popupTranscriptEvidenceMatchesContext(
  evidence: CurrentVideoTranscriptEvidenceState,
  context: CurrentVideoContextResult,
): boolean {
  return context.kind === 'video'
    && context.cid !== null
    && evidence.bvid === context.bvid
    && evidence.cid === context.cid
    && evidence.page === context.currentPart.page;
}

function popupSummaryAfterLiveConfigChange(
  summary: CurrentVideoSummaryHighlightsResult | null,
  userConfig: unknown,
): CurrentVideoSummaryHighlightsResult | null {
  if (summary?.status !== 'ready') return null;
  const gate = popupSummaryGenerationGate(userConfig);
  return {
    ...asPriorGeneratedCurrentVideoSummaryHighlights(summary),
    canGenerate: gate.canGenerate,
    generationBlockedMessage: gate.blockedMessage,
  };
}

function popupSummaryConfigRelevantChange(oldValue: unknown, newValue: unknown): boolean {
  const oldGate = popupSummaryGenerationGate(oldValue);
  const newGate = popupSummaryGenerationGate(newValue);
  return oldGate.enabled !== newGate.enabled
    || oldGate.configured !== newGate.configured
    || oldGate.baseURL !== newGate.baseURL
    || oldGate.apiKey !== newGate.apiKey
    || oldGate.chatModel !== newGate.chatModel;
}

function popupSummaryGenerationGate(value: unknown): {
  enabled: boolean;
  configured: boolean;
  baseURL: string;
  apiKey: string;
  chatModel: string;
  canGenerate: boolean;
  blockedMessage: string | null;
} {
  const config = isPopupRecord(value) ? value : {};
  const assistant = isPopupRecord(config.assistant) ? config.assistant : {};
  const ai = isPopupRecord(config.ai) ? config.ai : {};
  const enabled = assistant.currentVideoAiAssistantEnabled === true;
  const baseURL = popupString(ai.baseURL);
  const apiKey = popupString(ai.apiKey);
  const chatModel = popupString(ai.chatModel);
  const configured = Boolean(baseURL && apiKey && chatModel);
  return {
    enabled,
    configured,
    baseURL,
    apiKey,
    chatModel,
    canGenerate: enabled && configured,
    blockedMessage: !enabled
      ? '要生成或刷新，请先在设置中开启“当前视频 AI 助手”。'
      : configured
        ? null
        : '要生成或刷新，请先完成 AI 服务配置。',
  };
}

function isPopupRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function popupString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function App() {
  const [currentVideoContext, setCurrentVideoContext] = useState<CurrentVideoContextResult | null>(null);
  const [currentVideoSummary, setCurrentVideoSummary] = useState<CurrentVideoSummaryHighlightsResult | null>(null);
  const [videoKnowledge, setVideoKnowledge] = useState<VideoKnowledgeResult | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [subtitleProbeLoading, setSubtitleProbeLoading] = useState(false);
  const [subtitleProbeStatus, setSubtitleProbeStatus] = useState<string | null>(null);
  const [currentVideoActionError, setCurrentVideoActionError] = useState<string | null>(null);
  const [primaryTextSelectionRevision, setPrimaryTextSelectionRevision] = useState(0);
  const [currentVideoOperationRevision, setCurrentVideoOperationRevision] = useState(0);
  const [tailProbeReport, setTailProbeReport] = useState<HistoryTailProbeReport | null>(null);
  const [tailProbeLoading, setTailProbeLoading] = useState(false);
  const [tailProbeError, setTailProbeError] = useState<string | null>(null);
  const currentVideoContextRef = useRef<CurrentVideoContextResult | null>(null);
  const currentVideoSummaryRef = useRef<CurrentVideoSummaryHighlightsResult | null>(null);
  const currentVideoContextKeyRef = useRef(popupCurrentVideoContextKey(null));
  const primaryTextSelectionRevisionRef = useRef(0);
  const currentVideoOperationRevisionRef = useRef(0);
  const currentVideoContextRequestRef = useRef(0);
  const subtitleReprobeRequestRef = useRef(0);
  const summaryRequestRef = useRef(0);
  const activeSummaryRequestRef = useRef<PopupActiveSummaryHighlightsRequest | null>(null);
  const knowledgeRequestRef = useRef(0);
  const subtitleReprobeActiveRef = useRef(false);

  currentVideoContextRef.current = currentVideoContext;
  currentVideoSummaryRef.current = currentVideoSummary;
  currentVideoContextKeyRef.current = popupCurrentVideoContextKey(currentVideoContext);

  useEffect(() => {
    fetchStats(false);
    fetchCurrentVideoContext();
    const timer = window.setInterval(refreshSyncStatus, 1500);
    const storageChanges = chrome.storage?.onChanged;
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') {
        return;
      }
      const selectionChanged = Object.prototype.hasOwnProperty.call(
        changes,
        CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY,
      );
      const configChanged = Object.prototype.hasOwnProperty.call(changes, USER_CONFIG_STORAGE_KEY)
        && popupSummaryConfigRelevantChange(
          changes[USER_CONFIG_STORAGE_KEY]?.oldValue,
          changes[USER_CONFIG_STORAGE_KEY]?.newValue,
        );
      if (!selectionChanged && !configChanged) return;
      invalidateCurrentVideoOperations({
        selectionChanged,
        configChanged,
        userConfig: changes[USER_CONFIG_STORAGE_KEY]?.newValue,
      });
      if (selectionChanged) {
        void fetchCurrentVideoContext({ forceContextRefresh: true });
      } else if (configChanged) {
        void restoreCurrentVideoSummaryCache(currentVideoContextRef.current);
      }
    };
    storageChanges?.addListener?.(handleStorageChange);
    return () => {
      window.clearInterval(timer);
      storageChanges?.removeListener?.(handleStorageChange);
    };
  }, []);

  async function refreshSyncStatus() {
    try {
      const status = await requestSW<HistorySyncStatus>('GET_SYNC_STATUS');
      syncProgress.value = status.syncProgress;
      syncInProgress.value = status.syncProgress?.syncing ?? false;

      if (status.syncProgress?.syncing) {
        const data = await requestSW<QuickStats>('GET_QUICK_STATS');
        quickStats.value = data;
      }
    } catch {
      // The floating window can outlive a restarting service worker.
    }
  }

  async function fetchCurrentVideoContext(options: { forceContextRefresh?: boolean } = {}) {
    const requestId = currentVideoContextRequestRef.current + 1;
    currentVideoContextRequestRef.current = requestId;
    try {
      const context = await requestSW<CurrentVideoContextResult>(
        'GET_CURRENT_VIDEO_CONTEXT',
        options.forceContextRefresh ? { forceContextRefresh: true } : undefined,
      );
      if (currentVideoContextRequestRef.current !== requestId) return;
      commitCurrentVideoContext(context);
      void restoreCurrentVideoSummaryCache(context);
    } catch {
      if (currentVideoContextRequestRef.current !== requestId) return;
      commitCurrentVideoContext(null);
    }
  }

  async function fetchCurrentVideoSummary() {
    if (currentVideoSummary?.canGenerate === false) {
      setCurrentVideoActionError(
        currentVideoSummary.generationBlockedMessage ?? '当前不能生成或刷新，请先检查设置。',
      );
      return;
    }
    if (subtitleReprobeActiveRef.current) {
      setCurrentVideoActionError('正在重新检测字幕，请等待检测完成后再试。');
      return;
    }
    const action = beginCurrentVideoAction(summaryRequestRef);
    const context = currentVideoContextRef.current;
    const previousReady = currentVideoSummary?.status === 'ready'
      ? asPriorGeneratedCurrentVideoSummaryHighlights(currentVideoSummary)
      : null;
    let outboundRequestId: string | null = null;
    setCurrentVideoActionError(null);
    setSummaryLoading(true);
    setCurrentVideoSummary(previousReady ?? loadingCurrentVideoSummaryHighlights());
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!currentVideoActionIsCurrent(action, summaryRequestRef)) return;
      if (!authorization.ready) {
        setCurrentVideoSummary(previousReady);
        setCurrentVideoActionError(authorization.message);
        return;
      }
      if (!currentVideoActionIsCurrent(action, summaryRequestRef)) return;
      const requestId = createCurrentVideoFullTextRequestId('cvsh-popup');
      outboundRequestId = requestId;
      const requestParams = { ...authorization.params, requestId };
      activeSummaryRequestRef.current = {
        requestId,
        params: requestParams,
        contextKey: action.contextKey,
        selectionRevision: action.selectionRevision,
        selectedSourceIdentityKey: authorization.selectedSourceIdentityKey,
        previousReady,
      };
      const summary = await requestSW<CurrentVideoSummaryHighlightsResult>(
        'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
        requestParams,
      );
      if (!currentVideoActionIsCurrent(action, summaryRequestRef)) return;
      if (summary.status === 'ready') {
        setCurrentVideoSummary(summary);
      } else if (previousReady) {
        setCurrentVideoSummary(previousReady);
        setCurrentVideoActionError(summary.message);
      } else {
        setCurrentVideoSummary(summary);
      }
    } catch {
      if (!currentVideoActionIsCurrent(action, summaryRequestRef)) return;
      setCurrentVideoSummary(previousReady);
      setCurrentVideoActionError('摘要与亮点生成失败，请确认当前 B 站视频页仍然打开后重试。');
    } finally {
      if (
        outboundRequestId
        && activeSummaryRequestRef.current?.requestId === outboundRequestId
      ) {
        activeSummaryRequestRef.current = null;
        setSummaryLoading(false);
        if (!currentVideoActionIsCurrent(action, summaryRequestRef)) {
          void restoreCurrentVideoSummaryCache(currentVideoContextRef.current);
        }
      } else if (currentVideoActionIsCurrent(action, summaryRequestRef)) {
        setSummaryLoading(false);
      }
    }
  }

  async function restoreCurrentVideoSummaryCache(context: CurrentVideoContextResult | null) {
    const action = beginCurrentVideoAction(summaryRequestRef);
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!currentVideoActionIsCurrent(action, summaryRequestRef) || !authorization.ready) return;
      const result = await requestSW<CurrentVideoSummaryHighlightsResult>(
        'GET_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE',
        authorization.params,
      );
      if (!currentVideoActionIsCurrent(action, summaryRequestRef)) return;
      setCurrentVideoSummary((current) => (
        result.status === 'ready' || current?.status !== 'ready'
          ? result
          : current
      ));
    } catch {
      // Cache restore is opportunistic and must not block opening the popup.
    }
  }

  async function fetchVideoKnowledge() {
    if (subtitleReprobeActiveRef.current) {
      setCurrentVideoActionError('正在重新检测字幕，请等待检测完成后再试。');
      return;
    }
    const action = beginCurrentVideoAction(knowledgeRequestRef);
    const context = currentVideoContextRef.current;
    setCurrentVideoActionError(null);
    setKnowledgeLoading(true);
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!currentVideoActionIsCurrent(action, knowledgeRequestRef)) return;
      if (!authorization.ready) {
        setVideoKnowledge(null);
        setCurrentVideoActionError(authorization.message);
        return;
      }
      if (!currentVideoActionIsCurrent(action, knowledgeRequestRef)) return;
      const result = await requestSW<VideoKnowledgeResult>(
        'GET_VIDEO_KNOWLEDGE',
        authorization.params,
      );
      if (!currentVideoActionIsCurrent(action, knowledgeRequestRef)) return;
      setVideoKnowledge(result);
    } catch {
      if (!currentVideoActionIsCurrent(action, knowledgeRequestRef)) return;
      setVideoKnowledge(null);
      setCurrentVideoActionError('知识节点读取失败，请确认当前 B 站视频页仍然打开后重试。');
    } finally {
      if (currentVideoActionIsCurrent(action, knowledgeRequestRef)) setKnowledgeLoading(false);
    }
  }

  async function reprobeCurrentVideoSubtitle() {
    invalidateCurrentVideoOperations();
    currentVideoContextRequestRef.current += 1;
    const requestId = subtitleReprobeRequestRef.current + 1;
    subtitleReprobeRequestRef.current = requestId;
    const operationRevision = currentVideoOperationRevisionRef.current;
    subtitleReprobeActiveRef.current = true;
    setSubtitleProbeLoading(true);
    setSubtitleProbeStatus(null);
    setCurrentVideoActionError(null);
    try {
      const firstContext = await requestSW<CurrentVideoContextResult>('GET_CURRENT_VIDEO_CONTEXT', {
        forceContextRefresh: true,
        forceSubtitleProbe: true,
      });
      if (!subtitleReprobeIsCurrent(requestId, operationRevision)) return;
      commitCurrentVideoContext(firstContext, true);
      if (firstContext.kind !== 'video' || firstContext.cid === null) {
        const diagnostics = buildCurrentVideoSubtitleDiagnostics(firstContext);
        setSubtitleProbeStatus(`${diagnostics.title}：${diagnostics.message}`);
        return;
      }

      const transcriptEvidence = await requestSW<CurrentVideoTranscriptEvidenceState>('GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE', {
        forceContextRefresh: true,
        forceSubtitleProbe: true,
      });
      if (!subtitleReprobeIsCurrent(requestId, operationRevision)) return;
      const refreshedContext = await requestSW<CurrentVideoContextResult>('GET_CURRENT_VIDEO_CONTEXT');
      if (!subtitleReprobeIsCurrent(requestId, operationRevision)) return;
      if (!popupCurrentVideoExactIdentityMatches(firstContext, refreshedContext)) {
        commitCurrentVideoContext(refreshedContext, true);
        setSubtitleProbeStatus('检测期间当前视频已变化，请在新页面重新操作。');
        return;
      }
      if (!popupTranscriptEvidenceMatchesContext(transcriptEvidence, firstContext)) {
        commitCurrentVideoContext(refreshedContext, true);
        setSubtitleProbeStatus('字幕检测结果与当前页面不一致，请重新检测。');
        return;
      }
      const contextWithEvidence = { ...refreshedContext, transcriptEvidence };
      commitCurrentVideoContext(contextWithEvidence, true);
      const diagnostics = buildCurrentVideoSubtitleDiagnostics(contextWithEvidence);
      setSubtitleProbeStatus(`${diagnostics.title}：${diagnostics.message}`);
    } catch {
      if (!subtitleReprobeIsCurrent(requestId, operationRevision)) return;
      setSubtitleProbeStatus('重新检测失败：请确认当前 B 站视频页仍然打开，并在播放器里开启中文 AI 字幕后重试。');
    } finally {
      if (subtitleReprobeIsCurrent(requestId, operationRevision)) {
        subtitleReprobeActiveRef.current = false;
        setSubtitleProbeLoading(false);
      }
    }
  }

  function cancelCurrentVideoSummary() {
    const activeRequest = activeSummaryRequestRef.current;
    activeSummaryRequestRef.current = null;
    summaryRequestRef.current += 1;
    setSummaryLoading(false);
    const activeRequestStillCurrent = activeRequest
      ? popupActiveSummaryRequestStillMatchesCurrent(activeRequest)
      : true;
    const retained = activeRequestStillCurrent
      ? activeRequest?.previousReady ?? (
          currentVideoSummary?.status === 'ready'
            ? asPriorGeneratedCurrentVideoSummaryHighlights(currentVideoSummary)
            : null
        )
      : null;
    if (retained) {
      setCurrentVideoSummary(retained);
      setCurrentVideoActionError('本次生成已取消，此前结果保持不变。');
    } else if (activeRequest && !activeRequestStillCurrent) {
      setCurrentVideoSummary(null);
      setCurrentVideoActionError(null);
      void restoreCurrentVideoSummaryCache(currentVideoContextRef.current);
    } else {
      setCurrentVideoSummary(cancelledCurrentVideoSummaryHighlights(
        currentVideoSummaryHighlightsTitle(currentVideoContextRef.current),
        currentVideoSummary?.model ?? null,
        currentVideoSummary?.textSize ?? { lineCount: 0, charCount: null, utf8Bytes: 0 },
      ));
      setCurrentVideoActionError(null);
    }
    if (activeRequest) {
      void requestSW('CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS', activeRequest.params).catch(() => null);
    }
  }

  function popupActiveSummaryRequestStillMatchesCurrent(
    activeRequest: PopupActiveSummaryHighlightsRequest,
  ): boolean {
    return activeRequest.contextKey === currentVideoContextKeyRef.current
      && activeRequest.selectionRevision === primaryTextSelectionRevisionRef.current
      && activeRequest.selectedSourceIdentityKey === popupCurrentVideoAvailablePrimarySourceIdentityKey(
        currentVideoContextRef.current,
      );
  }

  function currentVideoScopeSnapshot(): PopupCurrentVideoScopeSnapshot {
    return {
      contextKey: currentVideoContextKeyRef.current,
      selectionRevision: primaryTextSelectionRevisionRef.current,
      operationRevision: currentVideoOperationRevisionRef.current,
    };
  }

  function beginCurrentVideoAction(requestRef: { current: number }): PopupCurrentVideoActionSnapshot {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    return { ...currentVideoScopeSnapshot(), requestId };
  }

  function currentVideoActionIsCurrent(
    action: PopupCurrentVideoActionSnapshot,
    requestRef: { current: number },
  ): boolean {
    const scope = currentVideoScopeSnapshot();
    return requestRef.current === action.requestId
      && scope.contextKey === action.contextKey
      && scope.selectionRevision === action.selectionRevision
      && scope.operationRevision === action.operationRevision;
  }

  function subtitleReprobeIsCurrent(requestId: number, operationRevision: number): boolean {
    return subtitleReprobeActiveRef.current
      && subtitleReprobeRequestRef.current === requestId
      && currentVideoOperationRevisionRef.current === operationRevision;
  }

  function invalidateCurrentVideoOperations({
    selectionChanged = false,
    configChanged = false,
    userConfig = null,
  }: {
    selectionChanged?: boolean;
    configChanged?: boolean;
    userConfig?: unknown;
  } = {}): void {
    if (selectionChanged) {
      primaryTextSelectionRevisionRef.current += 1;
      setPrimaryTextSelectionRevision(primaryTextSelectionRevisionRef.current);
    }
    const activeSummaryRequest = activeSummaryRequestRef.current;
    const retainedSummary = configChanged
      ? popupSummaryAfterLiveConfigChange(
          selectionChanged
            ? null
            : currentVideoSummaryRef.current ?? (
                activeSummaryRequest && popupActiveSummaryRequestStillMatchesCurrent(activeSummaryRequest)
                  ? activeSummaryRequest.previousReady
                  : null
              ),
          userConfig,
        )
      : null;
    if (configChanged && activeSummaryRequest) {
      activeSummaryRequestRef.current = null;
      void requestSW('CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS', activeSummaryRequest.params).catch(() => null);
    }
    currentVideoOperationRevisionRef.current += 1;
    setCurrentVideoOperationRevision(currentVideoOperationRevisionRef.current);
    summaryRequestRef.current += 1;
    knowledgeRequestRef.current += 1;
    subtitleReprobeRequestRef.current += 1;
    subtitleReprobeActiveRef.current = false;
    if (!activeSummaryRequestRef.current) setSummaryLoading(false);
    setKnowledgeLoading(false);
    setSubtitleProbeLoading(false);
    setCurrentVideoSummary(retainedSummary);
    setVideoKnowledge(null);
    setSubtitleProbeStatus(null);
    setCurrentVideoActionError(null);
  }

  function commitCurrentVideoContext(
    context: CurrentVideoContextResult | null,
    scopeAlreadyInvalidated = false,
  ): void {
    const nextContextKey = popupCurrentVideoContextKey(context);
    if (!scopeAlreadyInvalidated && nextContextKey !== currentVideoContextKeyRef.current) {
      invalidateCurrentVideoOperations();
    }
    currentVideoContextRef.current = context;
    currentVideoContextKeyRef.current = nextContextKey;
    setCurrentVideoContext(context);
  }

  function openSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html#settings') });
  }

  async function fetchStats(forceSync = true) {
    loading.value = quickStats.value === null;
    error.value = null;
    syncInProgress.value = false;
    try {
      if (forceSync) {
        lastSyncResult.value = await requestSW<SyncNowResult>('SYNC_NOW', {
          mode: 'full',
          maxPages: syncPageLimit.value,
        });
        await refreshSyncStatus();
      }
      const data = await requestSW<QuickStats>('GET_QUICK_STATS');
      quickStats.value = data;
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes('HISTORY_SYNC_IN_PROGRESS')) {
        await refreshSyncStatus();
        syncInProgress.value = true;
        const data = await requestSW<QuickStats>('GET_QUICK_STATS');
        quickStats.value = data;
        return;
      }
      error.value = message;
    } finally {
      loading.value = false;
    }
  }

  const isNotLoggedIn = error.value?.includes('NOT_LOGGED_IN') || error.value?.includes('-101');
  const progress = syncProgress.value;
  const progressPercent = progress
    ? progress.reachedEnd
      ? 100
      : progress.fetchedPages > 0
        ? Math.max(1, Math.min(99, Math.round((progress.fetchedPages / Math.max(progress.pageLimit, 1)) * 100)))
        : 0
    : 0;
  const elapsedSeconds = progress?.startedAt ? Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000)) : 0;

  async function stopSync() {
    if (syncProgress.value) {
      syncProgress.value = {
        ...syncProgress.value,
        currentTask: '正在停止同步...',
      };
    }
    await requestSW('CANCEL_SYNC');
    await refreshSyncStatus();
  }

  async function runTailProbe() {
    setTailProbeLoading(true);
    setTailProbeError(null);
    try {
      const report = await requestSW<HistoryTailProbeReport>('PROBE_HISTORY_TAIL', {
        maxPages: syncPageLimit.value,
      });
      setTailProbeReport(report);
    } catch (e) {
      setTailProbeError((e as Error).message);
    } finally {
      setTailProbeLoading(false);
    }
  }

  return (
    <div className="popup-shell">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 12px', gap: '8px' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{
            fontSize: '16px',
            fontWeight: 700,
            color: '#FB7299',
            margin: 0,
          }}>
            Bili-Bill
          </h1>
          <p style={{ margin: '2px 0 0', color: '#61666D', fontSize: '10px' }}>
            个人内容账单
          </p>
        </div>
        <button
          onClick={() => fetchStats(true)}
          disabled={loading.value}
          title="全量同步并刷新数据"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#61666D',
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px 4px',
            opacity: loading.value ? 0.5 : 1,
          }}
        >
          ↻
        </button>
      </div>
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '8px',
        marginTop: '8px',
      }}>
        <select
          value={syncPageLimit.value}
          onChange={(e) => {
            syncPageLimit.value = Number((e.currentTarget as HTMLSelectElement).value);
          }}
          title={syncInProgress.value ? '当前同步不受影响，修改会应用到下一次同步' : '限制本次最多同步的历史页数，每页约 30 条'}
          style={{
            background: '#F1F2F3',
            color: '#18191C',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: '6px',
            fontSize: '11px',
            padding: '4px 6px',
          }}
        >
          <option value={10}>最多 300 条</option>
          <option value={50}>最多 1500 条</option>
          <option value={100}>最多 3000 条</option>
          <option value={300}>最多 9000 条</option>
        </select>
        {syncInProgress.value && (
          <button
            onClick={stopSync}
            style={{
              background: '#FFF4E5',
              color: '#955600',
              border: '1px solid rgba(255, 179, 71, 0.35)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '11px',
              padding: '4px 8px',
            }}
          >
            停止同步
          </button>
        )}
      </div>
      <OpenDashboard />
      <CurrentVideoAssistantStatus
        context={currentVideoContext}
        summary={currentVideoSummary}
        knowledge={videoKnowledge}
        loading={summaryLoading}
        knowledgeLoading={knowledgeLoading}
        subtitleProbeLoading={subtitleProbeLoading}
        subtitleProbeStatus={subtitleProbeStatus}
        currentVideoActionError={currentVideoActionError}
        onRefresh={fetchCurrentVideoSummary}
        onCancel={cancelCurrentVideoSummary}
        onReprobeSubtitle={reprobeCurrentVideoSubtitle}
        onRefreshKnowledge={fetchVideoKnowledge}
        onOpenSettings={openSettings}
        getCurrentVideoActionScope={currentVideoScopeSnapshot}
        operationScopeKey={popupCurrentVideoContextKey(currentVideoContext)}
        primaryTextSelectionRevision={primaryTextSelectionRevision}
        currentVideoOperationRevision={currentVideoOperationRevision}
      />

      {loading.value && (
        <div style={{ textAlign: 'center', padding: '40px', color: '#61666D' }}>
          加载中...
        </div>
      )}

      {error.value && isNotLoggedIn && (
        <div style={{ textAlign: 'center', padding: '30px 20px' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>🔐</div>
          <p style={{ color: '#61666D', fontSize: '14px', marginBottom: '16px' }}>
            请先登录B站账号
          </p>
          <button
            onClick={() => chrome.tabs.create({ url: 'https://www.bilibili.com' })}
            style={{
              padding: '8px 24px',
              background: '#FB7299',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            打开B站登录 →
          </button>
        </div>
      )}

      {error.value && !isNotLoggedIn && (
        <div style={{ textAlign: 'center', padding: '20px', color: '#B42338' }}>
          <p>{error.value}</p>
          <button
            onClick={() => fetchStats(true)}
            style={{
              marginTop: '8px',
              padding: '6px 16px',
              background: '#FB7299',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            重试
          </button>
        </div>
      )}

      {!loading.value && !error.value && quickStats.value && (
        <>
          <div style={{ marginBottom: '4px' }}>
            <p style={{
              textAlign: 'center',
              fontSize: '12px',
              color: '#61666D',
              marginBottom: '4px',
            }}>
              今日进度：{Math.round(quickStats.value.todayWatchTime / 60)} / {Math.round(quickStats.value.dailyGoal / 60)} 分钟
            </p>
            <ProgressRing />
          </div>
          {lastSyncResult.value && (
            <p style={{
              textAlign: 'center',
              fontSize: '11px',
              color: '#61666D',
              margin: '0 12px 8px',
            }}>
              {lastSyncResult.value.mode === 'full' ? '全量' : '增量'}同步：扫描 {lastSyncResult.value.fetchedPages} 页 / {lastSyncResult.value.fetchedCount} 条，新增 {lastSyncResult.value.insertedCount} 条，更新 {lastSyncResult.value.updatedCount} 条，停止原因：{lastSyncResult.value.stoppedReason}
            </p>
          )}
          {syncInProgress.value && (
            <div style={{
              margin: '0 18px 12px',
              padding: '10px 12px',
              border: '1px solid rgba(255, 179, 71, 0.28)',
              borderRadius: '8px',
              background: 'rgba(255, 179, 71, 0.08)',
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '12px',
                color: '#955600',
                fontSize: '11px',
                fontWeight: 700,
                marginBottom: '8px',
              }}>
                <span>历史全量同步进行中</span>
                <span>{progressPercent}%</span>
              </div>
              <div style={{
                height: '6px',
                background: 'rgba(255,255,255,0.12)',
                borderRadius: '999px',
                overflow: 'hidden',
                marginBottom: '8px',
              }}>
                <div style={{
                  width: `${progressPercent}%`,
                  height: '100%',
                  background: '#955600',
                  borderRadius: '999px',
                  transition: 'width 180ms ease',
                }} />
              </div>
              <p style={{
                color: '#61666D',
                fontSize: '10px',
                lineHeight: 1.5,
                margin: 0,
              }}>
                已扫描 {progress?.fetchedPages ?? 0} / {progress?.pageLimit ?? 0} 页，获取 {progress?.fetchedCount ?? 0} 条，新增 {progress?.insertedCount ?? 0} 条，更新 {progress?.updatedCount ?? 0} 条，已运行 {elapsedSeconds}s。当前显示本地已有数据。
                <br />
                {progress?.currentTask ?? '正在准备同步'}
              </p>
              <button
                onClick={stopSync}
                style={{
                  marginTop: '8px',
                  width: '100%',
                  background: 'rgba(255, 179, 71, 0.12)',
                  color: '#955600',
                  border: '1px solid rgba(255, 179, 71, 0.32)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '6px 8px',
                }}
              >
                停止本次同步
              </button>
            </div>
          )}
          <p style={{
            textAlign: 'center',
            fontSize: '11px',
            color: '#61666D',
            margin: '0 12px 4px',
          }}>
            本周已计入 PC {Math.round(quickStats.value.weeklyLocalPcWatchTime / 60)} 分钟，覆盖 {quickStats.value.weeklyLocalPcDays} 天
          </p>
          <p style={{
            textAlign: 'center',
            fontSize: '10px',
            color: '#61666D',
            margin: '0 12px 8px',
          }}>
            B站历史进度为跨设备估算，本机 PC 播放为实测增强
          </p>
          <QuickStatsPanel />
        </>
      )}

      {!loading.value && !error.value && !quickStats.value && (
        <div style={{ textAlign: 'center', padding: '40px', color: '#61666D' }}>
          暂无数据
          <br />
          <span style={{ fontSize: '12px' }}>去B站看几个视频后回来查看</span>
        </div>
      )}
      <details className="popup-diagnostics" style={{
        margin: '8px 18px 12px',
        padding: '10px 12px',
        border: '1px solid rgba(0, 161, 214, 0.25)',
        borderRadius: '8px',
        background: 'rgba(0, 161, 214, 0.08)',
      }}>
        <summary style={{
          color: '#007FA8',
          fontSize: '12px',
          fontWeight: 700,
          marginBottom: '4px',
        }}>
          同步诊断
        </summary>
        <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.5 }}>
          仅用于诊断。使用当前运行时登录状态，有限拉取历史页，不保存历史明细。
        </div>
        <button
          onClick={runTailProbe}
          disabled={tailProbeLoading || syncInProgress.value}
          style={{
            marginTop: '8px',
            background: 'rgba(0, 161, 214, 0.16)',
            color: '#007FA8',
            border: '1px solid rgba(0, 161, 214, 0.32)',
            borderRadius: '6px',
            cursor: tailProbeLoading || syncInProgress.value ? 'default' : 'pointer',
            fontSize: '11px',
            padding: '6px 8px',
            opacity: tailProbeLoading || syncInProgress.value ? 0.7 : 1,
          }}
        >
          {tailProbeLoading ? '诊断中...' : '诊断历史尾页'}
        </button>
        {tailProbeError && (
          <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, marginTop: '8px' }}>
            {tailProbeError}
          </div>
        )}
        {tailProbeReport && (
          <div style={{ color: '#007FA8', fontSize: '10px', lineHeight: 1.55, marginTop: '8px', whiteSpace: 'pre-wrap' }}>
            {formatTailProbeReport(tailProbeReport)}
          </div>
        )}
      </details>

    </div>
  );
}

function CurrentVideoAssistantStatus({
  context,
  summary,
  knowledge,
  loading,
  knowledgeLoading,
  subtitleProbeLoading,
  subtitleProbeStatus,
  currentVideoActionError,
  onRefresh,
  onCancel,
  onReprobeSubtitle,
  onRefreshKnowledge,
  onOpenSettings,
  getCurrentVideoActionScope,
  operationScopeKey,
  primaryTextSelectionRevision,
  currentVideoOperationRevision,
}: {
  context: CurrentVideoContextResult | null;
  summary: CurrentVideoSummaryHighlightsResult | null;
  knowledge: VideoKnowledgeResult | null;
  loading: boolean;
  knowledgeLoading: boolean;
  subtitleProbeLoading: boolean;
  subtitleProbeStatus: string | null;
  currentVideoActionError: string | null;
  onRefresh: () => void;
  onCancel: () => void;
  onReprobeSubtitle: () => void;
  onRefreshKnowledge: () => void;
  onOpenSettings: () => void;
  getCurrentVideoActionScope: () => PopupCurrentVideoScopeSnapshot;
  operationScopeKey: string;
  primaryTextSelectionRevision: number;
  currentVideoOperationRevision: number;
}) {
  const isVideo = context?.kind === 'video';
  const [segmentQuery, setSegmentQuery] = useState('');
  const [segmentResult, setSegmentResult] = useState<CurrentVideoSegmentRetrievalResult | null>(null);
  const [segmentLoading, setSegmentLoading] = useState(false);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [segmentPreviewCandidateId, setSegmentPreviewCandidateId] = useState<string | null>(null);
  const [segmentJumpStatus, setSegmentJumpStatus] = useState<string | null>(null);
  const [segmentReturnAvailable, setSegmentReturnAvailable] = useState(false);
  const [segmentJumpLoading, setSegmentJumpLoading] = useState(false);
  const [segmentReturnLoading, setSegmentReturnLoading] = useState(false);
  const [fullTextQaResult, setFullTextQaResult] = useState<CurrentVideoFullTextQaResult | null>(null);
  const [fullTextQaActiveSessionIds, setFullTextQaActiveSessionIds] = useState<string[]>([]);
  const [fullTextQaErrors, setFullTextQaErrors] = useState<Record<string, string>>({});
  const [fullTextQaPreviewCitationId, setFullTextQaPreviewCitationId] = useState<string | null>(null);
  const [fullTextQaJumpStatus, setFullTextQaJumpStatus] = useState<string | null>(null);
  const [fullTextQaReturnAvailable, setFullTextQaReturnAvailable] = useState(false);
  const [fullTextQaJumpLoading, setFullTextQaJumpLoading] = useState(false);
  const [fullTextQaReturnLoading, setFullTextQaReturnLoading] = useState(false);
  const [fullTextQaSessions, setFullTextQaSessions] = useState<CurrentVideoQaSessionsView | null>(null);
  const [fullTextQaSessionsLoading, setFullTextQaSessionsLoading] = useState(false);
  const [fullTextQaSessionsError, setFullTextQaSessionsError] = useState<string | null>(null);
  const [fullTextQaActiveSessionId, setFullTextQaActiveSessionId] = useState<string | null>(null);
  const fullTextQaActiveSessionIdRef = useRef<string | null>(null);
  const [highlightPreview, setHighlightPreview] = useState<CurrentVideoSummaryHighlightBinding | null>(null);
  const [highlightJumpStatus, setHighlightJumpStatus] = useState<string | null>(null);
  const [highlightReturnAvailable, setHighlightReturnAvailable] = useState(false);
  const [highlightJumpLoading, setHighlightJumpLoading] = useState(false);
  const [highlightReturnLoading, setHighlightReturnLoading] = useState(false);
  const segmentSearchRequestRef = useRef(0);
  const timestampRequestRef = useRef(0);
  const fullTextQaSessionsRequestRef = useRef(0);
  const segmentSearchBusyRef = useRef(false);
  const timestampBusyRef = useRef(false);
  const fullTextQaActiveRequestsRef = useRef<Map<string, {
    sessionId: string;
    requestId: string;
    turnId: string;
    params: Record<string, unknown>;
  }>>(new Map());
  const subtitleDiagnostics = buildCurrentVideoSubtitleDiagnostics(context, {
    refreshing: subtitleProbeLoading,
  });

  useEffect(() => {
    if (isVideo) void loadFullTextQaSessions(fullTextQaActiveSessionId);
  }, [isVideo]);

  useEffect(() => {
    segmentSearchRequestRef.current += 1;
    timestampRequestRef.current += 1;
    segmentSearchBusyRef.current = false;
    timestampBusyRef.current = false;
    setSegmentLoading(false);
    setSegmentJumpLoading(false);
    setSegmentReturnLoading(false);
    setHighlightJumpLoading(false);
    setHighlightReturnLoading(false);
    setSegmentResult(null);
    setSegmentError(null);
    setSegmentPreviewCandidateId(null);
    setSegmentJumpStatus(null);
    setSegmentReturnAvailable(false);
    setFullTextQaErrors({});
    setFullTextQaPreviewCitationId(null);
    setFullTextQaJumpStatus(null);
    setFullTextQaReturnAvailable(false);
    setFullTextQaJumpLoading(false);
    setFullTextQaReturnLoading(false);
    setHighlightPreview(null);
    setHighlightJumpStatus(null);
    setHighlightReturnAvailable(false);
  }, [operationScopeKey, primaryTextSelectionRevision, currentVideoOperationRevision]);

  async function confirmHighlightJump(binding: CurrentVideoSummaryHighlightBinding) {
    if (
      !summary
      || summary.status !== 'ready'
      || !summary.model
      || subtitleProbeLoading
      || segmentSearchBusyRef.current
      || timestampBusyRef.current
    ) return;
    const currentBinding = currentVideoSummaryHighlightBindingFromResult(summary, binding.highlightId);
    if (!currentVideoSummaryHighlightBindingsEqual(currentBinding, binding)) {
      setHighlightPreview(null);
      setHighlightJumpStatus('亮点结果已更新，请重新预览后再跳转。');
      return;
    }
    const action = beginScopedAction(timestampRequestRef);
    timestampBusyRef.current = true;
    setHighlightJumpLoading(true);
    setHighlightReturnLoading(false);
    setHighlightJumpStatus('正在确认跳转...');
    setHighlightReturnAvailable(false);
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      if (!authorization.ready) {
        setHighlightJumpStatus(authorization.message);
        return;
      }
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      const result = await requestSW<CurrentVideoTimestampJumpResponse>('REQUEST_CURRENT_VIDEO_HIGHLIGHT_JUMP', {
        ...binding,
        confirmed: true,
        ...authorization.params,
      });
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setHighlightJumpStatus(result.ok
        ? '已跳到亮点位置，可返回原位置。'
        : '亮点结果或页面状态已变化，请重新预览后再试。');
      setHighlightReturnAvailable(result.ok && result.returnPointSeconds !== null);
      if (!result.ok) setHighlightPreview(null);
    } catch {
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setHighlightJumpStatus('亮点跳转失败，请确认当前 B 站视频页仍然打开后重试。');
      setHighlightReturnAvailable(false);
    } finally {
      if (scopedActionIsCurrent(action, timestampRequestRef)) {
        timestampBusyRef.current = false;
        setHighlightJumpLoading(false);
      }
    }
  }

  async function returnHighlightJump() {
    if (
      !highlightReturnAvailable
      || subtitleProbeLoading
      || segmentSearchBusyRef.current
      || timestampBusyRef.current
    ) return;
    const action = beginScopedAction(timestampRequestRef);
    timestampBusyRef.current = true;
    setHighlightJumpLoading(false);
    setHighlightReturnLoading(true);
    setHighlightJumpStatus('正在返回原位置...');
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      if (!authorization.ready) {
        setHighlightJumpStatus(authorization.message);
        setHighlightReturnAvailable(false);
        return;
      }
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      const result = await requestSW<CurrentVideoTimestampReturnResponse>(
        'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
        authorization.params,
      );
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setHighlightJumpStatus(result.ok
        ? '已返回原位置。'
        : '未能返回原位置，请回到当前视频页确认页面和播放器状态后重试。');
      if (result.ok) setHighlightReturnAvailable(false);
    } catch {
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setHighlightJumpStatus('返回原位置失败，请确认当前 B 站视频页仍然打开后重试。');
    } finally {
      if (scopedActionIsCurrent(action, timestampRequestRef)) {
        timestampBusyRef.current = false;
        setHighlightReturnLoading(false);
      }
    }
  }

  function updateFullTextQaActiveSessionId(sessionId: string | null) {
    fullTextQaActiveSessionIdRef.current = sessionId;
    setFullTextQaActiveSessionId(sessionId);
  }

  async function loadFullTextQaSessions(sessionId?: string | null, options: { activate?: boolean } = {}) {
    const requestId = fullTextQaSessionsRequestRef.current + 1;
    fullTextQaSessionsRequestRef.current = requestId;
    setFullTextQaSessionsLoading(true);
    setFullTextQaSessionsError(null);
    try {
      const targetSessionId = sessionId ?? fullTextQaActiveSessionIdRef.current ?? fullTextQaActiveSessionId;
      const view = await requestSW<CurrentVideoQaSessionsView>('GET_CURRENT_VIDEO_QA_SESSIONS', {
        sessionId: targetSessionId,
      });
      if (fullTextQaSessionsRequestRef.current !== requestId) return;
      setFullTextQaSessions(view);
      if (options.activate !== false) {
        updateFullTextQaActiveSessionId(view.activeSessionId ?? targetSessionId ?? null);
      }
    } catch {
      if (fullTextQaSessionsRequestRef.current !== requestId) return;
      setFullTextQaSessionsError('本地问答会话读取失败，请稍后重试。');
    } finally {
      if (fullTextQaSessionsRequestRef.current === requestId) {
        setFullTextQaSessionsLoading(false);
      }
    }
  }

  function activeFullTextQaSession(): CurrentVideoQaSessionRecord | null {
    const activeId = fullTextQaActiveSessionId ?? fullTextQaSessions?.activeSessionId ?? null;
    if (!activeId || fullTextQaSessions?.activeSession?.sessionId !== activeId) return null;
    return fullTextQaSessions.activeSession;
  }

  function refreshFullTextQaActiveSessionIds() {
    setFullTextQaActiveSessionIds(Array.from(fullTextQaActiveRequestsRef.current.keys()));
  }

  function hasActiveFullTextQaRequest(sessionId: string | null): boolean {
    return Boolean(sessionId && fullTextQaActiveRequestsRef.current.has(sessionId));
  }

  function activeFullTextQaRequestForSession(sessionId: string | null) {
    return sessionId ? fullTextQaActiveRequestsRef.current.get(sessionId) ?? null : null;
  }

  function fullTextQaErrorForSession(sessionId: string | null): string | null {
    return fullTextQaErrors[sessionId?.trim() || 'draft'] ?? null;
  }

  function setFullTextQaErrorForSession(sessionId: string | null, message: string | null) {
    const key = sessionId?.trim() || 'draft';
    setFullTextQaErrors(current => {
      if ((current[key] ?? null) === message) return current;
      const next = { ...current };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }

  async function renameFullTextQaSession(session: CurrentVideoQaSessionRecord | null) {
    if (!session) return;
    const title = window.prompt('输入新的会话标题', session.title)?.replace(/\s+/g, ' ').trim();
    if (!title) return;
    try {
      const view = await requestSW<CurrentVideoQaSessionsView>('RENAME_CURRENT_VIDEO_QA_SESSION', {
        sessionId: session.sessionId,
        title,
      });
      setFullTextQaSessions(view);
      updateFullTextQaActiveSessionId(session.sessionId);
    } catch {
      setFullTextQaSessionsError('会话重命名失败，请稍后重试。');
    }
  }

  async function deleteFullTextQaSession(session: CurrentVideoQaSessionRecord | null) {
    if (!session) return;
    if (!window.confirm('删除这个本地问答会话？')) return;
    try {
      const view = await requestSW<CurrentVideoQaSessionsView>('DELETE_CURRENT_VIDEO_QA_SESSION', {
        sessionId: session.sessionId,
      });
      setFullTextQaSessions(view);
      setFullTextQaErrorForSession(session.sessionId, null);
      updateFullTextQaActiveSessionId(view.activeSessionId);
      const active = fullTextQaActiveRequestsRef.current.get(session.sessionId);
      if (active) {
        fullTextQaActiveRequestsRef.current.delete(session.sessionId);
        refreshFullTextQaActiveSessionIds();
        void requestSW('CANCEL_CURRENT_VIDEO_FULL_TEXT_QA', active.params).catch(() => undefined);
      }
    } catch {
      setFullTextQaSessionsError('会话删除失败，请稍后重试。');
    }
  }

  async function askCurrentVideoFullText(retryTurnId?: string, retryQuestion?: string) {
    const question = (retryQuestion ?? segmentQuery).replace(/\s+/g, ' ').trim();
    const existingSessionId = fullTextQaActiveSessionIdRef.current
      ?? fullTextQaActiveSessionId;
    if (!question) {
      setFullTextQaErrorForSession(existingSessionId, '请输入一个关于当前视频的问题。');
      return;
    }
    const sessionId = existingSessionId
      ?? createCurrentVideoFullTextRequestId('cvqa-session');
    if (subtitleProbeLoading || hasActiveFullTextQaRequest(sessionId) || timestampBusyRef.current) return;

    setFullTextQaErrorForSession(sessionId, null);
    setFullTextQaPreviewCitationId(null);
    setFullTextQaJumpStatus(null);
    setFullTextQaReturnAvailable(false);
    updateFullTextQaActiveSessionId(sessionId);
    const requestId = createCurrentVideoFullTextRequestId('cvqa-popup');
    const turnId = retryTurnId?.trim() || createCurrentVideoFullTextRequestId('cvqa-turn');
    if (retryQuestion !== undefined) setSegmentQuery(question);
    const baseParams = { sessionId, requestId, turnId, question };
    fullTextQaActiveRequestsRef.current.set(sessionId, { sessionId, requestId, turnId, params: baseParams });
    refreshFullTextQaActiveSessionIds();
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (activeFullTextQaRequestForSession(sessionId)?.requestId !== requestId) return;
      if (!authorization.ready) {
        setFullTextQaErrorForSession(sessionId, authorization.message);
        return;
      }
      const params = { ...baseParams, ...authorization.params };
      fullTextQaActiveRequestsRef.current.set(sessionId, { sessionId, requestId, turnId, params });
      refreshFullTextQaActiveSessionIds();
      const result = await requestSW<CurrentVideoFullTextQaResult>('ASK_CURRENT_VIDEO_FULL_TEXT', params);
      if (
        activeFullTextQaRequestForSession(sessionId)?.requestId !== requestId
        || result.sessionId !== sessionId
        || result.requestId !== requestId
        || result.turnId !== turnId
      ) return;
      setFullTextQaResult(result);
      await loadFullTextQaSessions(fullTextQaActiveSessionIdRef.current ?? sessionId, { activate: false });
    } catch {
      if (activeFullTextQaRequestForSession(sessionId)?.requestId !== requestId) return;
      setFullTextQaErrorForSession(sessionId, '回答失败，问题已保留。请确认当前视频页和 AI 设置后重试。');
    } finally {
      if (activeFullTextQaRequestForSession(sessionId)?.requestId === requestId) {
        fullTextQaActiveRequestsRef.current.delete(sessionId);
        refreshFullTextQaActiveSessionIds();
      }
      void loadFullTextQaSessions(fullTextQaActiveSessionIdRef.current ?? sessionId, { activate: false });
    }
  }

  function cancelCurrentVideoFullTextQa() {
    const activeSessionId = fullTextQaActiveSessionId ?? fullTextQaSessions?.activeSessionId ?? null;
    const active = activeFullTextQaRequestForSession(activeSessionId);
    if (!active) return;
    fullTextQaActiveRequestsRef.current.delete(active.sessionId);
    refreshFullTextQaActiveSessionIds();
    setFullTextQaErrorForSession(active.sessionId, '本次回答已取消，问题已保留。');
    setFullTextQaPreviewCitationId(null);
    setFullTextQaJumpStatus(null);
    setFullTextQaReturnAvailable(false);
    void requestSW('CANCEL_CURRENT_VIDEO_FULL_TEXT_QA', active.params).catch(() => undefined);
  }

  async function confirmFullTextQaCitationJump(citation: CurrentVideoFullTextQaCitation) {
    if (
      fullTextQaPreviewCitationId !== fullTextQaPreviewKey(citation.binding)
      || subtitleProbeLoading
      || hasActiveFullTextQaRequest(fullTextQaActiveSessionId ?? fullTextQaSessions?.activeSessionId ?? null)
      || timestampBusyRef.current
    ) return;
    const activeSession = activeFullTextQaSession();
    const sessionCitation = activeSession?.turns
      .flatMap(turn => turn.citations)
      .find(item => fullTextQaCitationBindingsEqual(item.binding, citation.binding));
    const legacyCitation = fullTextQaResult?.citations.find(item =>
      fullTextQaCitationBindingsEqual(item.binding, citation.binding)
    );
    const currentCitation = sessionCitation ?? legacyCitation ?? null;
    if (!currentCitation) {
      setFullTextQaPreviewCitationId(null);
      setFullTextQaJumpStatus('引用结果已变化，请重新预览后再跳转。');
      return;
    }
    const action = beginScopedAction(timestampRequestRef);
    timestampBusyRef.current = true;
    setFullTextQaJumpLoading(true);
    setFullTextQaReturnLoading(false);
    setFullTextQaReturnAvailable(false);
    setFullTextQaJumpStatus('正在确认跳转...');
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      if (!authorization.ready) {
        setFullTextQaJumpStatus(authorization.message);
        return;
      }
      const result = await requestSW<CurrentVideoTimestampJumpResponse>(
        'REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP',
        { ...citation.binding, confirmed: true, ...authorization.params },
      );
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setFullTextQaJumpStatus(result.ok
        ? '已跳到引用位置，可返回原位置。'
        : '引用结果或页面状态已变化，请重新提交问题后再试。');
      setFullTextQaReturnAvailable(result.ok && result.returnPointSeconds !== null);
      setFullTextQaPreviewCitationId(null);
    } catch {
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setFullTextQaJumpStatus('引用跳转失败，请确认当前 B 站视频页仍然打开后重试。');
      setFullTextQaReturnAvailable(false);
    } finally {
      if (scopedActionIsCurrent(action, timestampRequestRef)) {
        timestampBusyRef.current = false;
        setFullTextQaJumpLoading(false);
      }
    }
  }

  async function returnFullTextQaCitationJump() {
    if (
      !fullTextQaReturnAvailable
      || subtitleProbeLoading
      || hasActiveFullTextQaRequest(fullTextQaActiveSessionId ?? fullTextQaSessions?.activeSessionId ?? null)
      || timestampBusyRef.current
    ) return;
    const action = beginScopedAction(timestampRequestRef);
    timestampBusyRef.current = true;
    setFullTextQaReturnLoading(true);
    setFullTextQaJumpStatus('正在返回原位置...');
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      if (!authorization.ready) {
        setFullTextQaJumpStatus(authorization.message);
        setFullTextQaReturnAvailable(false);
        return;
      }
      const result = await requestSW<CurrentVideoTimestampReturnResponse>(
        'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
        authorization.params,
      );
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setFullTextQaJumpStatus(result.ok
        ? '已返回原位置。'
        : '未能返回原位置，请回到当前视频页确认页面和播放器状态后重试。');
      if (result.ok) setFullTextQaReturnAvailable(false);
    } catch {
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setFullTextQaJumpStatus('返回原位置失败，请确认当前 B 站视频页仍然打开后重试。');
    } finally {
      if (scopedActionIsCurrent(action, timestampRequestRef)) {
        timestampBusyRef.current = false;
        setFullTextQaReturnLoading(false);
      }
    }
  }

  async function searchCurrentVideoSegments() {
    const query = segmentQuery.trim();
    if (!query) {
      setSegmentError('请输入想查找的片段内容。');
      setSegmentResult(null);
      setSegmentPreviewCandidateId(null);
      setSegmentJumpStatus(null);
      setSegmentReturnAvailable(false);
      return;
    }
    if (subtitleProbeLoading || segmentSearchBusyRef.current || timestampBusyRef.current) {
      return;
    }
    const action = beginScopedAction(segmentSearchRequestRef);
    segmentSearchBusyRef.current = true;
    setSegmentLoading(true);
    setSegmentError(null);
    setSegmentResult(null);
    setSegmentPreviewCandidateId(null);
    setSegmentJumpStatus(null);
    setSegmentReturnAvailable(false);
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!scopedActionIsCurrent(action, segmentSearchRequestRef)) return;
      if (!authorization.ready) {
        setSegmentError(authorization.message);
        return;
      }
      if (!scopedActionIsCurrent(action, segmentSearchRequestRef)) return;
      const result = await requestSW<CurrentVideoSegmentRetrievalResult>('SEARCH_CURRENT_VIDEO_SEGMENTS', {
        query,
        ...authorization.params,
      });
      if (!scopedActionIsCurrent(action, segmentSearchRequestRef)) return;
      setSegmentResult(result);
    } catch {
      if (!scopedActionIsCurrent(action, segmentSearchRequestRef)) return;
      setSegmentError('片段检索失败，请确认当前 B 站视频页仍然打开后重试。');
      setSegmentResult(null);
    } finally {
      if (scopedActionIsCurrent(action, segmentSearchRequestRef)) {
        segmentSearchBusyRef.current = false;
        setSegmentLoading(false);
      }
    }
  }

  async function confirmSegmentJump(candidate: CurrentVideoSegmentRetrievalCandidate) {
    if (
      !segmentResult
      || subtitleProbeLoading
      || segmentSearchBusyRef.current
      || timestampBusyRef.current
    ) return;
    if (!candidate.jumpPreview.canJump) {
      setSegmentJumpStatus('当前候选暂不可跳转，请重新检索后再试。');
      return;
    }
    const action = beginScopedAction(timestampRequestRef);
    timestampBusyRef.current = true;
    setSegmentJumpLoading(true);
    setSegmentReturnLoading(false);
    setSegmentJumpStatus('正在确认跳转...');
    setSegmentReturnAvailable(false);
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      if (!authorization.ready) {
        setSegmentJumpStatus(authorization.message);
        return;
      }
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      const result = await requestSW<CurrentVideoTimestampJumpResponse>('REQUEST_CURRENT_VIDEO_SEGMENT_JUMP', {
        query: segmentResult.query,
        candidateId: candidate.id,
        confirmed: true,
        ...authorization.params,
      });
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setSegmentJumpStatus(result.ok
        ? '跳转已完成，可返回原位置。'
        : '未能完成跳转，请回到当前视频页确认页面和播放器状态后重试。');
      setSegmentReturnAvailable(result.ok && result.returnPointSeconds !== null);
    } catch {
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setSegmentJumpStatus('跳转确认失败，请确认当前 B 站视频页仍然打开后重试。');
      setSegmentReturnAvailable(false);
    } finally {
      if (scopedActionIsCurrent(action, timestampRequestRef)) {
        timestampBusyRef.current = false;
        setSegmentJumpLoading(false);
      }
    }
  }

  async function returnSegmentJump() {
    if (
      !segmentReturnAvailable
      || subtitleProbeLoading
      || segmentSearchBusyRef.current
      || timestampBusyRef.current
    ) return;
    const action = beginScopedAction(timestampRequestRef);
    timestampBusyRef.current = true;
    setSegmentJumpLoading(false);
    setSegmentReturnLoading(true);
    setSegmentJumpStatus('正在返回原位置...');
    try {
      const authorization = await popupCurrentVideoPrimaryTextAuthorization(context);
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      if (!authorization.ready) {
        setSegmentJumpStatus(authorization.message);
        setSegmentReturnAvailable(false);
        return;
      }
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      const result = await requestSW<CurrentVideoTimestampReturnResponse>(
        'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
        authorization.params,
      );
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setSegmentJumpStatus(result.ok
        ? '已返回原位置。'
        : '未能返回原位置，请回到当前视频页确认页面和播放器状态后重试。');
      if (result.ok) setSegmentReturnAvailable(false);
    } catch {
      if (!scopedActionIsCurrent(action, timestampRequestRef)) return;
      setSegmentJumpStatus('返回原位置失败，请确认当前 B 站视频页仍然打开后重试。');
    } finally {
      if (scopedActionIsCurrent(action, timestampRequestRef)) {
        timestampBusyRef.current = false;
        setSegmentReturnLoading(false);
      }
    }
  }

  function beginScopedAction(requestRef: { current: number }): PopupCurrentVideoActionSnapshot {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    return { ...liveScopeSnapshot(), requestId };
  }

  function scopedActionIsCurrent(
    action: PopupCurrentVideoActionSnapshot,
    requestRef: { current: number },
  ): boolean {
    const scope = liveScopeSnapshot();
    return requestRef.current === action.requestId
      && scope.contextKey === action.contextKey
      && scope.selectionRevision === action.selectionRevision
      && scope.operationRevision === action.operationRevision;
  }

  function liveScopeSnapshot(): PopupCurrentVideoScopeSnapshot {
    return getCurrentVideoActionScope();
  }

  return (
    <section style={{
      margin: '10px 18px 12px',
      padding: '10px 12px',
      border: '1px solid rgba(251, 114, 153, 0.25)',
      borderRadius: '8px',
      background: 'rgba(251, 114, 153, 0.08)',
    }}>
      <div style={{
        color: '#FB7299',
        fontSize: '12px',
        fontWeight: 700,
        marginBottom: '6px',
      }}>
        当前视频助手
      </div>
      {isVideo ? (
        <>
          <div style={{ color: '#18191C', fontSize: '12px', lineHeight: 1.45, fontWeight: 600 }}>
            {context.title?.trim() || '当前视频'}
          </div>
          <p className="popup-part">P{context.currentPart.page} · {context.currentPart.title?.trim() || '当前分 P'}</p>
          <details className="popup-assistant-details">
          <summary>展开视频助手</summary>
          <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.5, marginTop: '4px' }}>
            当前分 P：{context.currentPart.title?.trim() || `第 ${context.currentPart.page} 段`}
            {context.currentPart.total ? `（第 ${context.currentPart.page}/${context.currentPart.total} 段）` : ''}
            <br />
            简介 {availabilityLabel(context.sources.description)}；字幕 {availabilityLabel(context.sources.transcript)}；正文文本 {availabilityLabel(context.sources.contentText)}
            <br />
            字幕状态：{subtitleDiagnostics.title}
          </div>
          <div style={{
            marginTop: '6px',
            padding: '7px 8px',
            border: `1px solid ${subtitleDiagnosticsBorder(subtitleDiagnostics)}`,
            borderRadius: '6px',
            background: subtitleDiagnosticsBackground(subtitleDiagnostics),
          }}>
            <div style={{ color: subtitleDiagnosticsColor(subtitleDiagnostics), fontSize: '10px', lineHeight: 1.45, fontWeight: 700 }}>
              {subtitleDiagnostics.title}
            </div>
            <div style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
              {subtitleDiagnostics.message}
            </div>
            <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
              {subtitleDiagnostics.action}
            </div>
            {subtitleDiagnostics.detailLines.slice(0, 2).map(line => (
              <div key={line} style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
                {line}
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginTop: '6px' }}>
              {subtitleDiagnostics.featureGates.map(item => (
                <div
                  key={item.label}
                  style={{
                    border: `1px solid ${item.available ? 'rgba(160,231,160,0.25)' : 'rgba(255,179,71,0.22)'}`,
                    borderRadius: '6px',
                    padding: '4px 5px',
                    color: item.available ? '#237A4B' : '#955600',
                    fontSize: '9px',
                    lineHeight: 1.35,
                  }}
                >
                  <strong>{item.label}</strong> {item.message}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={onReprobeSubtitle}
              disabled={subtitleProbeLoading || !subtitleDiagnostics.canRetry}
              style={{
                marginTop: '6px',
                background: subtitleProbeLoading || !subtitleDiagnostics.canRetry ? 'rgba(255,255,255,0.08)' : 'rgba(255,179,71,0.18)',
                color: subtitleProbeLoading || !subtitleDiagnostics.canRetry ? '#61666D' : '#955600',
                border: '1px solid rgba(255,179,71,0.32)',
                borderRadius: '6px',
                cursor: subtitleProbeLoading || !subtitleDiagnostics.canRetry ? 'default' : 'pointer',
                fontSize: '10px',
                padding: '4px 7px',
              }}
            >
              {subtitleProbeLoading ? '检测中...' : '重新检测字幕'}
            </button>
            {subtitleProbeStatus && (
              <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.45, marginTop: '5px' }}>
                {subtitleProbeStatus}
              </div>
            )}
            {currentVideoActionError && (
              <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, marginTop: '5px' }}>
                {currentVideoActionError}
              </div>
            )}
          </div>
          <CurrentVideoSummaryHighlightsPanel
            summary={summary}
            preview={highlightPreview}
            jumpStatus={highlightJumpStatus}
            returnAvailable={highlightReturnAvailable}
            jumpLoading={highlightJumpLoading}
            returnLoading={highlightReturnLoading}
            controlsDisabled={loading || subtitleProbeLoading || segmentLoading || segmentJumpLoading || segmentReturnLoading}
            onPreview={setHighlightPreview}
            onConfirmJump={confirmHighlightJump}
            onReturn={returnHighlightJump}
            onOpenSettings={onOpenSettings}
          />
          {loading && (
            <div style={{ color: '#007FA8', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
              正在生成新的摘要与亮点，此前结果会保留到新结果通过校验。
            </div>
          )}
          <div style={{
            marginTop: '6px',
            color: '#955600',
            fontSize: '10px',
            lineHeight: 1.45,
          }}>
            {currentVideoSummaryActionNotice(context, summary)}
          </div>
          <VideoKnowledgePanel
            knowledge={knowledge}
            loading={knowledgeLoading || subtitleProbeLoading}
            onRefresh={onRefreshKnowledge}
          />
          <CurrentVideoFullTextQaPanel
            context={context}
            query={segmentQuery}
            result={fullTextQaResult}
            sessions={fullTextQaSessions}
            activeSession={activeFullTextQaSession()}
            activeSessionId={fullTextQaActiveSessionId ?? fullTextQaSessions?.activeSessionId ?? null}
            sessionsLoading={fullTextQaSessionsLoading}
            sessionsError={fullTextQaSessionsError}
            loading={fullTextQaActiveSessionIds.includes(fullTextQaActiveSessionId ?? fullTextQaSessions?.activeSessionId ?? '')}
            error={fullTextQaErrorForSession(
              fullTextQaActiveSessionId ?? fullTextQaSessions?.activeSessionId ?? null,
            )}
            previewCitationId={fullTextQaPreviewCitationId}
            jumpStatus={fullTextQaJumpStatus}
            returnAvailable={fullTextQaReturnAvailable}
            jumpLoading={fullTextQaJumpLoading}
            returnLoading={fullTextQaReturnLoading}
            operationBlocked={subtitleProbeLoading}
            onQueryChange={setSegmentQuery}
            onSelectSession={(sessionId) => {
              updateFullTextQaActiveSessionId(sessionId);
              setFullTextQaPreviewCitationId(null);
              setFullTextQaJumpStatus(null);
              void loadFullTextQaSessions(sessionId);
            }}
            onNewSession={() => {
              updateFullTextQaActiveSessionId(createCurrentVideoFullTextRequestId('cvqa-session'));
              setFullTextQaPreviewCitationId(null);
              setFullTextQaJumpStatus(null);
            }}
            onRenameSession={renameFullTextQaSession}
            onDeleteSession={deleteFullTextQaSession}
            onSubmit={() => { void askCurrentVideoFullText(); }}
            onCancel={cancelCurrentVideoFullTextQa}
            onRetry={(turnId, question) => { void askCurrentVideoFullText(turnId, question); }}
            onPreviewCitation={setFullTextQaPreviewCitationId}
            onConfirmJump={confirmFullTextQaCitationJump}
            onReturn={returnFullTextQaCitationJump}
            onOpenSettings={onOpenSettings}
          />
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <button
              onClick={onRefresh}
              disabled={loading || subtitleProbeLoading || summary?.canGenerate === false}
              style={{
                flex: 1,
                background: '#FB7299',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: loading || subtitleProbeLoading || summary?.canGenerate === false ? 'default' : 'pointer',
                fontSize: '11px',
                padding: '6px 8px',
                opacity: loading || subtitleProbeLoading || summary?.canGenerate === false ? 0.7 : 1,
              }}
            >
              {loading
                ? '生成中...'
                : summary?.canGenerate === false
                  ? '暂不可生成'
                  : (summary?.status === 'ready' ? '重新生成摘要与亮点' : '生成摘要与亮点')}
            </button>
            {loading && (
              <button
                onClick={onCancel}
                style={{
                  background: 'rgba(255, 179, 71, 0.12)',
                  color: '#955600',
                  border: '1px solid rgba(255, 179, 71, 0.32)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '6px 8px',
                }}
              >
                取消
              </button>
            )}
          </div>
          </details>
        </>
      ) : (
        <div style={{ color: '#61666D', fontSize: '11px', lineHeight: 1.45 }}>
          当前未打开视频
        </div>
      )}
    </section>
  );
}

function CurrentVideoSummaryHighlightsPanel({
  summary,
  preview,
  jumpStatus,
  returnAvailable,
  jumpLoading,
  returnLoading,
  controlsDisabled,
  onPreview,
  onConfirmJump,
  onReturn,
  onOpenSettings,
}: {
  summary: CurrentVideoSummaryHighlightsResult | null;
  preview: CurrentVideoSummaryHighlightBinding | null;
  jumpStatus: string | null;
  returnAvailable: boolean;
  jumpLoading: boolean;
  returnLoading: boolean;
  controlsDisabled: boolean;
  onPreview: (binding: CurrentVideoSummaryHighlightBinding | null) => void;
  onConfirmJump: (binding: CurrentVideoSummaryHighlightBinding) => void;
  onReturn: () => void;
  onOpenSettings: () => void;
}) {
  const activePreview = summary
    && currentVideoSummaryHighlightBindingsEqual(
      preview,
      preview ? currentVideoSummaryHighlightBindingFromResult(summary, preview.highlightId) : null,
    )
    ? preview
    : null;
  const previewHighlight = summary?.highlights.find(
    highlight => highlight.id === activePreview?.highlightId,
  ) ?? null;
  if (!summary) {
    return (
      <div style={{
        marginTop: '8px',
        padding: '8px',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '6px',
        background: '#F6F7F8',
      }}>
        <div style={{ color: '#9F3757', fontSize: '10px', fontWeight: 700 }}>
          摘要与亮点
        </div>
        <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
          尚未生成。点击下方按钮后，会把当前选择的完整正文发送给已配置的模型。
        </div>
      </div>
    );
  }

  return (
    <div style={{
      marginTop: '8px',
      padding: '8px',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '6px',
      background: '#F6F7F8',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
        <span style={{
          color: '#9F3757',
          background: 'rgba(251, 114, 153, 0.16)',
          borderRadius: '6px',
          padding: '3px 6px',
          fontSize: '10px',
          fontWeight: 700,
        }}>
          {summary.priorGenerated ? '此前生成' : summaryHighlightsStatusLabel(summary.status)}
        </span>
        <span style={{ color: '#61666D', fontSize: '10px', textAlign: 'right' }}>
          {formatTextSize(summary.textSize)}
        </span>
      </div>
      <div style={{ color: summary.status === 'ready' ? '#237A4B' : '#955600', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
        {summary.message}
      </div>
      {summary.status === 'ready' ? (
        <>
          <div style={{ color: '#9F3757', fontSize: '10px', lineHeight: 1.45, fontWeight: 700, marginTop: '8px' }}>
            摘要
          </div>
          {summary.summarySentences.map(sentence => (
            <div key={sentence.id} style={{ color: '#18191C', fontSize: '11px', lineHeight: 1.5, marginTop: '4px' }}>
              {sentence.text}
            </div>
          ))}
          <div style={{ color: '#9F3757', fontSize: '10px', lineHeight: 1.45, fontWeight: 700, marginTop: '8px' }}>
            关键要点
          </div>
          {summary.keyPoints.map((point, index) => (
            <div key={point.id} style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
              {index + 1}. {point.text}
            </div>
          ))}
          <div style={{ color: '#9F3757', fontSize: '10px', lineHeight: 1.45, fontWeight: 700, marginTop: '8px' }}>
            视频亮点
          </div>
          {summary.highlights.map(highlight => (
            <HighlightCard
              key={highlight.id}
              highlight={highlight}
              selected={highlight.id === activePreview?.highlightId}
              disabled={controlsDisabled}
              onPreview={(selectedHighlight) => onPreview(
                selectedHighlight && summary
                  ? currentVideoSummaryHighlightBindingFromResult(summary, selectedHighlight.id)
                  : null,
              )}
            />
          ))}
          {previewHighlight && (
            <HighlightJumpPreview
              highlight={previewHighlight}
              disabled={controlsDisabled}
              loading={jumpLoading}
              onConfirm={() => activePreview && onConfirmJump(activePreview)}
              onCancel={() => onPreview(null)}
            />
          )}
          {jumpStatus && (
            <div style={{ color: jumpStatus.includes('未能') || jumpStatus.includes('失败') || jumpStatus.includes('不可') ? '#955600' : '#237A4B', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
              {jumpStatus}
            </div>
          )}
          {returnAvailable && (
            <button
              type="button"
              onClick={onReturn}
              disabled={controlsDisabled}
              style={{
                marginTop: '6px',
                width: '100%',
                background: 'rgba(255, 179, 71, 0.18)',
                color: '#955600',
                border: '1px solid rgba(255, 179, 71, 0.34)',
                borderRadius: '6px',
                cursor: controlsDisabled ? 'default' : 'pointer',
                fontSize: '10px',
                fontWeight: 700,
                padding: '5px 7px',
              }}
            >
              {returnLoading ? '返回中...' : '返回原位置'}
            </button>
          )}
        </>
      ) : (
        <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
          {summary.limitations[0] || summary.ai.note}
        </div>
      )}
      <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
        AI 状态：{summaryHighlightsAiStatusLabel(summary.ai.status)}。{summary.ai.note}
      </div>
      {needsAiSettingsLink(summary.ai.status) && (
        <SettingsInlineButton onClick={onOpenSettings} />
      )}
    </div>
  );
}

function HighlightCard({
  highlight,
  selected,
  disabled,
  onPreview,
}: {
  highlight: CurrentVideoSummaryHighlight;
  selected: boolean;
  disabled: boolean;
  onPreview: (highlight: CurrentVideoSummaryHighlight | null) => void;
}) {
  return (
    <div style={{
      marginTop: '6px',
      paddingTop: '6px',
      borderTop: '1px solid rgba(255,255,255,0.08)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, color: '#18191C', fontSize: '10px', lineHeight: 1.35, fontWeight: 650 }}>
          {highlight.title}
        </div>
        <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.35, flex: '0 0 auto' }}>
          {highlight.timeRangeLabel}
        </div>
      </div>
      <div style={{ color: '#18191C', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
        {highlight.description}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPreview(selected ? null : highlight)}
        style={{
          marginTop: '5px',
          background: 'rgba(0, 161, 214, 0.20)',
          color: '#007FA8',
          border: '1px solid rgba(127, 219, 255, 0.32)',
          borderRadius: '6px',
          cursor: disabled ? 'default' : 'pointer',
          fontSize: '10px',
          padding: '4px 7px',
          opacity: disabled ? 0.75 : 1,
        }}
      >
        {selected ? '收起预览' : '预览跳转'}
      </button>
    </div>
  );
}

function HighlightJumpPreview({
  highlight,
  onConfirm,
  onCancel,
  disabled,
  loading,
}: {
  highlight: CurrentVideoSummaryHighlight;
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
  loading: boolean;
}) {
  return (
    <div style={{
      marginTop: '8px',
      padding: '8px',
      border: '1px solid rgba(255,179,71,0.28)',
      borderRadius: '6px',
      background: 'rgba(255,179,71,0.08)',
    }}>
      <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, fontWeight: 700 }}>
        确认跳转前预览
      </div>
      <div style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
        目标时间：{highlight.timeRangeLabel}
      </div>
      <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
        {highlight.title}：{highlight.description}
      </div>
      <div style={{ color: '#237A4B', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
        确认后才会跳转，返回按钮会带你回到原位置。
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
        <button
          type="button"
          disabled={disabled}
          onClick={onConfirm}
          style={{
            flex: 1,
            background: disabled ? 'rgba(255,255,255,0.08)' : '#955600',
            color: disabled ? '#61666D' : '#FFFFFF',
            border: 'none',
            borderRadius: '6px',
            cursor: disabled ? 'default' : 'pointer',
            fontSize: '10px',
            fontWeight: 700,
            padding: '5px 7px',
          }}
        >
          {loading ? '确认中...' : '确认跳转'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          style={{
            background: 'transparent',
            color: '#18191C',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: '6px',
            cursor: disabled ? 'default' : 'pointer',
            fontSize: '10px',
            padding: '5px 7px',
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}

function CurrentVideoFullTextQaPanel({
  context,
  query,
  result,
  sessions,
  activeSession,
  activeSessionId,
  sessionsLoading,
  sessionsError,
  loading,
  error,
  previewCitationId,
  jumpStatus,
  returnAvailable,
  jumpLoading,
  returnLoading,
  operationBlocked,
  onQueryChange,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  onSubmit,
  onCancel,
  onRetry,
  onPreviewCitation,
  onConfirmJump,
  onReturn,
  onOpenSettings,
}: {
  context: CurrentVideoContextResult | null;
  query: string;
  result: CurrentVideoFullTextQaResult | null;
  sessions: CurrentVideoQaSessionsView | null;
  activeSession: CurrentVideoQaSessionRecord | null;
  activeSessionId: string | null;
  sessionsLoading: boolean;
  sessionsError: string | null;
  loading: boolean;
  error: string | null;
  previewCitationId: string | null;
  jumpStatus: string | null;
  returnAvailable: boolean;
  jumpLoading: boolean;
  returnLoading: boolean;
  operationBlocked: boolean;
  onQueryChange: (query: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (session: CurrentVideoQaSessionRecord | null) => void;
  onDeleteSession: (session: CurrentVideoQaSessionRecord | null) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onRetry: (turnId: string, question: string) => void;
  onPreviewCitation: (citationId: string | null) => void;
  onConfirmJump: (citation: CurrentVideoFullTextQaCitation) => void;
  onReturn: () => void;
  onOpenSettings: () => void;
}) {
  const matchingLooseResult = result?.sessionId === activeSessionId ? result : null;
  const sessionCitations = activeSession?.turns.flatMap(turn => turn.citations) ?? [];
  const previewCitation = [...sessionCitations, ...(matchingLooseResult?.citations ?? [])].find(citation =>
    fullTextQaPreviewKey(citation.binding) === previewCitationId
  ) ?? null;
  const timestampLoading = jumpLoading || returnLoading;
  const controlsDisabled = loading || timestampLoading || operationBlocked;
  const sessionsList = sessions?.sessions ?? [];
  const noticeResult = latestCurrentVideoQaTurnResult(activeSession) ?? matchingLooseResult;
  const referenceTitle = context?.kind === 'video'
    ? safeFullTextQaVisibleText(context.title || '当前视频')
    : '当前视频不可用';

  return (
    <div style={{
      marginTop: '8px',
      padding: '8px',
      border: '1px solid rgba(251, 114, 153, 0.24)',
      borderRadius: '6px',
      background: 'rgba(251, 114, 153, 0.07)',
    }}>
      <div style={{ color: '#9F3757', fontSize: '10px', fontWeight: 700 }}>
        问这个视频
      </div>
      <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45, marginTop: '4px' }}>
        本次参考：{referenceTitle}。切换视频只更新本次参考，不会自动发问或插入消息。
      </div>

      <div style={{ marginTop: '7px' }}>
        <div style={{
          display: 'flex',
          gap: '5px',
          overflowX: 'auto',
          paddingBottom: '2px',
        }}>
          {sessionsList.length > 0 ? sessionsList.map(session => {
            const active = session.sessionId === activeSessionId;
            return (
              <button
                type="button"
                key={session.sessionId}
                onClick={() => onSelectSession(session.sessionId)}
                style={{
                  flex: '0 0 auto',
                  maxWidth: '150px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  background: active ? 'rgba(251, 114, 153, 0.28)' : 'rgba(255,255,255,0.07)',
                  color: active ? '#9F3757' : '#18191C',
                  border: active ? '1px solid rgba(251, 114, 153, 0.45)' : '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '999px',
                  cursor: 'pointer',
                  fontSize: '9px',
                  padding: '4px 7px',
                }}
                title={safeFullTextQaVisibleText(session.title)}
              >
                {safeFullTextQaVisibleText(session.title)}（{session.turnCount}）
              </button>
            );
          }) : (
            <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45 }}>
              还没有本地问答会话。
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
          <button
            type="button"
            onClick={onNewSession}
            style={{
              background: 'rgba(255,255,255,0.07)',
              color: '#18191C',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '9px',
              padding: '4px 7px',
            }}
          >
            新建会话
          </button>
          <button
            type="button"
            onClick={() => onRenameSession(activeSession)}
            disabled={!activeSession}
            style={{
              background: 'rgba(255,255,255,0.07)',
              color: activeSession ? '#18191C' : '#61666D',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '6px',
              cursor: activeSession ? 'pointer' : 'default',
              fontSize: '9px',
              padding: '4px 7px',
            }}
          >
            重命名
          </button>
          <button
            type="button"
            onClick={() => onDeleteSession(activeSession)}
            disabled={!activeSession}
            style={{
              background: 'rgba(255,255,255,0.07)',
              color: activeSession ? '#18191C' : '#61666D',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '6px',
              cursor: activeSession ? 'pointer' : 'default',
              fontSize: '9px',
              padding: '4px 7px',
            }}
          >
            删除
          </button>
        </div>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          value={query}
          maxLength={500}
          rows={3}
          onInput={(event) => onQueryChange((event.currentTarget as HTMLTextAreaElement).value)}
          placeholder="例如：作者为什么认为这个方法更可靠？"
          style={{
            boxSizing: 'border-box',
            width: '100%',
            marginTop: '6px',
            resize: 'vertical',
            minHeight: '58px',
            maxHeight: '120px',
            background: 'rgba(255,255,255,0.08)',
            color: '#18191C',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: '6px',
            fontSize: '11px',
            lineHeight: 1.45,
            padding: '7px 8px',
            outline: 'none',
          }}
        />
        <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45, marginTop: '4px' }}>
          {currentVideoFullTextQaActionNotice(context, noticeResult)}
        </div>
        <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
          <button
            type="submit"
            disabled={controlsDisabled || !query.trim()}
            style={{
              flex: 1,
              background: controlsDisabled || !query.trim() ? 'rgba(251, 114, 153, 0.12)' : '#FB7299',
              color: controlsDisabled || !query.trim() ? '#61666D' : '#fff',
              border: '1px solid rgba(251, 114, 153, 0.36)',
              borderRadius: '6px',
              cursor: controlsDisabled || !query.trim() ? 'default' : 'pointer',
              fontSize: '10px',
              fontWeight: 700,
              padding: '6px 8px',
            }}
          >
            {loading ? '回答中...' : '提问'}
          </button>
          {loading && (
            <button
              type="button"
              onClick={onCancel}
              style={{
                background: 'transparent',
                color: '#18191C',
                border: '1px solid rgba(255,255,255,0.14)',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '10px',
                padding: '6px 8px',
              }}
            >
              取消
            </button>
          )}
        </div>
      </form>

      {sessionsLoading && (
        <div style={{ color: '#007FA8', fontSize: '10px', lineHeight: 1.45, marginTop: '7px' }}>
          正在读取本地问答会话...
        </div>
      )}
      {sessionsError && (
        <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, marginTop: '7px' }}>
          {sessionsError}
        </div>
      )}
      {error && (
        <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, marginTop: '7px' }}>
          {error}
        </div>
      )}
      {loading && (
        <div style={{ color: '#007FA8', fontSize: '10px', lineHeight: 1.45, marginTop: '7px' }}>
          正在核对全片内容...
        </div>
      )}

      <div style={{ marginTop: '8px', borderTop: '1px solid rgba(255,255,255,0.09)', paddingTop: '7px' }}>
        {activeSession ? (
          <div>
            <div style={{ color: '#9F3757', fontSize: '10px', lineHeight: 1.45, fontWeight: 700 }}>
              {safeFullTextQaVisibleText(activeSession.title)}
            </div>
            {activeSession.turns.length > 0 ? activeSession.turns.map(turn => (
              <CurrentVideoFullTextQaTurn
                key={turn.turnId}
                context={context}
                sessionId={activeSession.sessionId}
                turn={turn}
                controlsDisabled={controlsDisabled}
                previewCitationId={previewCitationId}
                jumpStatus={jumpStatus}
                returnAvailable={returnAvailable}
                jumpLoading={jumpLoading}
                returnLoading={returnLoading}
                onQuestionReuse={onQueryChange}
                onRetry={onRetry}
                onPreviewCitation={onPreviewCitation}
                onConfirmJump={onConfirmJump}
                onReturn={onReturn}
                onOpenSettings={onOpenSettings}
              />
            )) : (
              <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.45, marginTop: '5px' }}>
                这个会话还没有问题。
              </div>
            )}
          </div>
        ) : matchingLooseResult ? (
          <CurrentVideoFullTextQaResultBlock
            context={context}
            result={matchingLooseResult}
            source={null}
            controlsDisabled={controlsDisabled}
            previewCitationId={previewCitationId}
            jumpStatus={jumpStatus}
            returnAvailable={returnAvailable}
            jumpLoading={jumpLoading}
            returnLoading={returnLoading}
            onRetry={onRetry}
            onQuestionReuse={onQueryChange}
            onPreviewCitation={onPreviewCitation}
            onConfirmJump={onConfirmJump}
            onReturn={onReturn}
            onOpenSettings={onOpenSettings}
          />
        ) : (
          <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.45 }}>
            提交第一个问题后会创建本地会话。
          </div>
        )}
        {previewCitation && (
          <CurrentVideoFullTextQaCitationPreview
            citation={previewCitation}
            disabled={controlsDisabled}
            loading={jumpLoading}
            onConfirm={() => onConfirmJump(previewCitation)}
            onCancel={() => onPreviewCitation(null)}
          />
        )}
      </div>
    </div>
  );
}

function CurrentVideoFullTextQaTurn({
  context,
  sessionId,
  turn,
  controlsDisabled,
  previewCitationId,
  jumpStatus,
  returnAvailable,
  jumpLoading,
  returnLoading,
  onQuestionReuse,
  onRetry,
  onPreviewCitation,
  onConfirmJump,
  onReturn,
  onOpenSettings,
}: {
  context: CurrentVideoContextResult | null;
  sessionId: string;
  turn: CurrentVideoQaSessionTurn;
  controlsDisabled: boolean;
  previewCitationId: string | null;
  jumpStatus: string | null;
  returnAvailable: boolean;
  jumpLoading: boolean;
  returnLoading: boolean;
  onQuestionReuse: (question: string) => void;
  onRetry: (turnId: string, question: string) => void;
  onPreviewCitation: (citationId: string | null) => void;
  onConfirmJump: (citation: CurrentVideoFullTextQaCitation) => void;
  onReturn: () => void;
  onOpenSettings: () => void;
}) {
  if (turn.status === 'pending') {
    return (
      <div style={{ marginTop: '8px', paddingTop: '7px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <CurrentVideoFullTextQaQuestion question={turn.question} onQuestionReuse={onQuestionReuse} />
        <div style={{ color: '#007FA8', fontSize: '10px', lineHeight: 1.45, marginTop: '5px' }}>
          {safeFullTextQaVisibleText(turn.message || '正在核对全片内容...')}
        </div>
      </div>
    );
  }

  const result = currentVideoQaTurnToPopupResult(sessionId, turn);
  return (
    <div style={{ marginTop: '8px', paddingTop: '7px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <CurrentVideoFullTextQaQuestion question={turn.question} onQuestionReuse={onQuestionReuse} />
      <CurrentVideoFullTextQaResultBlock
        context={context}
        result={result}
        source={turn.source}
        controlsDisabled={controlsDisabled}
        previewCitationId={previewCitationId}
        jumpStatus={jumpStatus}
        returnAvailable={returnAvailable}
        jumpLoading={jumpLoading}
        returnLoading={returnLoading}
        onRetry={onRetry}
        onQuestionReuse={onQuestionReuse}
        onPreviewCitation={onPreviewCitation}
        onConfirmJump={onConfirmJump}
        onReturn={onReturn}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}

function CurrentVideoFullTextQaQuestion({
  question,
  onQuestionReuse,
}: {
  question: string;
  onQuestionReuse: (question: string) => void;
}) {
  return (
    <div style={{
      padding: '6px',
      border: '1px solid rgba(255,255,255,0.09)',
      borderRadius: '6px',
      background: 'rgba(255,255,255,0.05)',
    }}>
      <div style={{ color: '#9F3757', fontSize: '10px', lineHeight: 1.45, fontWeight: 700 }}>
        {safeFullTextQaVisibleText(question)}
      </div>
      <button
        type="button"
        onClick={() => onQuestionReuse(question)}
        style={{
          marginTop: '5px',
          background: 'rgba(255,255,255,0.07)',
          color: '#18191C',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '9px',
          padding: '4px 7px',
        }}
      >
        在当前视频再问
      </button>
    </div>
  );
}

function CurrentVideoFullTextQaResultBlock({
  context,
  result,
  source,
  controlsDisabled,
  previewCitationId,
  jumpStatus,
  returnAvailable,
  jumpLoading,
  returnLoading,
  onRetry,
  onQuestionReuse,
  onPreviewCitation,
  onConfirmJump,
  onReturn,
  onOpenSettings,
}: {
  context: CurrentVideoContextResult | null;
  result: CurrentVideoFullTextQaResult;
  source: CurrentVideoQaSourceSnapshot | null;
  controlsDisabled: boolean;
  previewCitationId: string | null;
  jumpStatus: string | null;
  returnAvailable: boolean;
  jumpLoading: boolean;
  returnLoading: boolean;
  onRetry: (turnId: string, question: string) => void;
  onQuestionReuse: (question: string) => void;
  onPreviewCitation: (citationId: string | null) => void;
  onConfirmJump: (citation: CurrentVideoFullTextQaCitation) => void;
  onReturn: () => void;
  onOpenSettings: () => void;
}) {
  const hasAnswer = Boolean(result.answer.trim());
  const sourceCurrent = currentVideoQaSourceMatchesPopupContext(source ?? result.sourceReference ?? null, context);

  return (
    <div style={{ marginTop: '6px' }}>
      <div style={{ color: fullTextQaStatusColor(result.status), fontSize: '10px', lineHeight: 1.45, fontWeight: 700 }}>
        {result.status === 'ready' ? '回答' : fullTextQaStatusLabel(result.status)}
      </div>
      {hasAnswer ? (
        <div style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.55, marginTop: '4px', whiteSpace: 'pre-wrap' }}>
          {safeFullTextQaVisibleText(result.answer)}
        </div>
      ) : (
        <div style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
          {safeFullTextQaVisibleText(result.message)}
        </div>
      )}
      {(result.sourceLabel || source) && (
        <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45, marginTop: '5px' }}>
          {fullTextQaSourceLine(result, sourceCurrent)}
        </div>
      )}
      {(source?.url || result.sourceReference?.url) && (
        <button
          type="button"
          onClick={() => window.open(source?.url ?? result.sourceReference?.url ?? '', '_blank', 'noopener,noreferrer')}
          style={{
            marginTop: '5px',
            background: 'rgba(255,255,255,0.07)',
            color: '#18191C',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '9px',
            padding: '4px 7px',
          }}
        >
          打开来源视频
        </button>
      )}
      {result.status === 'ready' && result.citations.length > 0 && (
        <div style={{ marginTop: '7px' }}>
          <div style={{ color: '#007FA8', fontSize: '10px', lineHeight: 1.45, fontWeight: 700 }}>
            引用片段
          </div>
          {result.citations.slice(0, 3).map((citation, index) => (
            <CurrentVideoFullTextQaCitationRow
              key={fullTextQaPreviewKey(citation.binding)}
              citation={citation}
              index={index}
              sourceCurrent={sourceCurrent}
              selected={fullTextQaPreviewKey(citation.binding) === previewCitationId}
              disabled={controlsDisabled || !sourceCurrent}
              onPreview={onPreviewCitation}
            />
          ))}
        </div>
      )}
      {jumpStatus && (
        <div style={{ color: jumpStatus.includes('失败') || jumpStatus.includes('不可') || jumpStatus.includes('变化') ? '#955600' : '#237A4B', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
          {jumpStatus}
        </div>
      )}
      {returnAvailable && (
        <button
          type="button"
          onClick={onReturn}
          disabled={controlsDisabled}
          style={{
            marginTop: '6px',
            width: '100%',
            background: 'rgba(255, 179, 71, 0.18)',
            color: '#955600',
            border: '1px solid rgba(255, 179, 71, 0.34)',
            borderRadius: '6px',
            cursor: controlsDisabled ? 'default' : 'pointer',
            fontSize: '10px',
            fontWeight: 700,
            padding: '5px 7px',
          }}
        >
          {returnLoading ? '返回中...' : '返回原位置'}
        </button>
      )}
      {result.canRetry && result.status !== 'ready' && (
        <button
          type="button"
          onClick={() => {
            if (sourceCurrent) onRetry(result.turnId, result.question);
            else onQuestionReuse(result.question);
          }}
          disabled={controlsDisabled}
          style={{
            marginTop: '6px',
            width: '100%',
            background: 'rgba(251, 114, 153, 0.16)',
            color: '#9F3757',
            border: '1px solid rgba(251, 114, 153, 0.30)',
            borderRadius: '6px',
            cursor: controlsDisabled ? 'default' : 'pointer',
            fontSize: '10px',
            fontWeight: 700,
            padding: '5px 7px',
          }}
        >
          {sourceCurrent ? '重试本题' : '在当前视频再问'}
        </button>
      )}
      {needsAiSettingsLink(result.status) && (
        <SettingsInlineButton onClick={onOpenSettings} />
      )}
    </div>
  );
}

function CurrentVideoFullTextQaCitationRow({
  citation,
  index,
  sourceCurrent,
  selected,
  disabled,
  onPreview,
}: {
  citation: CurrentVideoFullTextQaCitation;
  index: number;
  sourceCurrent: boolean;
  selected: boolean;
  disabled: boolean;
  onPreview: (citationId: string | null) => void;
}) {
  const previewKey = fullTextQaPreviewKey(citation.binding);
  return (
    <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
        <div style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.4, fontWeight: 650 }}>
          引用 {index + 1}
        </div>
        <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.4, flex: '0 0 auto' }}>
          {citation.timeRangeLabel}
        </div>
      </div>
      <div style={{ color: '#18191C', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
        {safeFullTextQaVisibleText(citation.evidenceText)}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPreview(selected ? null : previewKey)}
        style={{
          marginTop: '5px',
          background: 'rgba(0, 161, 214, 0.20)',
          color: '#007FA8',
          border: '1px solid rgba(127, 219, 255, 0.32)',
          borderRadius: '6px',
          cursor: disabled ? 'default' : 'pointer',
          fontSize: '10px',
          padding: '4px 7px',
        }}
      >
        {selected ? '收起预览' : '预览跳转'}
      </button>
      {!sourceCurrent && (
        <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45, marginTop: '4px' }}>
          请先打开对应视频和分 P，再预览或确认跳转。
        </div>
      )}
    </div>
  );
}

function CurrentVideoFullTextQaCitationPreview({
  citation,
  disabled,
  loading,
  onConfirm,
  onCancel,
}: {
  citation: CurrentVideoFullTextQaCitation;
  disabled: boolean;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      marginTop: '8px',
      padding: '8px',
      border: '1px solid rgba(255,179,71,0.28)',
      borderRadius: '6px',
      background: 'rgba(255,179,71,0.08)',
    }}>
      <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, fontWeight: 700 }}>
        确认跳转前预览
      </div>
      <div style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
        目标时间：{citation.timeRangeLabel}
      </div>
      <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
        片段内容：{safeFullTextQaVisibleText(citation.evidenceText)}
      </div>
      <div style={{ color: '#237A4B', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
        确认后才会跳转，可再返回原位置。
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
        <button
          type="button"
          disabled={disabled}
          onClick={onConfirm}
          style={{
            flex: 1,
            background: disabled ? 'rgba(255,255,255,0.08)' : '#955600',
            color: disabled ? '#61666D' : '#FFFFFF',
            border: 'none',
            borderRadius: '6px',
            cursor: disabled ? 'default' : 'pointer',
            fontSize: '10px',
            fontWeight: 700,
            padding: '5px 7px',
          }}
        >
          {loading ? '确认中...' : '确认跳转'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onCancel}
          style={{
            background: 'transparent',
            color: '#18191C',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: '6px',
            cursor: disabled ? 'default' : 'pointer',
            fontSize: '10px',
            padding: '5px 7px',
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}

function CurrentVideoSegmentRetrievalPanel({
  subtitleDiagnostics,
  query,
  result,
  loading,
  error,
  previewCandidateId,
  jumpStatus,
  returnAvailable,
  jumpLoading,
  returnLoading,
  operationBlocked,
  onQueryChange,
  onSearch,
  onPreviewCandidate,
  onConfirmJump,
  onReturn,
  onOpenSettings,
}: {
  subtitleDiagnostics: CurrentVideoSubtitleDiagnostics;
  query: string;
  result: CurrentVideoSegmentRetrievalResult | null;
  loading: boolean;
  error: string | null;
  previewCandidateId: string | null;
  jumpStatus: string | null;
  returnAvailable: boolean;
  jumpLoading: boolean;
  returnLoading: boolean;
  operationBlocked: boolean;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onPreviewCandidate: (candidateId: string | null) => void;
  onConfirmJump: (candidate: CurrentVideoSegmentRetrievalCandidate) => void;
  onReturn: () => void;
  onOpenSettings: () => void;
}) {
  const previewCandidate = result?.candidates.find(candidate => candidate.id === previewCandidateId) ?? null;
  const aiExplanations = new Map(
    (result?.aiRerank.explanations ?? []).map(explanation => [explanation.candidateId, explanation]),
  );
  const searchGate = subtitleDiagnostics.featureGates.find(item => item.label === '片段检索');
  const jumpGate = subtitleDiagnostics.featureGates.find(item => item.label === '手动跳转');
  const timestampLoading = jumpLoading || returnLoading;
  const controlsDisabled = loading || timestampLoading || operationBlocked;
  return (
    <div style={{
      marginTop: '8px',
      padding: '8px',
      border: '1px solid rgba(127, 219, 255, 0.18)',
      borderRadius: '6px',
      background: 'rgba(0, 161, 214, 0.08)',
    }}>
      <div style={{ color: '#007FA8', fontSize: '10px', fontWeight: 700 }}>
        本地片段检索
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
        style={{ display: 'flex', gap: '6px', marginTop: '6px' }}
      >
        <input
          value={query}
          onInput={(event) => onQueryChange((event.currentTarget as HTMLInputElement).value)}
          placeholder="例如：模型架构那段"
          style={{
            minWidth: 0,
            flex: 1,
            background: 'rgba(255,255,255,0.08)',
            color: '#18191C',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: '6px',
            fontSize: '11px',
            padding: '6px 8px',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={controlsDisabled}
          style={{
            width: '54px',
            background: controlsDisabled ? 'rgba(0, 161, 214, 0.12)' : 'rgba(0, 161, 214, 0.28)',
            color: '#007FA8',
            border: '1px solid rgba(127, 219, 255, 0.32)',
            borderRadius: '6px',
            cursor: controlsDisabled ? 'default' : 'pointer',
            fontSize: '10px',
            padding: '6px 8px',
          }}
        >
          {loading ? '检索中' : '检索'}
        </button>
      </form>
      <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45, marginTop: '5px' }}>
        {searchGate?.message} {jumpGate?.message}
      </div>
      {error && (
        <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
          {error}
        </div>
      )}
      {result && (
        <div style={{ marginTop: '7px' }}>
          <div style={{ color: retrievalStatusColor(result), fontSize: '10px', lineHeight: 1.45 }}>
            {retrievalStatusMessage(result)}
          </div>
          {result.queryRewrite.expanded && result.queryRewrite.visibleExpandedTerms.length > 0 && (
            <div style={{ color: '#007FA8', fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
              已扩展相关表达：{result.queryRewrite.visibleExpandedTerms.slice(0, 6).join('、')}
            </div>
          )}
          <div style={{ color: segmentAiRerankColor(result.aiRerank.status), fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
            AI 重排：{segmentAiRerankStatusLabel(result.aiRerank.status)}。{result.aiRerank.note}
          </div>
          {needsAiSettingsLink(result.aiRerank.status) && (
            <SettingsInlineButton onClick={onOpenSettings} />
          )}
          {result.candidates.length === 0 ? (
            <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.45, marginTop: '5px' }}>
              {result.limitations[0]}
            </div>
          ) : (
            result.candidates.map((candidate, index) => (
              <SegmentCandidateCard
                key={candidate.id}
                candidate={candidate}
                index={index}
                selected={candidate.id === previewCandidateId}
                aiExplanation={aiExplanations.get(candidate.id) ?? null}
                onPreview={onPreviewCandidate}
                disabled={controlsDisabled}
              />
            ))
          )}
          {previewCandidate && (
            <SegmentJumpPreview
              candidate={previewCandidate}
              onConfirm={onConfirmJump}
              onCancel={() => onPreviewCandidate(null)}
              disabled={controlsDisabled}
              loading={jumpLoading}
            />
          )}
          {jumpStatus && (
            <div style={{ color: jumpStatus.includes('不能') || jumpStatus.includes('不可') || jumpStatus.includes('过期') ? '#955600' : '#237A4B', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
              {jumpStatus}
            </div>
          )}
          {returnAvailable && (
            <button
              type="button"
              onClick={onReturn}
              disabled={controlsDisabled}
              style={{
                marginTop: '6px',
                width: '100%',
                background: 'rgba(255, 179, 71, 0.18)',
                color: '#955600',
                border: '1px solid rgba(255, 179, 71, 0.34)',
                borderRadius: '6px',
                cursor: controlsDisabled ? 'default' : 'pointer',
                fontSize: '10px',
                fontWeight: 700,
                padding: '5px 7px',
              }}
            >
              {returnLoading ? '返回中...' : '返回原位置'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SegmentCandidateCard({
  candidate,
  index,
  selected,
  aiExplanation,
  onPreview,
  disabled,
}: {
  candidate: CurrentVideoSegmentRetrievalCandidate;
  index: number;
  selected: boolean;
  aiExplanation: CurrentVideoSegmentRerankExplanation | null;
  onPreview: (candidateId: string | null) => void;
  disabled: boolean;
}) {
  const canJump = candidate.jumpPreview.canJump;
  return (
    <div style={{
      marginTop: '6px',
      paddingTop: '6px',
      borderTop: '1px solid rgba(255,255,255,0.08)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, color: '#18191C', fontSize: '10px', lineHeight: 1.35, fontWeight: 650 }}>
          候选 {index + 1} · {candidate.timeRangeLabel}
        </div>
        <div style={{
          flex: '0 0 auto',
          color: candidate.confidenceLabel === '低' ? '#955600' : '#237A4B',
          fontSize: '9px',
          lineHeight: 1.35,
        }}>
          {candidate.confidenceLabel} {Math.round(candidate.confidence * 100)}%
        </div>
      </div>
      <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.4, marginTop: '2px' }}>
        来源 {candidate.sourceLabel}
      </div>
      <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.4, marginTop: '3px' }}>
        证据片段：{candidate.evidenceText || '暂无可展示文本'}
      </div>
      <div style={{ color: '#18191C', fontSize: '9px', lineHeight: 1.4, marginTop: '3px' }}>
        匹配原因：{candidate.matchReasons.join('；')}
      </div>
      {candidate.note && (
        <div style={{ color: '#955600', fontSize: '9px', lineHeight: 1.4, marginTop: '3px' }}>
          {candidate.note}
        </div>
      )}
      {aiExplanation && (
        <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
          AI 解释：{aiExplanation.explanation}（{Math.round(aiExplanation.confidence * 100)}%）
          <br />
          排序理由：{aiExplanation.reason}
        </div>
      )}
      <div style={{ color: canJump ? '#237A4B' : '#955600', fontSize: '9px', lineHeight: 1.4, marginTop: '3px' }}>
        {candidate.jumpPreview.message}
      </div>
      <button
        type="button"
        disabled={!canJump || disabled}
        onClick={() => onPreview(selected ? null : candidate.id)}
        style={{
          marginTop: '5px',
          background: canJump ? 'rgba(0, 161, 214, 0.20)' : 'rgba(255, 255, 255, 0.06)',
          color: canJump ? '#007FA8' : '#61666D',
          border: canJump ? '1px solid rgba(127, 219, 255, 0.32)' : '1px solid rgba(255,255,255,0.10)',
          borderRadius: '6px',
          cursor: canJump && !disabled ? 'pointer' : 'default',
          fontSize: '10px',
          padding: '4px 7px',
          opacity: canJump && !disabled ? 1 : 0.75,
        }}
      >
        {canJump ? (selected ? '收起预览' : '预览跳转') : '不可跳转'}
      </button>
    </div>
  );
}

function SegmentJumpPreview({
  candidate,
  onConfirm,
  onCancel,
  disabled,
  loading,
}: {
  candidate: CurrentVideoSegmentRetrievalCandidate;
  onConfirm: (candidate: CurrentVideoSegmentRetrievalCandidate) => void;
  onCancel: () => void;
  disabled: boolean;
  loading: boolean;
}) {
  const preview = candidate.jumpPreview;
  return (
    <div style={{
      marginTop: '8px',
      padding: '8px',
      border: '1px solid rgba(255,179,71,0.28)',
      borderRadius: '6px',
      background: 'rgba(255,179,71,0.08)',
    }}>
      <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, fontWeight: 700 }}>
        确认跳转前预览
      </div>
      <div style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.45, marginTop: '4px' }}>
        目标时间：{preview.targetTimeLabel ?? candidate.timeRangeLabel}
      </div>
      <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45, marginTop: '2px' }}>
        来源：{preview.sourceLabel}；置信度：{preview.confidenceLabel} {Math.round(preview.confidence * 100)}%
      </div>
      <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
        证据预览：{preview.evidencePreview || '暂无可展示文本'}
      </div>
      <div style={{ color: preview.canJump ? '#237A4B' : '#955600', fontSize: '9px', lineHeight: 1.45, marginTop: '3px' }}>
        {preview.message}
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
        <button
          type="button"
          disabled={!preview.canJump || disabled}
          onClick={() => onConfirm(candidate)}
          style={{
            flex: 1,
            background: preview.canJump ? '#955600' : 'rgba(255,255,255,0.08)',
            color: preview.canJump ? '#FFFFFF' : '#61666D',
            border: 'none',
            borderRadius: '6px',
            cursor: preview.canJump && !disabled ? 'pointer' : 'default',
            fontSize: '10px',
            fontWeight: 700,
            padding: '5px 7px',
          }}
        >
          {loading ? '确认中...' : '确认跳转'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          style={{
            background: 'transparent',
            color: '#18191C',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: '6px',
            cursor: disabled ? 'default' : 'pointer',
            fontSize: '10px',
            padding: '5px 7px',
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}

function VideoKnowledgePanel({
  knowledge,
  loading,
  onRefresh,
}: {
  knowledge: VideoKnowledgeResult | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const nodes = knowledge?.nodes ?? [];
  const transcriptNodeCount = nodes.filter(node => node.source === 'transcript').length;
  return (
    <div style={{
      marginTop: '8px',
      padding: '8px',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '6px',
      background: '#F6F7F8',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
        <span style={{ color: '#9F3757', fontSize: '10px', fontWeight: 700 }}>
          视频知识节点
        </span>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{
            background: 'transparent',
            color: '#61666D',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: '6px',
            cursor: loading ? 'default' : 'pointer',
            fontSize: '10px',
            padding: '3px 6px',
          }}
        >
          {loading ? '读取中...' : '刷新'}
        </button>
      </div>
      <div style={{ color: '#955600', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
        {videoKnowledgeNotice(knowledge, transcriptNodeCount)}
      </div>
      {nodes.length === 0 ? (
        <div style={{ color: '#61666D', fontSize: '10px', lineHeight: 1.45, marginTop: '6px' }}>
          {knowledge?.status === 'no_context'
            ? '当前没有可用于知识节点的视频上下文。'
            : '当前没有足够安全的关键节点候选。'}
        </div>
      ) : (
        nodes.slice(0, 5).map(node => (
          <div key={node.id} style={{
            marginTop: '6px',
            paddingTop: '6px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}>
            <div style={{ color: '#18191C', fontSize: '10px', lineHeight: 1.35, fontWeight: 650 }}>
              {node.title}
            </div>
            <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.45, marginTop: '2px' }}>
              来源 {node.sourceLabel} / 证据强度 {Math.round(node.confidence * 100)}%
              {node.timestamp === null ? ' / 无时间点' : ` / ${formatNodeTimeRange(node)}`}
              {node.evidence?.sourceStatus ? ` / 来源状态 ${evidenceSourceStatusLabel(node.evidence.sourceStatus)}` : ''}
            </div>
            <div style={{ color: '#18191C', fontSize: '9px', lineHeight: 1.4, marginTop: '2px' }}>
              {node.reason}
            </div>
            {node.evidence?.textSpan && (
              <div style={{ color: '#007FA8', fontSize: '9px', lineHeight: 1.4, marginTop: '2px' }}>
                证据片段：{node.evidence.textSpan}
              </div>
            )}
            {node.source === 'transcript' && node.timestamp !== null && (
              <div style={{ color: '#61666D', fontSize: '9px', lineHeight: 1.4, marginTop: '2px' }}>
                字幕证据：{formatNodeTimeRange(node)}；来自当前视频字幕片段，暂不提供跳转。
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

async function popupCurrentVideoPrimaryTextAuthorization(
  context: CurrentVideoContextResult | null,
): Promise<CurrentVideoPrimaryTextAuthorization> {
  if (context?.kind !== 'video') {
    return {
      ready: false,
      source: null,
      selectedSourceIdentityKey: null,
      message: '当前没有可用的视频上下文，请保持 B 站视频页打开后重试。',
      params: { primaryTextSelectionsReady: false },
    };
  }

  const readResult = await readCurrentVideoPrimaryTextSelections(chrome.storage.local);
  const evidence = context.transcriptEvidence;
  const availableSourceIdentityKeys = (
    context.cid
    && evidence?.active === true
    && evidence.bvid === context.bvid
    && evidence.cid === context.cid
    && evidence.page === context.currentPart.page
    && evidence.sourceIdentityKey
    && evidence.sourceHash
    && evidence.bodyHash
    && evidence.timelineHash
  )
    ? [evidence.sourceIdentityKey]
    : [];

  return resolveCurrentVideoPrimaryTextAuthorization({
    readStatus: readResult.status,
    identity: {
      bvid: context.bvid,
      cid: context.cid,
      page: context.currentPart.page,
    },
    selections: readResult.selections,
    availableSourceIdentityKeys,
  });
}

function availabilityLabel(value: string): string {
  switch (value) {
    case 'available':
      return '可用';
    case 'unavailable':
      return '不可用';
    case 'unknown':
      return '未知';
    default:
      return '未知';
  }
}

function subtitleDiagnosticsColor(state: CurrentVideoSubtitleDiagnostics): string {
  if (state.tone === 'ready') return '#237A4B';
  if (state.tone === 'info') return '#007FA8';
  if (state.tone === 'blocked') return '#B42338';
  return '#955600';
}

function subtitleDiagnosticsBorder(state: CurrentVideoSubtitleDiagnostics): string {
  if (state.tone === 'ready') return 'rgba(160,231,160,0.28)';
  if (state.tone === 'info') return 'rgba(127,219,255,0.28)';
  if (state.tone === 'blocked') return 'rgba(255,138,138,0.28)';
  return 'rgba(255,179,71,0.24)';
}

function subtitleDiagnosticsBackground(state: CurrentVideoSubtitleDiagnostics): string {
  if (state.tone === 'ready') return 'rgba(160,231,160,0.08)';
  if (state.tone === 'info') return 'rgba(127,219,255,0.08)';
  if (state.tone === 'blocked') return 'rgba(255,138,138,0.08)';
  return 'rgba(255,179,71,0.08)';
}

function videoKnowledgeNotice(knowledge: VideoKnowledgeResult | null, transcriptNodeCount: number): string {
  if (!knowledge) return '尚未读取当前视频知识节点，请手动刷新。';
  if (transcriptNodeCount > 0) {
    return `已用当前视频本地字幕证据生成 ${transcriptNodeCount} 个节点；时间范围只来自字幕片段，暂不提供跳转。`;
  }
  const evidence = knowledge.transcriptEvidence;
  if (!evidence) {
    return '当前没有可引用字幕正文，知识节点暂不可用。';
  }
  if (evidence.status === 'stale') {
    return '本地字幕证据与当前视频或分 P 不匹配，知识节点暂不可用。';
  }
  if (evidence.status === 'language_mismatch') {
    return '本地字幕语言与当前请求不匹配，暂不生成字幕节点。';
  }
  if (evidence.status === 'empty') {
    return '已检测到字幕来源，但没有可用正文片段，暂不生成字幕节点。';
  }
  if (evidence.status === 'malformed') {
    return '字幕正文结构异常，暂不作为节点证据。';
  }
  if (evidence.active) {
    return '已检测到本地字幕证据，但没有匹配当前版本的可用片段。';
  }
  return evidence.message || '当前没有可引用字幕正文；不会生成推测时间戳。';
}

function evidenceSourceStatusLabel(
  status: NonNullable<NonNullable<VideoKnowledgeNode['evidence']>['sourceStatus']>,
): string {
  switch (status) {
    case 'active':
      return '当前匹配';
    case 'stale':
      return '已过期';
    case 'mismatch':
      return '不匹配';
    case 'unavailable':
      return '不可用';
    default:
      return '未知';
  }
}

function retrievalStatusMessage(result: CurrentVideoSegmentRetrievalResult): string {
  switch (result.status) {
    case 'ready':
      return result.summary;
    case 'low_confidence':
      return result.summary;
    case 'metadata_only':
      return result.summary;
    case 'empty_query':
      return '请输入想查找的片段内容。';
    case 'no_context':
      return '当前没有可用的视频上下文。';
    case 'stale_context':
      return '当前视频上下文已过期，请刷新后再试。';
    case 'no_evidence':
      return '没有找到可用的本地证据。';
    default:
      return result.summary;
  }
}

function retrievalStatusColor(result: CurrentVideoSegmentRetrievalResult): string {
  if (result.status === 'ready') return '#237A4B';
  if (result.status === 'metadata_only' || result.status === 'low_confidence') return '#955600';
  return '#61666D';
}

function segmentAiRerankStatusLabel(status: CurrentVideoSegmentRetrievalResult['aiRerank']['status']): string {
  switch (status) {
    case 'generated':
      return '已采用';
    case 'disabled':
      return '未启用';
    case 'not_configured':
      return '未配置';
    case 'failed':
      return '请求失败已回退';
    case 'rejected':
      return '结果未采用';
    case 'low_confidence':
      return '低置信已回退';
    case 'not_requested':
      return '未请求';
    default:
      return '本地顺序';
  }
}

function segmentAiRerankColor(status: CurrentVideoSegmentRetrievalResult['aiRerank']['status']): string {
  if (status === 'generated') return '#237A4B';
  if (status === 'disabled' || status === 'not_requested') return '#61666D';
  return '#955600';
}

function SettingsInlineButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        marginTop: '6px',
        background: 'rgba(0, 161, 214, 0.18)',
        color: '#007FA8',
        border: '1px solid rgba(127, 219, 255, 0.32)',
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '10px',
        padding: '4px 7px',
      }}
    >
      前往设置
    </button>
  );
}

function needsAiSettingsLink(status: string): boolean {
  return status === 'disabled' || status === 'not_configured';
}

function formatNodeTimeRange(node: VideoKnowledgeNode): string {
  if (node.timestamp === null) return '无时间点';
  if (typeof node.endTimestamp === 'number' && node.endTimestamp > node.timestamp) {
    return `${formatPopupDuration(node.timestamp)}-${formatPopupDuration(node.endTimestamp)}`;
  }
  return formatPopupDuration(node.timestamp);
}

function formatSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function currentVideoSummaryHighlightsTitle(context: CurrentVideoContextResult | null): string {
  if (context?.kind !== 'video') return '当前视频';
  return context.title?.trim() || '当前视频';
}

function popupCurrentVideoAvailablePrimarySourceIdentityKey(
  context: CurrentVideoContextResult | null,
): string | null {
  const evidence = context?.kind === 'video' ? context.transcriptEvidence : null;
  if (
    context?.kind !== 'video'
    || context.cid === null
    || evidence?.active !== true
    || evidence.bvid !== context.bvid
    || evidence.cid !== context.cid
    || evidence.page !== context.currentPart.page
    || !evidence.sourceIdentityKey
  ) {
    return null;
  }
  return evidence.sourceIdentityKey;
}

function latestCurrentVideoQaTurnResult(
  session: CurrentVideoQaSessionRecord | null,
): CurrentVideoFullTextQaResult | null {
  const turn = [...(session?.turns ?? [])].reverse().find(item => item.status !== 'pending');
  return session && turn ? currentVideoQaTurnToPopupResult(session.sessionId, turn) : null;
}

function currentVideoQaTurnToPopupResult(
  sessionId: string,
  turn: CurrentVideoQaSessionTurn,
): CurrentVideoFullTextQaResult {
  return {
    sessionId,
    status: turn.status as CurrentVideoFullTextQaResult['status'],
    requestId: turn.requestId,
    turnId: turn.turnId,
    question: turn.question,
    title: turn.source?.title ?? '当前视频',
    partTitle: turn.source?.partTitle ?? null,
    sourceLabel: turn.source?.sourceLabel ?? null,
    textSize: turn.source?.textSize ?? { lineCount: 0, charCount: null, utf8Bytes: 0 },
    answer: turn.answer,
    answerEvidenceLineNumbers: [],
    citations: turn.citations,
    message: turn.message,
    limitations: [],
    ai: turn.ai,
    sourceReference: sourceReferenceFromPopupQaSource(turn.source),
    rollingContext: turn.rollingContext,
    generatedAt: turn.generatedAt ?? turn.updatedAt,
    canRetry: turn.canRetry,
  };
}

function sourceReferenceFromPopupQaSource(
  source: CurrentVideoQaSourceSnapshot | null,
): CurrentVideoFullTextQaResult['sourceReference'] {
  if (!source) return null;
  return {
    title: source.title,
    partTitle: source.partTitle,
    page: source.page,
    bvid: source.bvid,
    cid: source.cid,
    url: source.url,
    sourceLabel: source.sourceLabel,
    language: source.language,
    sourceIdentityKey: source.sourceIdentityKey,
    textSize: source.textSize,
    capturedAt: source.capturedAt,
  };
}

function currentVideoQaSourceMatchesPopupContext(
  source: CurrentVideoQaSourceSnapshot | CurrentVideoFullTextQaResult['sourceReference'] | null,
  context: CurrentVideoContextResult | null,
): boolean {
  const activeSourceIdentityKey = popupCurrentVideoAvailablePrimarySourceIdentityKey(context);
  return Boolean(
    source
    && context?.kind === 'video'
    && context.cid !== null
    && source.bvid === context.bvid
    && source.cid === context.cid
    && source.page === context.currentPart.page
    && source.sourceIdentityKey
    && activeSourceIdentityKey
    && source.sourceIdentityKey === activeSourceIdentityKey,
  );
}

function fullTextQaPreviewKey(binding: CurrentVideoFullTextQaCitationBinding): string {
  return [
    binding.sessionId ?? 'legacy',
    binding.turnId,
    binding.requestId,
    binding.citationId,
  ].join(':');
}

function fullTextQaCitationBindingsEqual(
  left: CurrentVideoFullTextQaCitationBinding,
  right: CurrentVideoFullTextQaCitationBinding,
): boolean {
  return fullTextQaPreviewKey(left) === fullTextQaPreviewKey(right);
}

function currentVideoSummaryHighlightBindingsEqual(
  left: CurrentVideoSummaryHighlightBinding | null,
  right: CurrentVideoSummaryHighlightBinding | null,
): boolean {
  return Boolean(
    left
    && right
    && left.highlightId === right.highlightId
    && left.cacheKey === right.cacheKey
    && left.generatedAt === right.generatedAt
    && left.requestId === right.requestId
    && left.model === right.model,
  );
}

function currentVideoSummaryActionNotice(
  context: CurrentVideoContextResult | null,
  summary: CurrentVideoSummaryHighlightsResult | null,
): string {
  if (summary) {
    return `本次正文规模：${formatTextSize(summary.textSize)}。等待时间和费用由你配置的 AI 服务决定。`;
  }
  if (context?.kind === 'video') {
    const lineCount = context.transcriptEvidence?.segmentCount ?? 0;
    const bytes = context.transcriptEvidence?.serializedBytes ?? 0;
    return `可发送正文规模：${lineCount} 行，约 ${formatBytes(bytes)}。只有点击生成才会发送；等待时间和费用由你配置的 AI 服务决定。`;
  }
  return '当前没有可发送的正文。只有在视频页选择主要文本来源后，才可以手动生成。';
}

function currentVideoFullTextQaActionNotice(
  context: CurrentVideoContextResult | null,
  result: CurrentVideoFullTextQaResult | null,
): string {
  const durationSeconds = context?.kind === 'video'
    ? context.currentPart.page > 0
      ? context.parts.find(part => part.page === context.currentPart.page)?.durationSeconds ?? context.durationSeconds
      : context.durationSeconds
    : null;
  const durationLabel = typeof durationSeconds === 'number' && durationSeconds > 0
    ? `，视频约 ${formatPopupDuration(durationSeconds)}`
    : '';
  if (result) {
    return `每次提交都会发送当前分 P 的完整主要文本（${formatTextSize(result.textSize)}${durationLabel}）。长文本可能等待更久并产生更多费用，系统不会静默截短。`;
  }
  if (context?.kind === 'video') {
    const lineCount = context.transcriptEvidence?.segmentCount ?? 0;
    const bytes = context.transcriptEvidence?.serializedBytes ?? 0;
    return `每次提交都会发送当前分 P 的完整主要文本（${lineCount} 行，约 ${formatBytes(bytes)}${durationLabel}）。长文本可能等待更久并产生更多费用，系统不会静默截短。`;
  }
  return '当前没有可发送的主要文本。进入 B 站视频页并确认文本来源后再提交。';
}

function fullTextQaStatusLabel(status: CurrentVideoFullTextQaResult['status']): string {
  switch (status) {
    case 'unsupported':
      return '文本依据不足';
    case 'no_context':
      return '当前视频不可用';
    case 'no_text':
      return '当前文本不可用';
    case 'disabled':
      return '功能未开启';
    case 'not_configured':
      return 'AI 服务未配置';
    case 'context_too_long':
      return '正文超出所选模型限制';
    case 'cancelled':
      return '已取消';
    case 'invalid_output':
      return '回答未通过校验';
    case 'error':
      return '回答失败';
    case 'ready':
      return '回答';
    default:
      return '未完成';
  }
}

function fullTextQaStatusColor(status: CurrentVideoFullTextQaResult['status']): string {
  if (status === 'ready') return '#237A4B';
  if (status === 'unsupported') return '#007FA8';
  return '#955600';
}

function safeFullTextQaVisibleText(value: string): string {
  return value
    .replace(/document is not defined/gi, '运行状态不可用')
    .replace(
      /\b(?:subtitle_url|sourceHash|segmentIds?|candidateId|nodeId|sourceId|BVID|CID)\s*[:=]\s*[^\s,;，；。！？!?]+/gi,
      '内部信息已隐藏',
    )
    .replace(/\bBV[0-9A-Za-z]{10}\b/gi, '视频编号已隐藏')
    .replace(
      /\b(?:fallback|transcript|confidence|sourceHash|segmentIds?|subtitle_url|BVID|CID)\b/gi,
      (term) => {
        switch (term.toLowerCase()) {
          case 'fallback': return '本地兜底';
          case 'transcript': return '字幕正文';
          case 'confidence': return '匹配度';
          case 'sourcehash': return '来源标识';
          case 'segmentid':
          case 'segmentids': return '片段标识';
          case 'subtitle_url': return '字幕链接';
          case 'bvid': return '视频编号';
          case 'cid': return '分 P 信息';
          default: return '内部字段';
        }
      },
    );
}

function fullTextQaSourceLine(result: CurrentVideoFullTextQaResult, sourceCurrent = true): string {
  const title = safeFullTextQaVisibleText(result.title || '当前视频');
  const page = result.sourceReference?.page;
  const partTitle = result.partTitle?.trim() || null;
  const part = Number.isInteger(page) && Number(page) > 0
    ? ` · P${page}${partTitle ? `（${safeFullTextQaVisibleText(partTitle)}）` : ''}`
    : partTitle
      ? ` · ${safeFullTextQaVisibleText(partTitle)}`
      : '';
  const stale = sourceCurrent ? '' : '（基于此前视频文本）';
  return `依据《${title}》${part} · ${result.sourceLabel ?? '主要文本'}${stale}，${formatTextSize(result.textSize)}。`;
}

function summaryHighlightsStatusLabel(status: CurrentVideoSummaryHighlightsResult['status']): string {
  switch (status) {
    case 'ready':
      return '摘要与亮点';
    case 'not_requested':
      return '未生成';
    case 'no_context':
      return '无上下文';
    case 'no_text':
      return '无正文';
    case 'loading':
      return '准备中';
    case 'generating':
      return '生成中';
    case 'cancelled':
      return '已取消';
    case 'error':
      return '未生成';
    case 'invalid_output':
      return '已拒绝';
    default:
      return '未知状态';
  }
}

function summaryHighlightsAiStatusLabel(status: CurrentVideoSummaryHighlightsResult['ai']['status']): string {
  switch (status) {
    case 'not_requested':
      return '未请求';
    case 'disabled':
      return '未启用';
    case 'not_configured':
      return '未配置';
    case 'generated':
      return '已生成';
    case 'failed':
      return '失败';
    case 'invalid_output':
      return '已拒绝';
    case 'context_too_long':
      return '正文过长';
    case 'cancelled':
      return '已取消';
    default:
      return '未知状态';
  }
}

function formatBytes(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${(safe / 1024 / 1024).toFixed(1)} MB`;
}

function formatBoolean(value: boolean): string {
  return value ? '是' : '否';
}

function formatPopupDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatTailProbeReport(report: HistoryTailProbeReport): string {
  const lines = [
    `请求页数=${report.requestedMaxPages ?? '默认'}；规范化页数=${report.normalizedPageLimit}；每页=${report.pageSize}`,
    `已获取页数=${report.fetchedPages}；已获取条目=${report.fetchedItems}；停止原因=${report.stopReason}；到达末页=${formatBoolean(report.reachedDeclaredEnd)}`,
    `时间范围=${formatProbeViewAt(report.oldestFetchedAt)} -> ${formatProbeViewAt(report.newestFetchedAt)}`,
    `重复游标=${formatBoolean(report.repeatedCursorDetected)}；短页=${report.shortPageAnomalyCount}；空页异常=${report.emptyPageAnomalyCount}`,
  ];

  if (report.finalCursor) {
    lines.push(`最终游标=${formatProbeCursor(report.finalCursor)}`);
  }

  for (const page of report.pages) {
    lines.push(
      `第 ${page.pageIndex} 页：条目=${page.itemCount}；范围=${formatProbeViewAt(page.oldestViewAt)} -> ${formatProbeViewAt(page.newestViewAt)}；请求游标=${formatProbeCursor(page.requestedCursor)}；响应游标=${formatProbeCursor(page.responseCursor)}；重复=${formatBoolean(page.repeatedCursor)}；短页=${formatBoolean(page.shortPageAnomaly)}；空页=${formatBoolean(page.emptyPage)}；末页=${formatBoolean(page.declaredEnd)}`,
    );
  }

  return lines.join('\n');
}

function formatProbeCursor(cursor: HistoryTailProbeReport['finalCursor']): string {
  if (!cursor) return '初始';
  return `max=${cursor.max ?? '空'},view_at=${cursor.viewAt ?? '空'},business=${cursor.business ?? '空'},has_more=${cursor.hasMore == null ? '空' : formatBoolean(cursor.hasMore)}`;
}

function formatProbeViewAt(value: number | null): string {
  if (!value) return '无';
  return new Date(value * 1000).toLocaleString('zh-CN');
}
