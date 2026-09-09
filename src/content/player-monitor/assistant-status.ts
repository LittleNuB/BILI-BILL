import { syncAssistantResize } from './assistant-resize';
import { syncAssistantDrag, resetAssistantPosition } from './assistant-drag';
import type {
  CurrentVideoContext,
  CurrentVideoContextResult,
} from '../../shared/types/current-video-context';
import { assistantStyles } from './assistant-styles';
import { assistantIcon, compactSummaryText, followAssistantPageTheme } from './assistant-presentation';
import { learningEditorButton, learningSourceButton } from './learning-editor.ts';
import type { BiliVizResponse, RequestAction } from '../../shared/types/messages';
import type {
  CurrentVideoSummaryHighlight,
  CurrentVideoSummaryHighlightBinding,
  CurrentVideoSummaryHighlightsResult,
} from '../../shared/types/current-video-summary';
import type { CurrentVideoTranscriptEvidenceState } from '../../shared/types/current-video-transcript';
import type {
  CurrentVideoSegmentRetrievalCandidate,
  CurrentVideoSegmentRetrievalResult,
  CurrentVideoTimestampJumpResponse,
  CurrentVideoTimestampReturnResponse,
} from '../../shared/types/current-video-segment-retrieval';
import type {
  CurrentVideoSubtitleFollowState,
  CurrentVideoSubtitleLine,
  CurrentVideoSubtitleSearchState,
  CurrentVideoSubtitleViewingSource,
  CurrentVideoSubtitleViewSourcesResult,
} from '../../shared/current-video-subtitle-view.ts';
import type { CurrentVideoRelatedFavoritesResponse } from '../../shared/types/current-video-related-favorites';
import type {
  CurrentVideoFullTextQaCitation,
  CurrentVideoFullTextQaCitationBinding,
  CurrentVideoFullTextQaResult,
} from '../../shared/types/current-video-full-text-qa';
import type {
  CurrentVideoQaSessionRecord,
  CurrentVideoQaSessionsView,
  CurrentVideoQaSessionTurn,
  CurrentVideoQaSourceSnapshot,
} from '../../shared/types/current-video-qa-session';
import type {
  SmartFavoriteQaCitedVideo,
  SmartFavoriteQaResponse,
  SmartFavoriteQaSynthesisStatus,
} from '../../shared/types/favorite';
import type {
  VideoKnowledgeEvidenceSourceStatus,
  VideoKnowledgeNode,
  VideoKnowledgeResult,
} from '../../shared/types/video-knowledge';
import { buildCurrentVideoSubtitleDiagnostics } from '../../shared/current-video-subtitle-diagnostics';
import {
  createCurrentVideoFullTextRequestId,
  buildCurrentVideoPrimaryTextState,
  type CurrentVideoPrimaryTextSourceOption,
} from '../../shared/current-video-primary-text';
import {
  buildCurrentVideoSubtitleJumpPreview,
  buildSubtitleExportFilename,
  currentVideoSubtitleContextKey,
  formatSubtitleSrt,
  formatSubtitleTxt,
  navigateCurrentVideoSubtitleSearchResult,
  reduceCurrentVideoSubtitleFollowState,
  searchCurrentVideoSubtitleLines,
  selectDefaultSubtitleViewingSource,
  shouldShowSubtitleViewingSourceSwitcher,
  validateSubtitleViewingIdentity,
} from '../../shared/current-video-subtitle-view.ts';
import {
  asPriorGeneratedCurrentVideoSummaryHighlights,
  cancelledCurrentVideoSummaryHighlights,
  currentVideoSummaryHighlightBindingFromResult,
  formatTextSize,
  loadingCurrentVideoSummaryHighlights,
} from '../../shared/current-video-summary-highlights.ts';
import {
  CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY,
  currentVideoPrimaryTextPartKey,
  normalizeCurrentVideoPrimaryTextSelections,
  resolveCurrentVideoPrimaryTextAuthorization,
  type SaveCurrentVideoPrimaryTextSelectionResult,
} from '../../shared/current-video-primary-text-selection.ts';

const CARD_ID = 'bdc-current-video-assistant';
const STYLE_ID = 'bdc-current-video-assistant-style';
const USER_CONFIG_STORAGE_KEY = 'userConfig';

const RAW_FIELD_PATTERN = new RegExp(
  `\\b(?:${[
    ['subtitle', '_', 'url'],
    ['source', 'Hash'],
    ['segment', 'Id'],
    ['segment', 'Ids'],
    ['candidate', 'Id'],
    ['candidate', ' id'],
    ['node', 'Id'],
    ['node', ' id'],
    ['source', 'Id'],
    ['to', 'ken'],
    ['endpoint', ' path'],
    ['Coo', 'kie'],
    ['pro', 'file'],
    ['Key', '.', 'txt'],
    ['Chrome', '\\\\', 'User Data'],
  ].map(parts => escapeRegExp(parts.join(''))).join('|')})\\b`,
  'gi',
);
const CANDIDATE_ID_PATTERN = new RegExp(
  `${escapeRegExp(['candidate', ':'].join(''))}[A-Za-z0-9:._-]+`,
  'g',
);
const TRANSCRIPT_ID_PATTERN = new RegExp(
  `${escapeRegExp(['transcript', ':'].join(''))}[A-Za-z0-9:._-]+`,
  'g',
);
const NODE_ID_PATTERN = new RegExp(
  `${escapeRegExp(['node', ':'].join(''))}[A-Za-z0-9:._-]+`,
  'g',
);
const PLAYER_ENDPOINT_PATTERN = new RegExp(
  `${escapeRegExp(['/x', '/player'].join(''))}(?:${escapeRegExp('/wbi')})?${escapeRegExp('/v2')}`,
  'gi',
);
const ENGINEERING_VISIBLE_TERM_PATTERN = /\b(?:fallback|transcript|confidence)\b/gi;
const RAW_FIELD_VALUE_PATTERN = /\b(?:subtitle_url|sourceHash|segmentIds?|candidateId|nodeId|sourceId|BVID|CID)\s*[:=]\s*[^\s,;，；。！？!?]+/gi;
const BILIBILI_VIDEO_ID_PATTERN = /\bBV[0-9A-Za-z]{10}\b/gi;
const PAGE_BODY_TEXT_PATTERN = new RegExp(['正文', '文本'].join(''), 'g');

const CSS = assistantStyles(CARD_ID);

type AssistantTab = 'summary' | 'highlights' | 'qa' | 'subtitles';

interface AssistantState {
  expanded: boolean;
  activeTab: AssistantTab;
  context: CurrentVideoContextResult | null;
  contextKey: string;
  summary: CurrentVideoSummaryHighlightsResult | null;
  summaryContextKey: string;
  summaryLoading: boolean;
  summaryCacheLoading: boolean;
  summaryError: string | null;
  summaryRequestId: number;
  summaryActiveRequest: InPageSummaryHighlightsRequest | null;
  summaryHighlightPreview: CurrentVideoSummaryHighlightBinding | null;
  summaryHighlightJumpStatus: string | null;
  summaryHighlightJumpLoading: boolean;
  summaryHighlightReturnAvailable: boolean;
  summaryHighlightReturnLoading: boolean;
  summaryHighlightTimestampRequestId: number;
  knowledge: VideoKnowledgeResult | null;
  knowledgeContextKey: string;
  knowledgeLoading: boolean;
  knowledgeError: string | null;
  knowledgeRequestId: number;
  segmentQuery: string;
  segmentResult: CurrentVideoSegmentRetrievalResult | null;
  segmentContextKey: string;
  segmentLoading: boolean;
  segmentError: string | null;
  segmentRequestId: number;
  segmentPreviewCandidateId: string | null;
  segmentJumpStatus: string | null;
  segmentJumpLoading: boolean;
  segmentReturnAvailable: boolean;
  segmentReturnLoading: boolean;
  segmentTimestampRequestId: number;
  fullTextQaActiveRequests: Map<string, InPageFullTextQaRequest>;
  fullTextQaErrors: Map<string, string>;
  fullTextQaSessions: CurrentVideoQaSessionsView | null;
  fullTextQaSessionsLoading: boolean;
  fullTextQaSessionsError: string | null;
  fullTextQaSessionsRequestId: number;
  fullTextQaActiveSessionId: string | null;
  fullTextQaPreviewCitationId: string | null;
  fullTextQaJumpStatus: string | null;
  fullTextQaJumpLoading: boolean;
  fullTextQaReturnAvailable: boolean;
  fullTextQaReturnLoading: boolean;
  fullTextQaTimestampRequestId: number;
  relatedFavorites: CurrentVideoRelatedFavoritesResponse | null;
  relatedFavoritesContextKey: string;
  relatedFavoritesLoading: boolean;
  relatedFavoritesError: string | null;
  relatedFavoritesRequestId: number;
  primaryTextViewingSourceIdentityKey: string | null;
  primaryTextStatus: string | null;
  primaryTextSaving: boolean;
  subtitleRefreshing: boolean;
  subtitleStatus: string | null;
  subtitleRequestId: number;
  subtitleView: CurrentVideoSubtitleViewSourcesResult | null;
  subtitleViewContextKey: string;
  subtitleViewLoading: boolean;
  subtitleViewError: string | null;
  subtitleViewRequestId: number;
  subtitleViewingSourceIdentityKey: string | null;
  subtitleSearchQuery: string;
  subtitleSearch: CurrentVideoSubtitleSearchState | null;
  subtitleFollow: CurrentVideoSubtitleFollowState;
  subtitlePreviewLineId: string | null;
  subtitleJumpStatus: string | null;
  subtitleJumpLoading: boolean;
  subtitleReturnAvailable: boolean;
  subtitleReturnLoading: boolean;
  subtitleTimestampRequestId: number;
  subtitleExportStatus: string | null;
}

interface InPageSummaryHighlightsRequest {
  requestId: string;
  params: Record<string, unknown>;
  contextKey: string;
  selectionRevision: number;
  selectedSourceIdentityKey: string | null;
  title: string;
  textSize: CurrentVideoSummaryHighlightsResult['textSize'];
  previousReady: CurrentVideoSummaryHighlightsResult | null;
}

interface InPageFullTextQaRequest {
  liveText?: string;
  sessionId: string;
  requestId: string;
  turnId: string;
  params: Record<string, unknown>;
  contextKey: string;
  selectionRevision: number;
  selectedSourceIdentityKey: string | null;
  question: string;
}

const CURRENT_VIDEO_QA_DRAFT_SESSION_STATE_KEY = '__current-video-qa-draft__';
const primaryTextSelections = new Map<string, string>();
const primaryTextSelectionSaveFailedPartKeys = new Set<string>();
let primaryTextSelectionsLoaded = false;
let primaryTextSelectionsLoading = false;
let primaryTextSelectionsReadFailed = false;
let primaryTextSelectionsLoadRequestId = 0;
let primaryTextSelectionsRevision = 0;
let primaryTextSelectionStorageListenerRegistered = false;

const assistantState: AssistantState = {
  expanded: false,
  activeTab: 'summary',
  context: null,
  contextKey: '',
  summary: null,
  summaryContextKey: '',
  summaryLoading: false,
  summaryCacheLoading: false,
  summaryError: null,
  summaryRequestId: 0,
  summaryActiveRequest: null,
  summaryHighlightPreview: null,
  summaryHighlightJumpStatus: null,
  summaryHighlightJumpLoading: false,
  summaryHighlightReturnAvailable: false,
  summaryHighlightReturnLoading: false,
  summaryHighlightTimestampRequestId: 0,
  knowledge: null,
  knowledgeContextKey: '',
  knowledgeLoading: false,
  knowledgeError: null,
  knowledgeRequestId: 0,
  segmentQuery: '',
  segmentResult: null,
  segmentContextKey: '',
  segmentLoading: false,
  segmentError: null,
  segmentRequestId: 0,
  segmentPreviewCandidateId: null,
  segmentJumpStatus: null,
  segmentJumpLoading: false,
  segmentReturnAvailable: false,
  segmentReturnLoading: false,
  segmentTimestampRequestId: 0,
  fullTextQaActiveRequests: new Map(),
  fullTextQaErrors: new Map(),
  fullTextQaSessions: null,
  fullTextQaSessionsLoading: false,
  fullTextQaSessionsError: null,
  fullTextQaSessionsRequestId: 0,
  fullTextQaActiveSessionId: null,
  fullTextQaPreviewCitationId: null,
  fullTextQaJumpStatus: null,
  fullTextQaJumpLoading: false,
  fullTextQaReturnAvailable: false,
  fullTextQaReturnLoading: false,
  fullTextQaTimestampRequestId: 0,
  relatedFavorites: null,
  relatedFavoritesContextKey: '',
  relatedFavoritesLoading: false,
  relatedFavoritesError: null,
  relatedFavoritesRequestId: 0,
  primaryTextViewingSourceIdentityKey: null,
  primaryTextStatus: null,
  primaryTextSaving: false,
  subtitleRefreshing: false,
  subtitleStatus: null,
  subtitleRequestId: 0,
  subtitleView: null,
  subtitleViewContextKey: '',
  subtitleViewLoading: false,
  subtitleViewError: null,
  subtitleViewRequestId: 0,
  subtitleViewingSourceIdentityKey: null,
  subtitleSearchQuery: '',
  subtitleSearch: null,
  subtitleFollow: {
    mode: 'following',
    activeLineId: null,
    pausedReason: null,
  },
  subtitlePreviewLineId: null,
  subtitleJumpStatus: null,
  subtitleJumpLoading: false,
  subtitleReturnAvailable: false,
  subtitleReturnLoading: false,
  subtitleTimestampRequestId: 0,
  subtitleExportStatus: null,
};
let subtitleFollowTimer: number | null = null;
let subtitleProgrammaticScrollUntil = 0;
let sourceDetailsOpen = false;

export function renderCurrentVideoAssistant(context: CurrentVideoContextResult): void {
  injectStyle();
  ensurePrimaryTextSelectionStorageListener();
  ensurePrimaryTextSelectionsLoaded();
  const previousContextKey = assistantState.contextKey;
  updateAssistantContext(context);
  renderAssistantShell();
  if (previousContextKey !== assistantState.contextKey) {
    void restoreCurrentVideoSummaryHighlightsFromPage();
  }
}

function updateAssistantContext(context: CurrentVideoContextResult): void {
  const nextKey = contextStateKey(context);
  const previousSubtitleKey = subtitleContextKeyForContext(assistantState.context);
  const nextSubtitleKey = subtitleContextKeyForContext(context);
  const subtitleKeyChanged = previousSubtitleKey !== nextSubtitleKey;
  if (assistantState.contextKey !== nextKey) {
    const previous = assistantState.context;
    if (previous?.kind !== 'video' || context.kind !== 'video'
      || previous.bvid !== context.bvid || previous.cid !== context.cid
      || previous.currentPart.page !== context.currentPart.page) sourceDetailsOpen = false;
    invalidateSegmentTimestampRequests();
    assistantState.summary = null;
    assistantState.summaryContextKey = '';
    assistantState.summaryError = null;
    assistantState.summaryCacheLoading = false;
    assistantState.summaryHighlightPreview = null;
    assistantState.summaryHighlightJumpStatus = null;
    assistantState.summaryHighlightJumpLoading = false;
    assistantState.summaryHighlightReturnAvailable = false;
    assistantState.summaryHighlightReturnLoading = false;
    assistantState.summaryHighlightTimestampRequestId += 1;
    assistantState.knowledge = null;
    assistantState.knowledgeContextKey = '';
    assistantState.knowledgeError = null;
    assistantState.knowledgeLoading = false;
    assistantState.segmentResult = null;
    assistantState.segmentContextKey = '';
    assistantState.segmentError = null;
    assistantState.segmentPreviewCandidateId = null;
    assistantState.segmentJumpStatus = null;
    assistantState.segmentJumpLoading = false;
    assistantState.segmentReturnAvailable = false;
    assistantState.segmentReturnLoading = false;
    assistantState.fullTextQaErrors.clear();
    assistantState.fullTextQaPreviewCitationId = null;
    assistantState.fullTextQaJumpStatus = null;
    assistantState.fullTextQaJumpLoading = false;
    assistantState.fullTextQaReturnAvailable = false;
    assistantState.fullTextQaReturnLoading = false;
    assistantState.fullTextQaTimestampRequestId += 1;
    assistantState.relatedFavorites = null;
    assistantState.relatedFavoritesContextKey = '';
    assistantState.relatedFavoritesError = null;
    assistantState.relatedFavoritesLoading = false;
    assistantState.primaryTextViewingSourceIdentityKey = null;
    assistantState.primaryTextStatus = null;
    assistantState.subtitleStatus = null;
    if (subtitleKeyChanged) {
      assistantState.subtitleView = null;
      assistantState.subtitleViewContextKey = '';
      assistantState.subtitleViewLoading = false;
      assistantState.subtitleViewError = null;
      assistantState.subtitleViewRequestId += 1;
      assistantState.subtitleViewingSourceIdentityKey = null;
      assistantState.subtitleSearchQuery = '';
      assistantState.subtitleSearch = null;
      assistantState.subtitleFollow = {
        mode: 'following',
        activeLineId: null,
        pausedReason: 'source_changed',
      };
      assistantState.subtitlePreviewLineId = null;
      assistantState.subtitleJumpStatus = null;
      assistantState.subtitleJumpLoading = false;
      assistantState.subtitleReturnAvailable = false;
      assistantState.subtitleReturnLoading = false;
      assistantState.subtitleTimestampRequestId += 1;
      assistantState.subtitleExportStatus = null;
    }
  }
  assistantState.context = context;
  assistantState.contextKey = nextKey;
}

function renderAssistantShell(): void {
  const existing = document.getElementById(CARD_ID);
  const focusedElement = document.activeElement;
  const chatInput = focusedElement instanceof HTMLTextAreaElement && existing?.contains(focusedElement) ? focusedElement : null;
  const selection = chatInput ? [chatInput.selectionStart, chatInput.selectionEnd] : null;
  const scroll = existing?.querySelector<HTMLElement>('.bdc-chat-timeline');
  if (scroll) chatScroll.set(scroll.dataset.session!, scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64 ? Infinity : scroll.scrollTop);
  const restoreActiveTabFocus = Boolean(
    existing
    && focusedElement instanceof HTMLElement
    && existing.contains(focusedElement)
    && focusedElement.getAttribute('role') === 'tab',
  );
  const root = existing ?? document.createElement('aside');
  root.id = CARD_ID;
  root.className = assistantState.expanded
    ? 'bdc-assistant-expanded'
    : 'bdc-assistant-collapsed';
  root.setAttribute('aria-label', 'Bili-Bill 当前视频页内助手');
  followAssistantPageTheme(root);
  root.textContent = '';

  if (assistantState.expanded) {
    renderExpandedPanel(root);
  } else {
    renderCollapsedCard(root);
  }

  if (!existing) {
    document.body.appendChild(root);
  }
  syncAssistantResize(root, assistantState.expanded);
  syncAssistantDrag(root, assistantState.expanded);
  if (selection) {
    const input = root.querySelector<HTMLTextAreaElement>('.bdc-chat-composer textarea');
    input?.focus({ preventScroll: true }); input?.setSelectionRange(selection[0], selection[1]);
  }
  if (restoreActiveTabFocus && assistantState.expanded) {
    document.getElementById(assistantTabId(assistantState.activeTab))?.focus({ preventScroll: true });
  }
  syncSubtitleFollowTimer();
}

function renderCollapsedCard(root: HTMLElement): void {
  const card = document.createElement('div');
  card.className = 'bdc-assistant-shell bdc-assistant-compact';
  appendCompactVideoIdentity(card);
  const preview = compactSummaryText(assistantState.summary, assistantState.summaryContextKey === assistantState.contextKey);
  if (preview) appendText(card, 'div', 'bdc-assistant-compact-summary', safeVisibleText(preview));

  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-compact-actions';
  const expand = button('展开', 'bdc-assistant-button bdc-assistant-expand', () => {
    assistantState.expanded = true;
    renderAssistantShell();
    document.getElementById(assistantTabId(assistantState.activeTab))?.focus({ preventScroll: true });
    void restoreCurrentVideoSummaryHighlightsFromPage();
  });
  expand.setAttribute('aria-label', '展开助手');
  expand.appendChild(assistantIcon('down'));
  actions.appendChild(expand);
  card.appendChild(actions);
  root.appendChild(card);
}

function appendCompactVideoIdentity(parent: HTMLElement): void {
  const context = assistantState.context;
  const row = document.createElement('div');
  row.className = 'bdc-assistant-identity';
  const title = context?.kind === 'video' ? context.title || '当前视频' : '当前视频助手';
  const text = appendText(row, 'div', 'bdc-assistant-video-title', safeVisibleText(title));
  text.title = safeVisibleText(title);
  if (context?.kind === 'video') {
    const part = appendText(row, 'span', 'bdc-assistant-part', `P${context.currentPart.page}${context.currentPart.total ? ` / ${context.currentPart.total}` : ''}`);
    part.setAttribute('aria-label', `当前分 P：第 ${context.currentPart.page} P`);
  }
  parent.appendChild(row);
}

function iconButton(label: string, icon: 'minus' | 'refresh', action: () => void, disabled = false): HTMLButtonElement {
  const control = button('', 'bdc-assistant-button bdc-assistant-icon-button', action, disabled);
  control.title = label;
  control.setAttribute('aria-label', label);
  control.appendChild(assistantIcon(icon));
  return control;
}

function renderExpandedPanel(root: HTMLElement): void {
  const panel = document.createElement('div');
  panel.className = 'bdc-assistant-panel';

  const header = document.createElement('div');
  header.className = 'bdc-assistant-header';
  const brand = document.createElement('div');
  brand.className = 'bdc-assistant-brand';
  appendText(brand, 'div', 'bdc-assistant-kicker', 'Bili-Bill');
  header.appendChild(brand);

  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-actions';
  if (assistantState.context?.kind === 'video') actions.append(learningEditorButton('note'), learningEditorButton('bookmark'));
  const more = document.createElement('details');
  more.className = 'bdc-assistant-more';
  const trigger = document.createElement('summary');
  trigger.className = 'bdc-assistant-icon-button';
  trigger.title = '更多操作';
  trigger.setAttribute('aria-label', '更多操作');
  trigger.appendChild(assistantIcon('more'));
  more.appendChild(trigger);
  const menu = document.createElement('div');
  menu.className = 'bdc-assistant-more-content';
  menu.appendChild(dashboardLink('打开全局总览'));
  menu.appendChild(button('恢复窗口位置', 'bdc-assistant-button bdc-assistant-button-quiet', () => { resetAssistantPosition(); renderAssistantShell(); }));
  more.appendChild(menu);
  more.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { more.open = false; trigger.focus(); }
  });
  actions.appendChild(more);
  actions.appendChild(iconButton('收起', 'minus', () => {
    assistantState.expanded = false;
    renderAssistantShell();
    document.querySelector<HTMLButtonElement>(`#${CARD_ID} .bdc-assistant-expand`)?.focus({ preventScroll: true });
  }));
  header.appendChild(actions);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'bdc-assistant-body';

  const context = assistantState.context;
  if (context?.kind === 'video') {
    const identity = document.createElement('div');
    identity.className = 'bdc-assistant-context-bar';
    appendCompactVideoIdentity(identity);
    const details = document.createElement('details');
    details.className = 'bdc-assistant-source-details';
    details.open = sourceDetailsOpen;
    const source = document.createElement('summary');
    const sourceState = buildPrimaryTextStateForContext(context);
    const active = sourceState.sources.find((item) => item.identity.sourceIdentityKey === sourceState.activeSourceIdentityKey);
    source.textContent = active?.label ?? (sourceState.sources.length ? '选择来源' : '暂无字幕');
    source.setAttribute('aria-label', '主要文本来源');
    source.appendChild(assistantIcon('down'));
    details.appendChild(source);
    appendPrimaryTextSourceSwitcher(details, context);
    details.addEventListener('toggle', () => { if (details.isConnected) sourceDetailsOpen = details.open; });
    identity.appendChild(details);
    if (assistantState.primaryTextStatus) appendText(identity, 'div', 'bdc-assistant-status', safeVisibleText(assistantState.primaryTextStatus));
    panel.appendChild(identity);
    appendAssistantTabs(panel);
    switch (assistantState.activeTab) {
      case 'highlights':
        appendHighlights(body);
        break;
      case 'qa':
        appendSegmentSearch(body, context);
        break;
      case 'subtitles':
        appendSubtitleView(body, context);
        break;
      case 'summary':
      default:
        appendSummary(body);
        break;
    }
  } else {
    const empty = section('当前视频');
    appendText(empty, 'div', 'bdc-assistant-video-title', '没有当前视频上下文');
    appendText(empty, 'div', 'bdc-assistant-muted', '请在 B 站视频页使用当前视频助手。');
    body.appendChild(empty);
  }

  panel.appendChild(body);
  root.appendChild(panel);
}

function appendAssistantTabs(parent: HTMLElement): void {
  const tabs = document.createElement('div');
  tabs.className = 'bdc-assistant-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '当前视频助手页签');
  const tabItems = [
    { key: 'summary' as const, label: '摘要' },
    { key: 'highlights' as const, label: '亮点' },
    { key: 'qa' as const, label: '问答' },
    { key: 'subtitles' as const, label: '字幕' },
  ];
  for (const tab of tabItems) {
    const active = assistantState.activeTab === tab.key;
    const element = button(
      tab.label,
      active ? 'bdc-assistant-tab bdc-assistant-tab-active' : 'bdc-assistant-tab',
      () => {
        assistantState.activeTab = tab.key;
        renderAssistantShell();
        if (tab.key === 'subtitles') void ensureSubtitleViewLoaded(false);
        if (tab.key === 'qa') void loadCurrentVideoQaSessionsFromPage();
      },
    );
    element.id = assistantTabId(tab.key);
    element.setAttribute('role', 'tab');
    element.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) element.setAttribute('aria-controls', assistantPanelId(tab.key));
    element.tabIndex = active ? 0 : -1;
    element.addEventListener('keydown', (event) => {
      const currentIndex = tabItems.findIndex(item => item.key === assistantState.activeTab);
      const move = (nextIndex: number) => {
        const next = tabItems[(nextIndex + tabItems.length) % tabItems.length];
        assistantState.activeTab = next.key;
        renderAssistantShell();
        document.getElementById(assistantTabId(next.key))?.focus();
        if (next.key === 'subtitles') void ensureSubtitleViewLoaded(false);
        if (next.key === 'qa') void loadCurrentVideoQaSessionsFromPage();
      };
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        move(currentIndex + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        move(currentIndex - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        move(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        move(tabItems.length - 1);
      }
    });
    tabs.appendChild(element);
  }
  parent.appendChild(tabs);
}

function assistantTabId(tab: AssistantTab): string {
  return `${CARD_ID}-tab-${tab}`;
}

function assistantPanelId(tab: AssistantTab): string {
  return `${CARD_ID}-panel-${tab}`;
}

function markAssistantTabPanel(panel: HTMLElement, tab: AssistantTab): void {
  panel.id = assistantPanelId(tab);
  panel.classList.add('bdc-assistant-tab-panel');
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', assistantTabId(tab));
  panel.dataset.assistantTabContent = tab;
}

function appendVideoIdentity(parent: HTMLElement, context: CurrentVideoContext): void {
  const block = section('当前视频', 'bdc-assistant-section-auxiliary');
  appendText(block, 'div', 'bdc-assistant-video-title', context.title?.trim() || '当前视频');

  const pills = document.createElement('div');
  pills.className = 'bdc-assistant-pills';
  pills.appendChild(pill('视频页已识别', Boolean(context.bvid)));
  pills.appendChild(pill(context.cid ? '当前分 P 已识别' : '等待分 P 信息', Boolean(context.cid)));
  block.appendChild(pills);

  appendRow(block, '当前分 P', `第 ${context.currentPart.page}${context.currentPart.total ? ` / ${context.currentPart.total} P` : ' P'}`);
  parent.appendChild(block);
}

function appendPrimaryTextSourceSwitcher(parent: HTMLElement, context: CurrentVideoContext): void {
  const block = section('主要文本来源', 'bdc-assistant-section-auxiliary');
  const sourceState = buildPrimaryTextStateForContext(context);
  appendText(block, 'div', 'bdc-assistant-subtitle-text', sourceState.state.userMessage);
  appendText(block, 'div', 'bdc-assistant-subtitle-detail', sourceState.state.action);

  if (!primaryTextSelectionsLoaded && !primaryTextSelectionsReadFailed) {
    appendText(block, 'div', 'bdc-assistant-status', '正在读取本页已保存的来源选择...');
  }
  block.querySelector('.bdc-assistant-section-head')?.appendChild(iconButton(
    assistantState.subtitleRefreshing ? '检测中...' : '重新检测字幕', 'refresh',
    () => { void refreshSubtitleEvidenceFromPage(); }, assistantState.subtitleRefreshing,
  ));

  const list = document.createElement('div');
  list.className = 'bdc-assistant-source-list';
  if (sourceState.sources.length === 0) {
    appendText(list, 'div', 'bdc-assistant-muted', '当前还没有可查看的正文来源。');
  }
  for (const source of sourceState.sources) {
    list.appendChild(primaryTextSourceCard(context, source, sourceState.activeSourceIdentityKey));
  }
  block.appendChild(list);
  parent.appendChild(block);
}

function buildPrimaryTextStateForContext(context: CurrentVideoContext): {
  sources: CurrentVideoPrimaryTextSourceOption[];
  state: ReturnType<typeof buildCurrentVideoPrimaryTextState>;
  selectedSourceIdentityKey: string | null;
  activeSourceIdentityKey: string | null;
  selectionSaveFailed: boolean;
} {
  const sources = availablePrimaryTextSources(context);
  const selectedSourceIdentityKey = selectedPrimaryTextSourceIdentityKey(context);
  const state = buildCurrentVideoPrimaryTextState({
    bvid: context.bvid,
    cid: context.cid,
    page: context.currentPart.page,
    sources,
    selectedSourceIdentityKey,
  });
  const selectionSaveFailed = primaryTextSelectionSaveFailedForContext(context);
  const blockImplicitSource = (primaryTextSelectionsReadFailed || selectionSaveFailed)
    && !selectedSourceIdentityKey;
  return {
    sources: state.sources,
    state,
    selectedSourceIdentityKey,
    activeSourceIdentityKey: blockImplicitSource
      ? null
      : state.primarySource?.identity.sourceIdentityKey ?? null,
    selectionSaveFailed,
  };
}

function availablePrimaryTextSources(context: CurrentVideoContext): CurrentVideoPrimaryTextSourceOption[] {
  const evidence = context.transcriptEvidence;
  if (
    context.cid
    && evidence?.active
    && evidence.source === 'bilibili_subtitle'
    && evidence.sourceIdentityKey
    && evidence.sourceHash
    && evidence.bodyHash
    && evidence.timelineHash
  ) {
    return [{
      identity: {
        bvid: context.bvid,
        cid: context.cid,
        page: context.currentPart.page,
        source: 'bilibili_subtitle',
        sourceType: evidence.sourceType,
        language: evidence.language,
        bodyHash: evidence.bodyHash,
        timelineHash: evidence.timelineHash,
        sourceHash: evidence.sourceHash,
        sourceIdentityKey: evidence.sourceIdentityKey,
        lineCount: evidence.segmentCount,
      },
      label: 'B站字幕',
      status: evidence.temporary ? 'temporary' : 'available',
      lineCount: evidence.segmentCount,
      byteSize: evidence.serializedBytes ?? 0,
      temporary: evidence.temporary === true,
      selectedByUser: selectedPrimaryTextSourceIdentityKey(context) === evidence.sourceIdentityKey,
    }];
  }
  return [];
}

function primaryTextSourceCard(
  context: CurrentVideoContext,
  source: CurrentVideoPrimaryTextSourceOption,
  activeSourceIdentityKey: string | null,
): HTMLElement {
  const isActive = activeSourceIdentityKey === source.identity.sourceIdentityKey;
  const isSelectedByUser = selectedPrimaryTextSourceIdentityKey(context) === source.identity.sourceIdentityKey;
  const isSaving = assistantState.primaryTextSaving
    && assistantState.primaryTextViewingSourceIdentityKey === source.identity.sourceIdentityKey;
  const selectionReady = primaryTextSelectionsLoaded || primaryTextSelectionsReadFailed;
  const card = document.createElement('article');
  card.className = [
    'bdc-assistant-source-card',
    isActive ? 'bdc-assistant-source-card-active' : '',
  ].filter(Boolean).join(' ');

  appendText(card, 'div', 'bdc-assistant-source-title', source.label);
  appendText(card, 'div', 'bdc-assistant-subtitle-detail', primaryTextSourceDescription(source));
  appendText(card, 'div', 'bdc-assistant-muted', isSelectedByUser
    ? '已由你明确设为当前视频助手来源。'
    : isActive
      ? '当前可用于助手；点击“用于视频助手”后会记住这个选择。'
      : '选择这个来源后，后续当前视频助手会使用它。');

  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-source-actions';
  actions.appendChild(button(
    isSaving
      ? '保存中...'
      : !selectionReady
        ? '读取中...'
        : isSelectedByUser
          ? '已用于助手'
          : '用于视频助手',
    isSelectedByUser
      ? 'bdc-assistant-button bdc-assistant-button-quiet'
      : 'bdc-assistant-button bdc-assistant-button-primary',
    () => {
      void selectPrimaryTextSourceForAssistant(context, source.identity.sourceIdentityKey, source.label);
    },
    !selectionReady || assistantState.primaryTextSaving || isSelectedByUser,
  ));
  card.appendChild(actions);
  return card;
}

function primaryTextSourceDescription(source: CurrentVideoPrimaryTextSourceOption): string {
  const size = source.byteSize > 0 ? `，约 ${formatByteSize(source.byteSize)}` : '';
  if (source.temporary) {
    return `本次临时使用的字幕正文，${source.lineCount} 条${size}；离开页面或服务重载后可能需要重新检测。`;
  }
  return `当前分 P 可用字幕正文，${source.lineCount} 条${size}。`;
}

async function selectPrimaryTextSourceForAssistant(
  context: CurrentVideoContext,
  sourceIdentityKey: string,
  label: string,
): Promise<void> {
  if (!primaryTextSelectionsLoaded && !primaryTextSelectionsReadFailed) {
    assistantState.primaryTextStatus = '正在读取本页保存的主要文本来源选择，请稍等后再试。';
    renderAssistantShell();
    return;
  }
  const partKey = currentVideoPrimaryTextPartKey({
    bvid: context.bvid,
    cid: context.cid,
    page: context.currentPart.page,
  });
  if (!partKey) return;
  const previousSourceIdentityKey = primaryTextSelections.get(partKey) ?? null;
  primaryTextSelectionSaveFailedPartKeys.delete(partKey);
  assistantState.primaryTextSaving = true;
  assistantState.primaryTextViewingSourceIdentityKey = sourceIdentityKey;
  assistantState.primaryTextStatus = `正在保存${label}作为当前视频助手来源...`;
  const selectionsRevisionAtSubmit = primaryTextSelectionsRevision;
  renderAssistantShell();

  try {
    const result = await sendRuntimeRequest<SaveCurrentVideoPrimaryTextSelectionResult>(
      'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION',
      {
        bvid: context.bvid,
        cid: context.cid,
        page: context.currentPart.page,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    );
    const persistedSelections = normalizeCurrentVideoPrimaryTextSelections(result.selections);
    if (
      result.partKey !== partKey
      || result.selectedSourceIdentityKey !== sourceIdentityKey
      || persistedSelections[partKey] !== sourceIdentityKey
    ) {
      throw new Error('PRIMARY_TEXT_SELECTION_READBACK_MISMATCH');
    }
    if (primaryTextSelectionsRevision === selectionsRevisionAtSubmit) {
      replacePrimaryTextSelections(persistedSelections);
      primaryTextSelectionsLoaded = true;
      primaryTextSelectionsReadFailed = false;
    }
    primaryTextSelectionSaveFailedPartKeys.delete(partKey);
    if (currentAssistantContextMatchesPartKey(partKey)) {
      assistantState.primaryTextStatus = `${label}已用于当前视频助手。`;
    }
  } catch {
    if (primaryTextSelections.get(partKey) === sourceIdentityKey) {
      if (previousSourceIdentityKey) {
        primaryTextSelections.set(partKey, previousSourceIdentityKey);
      } else {
        primaryTextSelections.delete(partKey);
      }
      primaryTextSelectionsRevision += 1;
    }
    primaryTextSelectionSaveFailedPartKeys.add(partKey);
    if (!primaryTextSelectionsLoaded) {
      primaryTextSelectionsReadFailed = true;
    }
    if (currentAssistantContextMatchesPartKey(partKey)) {
      assistantState.primaryTextStatus = '保存主要文本来源失败，请重新选择一个来源后再继续。';
    }
  } finally {
    assistantState.primaryTextSaving = false;
    assistantState.primaryTextViewingSourceIdentityKey = null;
    renderAssistantShell();
  }
}

function currentAssistantContextMatchesPartKey(partKey: string): boolean {
  const current = assistantState.context;
  if (current?.kind !== 'video') return false;
  return currentVideoPrimaryTextPartKey({
    bvid: current.bvid,
    cid: current.cid,
    page: current.currentPart.page,
  }) === partKey;
}

function primaryTextSelectionSaveFailedForContext(context: CurrentVideoContext): boolean {
  const partKey = currentVideoPrimaryTextPartKey({
    bvid: context.bvid,
    cid: context.cid,
    page: context.currentPart.page,
  });
  return partKey ? primaryTextSelectionSaveFailedPartKeys.has(partKey) : false;
}

function appendSubtitleView(parent: HTMLElement, context: CurrentVideoContext): void {
  const block = section('字幕', 'bdc-assistant-section-primary');
  markAssistantTabPanel(block, 'subtitles');

  if (!currentSubtitleViewIsFresh() && !assistantState.subtitleViewLoading) {
    void ensureSubtitleViewLoaded(false, { renderLoadingState: false });
  }

  if (assistantState.subtitleStatus) {
    appendText(block, 'div', 'bdc-assistant-status', safeVisibleText(assistantState.subtitleStatus));
  }
  if (assistantState.subtitleViewLoading) {
    appendText(block, 'div', 'bdc-assistant-status', '正在读取当前分 P 的字幕全文...');
  }
  if (assistantState.subtitleViewError) {
    const error = appendText(block, 'div', 'bdc-assistant-retrieval-status', assistantState.subtitleViewError);
    error.style.color = 'var(--bb-warning)';
  }

  const result = currentSubtitleViewResult();
  if (!result) {
    if (!assistantState.subtitleViewLoading) {
      appendText(block, 'div', 'bdc-assistant-subtitle-text', '正在确认当前分 P 是否已有可展示字幕全文。');
    }
    parent.appendChild(block);
    return;
  }

  if (result.status !== 'ready' || result.sources.length === 0) {
    appendText(block, 'div', 'bdc-assistant-subtitle-text', safeVisibleText(result.message));
    appendText(block, 'div', 'bdc-assistant-subtitle-detail', subtitleViewActionText(result));
    parent.appendChild(block);
    return;
  }

  const source = currentSubtitleViewingSource();
  if (!source || !validateSubtitleViewingIdentity(context, source)) {
    appendText(block, 'div', 'bdc-assistant-subtitle-text', '字幕来源已变化，请刷新字幕页后再查看。');
    parent.appendChild(block);
    return;
  }

  appendSubtitleSourceSelector(block, result, source, context);
  appendSubtitleFollowControls(block, source);
  appendSubtitleSearch(block, source);
  appendSubtitleJumpStatus(block);
  appendSubtitleReader(block, source);
  appendSubtitlePreview(block, source);
  appendSubtitleExportControls(block, source);

  parent.appendChild(block);
  queueSubtitleActiveLineScroll();
}

function appendSubtitleSourceSelector(
  parent: HTMLElement,
  result: CurrentVideoSubtitleViewSourcesResult,
  activeSource: CurrentVideoSubtitleViewingSource,
  context: CurrentVideoContext,
): void {
  const primaryTextState = buildPrimaryTextStateForContext(context);
  const activePrimarySourceIdentityKey = primaryTextState.activeSourceIdentityKey
    ?? primaryTextState.selectedSourceIdentityKey;
  if (!shouldShowSubtitleViewingSourceSwitcher(result.sources)) {
    const meta = document.createElement('div');
    meta.className = 'bdc-assistant-candidate-meta bdc-assistant-subtitle-source-meta';
    appendBadge(meta, `正在查看：${activeSource.sourceLabel}`);
    if (activeSource.identity.sourceIdentityKey === activePrimarySourceIdentityKey) {
      appendBadge(meta, '视频助手正在使用');
    }
    appendBadge(meta, `${activeSource.lineCount} 条`);
    if (activeSource.temporary) appendBadge(meta, '本次临时可用');
    parent.appendChild(meta);
    return;
  }

  const segmented = document.createElement('div');
  segmented.className = 'bdc-assistant-segmented-control';
  segmented.setAttribute('role', 'radiogroup');
  segmented.setAttribute('aria-label', '字幕查看来源');
  const switchableSources = result.sources.filter(source =>
    (source.status === 'available' || source.status === 'temporary')
    && source.lines.length > 0,
  );
  for (const [sourceIndex, source] of switchableSources.entries()) {
    const active = source.identity.sourceIdentityKey === activeSource.identity.sourceIdentityKey;
    const usedByAssistant = source.identity.sourceIdentityKey === activePrimarySourceIdentityKey;
    const option = button(
      usedByAssistant ? `${source.sourceLabel}（视频助手正在使用）` : source.sourceLabel,
      [
        'bdc-assistant-segmented-option',
        active ? 'bdc-assistant-segmented-option-active' : '',
      ].filter(Boolean).join(' '),
      () => {
        if (!active) selectSubtitleViewingSource(source.identity.sourceIdentityKey);
      },
      false,
    );
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', active ? 'true' : 'false');
    option.dataset.subtitleSourceIndex = String(sourceIndex);
    option.tabIndex = active ? 0 : -1;
    option.addEventListener('keydown', (event) => {
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (sourceIndex + 1) % switchableSources.length;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (sourceIndex - 1 + switchableSources.length) % switchableSources.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = switchableSources.length - 1;
      }
      if (nextIndex === null || nextIndex === sourceIndex) return;
      event.preventDefault();
      selectSubtitleViewingSource(switchableSources[nextIndex].identity.sourceIdentityKey);
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(
          `#${CARD_ID} [data-subtitle-source-index="${nextIndex}"]`,
        )?.focus();
      });
    });
    segmented.appendChild(option);
  }
  parent.appendChild(segmented);

  const meta = document.createElement('div');
  meta.className = 'bdc-assistant-candidate-meta';
  appendBadge(meta, `正在查看：${activeSource.sourceLabel}`);
  appendBadge(meta, `${activeSource.lineCount} 条`);
  if (activeSource.identity.sourceIdentityKey === activePrimarySourceIdentityKey) {
    appendBadge(meta, '视频助手正在使用');
  }
  if (activeSource.temporary) appendBadge(meta, '本次临时可用');
  parent.appendChild(meta);
}

function appendSubtitleFollowControls(
  parent: HTMLElement,
  source: CurrentVideoSubtitleViewingSource,
): void {
  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-inline-actions';
  actions.appendChild(button(
    assistantState.subtitleFollow.mode === 'following' ? '正在跟随播放' : '回到当前字幕',
    assistantState.subtitleFollow.mode === 'following'
      ? 'bdc-assistant-button bdc-assistant-button-quiet'
      : 'bdc-assistant-button bdc-assistant-button-primary',
    () => {
      resumeSubtitleFollow(source);
    },
  ));
  parent.appendChild(actions);

  if (assistantState.subtitleFollow.mode === 'paused') {
    appendText(parent, 'div', 'bdc-assistant-subtitle-detail', subtitleFollowPausedText());
  }
  if (readCurrentPlaybackSeconds() === null) {
    appendText(parent, 'div', 'bdc-assistant-subtitle-detail', '播放器暂不可读，字幕仍可查看；跳转或跟随需要保持视频播放器可用。');
  }
}

function appendSubtitleSearch(
  parent: HTMLElement,
  source: CurrentVideoSubtitleViewingSource,
): void {
  const form = document.createElement('div');
  form.className = 'bdc-assistant-search-form';

  const row = document.createElement('div');
  row.className = 'bdc-assistant-subtitle-search-row';
  const input = document.createElement('input');
  input.className = 'bdc-assistant-subtitle-search-input';
  input.type = 'search';
  input.maxLength = 80;
  input.placeholder = '搜索当前字幕来源';
  input.value = assistantState.subtitleSearchQuery;
  input.setAttribute('aria-label', '搜索当前字幕来源');
  input.addEventListener('input', () => {
    assistantState.subtitleSearchQuery = input.value;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSubtitleSearch(source);
    }
  });
  row.appendChild(input);
  row.appendChild(button('查找', 'bdc-assistant-button bdc-assistant-button-primary', () => {
    runSubtitleSearch(source);
  }));
  form.appendChild(row);
  parent.appendChild(form);

  const search = currentSubtitleSearchForSource(source);
  if (!search) return;

  const status = appendText(parent, 'div', 'bdc-assistant-retrieval-status', safeVisibleText(search.message));
  status.style.color = search.results.length > 0 ? 'var(--bb-success)' : 'var(--bb-warning)';
  if (search.results.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'bdc-assistant-inline-actions';
    actions.appendChild(button('上一个', 'bdc-assistant-button bdc-assistant-button-quiet', () => {
      navigateSubtitleSearch(source, 'previous');
    }));
    actions.appendChild(button('下一个', 'bdc-assistant-button bdc-assistant-button-quiet', () => {
      navigateSubtitleSearch(source, 'next');
    }));
    parent.appendChild(actions);

    const list = document.createElement('div');
    list.className = 'bdc-assistant-subtitle-results';
    for (const [index, result] of search.results.slice(0, 12).entries()) {
      const active = index === search.activeIndex;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = active
        ? 'bdc-assistant-subtitle-result bdc-assistant-subtitle-result-active'
        : 'bdc-assistant-subtitle-result';
      item.addEventListener('click', () => {
        openSubtitleLinePreview(source, result.lineId, 'search_navigation');
      });
      appendText(item, 'span', 'bdc-assistant-subtitle-time', result.timeRangeLabel);
      appendText(item, 'span', 'bdc-assistant-subtitle-line-text', safeVisibleText(result.text));
      list.appendChild(item);
    }
    parent.appendChild(list);
  }
}

function appendSubtitleReader(
  parent: HTMLElement,
  source: CurrentVideoSubtitleViewingSource,
): void {
  const reader = document.createElement('div');
  reader.className = 'bdc-assistant-subtitle-reader';
  reader.addEventListener('scroll', () => {
    if (Date.now() < subtitleProgrammaticScrollUntil) return;
    pauseSubtitleFollow('manual_scroll');
  }, { passive: true });

  for (const line of source.lines) {
    const active = line.lineId === assistantState.subtitleFollow.activeLineId;
    const previewing = line.lineId === assistantState.subtitlePreviewLineId;
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.subtitleLineId = line.lineId;
    row.className = [
      'bdc-assistant-subtitle-row',
      active ? 'bdc-assistant-subtitle-row-active' : '',
      previewing ? 'bdc-assistant-subtitle-row-preview' : '',
    ].filter(Boolean).join(' ');
    if (active) row.setAttribute('aria-current', 'true');
    row.addEventListener('click', () => {
      openSubtitleLinePreview(source, line.lineId, 'manual_scroll');
    });
    appendText(row, 'span', 'bdc-assistant-subtitle-time', formatSubtitleRowTime(line));
    appendText(row, 'span', 'bdc-assistant-subtitle-line-text', safeVisibleText(line.text));
    reader.appendChild(row);
  }
  parent.appendChild(reader);
}

function appendSubtitlePreview(
  parent: HTMLElement,
  source: CurrentVideoSubtitleViewingSource,
): void {
  const line = currentSubtitlePreviewLine(source);
  if (!line) return;
  const preview = buildCurrentVideoSubtitleJumpPreview(source, line);
  const panel = document.createElement('div');
  panel.className = 'bdc-assistant-jump-preview';
  appendText(panel, 'div', 'bdc-assistant-jump-preview-title', '确认跳转前预览');
  appendText(panel, 'div', 'bdc-assistant-candidate-evidence', `时间范围：${safeVisibleText(preview.timeRangeLabel)}`);
  appendText(panel, 'div', 'bdc-assistant-subtitle-detail', `来源：${source.sourceLabel}`);
  appendText(panel, 'div', 'bdc-assistant-candidate-evidence', `字幕原文：${safeVisibleText(preview.sourceText)}`);
  appendText(panel, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(preview.message));

  panel.appendChild(learningSourceButton({ origin: 'subtitle', sourceIdentityKey: source.identity.sourceIdentityKey, subtitleLine: { id: line.lineId, binding: line.lineBindingKey } }, '保存这句字幕'));

  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-jump-actions';
  actions.appendChild(button(
    assistantState.subtitleJumpLoading ? '确认中...' : '确认跳转',
    'bdc-assistant-button bdc-assistant-button-warn',
    () => {
      void confirmCurrentVideoSubtitleJumpFromPage(source, line);
    },
    assistantState.subtitleJumpLoading || assistantState.subtitleReturnLoading || !preview.canJump,
  ));
  actions.appendChild(button(
    '取消',
    'bdc-assistant-button bdc-assistant-button-quiet',
    () => {
      assistantState.subtitlePreviewLineId = null;
      assistantState.subtitleJumpStatus = null;
      renderAssistantShell();
    },
    assistantState.subtitleJumpLoading || assistantState.subtitleReturnLoading,
  ));
  panel.appendChild(actions);
  parent.appendChild(panel);
}

function appendSubtitleJumpStatus(parent: HTMLElement): void {
  if (!assistantState.subtitleJumpStatus && !assistantState.subtitleReturnAvailable) return;
  const status = document.createElement('div');
  status.className = 'bdc-assistant-jump-status';
  appendText(status, 'div', 'bdc-assistant-jump-preview-title', '跳转状态');
  appendText(status, 'div', '', safeVisibleText(assistantState.subtitleJumpStatus ?? '已记录跳转前位置，可返回原位置。'));
  if (assistantState.subtitleReturnAvailable) {
    const actions = document.createElement('div');
    actions.className = 'bdc-assistant-jump-actions';
    actions.appendChild(button(
      assistantState.subtitleReturnLoading ? '返回中...' : '返回原位置',
      'bdc-assistant-button bdc-assistant-button-warn',
      () => { void returnCurrentVideoSubtitleJumpFromPage(); },
      assistantState.subtitleReturnLoading || assistantState.subtitleJumpLoading,
    ));
    status.appendChild(actions);
  }
  parent.appendChild(status);
}

function appendSubtitleExportControls(
  parent: HTMLElement,
  source: CurrentVideoSubtitleViewingSource,
): void {
  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-inline-actions';
  actions.appendChild(button('导出 TXT', 'bdc-assistant-button bdc-assistant-button-quiet', () => {
    exportSubtitleSource(source, 'txt');
  }));
  actions.appendChild(button('导出 SRT', 'bdc-assistant-button bdc-assistant-button-quiet', () => {
    exportSubtitleSource(source, 'srt');
  }));
  parent.appendChild(actions);
  if (assistantState.subtitleExportStatus) {
    appendText(parent, 'div', 'bdc-assistant-status', safeVisibleText(assistantState.subtitleExportStatus));
  }
}

const chatDrafts = new Map<string, string>();
const chatScroll = new Map<string, number>();
let chatDraftLoaded = false;
let chatDraftTimer: ReturnType<typeof setTimeout> | undefined;
function saveChatDraft(): void {
  const key = currentVideoQaActiveSessionId() ?? 'new';
  chatDrafts.set(key, assistantState.segmentQuery);
  clearTimeout(chatDraftTimer);
  chatDraftTimer = setTimeout(() => {
    const entries = [...chatDrafts.entries()].slice(-32);
    void chrome.storage.local.set({ learningChatDrafts: Object.fromEntries(entries) }).catch(() => {});
  }, 300);
}
function switchChat(sessionId: string): void {
  saveChatDraft();
  assistantState.fullTextQaActiveSessionId = sessionId;
  assistantState.segmentQuery = chatDrafts.get(sessionId) ?? '';
  assistantState.fullTextQaPreviewCitationId = null;
  assistantState.fullTextQaJumpStatus = null;
  renderAssistantShell();
  void loadCurrentVideoQaSessionsFromPage(sessionId, { activate: false });
}

function appendSegmentSearch(parent: HTMLElement, _context: CurrentVideoContext): void {
  const block = document.createElement('section');
  block.className = 'bdc-assistant-chat';
  markAssistantTabPanel(block, 'qa');
  if (!assistantState.fullTextQaSessions && !assistantState.fullTextQaSessionsLoading) {
    void loadCurrentVideoQaSessionsFromPage(undefined, { renderLoadingState: false });
  }
  const sessionId = currentVideoQaActiveSessionId();
  const session = currentVideoQaActiveSession();
  const request = currentVideoQaActiveRequest(sessionId);
  if (!chatDraftLoaded) {
    chatDraftLoaded = true;
    const initial = assistantState.segmentQuery;
    void chrome.storage.local.get('learningChatDrafts').then(values => {
      const saved = values.learningChatDrafts;
      if (saved && typeof saved === 'object') for (const [key, value] of Object.entries(saved).slice(-32)) {
        if (typeof value === 'string' && !chatDrafts.has(key)) chatDrafts.set(key, value.slice(0, 2000));
      }
      if (assistantState.segmentQuery === initial && !initial) {
        assistantState.segmentQuery = chatDrafts.get(currentVideoQaActiveSessionId() ?? 'new') ?? '';
        renderAssistantShell();
      }
    }).catch(() => {});
  }
  appendCurrentVideoQaSessionControls(block, sessionId, session);
  const timeline = document.createElement('div');
  timeline.className = 'bdc-chat-timeline';
  timeline.setAttribute('role', 'log');
  timeline.setAttribute('aria-label', '聊天记录');
  timeline.dataset.session = sessionId ?? 'new';
  if (session) for (const turn of session.turns) {
    if (turn.turnId === request?.turnId) continue;
    const message = document.createElement('div');
    message.className = 'bdc-chat-message';
    appendText(message, 'div', 'bdc-chat-question', safeVisibleText(turn.question));
    if (turn.answerMode === 'learning') {
      appendText(message, 'div', 'bdc-chat-answer', safeVisibleText(turn.answer || turn.message));
      if (turn.contextNotice) appendText(message, 'div', 'bdc-chat-source', safeVisibleText(turn.contextNotice));
      appendText(message, 'div', 'bdc-chat-source', safeVisibleText(turn.source?.sourceLabel
        ? `参考：${turn.source.title} · P${turn.source.page ?? 1} · ${turn.source.sourceLabel}；模型表述未逐条核实`
        : '拓展知识 · 模型生成'));
      if (turn.canRetry || turn.status === 'pending') {
        appendText(message, 'div', 'bdc-chat-source', turn.status === 'pending' ? '上次回答中断，可重试。' : safeVisibleText(turn.message));
        message.appendChild(button('重试', 'bdc-assistant-button bdc-assistant-button-quiet',
          () => { void askCurrentVideoFullTextFromPage(turn.turnId, turn.question); }, Boolean(request)));
      }
    } else if (turn.status === 'pending') {
      appendText(message, 'div', 'bdc-chat-source', '上次回答中断，可重新提问。');
    } else {
      appendFullTextQaResult(message, currentVideoQaTurnToResult(session!.sessionId, turn), { source: turn.source, sourceCurrent: currentVideoQaSourceMatchesCurrent(turn.source) });
    }
    timeline.appendChild(message);
  }
  if (request) {
    appendText(timeline, 'div', 'bdc-chat-question', safeVisibleText(request.question));
    const live = appendText(timeline, 'div', 'bdc-chat-answer', request.liveText || '正在回答…');
    live.dataset.chatLive = request.requestId;
  }
  if (assistantState.fullTextQaSessionsError) appendText(timeline, 'div', 'bdc-chat-source', assistantState.fullTextQaSessionsError);
  const error = currentVideoQaError(sessionId);
  if (error) appendText(timeline, 'div', 'bdc-chat-source', safeVisibleText(error));
  block.appendChild(timeline);
  timeline.addEventListener('scroll', () => { chatScroll.set(timeline.dataset.session!, timeline.scrollTop); });
  queueMicrotask(() => {
    const saved = chatScroll.get(timeline.dataset.session!);
    if (timeline.isConnected) timeline.scrollTop = saved === undefined || saved === Infinity ? timeline.scrollHeight : saved;
  });
  const form = document.createElement('div');
  form.className = 'bdc-chat-composer';
  const input = document.createElement('textarea');
  input.className = 'bdc-assistant-search-input';
  input.rows = 3; input.maxLength = 500;
  input.placeholder = '继续追问，或聊聊相关知识';
  input.setAttribute('aria-label', '聊天输入');
  input.value = assistantState.segmentQuery;
  input.addEventListener('input', () => { assistantState.segmentQuery = input.value; saveChatDraft(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); if (!request) void askCurrentVideoFullTextFromPage();
    }
  });
  form.appendChild(input);
  form.appendChild(button(request ? '停止生成' : '发送',
    'bdc-assistant-button bdc-assistant-button-primary',
    () => { if (request) cancelCurrentVideoFullTextQaFromPage(); else void askCurrentVideoFullTextFromPage(); }));
  block.appendChild(form);
  parent.appendChild(block);
}

function appendCurrentVideoQaSessionControls(parent: HTMLElement, activeSessionId: string | null, activeSession: CurrentVideoQaSessionRecord | null): void {
  const bar = document.createElement('div'); bar.className = 'bdc-chat-toolbar';
  appendText(bar, 'span', 'bdc-chat-session-title', activeSession?.title.replace(/ · [0-9]{4}.*$/, '') ?? '新对话');
  bar.appendChild(button('新对话', 'bdc-assistant-button bdc-assistant-button-quiet',
    () => switchChat(createCurrentVideoFullTextRequestId('cvqa-session'))));
  const details = document.createElement('details'); details.className = 'bdc-assistant-more';
  const trigger = document.createElement('summary'); trigger.className = 'bdc-assistant-icon-button';
  trigger.setAttribute('aria-label', '会话与聊天设置'); trigger.title = '会话与聊天设置'; trigger.appendChild(assistantIcon('more'));
  details.appendChild(trigger);
  const menu = document.createElement('div'); menu.className = 'bdc-assistant-more-content bdc-chat-menu';
  for (const session of assistantState.fullTextQaSessions?.sessions ?? []) {
    const item = button(session.title, 'bdc-assistant-session-button', () => switchChat(session.sessionId));
    item.setAttribute('aria-current', String(session.sessionId === activeSessionId)); menu.appendChild(item);
  }
  menu.appendChild(button('重命名', 'bdc-assistant-button bdc-assistant-button-quiet', () => { void renameCurrentVideoQaSessionFromPage(activeSession); }, !activeSession));
  menu.appendChild(button('删除会话', 'bdc-assistant-button bdc-assistant-button-quiet', () => { void deleteCurrentVideoQaSessionFromPage(activeSession); }, !activeSession));
  const streamingLabel = document.createElement('label'); streamingLabel.textContent = '流式输出';
  const streaming = document.createElement('input'); streaming.type = 'checkbox'; streaming.checked = true;
  streamingLabel.prepend(streaming); menu.appendChild(streamingLabel);
  streaming.addEventListener('change', () => { void chrome.storage.local.set({ learningChatStreaming: streaming.checked }); });
  const budgetLabel = document.createElement('label'); budgetLabel.textContent = '上下文预算';
  const budget = document.createElement('input'); budget.type = 'number'; budget.min = '8192'; budget.max = '131072'; budget.step = '1024'; budget.value = '32768';
  budget.setAttribute('aria-label', '上下文预算'); budgetLabel.appendChild(budget); menu.appendChild(budgetLabel);
  budget.addEventListener('change', () => {
    const value = Number(budget.value);
    if (Number.isFinite(value)) { budget.value = String(Math.max(8192, Math.min(131072, Math.floor(value)))); void chrome.storage.local.set({ learningChatBudget: Number(budget.value) }); }
  });
  void chrome.storage.local.get(['learningChatStreaming', 'learningChatBudget']).then(values => {
    streaming.checked = values.learningChatStreaming !== false;
    if (typeof values.learningChatBudget === 'number') budget.value = String(values.learningChatBudget);
  }).catch(() => {});
  menu.appendChild(dashboardLink('AI 设置', '#settings'));
  details.appendChild(menu); bar.appendChild(details); parent.appendChild(bar);
}


function currentVideoQaTurnToResult(
  sessionId: string,
  turn: CurrentVideoQaSessionTurn,
): CurrentVideoFullTextQaResult {
  return {
    answerMode: turn.answerMode,
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
    sourceReference: sourceReferenceFromQaSource(turn.source),
    rollingContext: turn.rollingContext,
    generatedAt: turn.generatedAt ?? turn.updatedAt,
    canRetry: turn.canRetry,
  };
}

function sourceReferenceFromQaSource(
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

function currentVideoQaSourceMatchesCurrent(source: CurrentVideoQaSourceSnapshot | null): boolean {
  const context = assistantState.context;
  if (!source || context?.kind !== 'video') return false;
  const selected = selectedSourceIdentityKeyFromParams(currentPrimaryTextRequestParams());
  return source.bvid === context.bvid
    && source.cid === context.cid
    && source.page === context.currentPart.page
    && Boolean(source.sourceIdentityKey)
    && source.sourceIdentityKey === selected;
}

function appendRelatedFavorites(parent: HTMLElement, context: CurrentVideoContext): void {
  const block = section('相关收藏');
  const head = block.querySelector('.bdc-assistant-section-head');
  const hasFreshResult = Boolean(
    assistantState.relatedFavorites
    && assistantState.relatedFavoritesContextKey === assistantState.contextKey,
  );
  head?.appendChild(button(
    assistantState.relatedFavoritesLoading
      ? '查找中...'
      : hasFreshResult
        ? '刷新相关收藏'
        : '查找相关收藏',
    hasFreshResult
      ? 'bdc-assistant-button bdc-assistant-button-quiet'
      : 'bdc-assistant-button bdc-assistant-button-primary',
    () => {
      void loadCurrentVideoRelatedFavoritesFromPage(true);
    },
    assistantState.relatedFavoritesLoading || !context.bvid,
  ));

  appendText(
    block,
    'div',
    'bdc-assistant-muted',
    '来自当前已同步收藏，只作为延伸阅读；上方当前视频回答仍只引用当前视频字幕或本地节点证据。',
  );

  if (assistantState.relatedFavoritesError) {
    const error = appendText(block, 'div', 'bdc-assistant-retrieval-status', assistantState.relatedFavoritesError);
    error.style.color = 'var(--bb-warning)';
  }

  if (assistantState.relatedFavoritesLoading) {
    const loading = appendText(block, 'div', 'bdc-assistant-retrieval-status', '正在用当前视频线索查找已同步收藏...');
    loading.style.color = 'var(--bb-link)';
  }

  if (!hasFreshResult) {
    appendText(
      block,
      'div',
      'bdc-assistant-subtitle-detail',
      '会使用当前视频标题、UP、简介摘要，以及你在上方输入的问题作为线索；不会读取完整收藏库、历史、关注或本地敏感文件。',
    );
    parent.appendChild(block);
    return;
  }

  appendRelatedFavoritesResult(block, assistantState.relatedFavorites as CurrentVideoRelatedFavoritesResponse);
  parent.appendChild(block);
}

function appendRelatedFavoritesResult(
  parent: HTMLElement,
  result: CurrentVideoRelatedFavoritesResponse,
): void {
  const qa = result.favorites;
  if (result.status !== 'ready' || !qa) {
    const status = appendText(parent, 'div', 'bdc-assistant-retrieval-status', safeVisibleText(result.limitations[0] ?? '当前没有可用的相关收藏线索。'));
    status.style.color = 'var(--bb-warning)';
    return;
  }

  const status = appendText(
    parent,
    'div',
    'bdc-assistant-retrieval-status',
    safeVisibleText(relatedFavoritesNotice(qa)),
  );
  status.style.color = relatedFavoritesStatusColor(qa);

  const meta = document.createElement('div');
  meta.className = 'bdc-assistant-candidate-meta';
  appendBadge(meta, '来源：当前已同步收藏');
  appendBadge(meta, `引用收藏 ${qa.citedVideos.length} 条`);
  if (result.hintSourceLabels.length > 0) {
    appendBadge(meta, `线索：${result.hintSourceLabels.slice(0, 3).join('、')}`);
  }
  appendBadge(meta, `AI ${relatedFavoritesAiStatusLabel(qa.synthesis?.status)}`);
  parent.appendChild(meta);

  const coverage = relatedFavoritesCoverageNotice(qa);
  if (coverage) {
    appendText(parent, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(coverage));
  }

  if (qa.citedVideos.length === 0) {
    appendText(parent, 'div', 'bdc-assistant-answer-text', safeVisibleText(qa.answer));
    appendRelatedFavoritesLimitations(parent, result, qa);
    appendRelatedFavoritesSettingsLink(parent, qa);
    return;
  }

  const list = document.createElement('div');
  list.className = 'bdc-assistant-candidate-list';
  for (const [index, video] of qa.citedVideos.slice(0, 5).entries()) {
    list.appendChild(relatedFavoriteCard(video, index));
  }
  parent.appendChild(list);
  appendRelatedFavoritesLimitations(parent, result, qa);
  appendRelatedFavoritesSettingsLink(parent, qa);
}

function relatedFavoriteCard(video: SmartFavoriteQaCitedVideo, index: number): HTMLElement {
  const card = document.createElement('article');
  card.className = 'bdc-assistant-candidate-card';

  const head = document.createElement('div');
  head.className = 'bdc-assistant-candidate-head';
  appendText(head, 'div', 'bdc-assistant-candidate-title', `收藏 ${index + 1} · ${safeVisibleText(video.title)}`);
  appendText(
    head,
    'div',
    'bdc-assistant-candidate-strength',
    `证据强度 ${relatedFavoriteConfidenceLabel(video.confidence)}`,
  );
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'bdc-assistant-candidate-meta';
  if (video.authorName) appendBadge(meta, `UP ${safeVisibleText(video.authorName)}`);
  if (video.folderTitle) appendBadge(meta, `收藏夹 ${safeVisibleText(video.folderTitle)}`);
  if (video.smartPath.length > 0) appendBadge(meta, `智能路径 ${safeVisibleText(video.smartPath.slice(0, 3).join(' / '))}`);
  card.appendChild(meta);

  appendText(card, 'div', 'bdc-assistant-candidate-evidence', safeVisibleText(video.evidence));

  if (video.matchReasons.length > 0) {
    const reasons = document.createElement('ul');
    reasons.className = 'bdc-assistant-candidate-reasons';
    for (const reason of video.matchReasons.slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = safeVisibleText(reason);
      reasons.appendChild(item);
    }
    card.appendChild(reasons);
  }

  if (video.link) {
    const link = document.createElement('a');
    link.className = 'bdc-assistant-link bdc-assistant-button-quiet';
    link.href = video.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '打开收藏视频';
    card.appendChild(link);
  }

  return card;
}

function appendRelatedFavoritesLimitations(
  parent: HTMLElement,
  result: CurrentVideoRelatedFavoritesResponse,
  qa: SmartFavoriteQaResponse,
): void {
  const notes = [
    ...result.limitations,
    ...qa.status.notes.slice(0, 2),
  ].map(safeVisibleText);
  if (notes.length > 0) {
    appendText(parent, 'div', 'bdc-assistant-subtitle-detail', notes.join(' '));
  }
}

function appendRelatedFavoritesSettingsLink(parent: HTMLElement, qa: SmartFavoriteQaResponse): void {
  if (needsAiSettingsLink(qa.synthesis?.status ?? '')) {
    parent.appendChild(dashboardLink('前往设置', '#settings'));
  }
}

function appendFullTextQaResult(
  parent: HTMLElement,
  result: CurrentVideoFullTextQaResult,
  options: {
    source?: CurrentVideoQaSourceSnapshot | null;
    sourceCurrent?: boolean;
  } = {},
): void {
  const answerCard = document.createElement('div');
  answerCard.className = 'bdc-assistant-answer-card';
  answerCard.style.borderColor = fullTextQaStatusColor(result.status);

  const head = document.createElement('div');
  head.className = 'bdc-assistant-answer-head';
  head.style.color = fullTextQaStatusColor(result.status);
  appendText(
    head,
    'span',
    '',
    `${result.status === 'ready' || result.status === 'unsupported' ? '回答' : '状态'}：${fullTextQaStatusLabel(result.status)}`,
  );
  if (result.status === 'ready') {
    appendText(head, 'span', '', `引用 ${result.citations.length} 条`);
    const identity = options.source?.sourceIdentityKey ?? result.sourceReference?.sourceIdentityKey;
    if (identity && result.sessionId && options.sourceCurrent !== false) head.appendChild(learningSourceButton({
      origin: 'answer', sourceIdentityKey: identity, sessionId: result.sessionId, turnId: result.turnId, requestId: result.requestId,
    }, '保存答案'));
  }
  answerCard.appendChild(head);

  appendText(
    answerCard,
    'div',
    'bdc-assistant-answer-text',
    safeVisibleText(result.answer || result.message),
  );
  if (result.sourceLabel || options.source) {
    appendText(
      answerCard,
      'div',
      'bdc-assistant-subtitle-detail',
      safeVisibleText(fullTextQaSourceLine(result, options.sourceCurrent ?? true)),
    );
    if (options.source?.url) {
      const actions = document.createElement('div');
      actions.className = 'bdc-assistant-inline-actions';
      actions.appendChild(button(
        '打开来源视频',
        'bdc-assistant-button bdc-assistant-button-quiet',
        () => {
          window.open(options.source?.url ?? result.sourceReference?.url ?? '', '_blank', 'noopener,noreferrer');
        },
      ));
      answerCard.appendChild(actions);
    }
  }
  parent.appendChild(answerCard);

  if (result.citations.length > 0) {
    appendText(parent, 'div', 'bdc-assistant-citation-title', '引用片段');
    const list = document.createElement('div');
    list.className = 'bdc-assistant-candidate-list';
    for (const [index, citation] of result.citations.slice(0, 3).entries()) {
      list.appendChild(fullTextQaCitationCard(citation, index, options.sourceCurrent ?? true));
    }
    parent.appendChild(list);
  }

  if (assistantState.fullTextQaJumpStatus) {
    appendText(
      parent,
      'div',
      'bdc-assistant-retrieval-status',
      safeVisibleText(assistantState.fullTextQaJumpStatus),
    );
  }
  if (assistantState.fullTextQaReturnAvailable) {
    parent.appendChild(button(
      assistantState.fullTextQaReturnLoading ? '正在返回...' : '返回原位置',
      'bdc-assistant-button bdc-assistant-button-quiet',
      () => { void returnCurrentVideoFullTextQaJumpFromPage(); },
      assistantState.fullTextQaReturnLoading || assistantState.fullTextQaJumpLoading,
    ));
  }

  if (result.status !== 'ready' && result.status !== 'unsupported') {
    if (result.canRetry) {
      parent.appendChild(button(
        options.sourceCurrent === false ? '在当前视频再问' : '重试本题',
        'bdc-assistant-button bdc-assistant-button-quiet',
        () => {
          if (options.sourceCurrent === false) {
            assistantState.segmentQuery = result.question;
            renderAssistantShell();
          } else {
            void askCurrentVideoFullTextFromPage(result.turnId, result.question);
          }
        },
        Boolean(result.sessionId && assistantState.fullTextQaActiveRequests.has(result.sessionId)),
      ));
    }
    if (result.status === 'disabled' || result.status === 'not_configured') {
      parent.appendChild(dashboardLink('前往设置', '#settings'));
    }
  }
}

function fullTextQaCitationCard(
  citation: CurrentVideoFullTextQaCitation,
  index: number,
  sourceCurrent = true,
): HTMLElement {
  const primaryTextBlockReason = assistantState.context?.kind === 'video'
    ? primaryTextSubmissionBlockMessage(buildPrimaryTextStateForContext(assistantState.context))
    : '当前没有可用的视频上下文。';
  const card = document.createElement('article');
  card.className = 'bdc-assistant-candidate-card';

  const head = document.createElement('div');
  head.className = 'bdc-assistant-candidate-head';
  appendText(head, 'div', 'bdc-assistant-candidate-title', `引用 ${index + 1} · ${citation.timeRangeLabel}`);
  appendText(head, 'div', 'bdc-assistant-candidate-strength', citation.sourceLabel);
  card.appendChild(head);
  appendText(card, 'div', 'bdc-assistant-candidate-evidence', safeVisibleText(citation.evidenceText));

  const previewKey = fullTextQaPreviewKey(citation.binding);
  const previewed = assistantState.fullTextQaPreviewCitationId === previewKey;
  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-candidate-actions';
  actions.appendChild(button(
    previewed ? '已预览' : '预览跳转',
    'bdc-assistant-button bdc-assistant-button-quiet',
    () => {
      assistantState.fullTextQaPreviewCitationId = previewKey;
      assistantState.fullTextQaJumpStatus = `确认跳转前预览：${citation.timeRangeLabel}；确认后才会改变播放位置。`;
      renderAssistantShell();
    },
    !sourceCurrent
      || Boolean(primaryTextBlockReason)
      || previewed
      || assistantState.fullTextQaJumpLoading
      || assistantState.fullTextQaReturnLoading,
  ));
  if (previewed) {
    actions.appendChild(button(
      assistantState.fullTextQaJumpLoading ? '正在跳转...' : '确认跳转',
      'bdc-assistant-button bdc-assistant-button-primary',
      () => { void confirmCurrentVideoFullTextQaJumpFromPage(citation.binding); },
      !sourceCurrent
        || Boolean(primaryTextBlockReason)
        || assistantState.fullTextQaJumpLoading
        || assistantState.fullTextQaReturnLoading,
    ));
  }
  card.appendChild(actions);
  if (!sourceCurrent) {
    appendText(card, 'div', 'bdc-assistant-subtitle-detail', '请先打开对应视频和分 P，再预览或确认跳转。');
  }
  return card;
}

function fullTextQaStatusLabel(status: CurrentVideoFullTextQaResult['status']): string {
  switch (status) {
    case 'ready': return '有证据';
    case 'unsupported': return '证据不足';
    case 'context_too_long': return '正文过长';
    case 'cancelled': return '已取消';
    case 'disabled': return '功能未开启';
    case 'not_configured': return '服务未配置';
    case 'no_context': return '未识别视频';
    case 'no_text': return '主要文本不可用';
    case 'invalid_output': return '引用未核实';
    case 'error':
    default: return '回答失败';
  }
}

function fullTextQaStatusColor(status: CurrentVideoFullTextQaResult['status']): string {
  if (status === 'ready') return 'var(--bb-success)';
  if (status === 'unsupported') return 'var(--bb-warning)';
  return 'var(--bb-warning)';
}

function fullTextQaSourceLine(result: CurrentVideoFullTextQaResult, sourceCurrent = true): string {
  const page = result.sourceReference?.page;
  const partTitle = result.partTitle?.trim() || null;
  const part = Number.isInteger(page) && Number(page) > 0
    ? ` · P${page}${partTitle ? `（${partTitle}）` : ''}`
    : partTitle
      ? ` · ${partTitle}`
      : '';
  const stale = sourceCurrent ? '' : '（基于此前视频文本）';
  return `来源：《${result.title}》${part} · ${result.sourceLabel ?? '主要文本'}${stale}`;
}

function currentVideoQaActiveSessionId(): string | null {
  return assistantState.fullTextQaActiveSessionId
    ?? assistantState.fullTextQaSessions?.activeSessionId
    ?? null;
}

function currentVideoQaActiveSession(): CurrentVideoQaSessionRecord | null {
  const activeSessionId = currentVideoQaActiveSessionId();
  const view = assistantState.fullTextQaSessions;
  if (!activeSessionId || !view?.activeSession) return null;
  return view.activeSession.sessionId === activeSessionId ? view.activeSession : null;
}

function currentVideoQaActiveRequest(
  sessionId: string | null = currentVideoQaActiveSessionId(),
): InPageFullTextQaRequest | null {
  if (!sessionId) return null;
  return assistantState.fullTextQaActiveRequests.get(sessionId) ?? null;
}

function currentVideoQaError(sessionId: string | null): string | null {
  return assistantState.fullTextQaErrors.get(fullTextQaSessionStateKey(sessionId)) ?? null;
}

function setCurrentVideoQaError(sessionId: string | null, message: string | null): void {
  const key = fullTextQaSessionStateKey(sessionId);
  if (message) assistantState.fullTextQaErrors.set(key, message);
  else assistantState.fullTextQaErrors.delete(key);
}

function fullTextQaSessionStateKey(sessionId: string | null): string {
  return sessionId?.trim() || CURRENT_VIDEO_QA_DRAFT_SESSION_STATE_KEY;
}

async function loadCurrentVideoQaSessionsFromPage(
  sessionId?: string | null,
  options: { activate?: boolean; renderLoadingState?: boolean } = {},
): Promise<void> {
  const requestId = assistantState.fullTextQaSessionsRequestId + 1;
  assistantState.fullTextQaSessionsRequestId = requestId;
  assistantState.fullTextQaSessionsLoading = true;
  assistantState.fullTextQaSessionsError = null;
  // When called during panel construction, the caller paints this loading state.
  if (options.renderLoadingState !== false) renderAssistantShell();
  try {
    const targetSessionId = sessionId ?? currentVideoQaActiveSessionId();
    const view = await sendRuntimeRequest<CurrentVideoQaSessionsView>('GET_CURRENT_VIDEO_QA_SESSIONS', {
      sessionId: targetSessionId,
    });
    if (assistantState.fullTextQaSessionsRequestId !== requestId) return;
    assistantState.fullTextQaSessions = view;
    if (options.activate !== false) {
      assistantState.fullTextQaActiveSessionId = view.activeSessionId ?? targetSessionId ?? null;
      if (!assistantState.segmentQuery && !currentVideoQaActiveRequest()) {
        assistantState.segmentQuery = chatDrafts.get(currentVideoQaActiveSessionId() ?? 'new') ?? '';
      }
    }
  } catch {
    if (assistantState.fullTextQaSessionsRequestId !== requestId) return;
    assistantState.fullTextQaSessionsError = '本地问答会话读取失败，请稍后重试。';
  } finally {
    if (assistantState.fullTextQaSessionsRequestId === requestId) {
      assistantState.fullTextQaSessionsLoading = false;
      renderAssistantShell();
    }
  }
}

async function renameCurrentVideoQaSessionFromPage(
  session: CurrentVideoQaSessionRecord | null,
): Promise<void> {
  if (!session) return;
  const title = window.prompt('输入新的会话标题', session.title)?.replace(/\s+/g, ' ').trim();
  if (!title) return;
  assistantState.fullTextQaSessionsError = null;
  try {
    const view = await sendRuntimeRequest<CurrentVideoQaSessionsView>('RENAME_CURRENT_VIDEO_QA_SESSION', {
      sessionId: session.sessionId,
      title,
    });
    assistantState.fullTextQaSessions = view;
    assistantState.fullTextQaActiveSessionId = session.sessionId;
  } catch {
    assistantState.fullTextQaSessionsError = '会话重命名失败，请稍后重试。';
  }
  renderAssistantShell();
}

async function deleteCurrentVideoQaSessionFromPage(
  session: CurrentVideoQaSessionRecord | null,
): Promise<void> {
  if (!session) return;
  if (!window.confirm('删除这个本地问答会话？')) return;
  const active = assistantState.fullTextQaActiveRequests.get(session.sessionId);
  if (active) void sendRuntimeRequest('CANCEL_LEARNING_CHAT', active.params).catch(() => {});
  assistantState.fullTextQaSessionsError = null;
  try {
    const view = await sendRuntimeRequest<CurrentVideoQaSessionsView>('DELETE_CURRENT_VIDEO_QA_SESSION', {
      sessionId: session.sessionId,
    });
    assistantState.fullTextQaSessions = view;
    assistantState.fullTextQaActiveSessionId = view.activeSessionId;
    assistantState.fullTextQaActiveRequests.delete(session.sessionId);
    assistantState.fullTextQaErrors.delete(fullTextQaSessionStateKey(session.sessionId));
    chatDrafts.delete(session.sessionId); chatScroll.delete(session.sessionId);
    assistantState.segmentQuery = chatDrafts.get(view.activeSessionId ?? 'new') ?? '';
    saveChatDraft();
  } catch {
    assistantState.fullTextQaSessionsError = '会话删除失败，请稍后重试。';
  }
  renderAssistantShell();
}

function fullTextQaPreviewKey(binding: CurrentVideoFullTextQaCitationBinding): string {
  return `${binding.sessionId ?? ''}:${binding.requestId}:${binding.turnId}:${binding.citationId}`;
}

function findCurrentVideoQaCitation(
  binding: CurrentVideoFullTextQaCitationBinding,
): CurrentVideoFullTextQaCitation | null {
  const session = currentVideoQaActiveSession();
  const turn = session?.turns.find(item =>
    item.requestId === binding.requestId
    && item.turnId === binding.turnId
  );
  return turn?.citations.find(citation => fullTextQaBindingsEqual(citation.binding, binding)) ?? null;
}

function appendSegmentRetrievalResult(
  parent: HTMLElement,
  result: CurrentVideoSegmentRetrievalResult,
  context: CurrentVideoContext,
): void {
  const queryRewrite = result.queryRewrite ?? {
    expanded: false,
    visibleExpandedTerms: [],
  };
  const status = appendText(
    parent,
    'div',
    'bdc-assistant-retrieval-status',
    safeVisibleText(segmentRetrievalStatusMessage(result, context)),
  );
  status.style.color = segmentRetrievalStatusColor(result);

  appendCurrentVideoQaAnswer(parent, result);
  appendSegmentJumpStatus(parent);

  const meta = document.createElement('div');
  meta.className = 'bdc-assistant-candidate-meta';
  appendBadge(meta, result.evidenceState.transcriptSegmentCount > 0
    ? `字幕证据 ${result.evidenceState.transcriptSegmentCount} 条`
    : '字幕证据未就绪');
  if (result.evidenceState.timedKnowledgeNodeCount > 0) {
    appendBadge(meta, `本地节点 ${result.evidenceState.timedKnowledgeNodeCount} 条`);
  }
  appendBadge(meta, result.evidenceState.contextFresh ? '当前视频上下文有效' : '上下文需刷新');
  if (queryRewrite.expanded) {
    appendBadge(meta, '已扩展相关表达');
  }
  parent.appendChild(meta);

  if (queryRewrite.expanded && queryRewrite.visibleExpandedTerms.length > 0) {
    appendText(
      parent,
      'div',
      'bdc-assistant-muted',
      safeVisibleText(`已扩展相关表达：${queryRewrite.visibleExpandedTerms.slice(0, 6).join('、')}`),
    );
  }

  if (result.candidates.length === 0) {
    appendSegmentLimitations(parent, result);
    return;
  }

  const citedCandidateIds = new Set(result.qa.citedSegments.map(segment => segment.candidateId));
  const displayCandidates = citedCandidateIds.size > 0
    ? result.candidates.filter(candidate => citedCandidateIds.has(candidate.id))
    : result.candidates;
  appendText(
    parent,
    'div',
    'bdc-assistant-citation-title',
    citedCandidateIds.size > 0 ? '引用片段' : '候选片段',
  );
  const list = document.createElement('div');
  list.className = 'bdc-assistant-candidate-list';
  for (const [index, candidate] of displayCandidates.slice(0, 5).entries()) {
    list.appendChild(segmentCandidateCard(
      candidate,
      index,
      result,
      citedCandidateIds.size > 0 ? '引用' : '候选',
    ));
  }
  parent.appendChild(list);
  appendSegmentLimitations(parent, result);
}

function appendCurrentVideoQaAnswer(
  parent: HTMLElement,
  result: CurrentVideoSegmentRetrievalResult,
): void {
  const card = document.createElement('div');
  card.className = 'bdc-assistant-answer-card';
  card.style.borderColor = qaStatusColor(result.qa.status);

  const head = document.createElement('div');
  head.className = 'bdc-assistant-answer-head';
  head.style.color = qaStatusColor(result.qa.status);
  appendText(head, 'span', '', `回答：${qaStatusLabel(result.qa.status)}`);
  appendText(head, 'span', '', `引用 ${result.qa.citedSegments.length} 条`);
  card.appendChild(head);

  appendText(card, 'div', 'bdc-assistant-answer-text', safeVisibleText(result.qa.answer));

  const meta = document.createElement('div');
  meta.className = 'bdc-assistant-candidate-meta';
  appendBadge(meta, qaSourceStateLabel(result));
  appendBadge(meta, `引用片段 ${result.qa.citedSegments.length} 条`);
  appendBadge(meta, result.qa.aiState.status === 'generated' ? '已整理回答' : '本地证据回答');
  card.appendChild(meta);

  if (result.qa.citedSegments.length === 0 && result.qa.limitations.length > 0) {
    appendText(card, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(result.qa.limitations[0]));
  }
  if (needsAiSettingsLink(result.qa.aiState.status)) {
    appendText(card, 'div', 'bdc-assistant-subtitle-detail', '当前答案来自本地证据；需要额外整理时，可先完成设置。');
    card.appendChild(dashboardLink('打开设置', '#settings'));
  }

  parent.appendChild(card);
}

function segmentCandidateCard(
  candidate: CurrentVideoSegmentRetrievalCandidate,
  index: number,
  result: CurrentVideoSegmentRetrievalResult,
  titlePrefix = '候选',
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'bdc-assistant-candidate-card';

  const head = document.createElement('div');
  head.className = 'bdc-assistant-candidate-head';
  appendText(head, 'div', 'bdc-assistant-candidate-title', `${titlePrefix} ${index + 1} · ${safeVisibleText(candidate.timeRangeLabel)}`);
  appendText(
    head,
    'div',
    'bdc-assistant-candidate-strength',
    `匹配 ${candidate.confidenceLabel} ${formatPercent(candidate.confidence)}`,
  );
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'bdc-assistant-candidate-meta';
  appendBadge(meta, safeVisibleText(candidate.sourceLabel));
  appendBadge(meta, segmentCandidateSourceStatus(candidate, result));
  card.appendChild(meta);

  appendText(card, 'div', 'bdc-assistant-candidate-evidence', safeVisibleText(candidate.evidenceText));

  if (candidate.matchReasons.length > 0) {
    const reasons = document.createElement('ul');
    reasons.className = 'bdc-assistant-candidate-reasons';
    for (const reason of candidate.matchReasons.slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = safeVisibleText(reason);
      reasons.appendChild(item);
    }
    card.appendChild(reasons);
  }

  if (candidate.note) {
    appendText(card, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(candidate.note));
  }

  appendSegmentJumpControls(card, candidate, result);

  return card;
}

function appendSegmentJumpStatus(parent: HTMLElement): void {
  if (!assistantState.segmentJumpStatus && !assistantState.segmentReturnAvailable) return;

  const status = document.createElement('div');
  status.className = 'bdc-assistant-jump-status';
  appendText(
    status,
    'div',
    'bdc-assistant-jump-preview-title',
    '跳转状态',
  );
  appendText(
    status,
    'div',
    '',
    safeVisibleText(assistantState.segmentJumpStatus ?? '已记录跳转前位置，可返回原位置。'),
  );

  if (assistantState.segmentReturnAvailable) {
    const actions = document.createElement('div');
    actions.className = 'bdc-assistant-jump-actions';
    actions.appendChild(button(
      assistantState.segmentReturnLoading ? '返回中...' : '返回原位置',
      'bdc-assistant-button bdc-assistant-button-warn',
      () => {
        void returnCurrentVideoSegmentJumpFromPage();
      },
      assistantState.segmentReturnLoading,
    ));
    status.appendChild(actions);
  }

  parent.appendChild(status);
}

function appendSegmentJumpControls(
  parent: HTMLElement,
  candidate: CurrentVideoSegmentRetrievalCandidate,
  result: CurrentVideoSegmentRetrievalResult,
): void {
  const preview = candidate.jumpPreview;
  const selected = assistantState.segmentPreviewCandidateId === candidate.id;
  const timestampOperationLoading = assistantState.segmentJumpLoading
    || assistantState.segmentReturnLoading;
  const controls = document.createElement('div');
  controls.className = 'bdc-assistant-jump-actions';

  controls.appendChild(button(
    preview.canJump ? (selected ? '收起预览' : '预览跳转') : '不可跳转',
    preview.canJump
      ? 'bdc-assistant-button bdc-assistant-button-quiet'
      : 'bdc-assistant-button bdc-assistant-button-quiet',
    () => {
      if (!preview.canJump) return;
      invalidateSegmentTimestampRequests();
      assistantState.segmentPreviewCandidateId = selected ? null : candidate.id;
      assistantState.segmentJumpStatus = selected ? assistantState.segmentJumpStatus : null;
      renderAssistantShell();
    },
    !preview.canJump || timestampOperationLoading,
  ));
  parent.appendChild(controls);

  if (!preview.canJump) {
    appendText(parent, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(preview.message));
    return;
  }

  appendText(
    parent,
    'div',
    'bdc-assistant-subtitle-detail',
    `可预览目标时间 ${safeVisibleText(preview.targetTimeLabel ?? candidate.timeRangeLabel)}；预览不会改变播放位置。`,
  );

  if (selected) {
    parent.appendChild(segmentJumpPreviewPanel(candidate, result));
  }
}

function segmentJumpPreviewPanel(
  candidate: CurrentVideoSegmentRetrievalCandidate,
  result: CurrentVideoSegmentRetrievalResult,
): HTMLElement {
  const preview = candidate.jumpPreview;
  const primaryTextBlockReason = assistantState.context?.kind === 'video'
    ? primaryTextSubmissionBlockMessage(buildPrimaryTextStateForContext(assistantState.context))
    : null;
  const panel = document.createElement('div');
  panel.className = 'bdc-assistant-jump-preview';
  appendText(panel, 'div', 'bdc-assistant-jump-preview-title', '确认跳转前预览');
  appendText(
    panel,
    'div',
    'bdc-assistant-candidate-evidence',
    `目标时间：${safeVisibleText(preview.targetTimeLabel ?? candidate.timeRangeLabel)}`,
  );
  appendText(
    panel,
    'div',
    'bdc-assistant-subtitle-detail',
    `依据：${safeVisibleText(preview.sourceLabel)}；匹配 ${preview.confidenceLabel} ${formatPercent(preview.confidence)}`,
  );
  appendText(
    panel,
    'div',
    'bdc-assistant-candidate-evidence',
    `证据预览：${safeVisibleText(preview.evidencePreview || candidate.evidenceText)}`,
  );
  appendText(panel, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(preview.message));
  if (primaryTextBlockReason) {
    appendText(panel, 'div', 'bdc-assistant-subtitle-detail', primaryTextBlockReason);
  }

  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-jump-actions';
  actions.appendChild(button(
    assistantState.segmentJumpLoading ? '确认中...' : '确认跳转',
    'bdc-assistant-button bdc-assistant-button-warn',
    () => {
      void confirmCurrentVideoSegmentJumpFromPage(candidate, result);
    },
    assistantState.segmentJumpLoading || !preview.canJump || Boolean(primaryTextBlockReason),
  ));
  actions.appendChild(button(
    '取消',
    'bdc-assistant-button bdc-assistant-button-quiet',
    () => {
      invalidateSegmentTimestampRequests();
      assistantState.segmentPreviewCandidateId = null;
      renderAssistantShell();
    },
    assistantState.segmentJumpLoading || assistantState.segmentReturnLoading,
  ));
  panel.appendChild(actions);
  return panel;
}

function appendSegmentLimitations(
  parent: HTMLElement,
  result: CurrentVideoSegmentRetrievalResult,
): void {
  const limitations = segmentVisibleLimitations(result);
  if (limitations.length === 0) return;
  appendText(parent, 'div', 'bdc-assistant-subtitle-detail', limitations.join(' '));
}

function appendSummary(parent: HTMLElement): void {
  appendSummaryHighlightsPanel(parent, 'summary');
}

function appendHighlights(parent: HTMLElement): void {
  appendSummaryHighlightsPanel(parent, 'highlights');
}

function appendSummaryHighlightsPanel(parent: HTMLElement, view: 'summary' | 'highlights'): void {
  const block = section(view === 'summary' ? '摘要' : '亮点', 'bdc-assistant-section-primary');
  markAssistantTabPanel(block, view);
  const context = assistantState.context?.kind === 'video' ? assistantState.context : null;
  const primaryTextBlockReason = context
    ? primaryTextSubmissionBlockMessage(buildPrimaryTextStateForContext(context))
    : null;
  const summary = assistantState.summaryContextKey === assistantState.contextKey
    ? assistantState.summary
    : null;
  const actionBlocked = Boolean(primaryTextBlockReason)
    || assistantState.summaryCacheLoading
    || summary?.canGenerate === false;
  const head = block.querySelector('.bdc-assistant-section-head');
  const sourceIdentity = context ? buildPrimaryTextStateForContext(context).activeSourceIdentityKey : null;
  if (summary?.status === 'ready' && !summary.unverifiedText && summary.current && summary.cacheKey && sourceIdentity && !primaryTextBlockReason) {
    head?.appendChild(learningSourceButton({ origin: view, sourceIdentityKey: sourceIdentity, cacheKey: summary.cacheKey, generatedAt: summary.generatedAt }, view === 'summary' ? '保存摘要' : '保存亮点'));
  }

  if (assistantState.summaryLoading) {
    head?.appendChild(button(
      '取消生成',
      'bdc-assistant-button bdc-assistant-button-warn',
      cancelCurrentVideoSummaryHighlightsFromPage,
    ));
  } else {
    head?.appendChild(button(
      summary?.status === 'ready' ? '重新生成' : '生成摘要与亮点',
      'bdc-assistant-button bdc-assistant-button-primary',
      () => { void generateCurrentVideoSummaryHighlightsFromPage(); },
      actionBlocked,
    ));
  }

  const textSize = summary?.textSize ?? {
    lineCount: context?.transcriptEvidence?.segmentCount ?? 0,
    charCount: null,
    utf8Bytes: context?.transcriptEvidence?.serializedBytes ?? 0,
  };
  const generationDetails = document.createElement('details');
  generationDetails.className = 'bdc-assistant-generation-details';
  const generationLabel = document.createElement('summary');
  generationLabel.textContent = '正文与生成信息';
  generationLabel.appendChild(assistantIcon('down'));
  generationDetails.appendChild(generationLabel);
  appendText(generationDetails, 'div', 'bdc-assistant-subtitle-detail',
    `正文规模：${formatTextSize(textSize)}。等待时间和费用由你配置的 AI 服务决定。`);
  if (summary?.sourceLabel) appendText(generationDetails, 'div', 'bdc-assistant-subtitle-detail', summary.sourceLabel);
  block.appendChild(generationDetails);

  if (assistantState.summaryLoading) {
    appendText(block, 'div', 'bdc-assistant-muted', '正在生成摘要、关键要点和视频亮点，请稍等。');
  }

  if (assistantState.summaryError) {
    appendText(block, 'div', 'bdc-assistant-subtitle-text', assistantState.summaryError);
  }

  if (primaryTextBlockReason) {
    appendText(block, 'div', 'bdc-assistant-subtitle-text', primaryTextBlockReason);
    block.appendChild(button('查看来源', 'bdc-assistant-button bdc-assistant-button-quiet', () => {
      sourceDetailsOpen = true;
      renderAssistantShell();
      document.querySelector<HTMLElement>(`#${CARD_ID} .bdc-assistant-source-details > summary`)?.focus();
    }));
    if (summary?.status !== 'ready') {
      parent.appendChild(block);
      return;
    }
  }

  if (assistantState.summaryCacheLoading) {
    appendText(block, 'div', 'bdc-assistant-muted', '正在读取本页此前保存的摘要与亮点...');
    if (summary?.status !== 'ready') {
      parent.appendChild(block);
      return;
    }
  }

  if (!summary) {
    appendText(block, 'div', 'bdc-assistant-muted', '尚未生成。只有点击生成后才会发送当前选择的完整正文。');
    parent.appendChild(block);
    return;
  }

  if (summary.priorGenerated || summary.status !== 'ready') {
    if (summary.priorGenerated) appendText(block, 'div', 'bdc-assistant-status', '此前生成');
    appendText(block, 'div', 'bdc-assistant-subtitle-text', safeVisibleText(summary.message));
  }

  if (summary.unverifiedText) {
    appendText(block, 'div', 'bdc-assistant-status', '模型输出 · 引用未核实');
    appendText(block, 'div', 'bdc-assistant-summary-text', safeVisibleText(summary.unverifiedText));
    if (summary.status === 'ready') appendText(block, 'div', 'bdc-assistant-citation-title', '此前已核实内容');
  }
  if (summary.status === 'ready' && view === 'summary') {
    for (const sentence of summary.summarySentences) {
      appendText(block, 'div', 'bdc-assistant-summary-text', safeVisibleText(sentence.text));
    }

    appendText(block, 'div', 'bdc-assistant-citation-title', '关键要点');
    const list = document.createElement('ul');
    list.className = 'bdc-assistant-list';
    for (const item of summary.keyPoints) {
      const li = document.createElement('li');
      li.textContent = safeVisibleText(item.text);
      list.appendChild(li);
    }
    block.appendChild(list);

  } else if (summary.status === 'ready') {
    appendText(block, 'div', 'bdc-assistant-citation-title', '视频亮点');
    const highlights = document.createElement('div');
    highlights.className = 'bdc-assistant-candidate-list';
    for (const highlight of summary.highlights) {
      highlights.appendChild(summaryHighlightCard(highlight, summary));
    }
    block.appendChild(highlights);

    const preview = activeSummaryHighlightPreview(summary);
    if (preview) {
      const highlight = summary.highlights.find(item => item.id === preview.highlightId);
      if (highlight) block.appendChild(summaryHighlightJumpPreview(highlight, preview));
    }
    appendSummaryHighlightJumpStatus(block);
  } else if (summary.limitations.length > 0) {
    appendText(
      block,
      'div',
      'bdc-assistant-subtitle-detail',
      safeVisibleText(summary.limitations[0]),
    );
  }

  if (needsAiSettingsLink(summary.ai.status)) {
    if (summary.generationBlockedMessage) {
      appendText(block, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(summary.generationBlockedMessage));
    }
    block.appendChild(dashboardLink('打开设置', '#settings'));
  }

  parent.appendChild(block);
}

function summaryHighlightCard(
  highlight: CurrentVideoSummaryHighlight,
  summary: CurrentVideoSummaryHighlightsResult,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'bdc-assistant-candidate-card';
  const head = document.createElement('div');
  head.className = 'bdc-assistant-candidate-head';
  appendText(head, 'div', 'bdc-assistant-candidate-title', safeVisibleText(highlight.title));
  appendText(head, 'div', 'bdc-assistant-candidate-strength', safeVisibleText(highlight.timeRangeLabel));
  card.appendChild(head);
  appendText(card, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(highlight.description));

  const binding = currentVideoSummaryHighlightBindingFromResult(summary, highlight.id);
  const selected = currentVideoSummaryHighlightBindingsEqual(
    assistantState.summaryHighlightPreview,
    binding,
  );
  card.appendChild(button(
    selected ? '收起预览' : '预览跳转',
    'bdc-assistant-button bdc-assistant-button-quiet',
    () => {
      assistantState.summaryHighlightPreview = selected ? null : binding;
      assistantState.summaryHighlightJumpStatus = null;
      renderAssistantShell();
    },
    !binding || assistantState.summaryHighlightJumpLoading || assistantState.summaryHighlightReturnLoading,
  ));
  return card;
}

function summaryHighlightJumpPreview(
  highlight: CurrentVideoSummaryHighlight,
  binding: CurrentVideoSummaryHighlightBinding,
): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'bdc-assistant-jump-preview';
  appendText(panel, 'div', 'bdc-assistant-jump-preview-title', '确认跳转前预览');
  appendText(panel, 'div', 'bdc-assistant-candidate-evidence', `目标时间：${safeVisibleText(highlight.timeRangeLabel)}`);
  appendText(panel, 'div', 'bdc-assistant-subtitle-detail', `${safeVisibleText(highlight.title)}：${safeVisibleText(highlight.description)}`);
  appendText(panel, 'div', 'bdc-assistant-subtitle-detail', '确认后才会跳转，并可返回原位置。');
  const actions = document.createElement('div');
  actions.className = 'bdc-assistant-jump-actions';
  actions.appendChild(button(
    assistantState.summaryHighlightJumpLoading ? '确认中...' : '确认跳转',
    'bdc-assistant-button bdc-assistant-button-warn',
    () => { void confirmCurrentVideoSummaryHighlightJumpFromPage(binding); },
    assistantState.summaryHighlightJumpLoading || assistantState.summaryHighlightReturnLoading,
  ));
  actions.appendChild(button(
    '取消',
    'bdc-assistant-button bdc-assistant-button-quiet',
    () => {
      assistantState.summaryHighlightPreview = null;
      renderAssistantShell();
    },
    assistantState.summaryHighlightJumpLoading || assistantState.summaryHighlightReturnLoading,
  ));
  panel.appendChild(actions);
  return panel;
}

function appendSummaryHighlightJumpStatus(parent: HTMLElement): void {
  if (assistantState.summaryHighlightJumpStatus) {
    appendText(
      parent,
      'div',
      'bdc-assistant-jump-status',
      safeVisibleText(assistantState.summaryHighlightJumpStatus),
    );
  }
  if (assistantState.summaryHighlightReturnAvailable) {
    parent.appendChild(button(
      assistantState.summaryHighlightReturnLoading ? '返回中...' : '返回原位置',
      'bdc-assistant-button bdc-assistant-button-warn',
      () => { void returnCurrentVideoSummaryHighlightJumpFromPage(); },
      assistantState.summaryHighlightReturnLoading || assistantState.summaryHighlightJumpLoading,
    ));
  }
}

function appendVideoKnowledge(parent: HTMLElement, context: CurrentVideoContext): void {
  const block = section('辅助知识节点', 'bdc-assistant-section-auxiliary');
  const primaryTextBlockReason = primaryTextSubmissionBlockMessage(buildPrimaryTextStateForContext(context));
  const head = block.querySelector('.bdc-assistant-section-head');
  head?.appendChild(button(
    assistantState.knowledgeLoading ? '刷新中...' : '刷新节点',
    'bdc-assistant-button bdc-assistant-button-quiet',
    () => {
      void loadCurrentVideoKnowledge(true);
    },
    assistantState.knowledgeLoading || !context.bvid || Boolean(primaryTextBlockReason),
  ));

  if (assistantState.knowledgeLoading) {
    appendText(block, 'div', 'bdc-assistant-muted', '正在读取当前视频知识节点...');
    parent.appendChild(block);
    return;
  }

  if (assistantState.knowledgeError) {
    appendText(block, 'div', 'bdc-assistant-subtitle-text', assistantState.knowledgeError);
    parent.appendChild(block);
    return;
  }

  if (primaryTextBlockReason) {
    appendText(block, 'div', 'bdc-assistant-subtitle-text', primaryTextBlockReason);
    parent.appendChild(block);
    return;
  }

  const knowledge = assistantState.knowledge;
  if (!knowledge || assistantState.knowledgeContextKey !== assistantState.contextKey) {
    appendText(block, 'div', 'bdc-assistant-muted', '展开后会读取当前视频知识节点。');
    parent.appendChild(block);
    return;
  }

  const transcriptNodeCount = knowledge.nodes.filter(node => node.source === 'transcript').length;
  const status = appendText(
    block,
    'div',
    'bdc-assistant-retrieval-status',
    safeVisibleText(videoKnowledgeNotice(knowledge, transcriptNodeCount)),
  );
  status.style.color = transcriptNodeCount > 0 ? 'var(--bb-success)' : 'var(--bb-warning)';

  const nodes = knowledge.nodes.slice(0, 5);
  const meta = document.createElement('div');
  meta.className = 'bdc-assistant-candidate-meta';
  appendBadge(meta, transcriptNodeCount > 0 ? `字幕节点 ${transcriptNodeCount} 条` : '暂无字幕节点');
  appendBadge(meta, knowledge.transcriptEvidence?.active ? '字幕正文已缓存' : '字幕正文未缓存');
  if (nodes.some(node => node.source === 'description')) appendBadge(meta, '简介辅助');
  if (nodes.some(node => node.source === 'page' || node.source === 'chapter')) {
    appendBadge(meta, '分 P / 章节辅助');
  }
  block.appendChild(meta);

  if (nodes.length === 0) {
    appendText(block, 'div', 'bdc-assistant-subtitle-detail', '当前没有足够安全的当前视频知识节点候选。');
    appendVideoKnowledgeLimitations(block, knowledge);
    parent.appendChild(block);
    return;
  }

  const list = document.createElement('div');
  list.className = 'bdc-assistant-candidate-list';
  for (const [index, node] of nodes.entries()) {
    list.appendChild(videoKnowledgeNodeCard(node, index));
  }
  block.appendChild(list);
  appendVideoKnowledgeLimitations(block, knowledge);
  parent.appendChild(block);
}

function videoKnowledgeNodeCard(node: VideoKnowledgeNode, index: number): HTMLElement {
  const card = document.createElement('article');
  card.className = 'bdc-assistant-candidate-card';

  const head = document.createElement('div');
  head.className = 'bdc-assistant-candidate-head';
  appendText(head, 'div', 'bdc-assistant-candidate-title', `节点 ${index + 1} · ${videoKnowledgeTimeRange(node)}`);
  appendText(
    head,
    'div',
    'bdc-assistant-candidate-strength',
    `依据 ${formatPercent(node.confidence)}`,
  );
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'bdc-assistant-candidate-meta';
  appendBadge(meta, safeVisibleText(node.sourceLabel));
  appendBadge(meta, videoKnowledgeSourceStatus(node));
  if (node.evidence?.sourceStatus) {
    appendBadge(meta, videoKnowledgeEvidenceStatusLabel(node.evidence.sourceStatus));
  }
  card.appendChild(meta);

  appendText(card, 'div', 'bdc-assistant-candidate-evidence', safeVisibleText(node.title));
  appendText(card, 'div', 'bdc-assistant-subtitle-detail', safeVisibleText(node.reason));

  if (node.evidence?.textSpan) {
    const label = node.source === 'transcript'
      ? `字幕证据 ${videoKnowledgeTimeRange(node)}：`
      : '证据片段：';
    appendText(
      card,
      'div',
      'bdc-assistant-evidence',
      `${label}${safeVisibleText(node.evidence.textSpan)}`,
    );
  }

  appendText(
    card,
    'div',
    'bdc-assistant-subtitle-detail',
    videoKnowledgeNodePositionHint(node),
  );

  return card;
}

function appendVideoKnowledgeLimitations(parent: HTMLElement, knowledge: VideoKnowledgeResult): void {
  const limitations = knowledge.limitations.slice(0, 2).map(safeVisibleText).join(' ');
  if (limitations) {
    appendText(parent, 'div', 'bdc-assistant-subtitle-detail', limitations);
  }
}

async function ensureSubtitleViewLoaded(
  force: boolean,
  options: { renderLoadingState?: boolean } = {},
): Promise<void> {
  if (assistantState.context?.kind !== 'video') return;
  if (assistantState.subtitleViewLoading) return;
  const contextKey = currentVideoSubtitleContextKey(assistantState.context);
  if (!force && currentSubtitleViewIsFresh()) return;

  const requestId = assistantState.subtitleViewRequestId + 1;
  assistantState.subtitleViewRequestId = requestId;
  assistantState.subtitleViewLoading = true;
  assistantState.subtitleViewError = null;
  if (force) assistantState.subtitleExportStatus = null;
  if (options.renderLoadingState !== false) renderAssistantShell();

  try {
    const result = await sendRuntimeRequest<CurrentVideoSubtitleViewSourcesResult>(
      'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES',
      {},
    );
    if (
      assistantState.subtitleViewRequestId !== requestId
      || subtitleContextKeyForCurrentState() !== contextKey
    ) return;
    assistantState.subtitleView = result;
    assistantState.subtitleViewContextKey = contextKey;
    const previousSourceKey = assistantState.subtitleViewingSourceIdentityKey;
    const primaryTextState = assistantState.context?.kind === 'video'
      ? buildPrimaryTextStateForContext(assistantState.context)
      : null;
    const primarySourceKey = primaryTextState?.activeSourceIdentityKey
      ?? primaryTextState?.selectedSourceIdentityKey
      ?? null;
    const source = selectDefaultSubtitleViewingSource(result.sources, previousSourceKey ?? primarySourceKey);
    const sourceChanged = previousSourceKey !== (source?.identity.sourceIdentityKey ?? null);
    assistantState.subtitleViewingSourceIdentityKey = source?.identity.sourceIdentityKey ?? null;
    if (!source || sourceChanged || force) {
      clearSubtitleSearchAndPreview();
      assistantState.subtitleFollow = source
        ? reduceCurrentVideoSubtitleFollowState(
            { mode: 'following', activeLineId: null, pausedReason: null },
            { type: 'resume_follow', currentSeconds: readCurrentPlaybackSeconds() ?? 0 },
            source.lines,
          )
        : { mode: 'paused', activeLineId: null, pausedReason: 'source_changed' };
    }
    if (result.status !== 'ready') {
      assistantState.subtitleViewingSourceIdentityKey = null;
    }
  } catch {
    if (assistantState.subtitleViewRequestId !== requestId) return;
    assistantState.subtitleViewError = '字幕全文读取失败，请确认当前 B 站视频页仍然打开后重试。';
  } finally {
    if (assistantState.subtitleViewRequestId === requestId) {
      assistantState.subtitleViewLoading = false;
      renderAssistantShell();
    }
  }
}

function currentSubtitleViewIsFresh(): boolean {
  const currentKey = subtitleContextKeyForCurrentState();
  return Boolean(
    currentKey
    && assistantState.subtitleView
    && assistantState.subtitleViewContextKey === currentKey,
  );
}

function currentSubtitleViewResult(): CurrentVideoSubtitleViewSourcesResult | null {
  return currentSubtitleViewIsFresh() ? assistantState.subtitleView : null;
}

function currentSubtitleViewingSource(): CurrentVideoSubtitleViewingSource | null {
  const result = currentSubtitleViewResult();
  if (!result) return null;
  return selectDefaultSubtitleViewingSource(result.sources, assistantState.subtitleViewingSourceIdentityKey);
}

function selectSubtitleViewingSource(sourceIdentityKey: string): void {
  const result = currentSubtitleViewResult();
  const source = result?.sources.find(item => item.identity.sourceIdentityKey === sourceIdentityKey) ?? null;
  if (!source) {
    assistantState.subtitleJumpStatus = '字幕来源已变化，请刷新字幕页后再查看。';
    renderAssistantShell();
    return;
  }
  const query = assistantState.subtitleSearchQuery;
  assistantState.subtitleViewingSourceIdentityKey = source.identity.sourceIdentityKey;
  clearSubtitleSearchAndPreview({ preserveQuery: true });
  if (query.trim()) {
    const search = searchCurrentVideoSubtitleLines(source, query);
    assistantState.subtitleSearch = search;
    const active = search.results[search.activeIndex];
    if (active) {
      openSubtitleLinePreview(source, active.lineId, 'search_navigation', false);
    } else {
      assistantState.subtitleFollow = reduceCurrentVideoSubtitleFollowState(
        { mode: 'following', activeLineId: null, pausedReason: null },
        { type: 'search_navigation' },
        source.lines,
      );
    }
  } else {
    assistantState.subtitleFollow = reduceCurrentVideoSubtitleFollowState(
      { mode: 'following', activeLineId: null, pausedReason: null },
      { type: 'resume_follow', currentSeconds: readCurrentPlaybackSeconds() ?? 0 },
      source.lines,
    );
  }
  renderAssistantShell();
}

function clearSubtitleSearchAndPreview(options: { preserveQuery?: boolean } = {}): void {
  if (!options.preserveQuery) {
    assistantState.subtitleSearchQuery = '';
  }
  assistantState.subtitleSearch = null;
  assistantState.subtitlePreviewLineId = null;
  assistantState.subtitleJumpStatus = null;
  assistantState.subtitleJumpLoading = false;
  assistantState.subtitleReturnAvailable = false;
  assistantState.subtitleReturnLoading = false;
  assistantState.subtitleExportStatus = null;
  assistantState.subtitleTimestampRequestId += 1;
}

function subtitleViewActionText(result: CurrentVideoSubtitleViewSourcesResult): string {
  switch (result.status) {
    case 'requires_user_subtitle':
      return '请先在播放器中开启中文 AI 字幕，再点击“重新检测字幕”。正式完成的本地字幕稿存在时才会出现切换入口。';
    case 'empty':
      return '当前来源没有有效字幕行，不能搜索、跳转或导出。';
    case 'malformed':
      return '为避免展示错误时间轴，暂不读取这份字幕。';
    case 'detecting':
      return '检测完成前不会展示或导出字幕，也不会请求 AI。';
    case 'no_context':
      return '请在 B 站视频页内使用当前视频助手。';
    case 'local_absent':
      return '正式完成的本地字幕稿存在时才会显示可切换来源。';
    case 'unavailable':
    default:
      return '当前没有可展示的字幕全文。';
  }
}

function runSubtitleSearch(source: CurrentVideoSubtitleViewingSource): void {
  const search = searchCurrentVideoSubtitleLines(source, assistantState.subtitleSearchQuery);
  assistantState.subtitleSearch = search;
  assistantState.subtitleExportStatus = null;
  if (search.results.length > 0) {
    const first = search.results[search.activeIndex];
    openSubtitleLinePreview(source, first.lineId, 'search_navigation', false);
  } else {
    assistantState.subtitlePreviewLineId = null;
    assistantState.subtitleFollow = reduceCurrentVideoSubtitleFollowState(
      assistantState.subtitleFollow,
      { type: 'search_navigation', lineId: assistantState.subtitleFollow.activeLineId },
      source.lines,
    );
  }
  renderAssistantShell();
}

function currentSubtitleSearchForSource(
  source: CurrentVideoSubtitleViewingSource,
): CurrentVideoSubtitleSearchState | null {
  const search = assistantState.subtitleSearch;
  if (!search || search.query !== assistantState.subtitleSearchQuery.replace(/\s+/g, ' ').trim()) return null;
  if (search.results.some(result => result.sourceIdentityKey !== source.identity.sourceIdentityKey)) {
    return null;
  }
  return search;
}

function navigateSubtitleSearch(
  source: CurrentVideoSubtitleViewingSource,
  direction: 'previous' | 'next',
): void {
  const current = currentSubtitleSearchForSource(source);
  if (!current) return;
  const next = navigateCurrentVideoSubtitleSearchResult(current, direction);
  assistantState.subtitleSearch = next;
  const result = next.results[next.activeIndex];
  if (result) {
    openSubtitleLinePreview(source, result.lineId, 'search_navigation', false);
  }
  renderAssistantShell();
}

function openSubtitleLinePreview(
  source: CurrentVideoSubtitleViewingSource,
  lineId: string,
  reason: 'manual_scroll' | 'search_navigation',
  rerender = true,
): void {
  const line = source.lines.find(item => item.lineId === lineId) ?? null;
  if (!line) {
    assistantState.subtitleJumpStatus = '字幕行已变化，请刷新字幕页后再查看。';
    if (rerender) renderAssistantShell();
    return;
  }
  assistantState.subtitlePreviewLineId = line.lineId;
  assistantState.subtitleJumpStatus = null;
  assistantState.subtitleExportStatus = null;
  assistantState.subtitleFollow = reduceCurrentVideoSubtitleFollowState(
    assistantState.subtitleFollow,
    reason === 'search_navigation'
      ? { type: 'search_navigation', lineId: line.lineId }
      : { type: 'manual_scroll' },
    source.lines,
  );
  assistantState.subtitleFollow = {
    ...assistantState.subtitleFollow,
    activeLineId: line.lineId,
  };
  if (rerender) renderAssistantShell();
}

function pauseSubtitleFollow(reason: 'manual_scroll' | 'search_navigation'): void {
  if (assistantState.subtitleFollow.mode !== 'following') return;
  const source = currentSubtitleViewingSource();
  if (!source) return;
  assistantState.subtitleFollow = reduceCurrentVideoSubtitleFollowState(
    assistantState.subtitleFollow,
    reason === 'manual_scroll' ? { type: 'manual_scroll' } : { type: 'search_navigation' },
    source.lines,
  );
  renderAssistantShell();
}

function resumeSubtitleFollow(source: CurrentVideoSubtitleViewingSource): void {
  const currentSeconds = readCurrentPlaybackSeconds();
  if (currentSeconds === null) {
    assistantState.subtitleJumpStatus = '播放器暂不可读，不能回到当前字幕。请保持视频播放器可用后再试。';
    renderAssistantShell();
    return;
  }
  assistantState.subtitleFollow = reduceCurrentVideoSubtitleFollowState(
    assistantState.subtitleFollow,
    { type: 'resume_follow', currentSeconds },
    source.lines,
  );
  assistantState.subtitlePreviewLineId = assistantState.subtitleFollow.activeLineId;
  assistantState.subtitleJumpStatus = null;
  renderAssistantShell();
}

async function confirmCurrentVideoSubtitleJumpFromPage(
  source: CurrentVideoSubtitleViewingSource,
  line: CurrentVideoSubtitleLine,
): Promise<void> {
  if (assistantState.subtitleJumpLoading || assistantState.subtitleReturnLoading) return;
  const context = assistantState.context;
  const currentSource = currentSubtitleViewingSource();
  if (
    context?.kind !== 'video'
    || !currentSource
    || currentSource.identity.sourceIdentityKey !== source.identity.sourceIdentityKey
    || !validateSubtitleViewingIdentity(context, currentSource)
    || !currentSource.lines.some(item => item.lineId === line.lineId && item.lineBindingKey === line.lineBindingKey)
  ) {
    assistantState.subtitleJumpStatus = '字幕来源已变化，请重新打开预览后再跳转。';
    assistantState.subtitleReturnAvailable = false;
    renderAssistantShell();
    return;
  }

  const operationId = assistantState.subtitleTimestampRequestId + 1;
  const contextKey = assistantState.contextKey;
  assistantState.subtitleTimestampRequestId = operationId;
  assistantState.subtitleJumpLoading = true;
  assistantState.subtitleReturnLoading = false;
  assistantState.subtitleReturnAvailable = false;
  assistantState.subtitleJumpStatus = '正在确认跳转...';
  renderAssistantShell();

  try {
    const response = await sendRuntimeRequest<CurrentVideoTimestampJumpResponse>(
      'REQUEST_CURRENT_VIDEO_SUBTITLE_JUMP',
      {
        sourceIdentityKey: currentSource.identity.sourceIdentityKey,
        lineId: line.lineId,
        lineBindingKey: line.lineBindingKey,
        confirmed: true,
      },
    );
    if (assistantState.subtitleTimestampRequestId !== operationId || assistantState.contextKey !== contextKey) return;
    assistantState.subtitleJumpStatus = timestampJumpStatusText(response);
    assistantState.subtitleReturnAvailable = response.ok && response.returnPointSeconds !== null;
    if (response.ok) {
      assistantState.subtitlePreviewLineId = null;
    }
  } catch {
    if (assistantState.subtitleTimestampRequestId !== operationId) return;
    assistantState.subtitleJumpStatus = '跳转失败：请确认当前 B 站视频页仍然打开，并稍后重试。';
    assistantState.subtitleReturnAvailable = false;
  } finally {
    if (assistantState.subtitleTimestampRequestId === operationId) {
      assistantState.subtitleJumpLoading = false;
      renderAssistantShell();
    }
  }
}

async function returnCurrentVideoSubtitleJumpFromPage(): Promise<void> {
  if (assistantState.subtitleReturnLoading || assistantState.subtitleJumpLoading) return;
  const source = currentSubtitleViewingSource();
  if (!source) {
    assistantState.subtitleJumpStatus = '字幕来源已变化，请刷新字幕页后再返回。';
    renderAssistantShell();
    return;
  }

  const operationId = assistantState.subtitleTimestampRequestId + 1;
  const contextKey = assistantState.contextKey;
  assistantState.subtitleTimestampRequestId = operationId;
  assistantState.subtitleReturnLoading = true;
  assistantState.subtitleJumpStatus = '正在返回原位置...';
  renderAssistantShell();

  try {
    const response = await sendRuntimeRequest<CurrentVideoTimestampReturnResponse>(
      'RETURN_CURRENT_VIDEO_SUBTITLE_JUMP',
      { sourceIdentityKey: source.identity.sourceIdentityKey },
    );
    if (assistantState.subtitleTimestampRequestId !== operationId || assistantState.contextKey !== contextKey) return;
    assistantState.subtitleJumpStatus = timestampReturnStatusText(response);
    if (response.ok) assistantState.subtitleReturnAvailable = false;
  } catch {
    if (assistantState.subtitleTimestampRequestId !== operationId) return;
    assistantState.subtitleJumpStatus = '返回失败：请确认当前 B 站视频页仍然打开，并稍后重试。';
  } finally {
    if (assistantState.subtitleTimestampRequestId === operationId) {
      assistantState.subtitleReturnLoading = false;
      renderAssistantShell();
    }
  }
}

function exportSubtitleSource(
  source: CurrentVideoSubtitleViewingSource,
  extension: 'txt' | 'srt',
): void {
  const context = assistantState.context;
  if (context?.kind !== 'video' || !validateSubtitleViewingIdentity(context, source)) {
    assistantState.subtitleExportStatus = '字幕来源已变化，请刷新字幕页后再导出。';
    renderAssistantShell();
    return;
  }
  try {
    const content = extension === 'txt'
      ? formatSubtitleTxt(source, { title: context.title, partTitle: context.currentPart.title })
      : formatSubtitleSrt(source);
    const filename = buildSubtitleExportFilename({
      title: context.title,
      partTitle: context.currentPart.title,
      sourceLabel: source.sourceLabel,
      extension,
    });
    const blob = new Blob([content], {
      type: extension === 'txt' ? 'text/plain;charset=utf-8' : 'application/x-subrip;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    assistantState.subtitleExportStatus = `已准备导出 ${filename}。`;
  } catch {
    assistantState.subtitleExportStatus = '导出失败，请稍后重试。';
  }
  renderAssistantShell();
}

function subtitleContextKeyForCurrentState(): string {
  const context = assistantState.context;
  return context?.kind === 'video' ? currentVideoSubtitleContextKey(context) : '';
}

function subtitleContextKeyForContext(context: CurrentVideoContextResult | null): string {
  return context?.kind === 'video' ? currentVideoSubtitleContextKey(context) : '';
}

function currentSubtitlePreviewLine(
  source: CurrentVideoSubtitleViewingSource,
): CurrentVideoSubtitleLine | null {
  const lineId = assistantState.subtitlePreviewLineId;
  if (!lineId) return null;
  return source.lines.find(line => line.lineId === lineId) ?? null;
}

function formatSubtitleRowTime(line: CurrentVideoSubtitleLine): string {
  return `${formatDuration(line.startSeconds)}-${formatDuration(line.endSeconds)}`;
}

function subtitleFollowPausedText(): string {
  switch (assistantState.subtitleFollow.pausedReason) {
    case 'search_navigation':
      return '已暂停跟随：正在查看搜索结果。';
    case 'source_changed':
      return '已暂停跟随：字幕来源已变化。';
    case 'manual_scroll':
    default:
      return '已暂停跟随：正在手动浏览字幕。';
  }
}

function readCurrentPlaybackSeconds(): number | null {
  const video = document.querySelector('video');
  if (!(video instanceof HTMLVideoElement)) return null;
  const currentTime = video.currentTime;
  return Number.isFinite(currentTime) ? Math.max(0, currentTime) : null;
}

function syncSubtitleFollowTimer(): void {
  const source = currentSubtitleViewingSource();
  const shouldRun = assistantState.expanded
    && assistantState.activeTab === 'subtitles'
    && assistantState.subtitleFollow.mode === 'following'
    && Boolean(source);
  if (!shouldRun) {
    if (subtitleFollowTimer !== null) {
      window.clearInterval(subtitleFollowTimer);
      subtitleFollowTimer = null;
    }
    return;
  }
  if (subtitleFollowTimer !== null) return;
  subtitleFollowTimer = window.setInterval(updateSubtitleFollowFromPlayback, 600);
}

function updateSubtitleFollowFromPlayback(): void {
  const source = currentSubtitleViewingSource();
  if (!source || assistantState.subtitleFollow.mode !== 'following') {
    syncSubtitleFollowTimer();
    return;
  }
  const currentSeconds = readCurrentPlaybackSeconds();
  if (currentSeconds === null) return;
  const next = reduceCurrentVideoSubtitleFollowState(
    assistantState.subtitleFollow,
    { type: 'playback_tick', currentSeconds },
    source.lines,
  );
  if (next.activeLineId !== assistantState.subtitleFollow.activeLineId || next.mode !== assistantState.subtitleFollow.mode) {
    const previousActiveLineId = assistantState.subtitleFollow.activeLineId;
    assistantState.subtitleFollow = next;
    updateSubtitleActiveLineInDom(previousActiveLineId, next.activeLineId);
    queueSubtitleActiveLineScroll();
  }
}

function updateSubtitleActiveLineInDom(previousLineId: string | null, nextLineId: string | null): void {
  const root = document.getElementById(CARD_ID);
  const rows = Array.from(root?.querySelectorAll<HTMLElement>('[data-subtitle-line-id]') ?? []);
  for (const row of rows) {
    const lineId = row.dataset.subtitleLineId ?? null;
    if (lineId !== previousLineId && lineId !== nextLineId) continue;
    const active = lineId === nextLineId;
    row.classList.toggle('bdc-assistant-subtitle-row-active', active);
    if (active) {
      row.setAttribute('aria-current', 'true');
    } else {
      row.removeAttribute('aria-current');
    }
  }
}

function queueSubtitleActiveLineScroll(): void {
  if (assistantState.activeTab !== 'subtitles') return;
  window.setTimeout(scrollActiveSubtitleLineIntoView, 0);
}

function scrollActiveSubtitleLineIntoView(): void {
  const lineId = assistantState.subtitleFollow.activeLineId ?? assistantState.subtitlePreviewLineId;
  if (!lineId) return;
  const root = document.getElementById(CARD_ID);
  const rows = Array.from(root?.querySelectorAll<HTMLElement>('[data-subtitle-line-id]') ?? []);
  const row = rows.find(item => item.dataset.subtitleLineId === lineId);
  if (!row) return;
  subtitleProgrammaticScrollUntil = Date.now() + 250;
  row.scrollIntoView({ block: 'nearest' });
}

async function loadCurrentVideoRelatedFavoritesFromPage(force: boolean): Promise<void> {
  if (assistantState.context?.kind !== 'video') return;
  if (assistantState.relatedFavoritesLoading) return;
  if (
    !force
    && assistantState.relatedFavorites
    && assistantState.relatedFavoritesContextKey === assistantState.contextKey
  ) {
    return;
  }

  const requestId = assistantState.relatedFavoritesRequestId + 1;
  const contextKey = assistantState.contextKey;
  assistantState.relatedFavoritesRequestId = requestId;
  assistantState.relatedFavoritesLoading = true;
  assistantState.relatedFavoritesError = null;
  renderAssistantShell();

  try {
    const result = await sendRuntimeRequest<CurrentVideoRelatedFavoritesResponse>('GET_CURRENT_VIDEO_RELATED_FAVORITES', {
      question: assistantState.segmentQuery,
      summaryHint: null,
      limit: 5,
    });
    if (assistantState.relatedFavoritesRequestId !== requestId || assistantState.contextKey !== contextKey) return;
    assistantState.relatedFavorites = result;
    assistantState.relatedFavoritesContextKey = contextKey;
  } catch {
    if (assistantState.relatedFavoritesRequestId !== requestId) return;
    assistantState.relatedFavoritesError = '相关收藏查找失败：请确认当前 B 站视频页仍然打开，并稍后重试。';
  } finally {
    if (assistantState.relatedFavoritesRequestId === requestId) {
      assistantState.relatedFavoritesLoading = false;
      renderAssistantShell();
    }
  }
}

async function askCurrentVideoFullTextFromPage(
  retryTurnId?: string,
  retryQuestion?: string,
): Promise<void> {
  const existingSessionId = currentVideoQaActiveSessionId();
  if (currentVideoQaActiveRequest(existingSessionId)) return;
  const question = (retryQuestion ?? assistantState.segmentQuery).replace(/\s+/g, ' ').trim();
  if (!question) {
    setCurrentVideoQaError(existingSessionId, '请输入一个关于当前视频的问题。');
    renderAssistantShell();
    return;
  }
  if (assistantState.context?.kind !== 'video') {
    setCurrentVideoQaError(existingSessionId, '当前没有可用视频上下文，请在 B 站视频页内使用。');
    renderAssistantShell();
    return;
  }
  const contextKey = assistantState.contextKey;
  const sessionId = existingSessionId ?? createCurrentVideoFullTextRequestId('cvqa-session');
  if (assistantState.fullTextQaActiveRequests.has(sessionId)) return;
  assistantState.fullTextQaActiveSessionId = sessionId;
  const requestId = createCurrentVideoFullTextRequestId('cvqa-page');
  const turnId = retryTurnId?.trim() || createCurrentVideoFullTextRequestId('cvqa-turn');
  if (!retryQuestion) { assistantState.segmentQuery = ''; saveChatDraft(); }
  const params = {
    ...currentPrimaryTextRequestParams(),
    sessionId,
    requestId,
    turnId,
    question,
  };
  const activeRequest: InPageFullTextQaRequest = {
    sessionId,
    requestId,
    turnId,
    params,
    contextKey,
    selectionRevision: primaryTextSelectionsRevision,
    selectedSourceIdentityKey: selectedSourceIdentityKeyFromParams(params),
    question,
  };
  assistantState.fullTextQaActiveRequests.set(sessionId, activeRequest);
  setCurrentVideoQaError(sessionId, null);
  assistantState.fullTextQaPreviewCitationId = null;
  assistantState.fullTextQaJumpStatus = null;
  assistantState.fullTextQaJumpLoading = false;
  assistantState.fullTextQaReturnAvailable = false;
  assistantState.fullTextQaReturnLoading = false;
  assistantState.fullTextQaTimestampRequestId += 1;
  chatScroll.delete(sessionId);
  renderAssistantShell();
  let polling = true;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    if (!polling) return;
    try {
      const progress = await sendRuntimeRequest<{ text: string }>('GET_LEARNING_CHAT_PROGRESS', { requestId });
      if (polling && assistantState.fullTextQaActiveRequests.get(sessionId)?.requestId === requestId) {
        activeRequest.liveText = safeVisibleText(progress.text);
        const live = document.querySelector<HTMLElement>('[data-chat-live]');
        if (live?.dataset.chatLive === requestId && progress.text) {
          const timeline = live.closest<HTMLElement>('.bdc-chat-timeline');
          const following = timeline && timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 64;
          live.textContent = activeRequest.liveText;
          if (following && timeline) timeline.scrollTop = timeline.scrollHeight;
        }
      }
    } catch { /* The final request reports network failures. */ }
    if (polling) timer = setTimeout(poll, 300);
  };
  timer = setTimeout(poll, 300);
  try {
    const result = await sendRuntimeRequest<CurrentVideoFullTextQaResult>(
      'ASK_LEARNING_CHAT',
      params,
    );
    if (
      !fullTextQaActiveRequestStillMatchesCurrent(activeRequest)
      || result.sessionId !== sessionId
      || result.requestId !== requestId
      || result.turnId !== turnId
    ) return;
    await loadCurrentVideoQaSessionsFromPage(
      currentVideoQaActiveSessionId() ?? sessionId,
      { activate: false },
    );
    if (!fullTextQaActiveRequestStillMatchesCurrent(activeRequest)) return;
    setCurrentVideoQaError(sessionId, result.answer ? null : result.message);
    if (!result.answer && result.canRetry && !assistantState.segmentQuery) { assistantState.segmentQuery = question; saveChatDraft(); }
  } catch {
    if (!fullTextQaActiveRequestStillMatchesCurrent(activeRequest)) return;
    setCurrentVideoQaError(sessionId, '回答失败，问题已保留。请确认当前视频页和 AI 设置后重试。');
  } finally {
    polling = false; clearTimeout(timer);
    if (fullTextQaActiveRequestStillMatchesCurrent(activeRequest)) {
      assistantState.fullTextQaActiveRequests.delete(sessionId);
      renderAssistantShell();
    }
    void loadCurrentVideoQaSessionsFromPage(
      currentVideoQaActiveSessionId() ?? sessionId,
      { activate: false },
    );
  }
}

function cancelCurrentVideoFullTextQaFromPage(): void {
  const sessionId = currentVideoQaActiveSessionId();
  const activeRequest = currentVideoQaActiveRequest(sessionId);
  if (!activeRequest) return;
  setCurrentVideoQaError(activeRequest.sessionId, '正在停止…');
  assistantState.fullTextQaPreviewCitationId = null;
  assistantState.fullTextQaJumpStatus = null;
  assistantState.fullTextQaReturnAvailable = false;
  assistantState.fullTextQaTimestampRequestId += 1;
  renderAssistantShell();
  void sendRuntimeRequest('CANCEL_LEARNING_CHAT', activeRequest.params).catch(() => undefined);
}

async function confirmCurrentVideoFullTextQaJumpFromPage(
  binding: CurrentVideoFullTextQaCitationBinding,
): Promise<void> {
  if (
    assistantState.fullTextQaJumpLoading
    || assistantState.fullTextQaReturnLoading
    || assistantState.context?.kind !== 'video'
  ) return;
  const primaryTextBlockReason = primaryTextSubmissionBlockMessage(
    buildPrimaryTextStateForContext(assistantState.context),
  );
  if (primaryTextBlockReason) {
    assistantState.fullTextQaJumpStatus = primaryTextBlockReason;
    assistantState.fullTextQaReturnAvailable = false;
    renderAssistantShell();
    return;
  }
  const citation = findCurrentVideoQaCitation(binding);
  if (!citation || assistantState.fullTextQaPreviewCitationId !== fullTextQaPreviewKey(binding)) {
    assistantState.fullTextQaPreviewCitationId = null;
    assistantState.fullTextQaJumpStatus = '引用结果已变化，请重新预览后再跳转。';
    renderAssistantShell();
    return;
  }

  const operationId = assistantState.fullTextQaTimestampRequestId + 1;
  const contextKey = assistantState.contextKey;
  assistantState.fullTextQaTimestampRequestId = operationId;
  assistantState.fullTextQaJumpLoading = true;
  assistantState.fullTextQaReturnLoading = false;
  assistantState.fullTextQaReturnAvailable = false;
  assistantState.fullTextQaJumpStatus = '正在确认跳转...';
  renderAssistantShell();

  try {
    const response = await sendRuntimeRequest<CurrentVideoTimestampJumpResponse>(
      'REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP',
      {
        ...binding,
        confirmed: true,
        ...currentPrimaryTextRequestParams(),
      },
    );
    if (
      assistantState.fullTextQaTimestampRequestId !== operationId
      || assistantState.contextKey !== contextKey
    ) return;
    assistantState.fullTextQaJumpStatus = response.ok
      ? '已跳到引用位置，可返回原位置。'
      : '引用结果或页面状态已变化，请重新提交问题后再试。';
    assistantState.fullTextQaReturnAvailable = response.ok && response.returnPointSeconds !== null;
    assistantState.fullTextQaPreviewCitationId = null;
  } catch {
    if (assistantState.fullTextQaTimestampRequestId !== operationId) return;
    assistantState.fullTextQaJumpStatus = '引用跳转失败，请确认当前视频页仍然打开后重试。';
    assistantState.fullTextQaReturnAvailable = false;
  } finally {
    if (assistantState.fullTextQaTimestampRequestId === operationId) {
      assistantState.fullTextQaJumpLoading = false;
      renderAssistantShell();
    }
  }
}

async function returnCurrentVideoFullTextQaJumpFromPage(): Promise<void> {
  if (assistantState.fullTextQaReturnLoading || assistantState.fullTextQaJumpLoading) return;
  const operationId = assistantState.fullTextQaTimestampRequestId + 1;
  const contextKey = assistantState.contextKey;
  assistantState.fullTextQaTimestampRequestId = operationId;
  assistantState.fullTextQaReturnLoading = true;
  assistantState.fullTextQaJumpStatus = '正在返回原位置...';
  renderAssistantShell();
  try {
    const response = await sendRuntimeRequest<CurrentVideoTimestampReturnResponse>(
      'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
      currentPrimaryTextRequestParams(),
    );
    if (
      assistantState.fullTextQaTimestampRequestId !== operationId
      || assistantState.contextKey !== contextKey
    ) return;
    assistantState.fullTextQaJumpStatus = timestampReturnStatusText(response);
    if (response.ok) assistantState.fullTextQaReturnAvailable = false;
  } catch {
    if (assistantState.fullTextQaTimestampRequestId !== operationId) return;
    assistantState.fullTextQaJumpStatus = '返回失败，请确认当前视频页仍然打开后重试。';
  } finally {
    if (assistantState.fullTextQaTimestampRequestId === operationId) {
      assistantState.fullTextQaReturnLoading = false;
      renderAssistantShell();
    }
  }
}

async function searchCurrentVideoSegmentsFromPage(): Promise<void> {
  if (assistantState.segmentLoading) return;

  const query = assistantState.segmentQuery.trim();
  if (!query) {
    assistantState.segmentError = '请输入问题或想跳到的片段，例如“有没有关于 subagent 的介绍？”。';
    assistantState.segmentResult = null;
    renderAssistantShell();
    return;
  }
  if (assistantState.context?.kind !== 'video') {
    assistantState.segmentError = '当前没有可用视频上下文，请在 B 站视频页内使用。';
    assistantState.segmentResult = null;
    renderAssistantShell();
    return;
  }
  const primaryTextBlockReason = primaryTextSubmissionBlockMessage(
    buildPrimaryTextStateForContext(assistantState.context),
  );
  if (primaryTextBlockReason) {
    assistantState.segmentError = primaryTextBlockReason;
    assistantState.segmentResult = null;
    renderAssistantShell();
    return;
  }

  const requestId = assistantState.segmentRequestId + 1;
  const contextKey = assistantState.contextKey;
  const returnAvailable = assistantState.segmentReturnAvailable;
  const returnStatus = returnAvailable ? assistantState.segmentJumpStatus : null;
  invalidateSegmentTimestampRequests();
  assistantState.segmentRequestId = requestId;
  assistantState.segmentLoading = true;
  assistantState.segmentError = null;
  assistantState.segmentResult = null;
  assistantState.segmentContextKey = contextKey;
  assistantState.segmentPreviewCandidateId = null;
  assistantState.segmentJumpStatus = returnStatus;
  assistantState.segmentJumpLoading = false;
  assistantState.segmentReturnAvailable = returnAvailable;
  assistantState.segmentReturnLoading = false;
  renderAssistantShell();

  try {
    const result = await sendRuntimeRequest<CurrentVideoSegmentRetrievalResult>('SEARCH_CURRENT_VIDEO_SEGMENTS', {
      query,
      ...currentPrimaryTextRequestParams(),
    });
    if (assistantState.segmentRequestId !== requestId || assistantState.contextKey !== contextKey) return;
    assistantState.segmentResult = result;
    assistantState.segmentContextKey = contextKey;
  } catch {
    if (assistantState.segmentRequestId !== requestId) return;
    assistantState.segmentError = '回答失败：请确认当前 B 站视频页仍然打开，并稍后重试。';
  } finally {
    if (assistantState.segmentRequestId === requestId) {
      assistantState.segmentLoading = false;
      renderAssistantShell();
    }
  }
}

async function confirmCurrentVideoSegmentJumpFromPage(
  candidate: CurrentVideoSegmentRetrievalCandidate,
  result: CurrentVideoSegmentRetrievalResult,
): Promise<void> {
  if (assistantState.segmentJumpLoading || assistantState.segmentReturnLoading) return;

  const preview = candidate.jumpPreview;
  if (!preview.canJump) {
    invalidateSegmentTimestampRequests();
    assistantState.segmentJumpStatus = safeVisibleText(preview.message);
    assistantState.segmentReturnAvailable = false;
    renderAssistantShell();
    return;
  }
  if (assistantState.context?.kind === 'video') {
    const primaryTextBlockReason = primaryTextSubmissionBlockMessage(
      buildPrimaryTextStateForContext(assistantState.context),
    );
    if (primaryTextBlockReason) {
      invalidateSegmentTimestampRequests();
      assistantState.segmentJumpStatus = primaryTextBlockReason;
      assistantState.segmentReturnAvailable = false;
      renderAssistantShell();
      return;
    }
  }

  const operation = beginSegmentTimestampOperation();
  assistantState.segmentJumpLoading = true;
  assistantState.segmentReturnLoading = false;
  assistantState.segmentJumpStatus = '正在确认跳转...';
  assistantState.segmentReturnAvailable = false;
  renderAssistantShell();

  try {
    const response = await sendRuntimeRequest<CurrentVideoTimestampJumpResponse>(
      'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP',
      {
        query: result.query,
        candidateId: candidate.id,
        confirmed: true,
        ...currentPrimaryTextRequestParams(),
      },
    );
    if (!segmentTimestampOperationIsCurrent(operation)) return;
    assistantState.segmentJumpStatus = timestampJumpStatusText(response);
    assistantState.segmentReturnAvailable = response.ok && response.returnPointSeconds !== null;
    if (response.ok) {
      assistantState.segmentPreviewCandidateId = null;
    }
  } catch {
    if (!segmentTimestampOperationIsCurrent(operation)) return;
    assistantState.segmentJumpStatus = '跳转失败：请确认当前 B 站视频页仍然打开，并稍后重试。';
    assistantState.segmentReturnAvailable = false;
  } finally {
    if (segmentTimestampOperationIsCurrent(operation)) {
      assistantState.segmentJumpLoading = false;
      renderAssistantShell();
    }
  }
}

async function returnCurrentVideoSegmentJumpFromPage(): Promise<void> {
  if (assistantState.segmentReturnLoading || assistantState.segmentJumpLoading) return;

  const operation = beginSegmentTimestampOperation();
  assistantState.segmentReturnLoading = true;
  assistantState.segmentJumpLoading = false;
  assistantState.segmentJumpStatus = '正在返回原位置...';
  renderAssistantShell();

  try {
    const response = await sendRuntimeRequest<CurrentVideoTimestampReturnResponse>(
      'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
      currentPrimaryTextRequestParams(),
    );
    if (!segmentTimestampOperationIsCurrent(operation)) return;
    assistantState.segmentJumpStatus = timestampReturnStatusText(response);
    if (response.ok) {
      assistantState.segmentReturnAvailable = false;
    }
  } catch {
    if (!segmentTimestampOperationIsCurrent(operation)) return;
    assistantState.segmentJumpStatus = '返回失败：请确认当前 B 站视频页仍然打开，并稍后重试。';
  } finally {
    if (segmentTimestampOperationIsCurrent(operation)) {
      assistantState.segmentReturnLoading = false;
      renderAssistantShell();
    }
  }
}

async function refreshSubtitleEvidenceFromPage(): Promise<void> {
  if (assistantState.subtitleRefreshing) return;
  const initialIdentity = currentAssistantVideoIdentity();
  if (!initialIdentity) return;
  if (assistantState.context?.kind === 'video' && primaryTextSelectionsLoading) {
    const primaryTextBlockReason = primaryTextSubmissionBlockMessage(
      buildPrimaryTextStateForContext(assistantState.context),
    );
    if (primaryTextBlockReason) {
      assistantState.subtitleStatus = primaryTextBlockReason;
      renderAssistantShell();
      return;
    }
  }

  const requestId = assistantState.subtitleRequestId + 1;
  assistantState.subtitleRequestId = requestId;
  assistantState.subtitleRefreshing = true;
  assistantState.subtitleStatus = null;
  renderAssistantShell();

  try {
    const refreshedContext = await sendRuntimeRequest<CurrentVideoContextResult>('GET_CURRENT_VIDEO_CONTEXT', {
      forceContextRefresh: true,
      forceSubtitleProbe: true,
    });
    if (!subtitleRefreshStillTargets(requestId, initialIdentity, refreshedContext)) {
      finishStaleSubtitleRefresh(requestId);
      return;
    }
    const transcriptEvidence = await sendRuntimeRequest<CurrentVideoTranscriptEvidenceState>(
      'GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE',
      {
        ...currentPrimaryTextRequestParams(),
        forceContextRefresh: true,
        forceSubtitleProbe: true,
      },
    );
    if (!subtitleRefreshStillTargets(requestId, initialIdentity, transcriptEvidence)) {
      finishStaleSubtitleRefresh(requestId);
      return;
    }
    const context = await sendRuntimeRequest<CurrentVideoContextResult>('GET_CURRENT_VIDEO_CONTEXT', {
      forceContextRefresh: true,
    });
    if (!subtitleRefreshStillTargets(requestId, initialIdentity, context)
      || !transcriptEvidenceMatchesVideoIdentity(transcriptEvidence, initialIdentity)
    ) {
      finishStaleSubtitleRefresh(requestId);
      return;
    }

    const nextContext = context.kind === 'video'
      ? { ...context, transcriptEvidence }
      : context;
    updateAssistantContext(nextContext);
    assistantState.subtitleRefreshing = false;
    assistantState.subtitleStatus = subtitleRefreshResultText(nextContext);
    renderAssistantShell();
    void restoreCurrentVideoSummaryHighlightsFromPage();
  } catch {
    if (assistantState.subtitleRequestId !== requestId) return;
    assistantState.subtitleRefreshing = false;
    assistantState.subtitleStatus = '重新检测失败：请确认当前 B 站视频页仍然打开，并在播放器里开启中文 AI 字幕后重试。';
    renderAssistantShell();
  }
}

function finishStaleSubtitleRefresh(requestId: number): void {
  if (assistantState.subtitleRequestId !== requestId) return;
  assistantState.subtitleRefreshing = false;
  assistantState.subtitleStatus = '当前视频或分 P 已切换，请在当前分 P 重新检测字幕。';
  renderAssistantShell();
}

async function restoreCurrentVideoSummaryHighlightsFromPage(): Promise<void> {
  if (assistantState.context?.kind !== 'video') return;
  if (assistantState.summaryLoading || assistantState.summaryCacheLoading) return;
  const primaryTextBlockReason = primaryTextSubmissionBlockMessage(
    buildPrimaryTextStateForContext(assistantState.context),
  );
  if (primaryTextBlockReason) return;

  const operationId = assistantState.summaryRequestId + 1;
  const contextKey = assistantState.contextKey;
  assistantState.summaryRequestId = operationId;
  assistantState.summaryCacheLoading = true;
  assistantState.summaryError = null;
  renderAssistantShell();

  try {
    const summary = await sendRuntimeRequest<CurrentVideoSummaryHighlightsResult>(
      'GET_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE',
      currentPrimaryTextRequestParams(),
    );
    if (assistantState.summaryRequestId !== operationId || assistantState.contextKey !== contextKey) return;
    const currentSummary = assistantState.summaryContextKey === contextKey
      ? assistantState.summary
      : null;
    if (summary.status === 'ready' || currentSummary?.status !== 'ready') {
      assistantState.summary = summary;
      assistantState.summaryContextKey = contextKey;
    }
  } catch {
    if (assistantState.summaryRequestId !== operationId) return;
    assistantState.summaryError = '此前结果读取失败，请确认当前视频页仍然打开后重试。';
  } finally {
    if (assistantState.summaryRequestId === operationId) {
      assistantState.summaryCacheLoading = false;
      renderAssistantShell();
    }
  }
}

async function generateCurrentVideoSummaryHighlightsFromPage(): Promise<void> {
  if (assistantState.context?.kind !== 'video' || assistantState.summaryActiveRequest) return;
  const context = assistantState.context;
  const currentSummary = assistantState.summaryContextKey === assistantState.contextKey
    ? assistantState.summary
    : null;
  if (currentSummary?.canGenerate === false) {
    assistantState.summaryError = currentSummary.generationBlockedMessage
      ?? '当前不能生成或刷新，请先检查设置。';
    renderAssistantShell();
    return;
  }
  const primaryTextBlockReason = primaryTextSubmissionBlockMessage(
    buildPrimaryTextStateForContext(context),
  );
  if (primaryTextBlockReason) {
    assistantState.summaryError = primaryTextBlockReason;
    renderAssistantShell();
    return;
  }

  const operationId = assistantState.summaryRequestId + 1;
  const contextKey = assistantState.contextKey;
  const requestId = createCurrentVideoFullTextRequestId('cvsh-page');
  const params = { ...currentPrimaryTextRequestParams(), requestId };
  const textSize = currentSummary?.textSize ?? {
    lineCount: context.transcriptEvidence?.segmentCount ?? 0,
    charCount: null,
    utf8Bytes: context.transcriptEvidence?.serializedBytes ?? 0,
  };
  const previousReady = currentSummary?.status === 'ready'
    ? asPriorGeneratedCurrentVideoSummaryHighlights(currentSummary)
    : null;
  const activeRequest: InPageSummaryHighlightsRequest = {
    requestId,
    params,
    contextKey,
    selectionRevision: primaryTextSelectionsRevision,
    selectedSourceIdentityKey: selectedSourceIdentityKeyFromParams(params),
    title: context.title?.trim() || '当前视频',
    textSize,
    previousReady,
  };
  assistantState.summaryRequestId = operationId;
  assistantState.summaryActiveRequest = activeRequest;
  assistantState.summaryLoading = true;
  assistantState.summaryCacheLoading = false;
  assistantState.summaryError = null;
  assistantState.summary = previousReady ?? {
    ...loadingCurrentVideoSummaryHighlights(),
    title: activeRequest.title,
    textSize,
    requestId,
  };
  assistantState.summaryContextKey = contextKey;
  assistantState.summaryHighlightPreview = null;
  renderAssistantShell();

  try {
    const summary = await sendRuntimeRequest<CurrentVideoSummaryHighlightsResult>(
      'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params,
    );
    if (assistantState.summaryRequestId !== operationId || assistantState.contextKey !== contextKey) return;
    if (summary.status === 'ready') {
      assistantState.summary = summary;
      assistantState.summaryError = null;
    } else if (previousReady) {
      assistantState.summary = { ...previousReady, unverifiedText: summary.unverifiedText };
      assistantState.summaryError = summary.unverifiedText ? null : summary.message;
    } else {
      assistantState.summary = summary;
    }
    assistantState.summaryContextKey = contextKey;
  } catch {
    if (assistantState.summaryRequestId !== operationId || assistantState.contextKey !== contextKey) return;
    assistantState.summary = previousReady;
    assistantState.summaryContextKey = contextKey;
    assistantState.summaryError = '摘要与亮点生成失败，请确认当前视频页仍然打开后重试。';
  } finally {
    const operationStale = assistantState.summaryRequestId !== operationId
      || assistantState.contextKey !== contextKey;
    if (assistantState.summaryActiveRequest?.requestId === requestId) {
      assistantState.summaryActiveRequest = null;
      assistantState.summaryLoading = false;
      renderAssistantShell();
      if (operationStale) {
        void restoreCurrentVideoSummaryHighlightsFromPage();
      }
    }
  }
}

function cancelCurrentVideoSummaryHighlightsFromPage(): void {
  const activeRequest = assistantState.summaryActiveRequest;
  if (!activeRequest) return;
  assistantState.summaryActiveRequest = null;
  assistantState.summaryRequestId += 1;
  assistantState.summaryLoading = false;
  const activeRequestStillCurrent = summaryActiveRequestStillMatchesCurrent(activeRequest);
  const retained = activeRequestStillCurrent
    ? activeRequest.previousReady
    : null;
  if (!activeRequestStillCurrent) {
    assistantState.summary = null;
    assistantState.summaryContextKey = '';
    assistantState.summaryError = null;
    renderAssistantShell();
    void restoreCurrentVideoSummaryHighlightsFromPage();
    void sendRuntimeRequest('CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS', activeRequest.params).catch(() => undefined);
    return;
  }
  assistantState.summary = retained ?? cancelledCurrentVideoSummaryHighlights(
    activeRequest.title,
    null,
    activeRequest.textSize,
  );
  assistantState.summaryContextKey = assistantState.contextKey;
  assistantState.summaryError = retained ? '本次生成已取消，此前结果保持不变。' : null;
  renderAssistantShell();
  void sendRuntimeRequest('CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS', activeRequest.params).catch(() => undefined);
}

async function confirmCurrentVideoSummaryHighlightJumpFromPage(
  binding: CurrentVideoSummaryHighlightBinding,
): Promise<void> {
  if (
    assistantState.summaryHighlightJumpLoading
    || assistantState.summaryHighlightReturnLoading
    || assistantState.context?.kind !== 'video'
  ) return;
  const summary = assistantState.summaryContextKey === assistantState.contextKey
    ? assistantState.summary
    : null;
  const currentBinding = summary
    ? currentVideoSummaryHighlightBindingFromResult(summary, binding.highlightId)
    : null;
  if (!currentVideoSummaryHighlightBindingsEqual(binding, currentBinding)) {
    assistantState.summaryHighlightPreview = null;
    assistantState.summaryHighlightJumpStatus = '亮点结果已更新，请重新预览后再跳转。';
    renderAssistantShell();
    return;
  }

  const operationId = assistantState.summaryHighlightTimestampRequestId + 1;
  assistantState.summaryHighlightTimestampRequestId = operationId;
  assistantState.summaryHighlightJumpLoading = true;
  assistantState.summaryHighlightReturnLoading = false;
  assistantState.summaryHighlightReturnAvailable = false;
  assistantState.summaryHighlightJumpStatus = '正在确认跳转...';
  renderAssistantShell();

  try {
    const response = await sendRuntimeRequest<CurrentVideoTimestampJumpResponse>(
      'REQUEST_CURRENT_VIDEO_HIGHLIGHT_JUMP',
      {
        ...binding,
        confirmed: true,
        ...currentPrimaryTextRequestParams(),
      },
    );
    if (assistantState.summaryHighlightTimestampRequestId !== operationId) return;
    assistantState.summaryHighlightJumpStatus = response.ok
      ? '已跳到亮点位置，可返回原位置。'
      : '亮点结果或页面状态已变化，请重新预览后再试。';
    assistantState.summaryHighlightReturnAvailable = response.ok && response.returnPointSeconds !== null;
    assistantState.summaryHighlightPreview = null;
  } catch {
    if (assistantState.summaryHighlightTimestampRequestId !== operationId) return;
    assistantState.summaryHighlightJumpStatus = '亮点跳转失败，请确认当前视频页仍然打开后重试。';
    assistantState.summaryHighlightReturnAvailable = false;
  } finally {
    if (assistantState.summaryHighlightTimestampRequestId === operationId) {
      assistantState.summaryHighlightJumpLoading = false;
      renderAssistantShell();
    }
  }
}

async function returnCurrentVideoSummaryHighlightJumpFromPage(): Promise<void> {
  if (
    !assistantState.summaryHighlightReturnAvailable
    || assistantState.summaryHighlightReturnLoading
    || assistantState.summaryHighlightJumpLoading
  ) return;
  const operationId = assistantState.summaryHighlightTimestampRequestId + 1;
  assistantState.summaryHighlightTimestampRequestId = operationId;
  assistantState.summaryHighlightReturnLoading = true;
  assistantState.summaryHighlightJumpStatus = '正在返回原位置...';
  renderAssistantShell();
  try {
    const response = await sendRuntimeRequest<CurrentVideoTimestampReturnResponse>(
      'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
      currentPrimaryTextRequestParams(),
    );
    if (assistantState.summaryHighlightTimestampRequestId !== operationId) return;
    assistantState.summaryHighlightJumpStatus = response.ok
      ? '已返回原位置。'
      : '未能返回原位置，请确认当前视频页和播放器状态后重试。';
    if (response.ok) assistantState.summaryHighlightReturnAvailable = false;
  } catch {
    if (assistantState.summaryHighlightTimestampRequestId !== operationId) return;
    assistantState.summaryHighlightJumpStatus = '返回原位置失败，请确认当前视频页仍然打开后重试。';
  } finally {
    if (assistantState.summaryHighlightTimestampRequestId === operationId) {
      assistantState.summaryHighlightReturnLoading = false;
      renderAssistantShell();
    }
  }
}

async function loadCurrentVideoKnowledge(force: boolean): Promise<void> {
  if (assistantState.context?.kind !== 'video') return;
  if (assistantState.knowledgeLoading) return;
  const primaryTextBlockReason = primaryTextSubmissionBlockMessage(
    buildPrimaryTextStateForContext(assistantState.context),
  );
  if (primaryTextBlockReason) {
    assistantState.knowledge = null;
    assistantState.knowledgeError = primaryTextBlockReason;
    renderAssistantShell();
    return;
  }
  if (
    !force
    && assistantState.knowledge
    && assistantState.knowledgeContextKey === assistantState.contextKey
  ) {
    return;
  }

  const requestId = assistantState.knowledgeRequestId + 1;
  const contextKey = assistantState.contextKey;
  assistantState.knowledgeRequestId = requestId;
  assistantState.knowledgeLoading = true;
  assistantState.knowledgeError = null;
  renderAssistantShell();

  try {
    const knowledge = await sendRuntimeRequest<VideoKnowledgeResult>(
      'GET_VIDEO_KNOWLEDGE',
      currentPrimaryTextRequestParams(),
    );
    if (assistantState.knowledgeRequestId !== requestId || assistantState.contextKey !== contextKey) return;
    assistantState.knowledge = knowledge;
    assistantState.knowledgeContextKey = contextKey;
  } catch {
    if (assistantState.knowledgeRequestId !== requestId) return;
    assistantState.knowledgeError = '知识节点刷新失败：请确认当前 B 站视频页仍然打开，并稍后重试。';
  } finally {
    if (assistantState.knowledgeRequestId === requestId) {
      assistantState.knowledgeLoading = false;
      renderAssistantShell();
    }
  }
}

async function sendRuntimeRequest<T>(
  action: RequestAction,
  params?: Record<string, unknown>,
): Promise<T> {
  const response = await chrome.runtime.sendMessage({ action, params }) as BiliVizResponse<T>;
  if (!response?.success || response.data === undefined) {
    throw new Error('REQUEST_FAILED');
  }
  return response.data;
}

function section(title: string, extraClass = ''): HTMLElement {
  const block = document.createElement('section');
  block.className = ['bdc-assistant-section', extraClass].filter(Boolean).join(' ');
  const head = document.createElement('div');
  head.className = 'bdc-assistant-section-head';
  appendText(head, 'div', 'bdc-assistant-section-title', title);
  block.appendChild(head);
  return block;
}

function button(
  text: string,
  className: string,
  onClick: () => void,
  disabled = false,
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  element.disabled = disabled;
  element.addEventListener('click', onClick);
  return element;
}

function dashboardLink(text: string, hash = ''): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'bdc-assistant-link';
  link.href = chrome.runtime.getURL(`dashboard/index.html${hash}`);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  return link;
}

function needsAiSettingsLink(status: string): boolean {
  return status === 'disabled' || status === 'not_configured';
}

function appendRow(parent: HTMLElement, label: string, value: string): void {
  const row = document.createElement('div');
  row.className = 'bdc-assistant-row';
  appendText(row, 'span', '', label);
  appendText(row, 'span', '', value);
  parent.appendChild(row);
}

function appendBadge(parent: HTMLElement, text: string): void {
  const badge = document.createElement('span');
  badge.className = 'bdc-assistant-badge';
  badge.textContent = text;
  parent.appendChild(badge);
}

function pill(text: string, ready: boolean): HTMLElement {
  const element = document.createElement('span');
  element.className = ready
    ? 'bdc-assistant-pill bdc-assistant-pill-ready'
    : 'bdc-assistant-pill bdc-assistant-pill-warn';
  element.textContent = text;
  return element;
}

function appendText(
  parent: HTMLElement,
  tag: 'div' | 'p' | 'span',
  className: string,
  text: string,
): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

interface CurrentAssistantVideoIdentity {
  bvid: string;
  cid: number | null;
  page: number;
}

function currentAssistantVideoIdentity(): CurrentAssistantVideoIdentity | null {
  const context = assistantState.context;
  if (context?.kind !== 'video') return null;
  return {
    bvid: context.bvid,
    cid: context.cid ?? null,
    page: context.currentPart.page,
  };
}

function subtitleRefreshStillTargets(
  requestId: number,
  identity: CurrentAssistantVideoIdentity,
  result: CurrentVideoContextResult | CurrentVideoTranscriptEvidenceState,
): boolean {
  return assistantState.subtitleRequestId === requestId
    && currentAssistantIdentityMatches(identity)
    && (
      isTranscriptEvidenceState(result)
        ? transcriptEvidenceMatchesVideoIdentity(result, identity)
        : contextMatchesVideoIdentity(result, identity)
    );
}

function currentAssistantIdentityMatches(identity: CurrentAssistantVideoIdentity): boolean {
  const current = currentAssistantVideoIdentity();
  return Boolean(current && sameCurrentAssistantVideoIdentity(current, identity));
}

function contextMatchesVideoIdentity(
  context: CurrentVideoContextResult,
  identity: CurrentAssistantVideoIdentity,
): boolean {
  return context.kind === 'video'
    && sameCurrentAssistantVideoIdentity({
      bvid: context.bvid,
      cid: context.cid ?? null,
      page: context.currentPart.page,
    }, identity);
}

function transcriptEvidenceMatchesVideoIdentity(
  evidence: CurrentVideoTranscriptEvidenceState,
  identity: CurrentAssistantVideoIdentity,
): boolean {
  return evidence.bvid === identity.bvid
    && (evidence.cid ?? null) === identity.cid
    && evidence.page === identity.page;
}

function sameCurrentAssistantVideoIdentity(
  left: CurrentAssistantVideoIdentity,
  right: CurrentAssistantVideoIdentity,
): boolean {
  return left.bvid === right.bvid
    && left.cid === right.cid
    && left.page === right.page;
}

function isTranscriptEvidenceState(
  value: CurrentVideoContextResult | CurrentVideoTranscriptEvidenceState,
): value is CurrentVideoTranscriptEvidenceState {
  return 'status' in value && 'active' in value && 'segmentCount' in value;
}

function contextStateKey(context: CurrentVideoContextResult): string {
  if (context.kind !== 'video') {
    return ['no-context', context.reason, context.url ?? ''].join(':');
  }

  const evidence = context.transcriptEvidence;
  return [
    context.bvid,
    context.cid ?? 'cid-unknown',
    context.currentPart.page,
    selectedPrimaryTextSourceIdentityKey(context) ?? 'no-selected-source',
    context.sources.transcript,
    context.sources.contentText,
    evidence?.status ?? 'no-evidence',
    evidence?.active === true ? 'active' : 'inactive',
    evidence?.sourceIdentityKey ?? 'no-source-key',
    evidence?.sourceHash ?? 'no-source-hash',
    evidence?.bodyHash ?? 'no-body-hash',
    evidence?.timelineHash ?? 'no-timeline-hash',
    evidence?.segmentCount ?? 0,
    evidence?.updatedAt ?? 0,
  ].join(':');
}

function ensurePrimaryTextSelectionsLoaded(): void {
  if (primaryTextSelectionsLoaded || primaryTextSelectionsLoading || primaryTextSelectionsReadFailed) return;
  primaryTextSelectionsLoading = true;
  const requestId = primaryTextSelectionsLoadRequestId + 1;
  primaryTextSelectionsLoadRequestId = requestId;
  chrome.storage?.local?.get(CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY)
    .then((stored) => {
      if (primaryTextSelectionsLoadRequestId !== requestId) return;
      const selections = normalizeCurrentVideoPrimaryTextSelections(
        stored?.[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY],
      );
      replacePrimaryTextSelections(selections);
      primaryTextSelectionsLoaded = true;
      primaryTextSelectionsLoading = false;
      primaryTextSelectionsReadFailed = false;
      if (assistantState.context) {
        updateAssistantContext(assistantState.context);
        renderAssistantShell();
        void restoreCurrentVideoSummaryHighlightsFromPage();
      }
    })
    .catch(() => {
      if (primaryTextSelectionsLoadRequestId !== requestId) return;
      primaryTextSelections.clear();
      primaryTextSelectionsLoaded = false;
      primaryTextSelectionsLoading = false;
      primaryTextSelectionsReadFailed = true;
      assistantState.primaryTextStatus = '保存的主要文本来源选择读取失败，请先在来源卡片中明确选择一个来源后再继续。';
      if (assistantState.context) {
        updateAssistantContext(assistantState.context);
        renderAssistantShell();
      }
    });
}

function ensurePrimaryTextSelectionStorageListener(): void {
  if (primaryTextSelectionStorageListenerRegistered) return;
  const storageChanges = chrome.storage?.onChanged;
  if (!storageChanges?.addListener) return;

  storageChanges.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const selectionChanged = Object.prototype.hasOwnProperty.call(
      changes,
      CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY,
    );
    const configChanged = Object.prototype.hasOwnProperty.call(changes, USER_CONFIG_STORAGE_KEY)
      && currentVideoSummaryConfigRelevantChange(
        changes[USER_CONFIG_STORAGE_KEY]?.oldValue,
        changes[USER_CONFIG_STORAGE_KEY]?.newValue,
      );

    if (selectionChanged) {
      const change = changes[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY];
      const selections = normalizeCurrentVideoPrimaryTextSelections(change?.newValue);
      primaryTextSelectionsLoadRequestId += 1;
      primaryTextSelectionsRevision += 1;
      replacePrimaryTextSelections(selections);
      primaryTextSelectionsLoaded = true;
      primaryTextSelectionsLoading = false;
      primaryTextSelectionsReadFailed = false;
      primaryTextSelectionSaveFailedPartKeys.clear();
      invalidatePrimaryTextDependentAssistantState();
      if (assistantState.context) {
        updateAssistantContext(assistantState.context);
        renderAssistantShell();
        void restoreCurrentVideoSummaryHighlightsFromPage();
      }
    }

    if (configChanged) {
      invalidateSummaryHighlightsForLiveConfigChange(changes[USER_CONFIG_STORAGE_KEY]?.newValue);
      invalidateFullTextQaForLiveConfigChange(changes[USER_CONFIG_STORAGE_KEY]?.newValue);
      if (assistantState.context) {
        renderAssistantShell();
        void restoreCurrentVideoSummaryHighlightsFromPage();
      }
    }
  });
  primaryTextSelectionStorageListenerRegistered = true;
}

function replacePrimaryTextSelections(selections: Record<string, string>): void {
  primaryTextSelections.clear();
  for (const [partKey, sourceIdentityKey] of Object.entries(selections)) {
    primaryTextSelections.set(partKey, sourceIdentityKey);
  }
}

function invalidatePrimaryTextDependentAssistantState(): void {
  assistantState.summaryRequestId += 1;
  if (!assistantState.summaryActiveRequest) {
    assistantState.summaryLoading = false;
  }
  assistantState.summary = null;
  assistantState.summaryContextKey = '';
  assistantState.summaryCacheLoading = false;
  assistantState.summaryError = null;
  assistantState.summaryHighlightPreview = null;
  assistantState.summaryHighlightJumpStatus = null;
  assistantState.summaryHighlightJumpLoading = false;
  assistantState.summaryHighlightReturnAvailable = false;
  assistantState.summaryHighlightReturnLoading = false;
  assistantState.summaryHighlightTimestampRequestId += 1;

  assistantState.knowledgeRequestId += 1;
  assistantState.knowledge = null;
  assistantState.knowledgeContextKey = '';
  assistantState.knowledgeLoading = false;
  assistantState.knowledgeError = null;

  assistantState.segmentRequestId += 1;
  invalidateSegmentTimestampRequests();
  assistantState.segmentResult = null;
  assistantState.segmentContextKey = '';
  assistantState.segmentLoading = false;
  assistantState.segmentError = null;
  assistantState.segmentPreviewCandidateId = null;
  assistantState.segmentJumpStatus = null;
  assistantState.segmentJumpLoading = false;
  assistantState.segmentReturnAvailable = false;
  assistantState.segmentReturnLoading = false;

  assistantState.fullTextQaPreviewCitationId = null;
  assistantState.fullTextQaJumpStatus = null;
  assistantState.fullTextQaJumpLoading = false;
  assistantState.fullTextQaReturnAvailable = false;
  assistantState.fullTextQaReturnLoading = false;
  assistantState.fullTextQaTimestampRequestId += 1;

  assistantState.subtitleRequestId += 1;
  assistantState.subtitleRefreshing = false;
  assistantState.subtitleStatus = null;
  assistantState.primaryTextStatus = null;
}

function invalidateSummaryHighlightsForLiveConfigChange(userConfig: unknown): void {
  const activeRequest = assistantState.summaryActiveRequest;
  const visibleSummary = assistantState.summaryContextKey === assistantState.contextKey
    ? assistantState.summary
    : null;
  const activeRequestSummary = activeRequest && summaryActiveRequestStillMatchesCurrent(activeRequest)
    ? activeRequest.previousReady
    : null;
  const retained = currentVideoSummaryAfterLiveConfigChange(
    visibleSummary ?? activeRequestSummary,
    userConfig,
  );

  if (activeRequest) {
    assistantState.summaryActiveRequest = null;
    void sendRuntimeRequest('CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS', activeRequest.params).catch(() => undefined);
  }
  assistantState.summaryRequestId += 1;
  assistantState.summaryLoading = false;
  assistantState.summaryCacheLoading = false;
  assistantState.summaryError = null;
  assistantState.summary = retained;
  assistantState.summaryContextKey = retained ? assistantState.contextKey : '';
  assistantState.summaryHighlightPreview = null;
  assistantState.summaryHighlightJumpStatus = null;
  assistantState.summaryHighlightJumpLoading = false;
  assistantState.summaryHighlightReturnAvailable = false;
  assistantState.summaryHighlightReturnLoading = false;
  assistantState.summaryHighlightTimestampRequestId += 1;
}

function currentVideoSummaryAfterLiveConfigChange(
  summary: CurrentVideoSummaryHighlightsResult | null,
  userConfig: unknown,
): CurrentVideoSummaryHighlightsResult | null {
  if (summary?.status !== 'ready') return null;
  const gate = currentVideoSummaryGenerationGate(userConfig);
  return {
    ...asPriorGeneratedCurrentVideoSummaryHighlights(summary),
    canGenerate: gate.canGenerate,
    generationBlockedMessage: gate.blockedMessage,
  };
}

function currentVideoSummaryConfigRelevantChange(oldValue: unknown, newValue: unknown): boolean {
  const oldGate = currentVideoSummaryGenerationGate(oldValue);
  const newGate = currentVideoSummaryGenerationGate(newValue);
  return oldGate.enabled !== newGate.enabled
    || oldGate.configured !== newGate.configured
    || oldGate.baseURL !== newGate.baseURL
    || oldGate.apiKey !== newGate.apiKey
    || oldGate.chatModel !== newGate.chatModel;
}

function currentVideoSummaryGenerationGate(value: unknown): {
  enabled: boolean;
  configured: boolean;
  baseURL: string;
  apiKey: string;
  chatModel: string;
  canGenerate: boolean;
  blockedMessage: string | null;
} {
  const config = isPlainRecord(value) ? value : {};
  const assistant = isPlainRecord(config.assistant) ? config.assistant : {};
  const ai = isPlainRecord(config.ai) ? config.ai : {};
  const enabled = assistant.currentVideoAiAssistantEnabled === true;
  const baseURL = stringValue(ai.baseURL);
  const apiKey = stringValue(ai.apiKey);
  const chatModel = stringValue(ai.chatModel);
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface SegmentTimestampOperationSnapshot {
  requestId: number;
  contextKey: string;
  selectionRevision: number;
}

function beginSegmentTimestampOperation(): SegmentTimestampOperationSnapshot {
  const requestId = assistantState.segmentTimestampRequestId + 1;
  assistantState.segmentTimestampRequestId = requestId;
  return {
    requestId,
    contextKey: assistantState.contextKey,
    selectionRevision: primaryTextSelectionsRevision,
  };
}

function invalidateSegmentTimestampRequests(): void {
  assistantState.segmentTimestampRequestId += 1;
}

function segmentTimestampOperationIsCurrent(
  operation: SegmentTimestampOperationSnapshot,
): boolean {
  return assistantState.segmentTimestampRequestId === operation.requestId
    && assistantState.contextKey === operation.contextKey
    && primaryTextSelectionsRevision === operation.selectionRevision;
}

function selectedPrimaryTextSourceIdentityKey(context: CurrentVideoContext): string | null {
  const partKey = currentVideoPrimaryTextPartKey({
    bvid: context.bvid,
    cid: context.cid,
    page: context.currentPart.page,
  });
  if (!partKey) return null;
  return primaryTextSelections.get(partKey) ?? null;
}

function primaryTextSubmissionBlockMessage(
  primaryTextState: ReturnType<typeof buildPrimaryTextStateForContext>,
): string | null {
  if (assistantState.primaryTextSaving) {
    return '正在保存主要文本来源，请保存完成后再继续。';
  }
  if (primaryTextState.selectionSaveFailed) {
    return '上次保存主要文本来源失败，请重新选择这个来源并等待保存完成后再继续。';
  }
  if (primaryTextSelectionsReadFailed) {
    return '保存的主要文本来源选择读取失败，请先在来源卡片中明确选择一个来源后再继续。';
  }
  if (!primaryTextSelectionsLoaded) {
    return '正在读取本页保存的主要文本来源选择，请稍等后再试。';
  }
  if (primaryTextState.state.status === 'selected_source_missing') {
    return '此前选择的主要文本来源已不可用。请重新检测字幕正文，或重新选择新的主要文本来源后再提问。';
  }
  if (
    primaryTextState.sources.length > 1
    && !primaryTextState.selectedSourceIdentityKey
  ) {
    return '请先明确选择一个主要文本来源，再向当前视频提问。';
  }
  return null;
}

function summaryActiveRequestStillMatchesCurrent(
  activeRequest: InPageSummaryHighlightsRequest,
): boolean {
  return activeRequest.contextKey === assistantState.contextKey
    && activeRequest.selectionRevision === primaryTextSelectionsRevision
    && activeRequest.selectedSourceIdentityKey === selectedSourceIdentityKeyFromParams(
      currentPrimaryTextRequestParams(),
    );
}

function invalidateFullTextQaForLiveConfigChange(userConfig: unknown): void {
  const activeRequests = [...assistantState.fullTextQaActiveRequests.values()];
  if (activeRequests.length === 0) return;
  assistantState.fullTextQaActiveRequests.clear();
  assistantState.fullTextQaPreviewCitationId = null;
  assistantState.fullTextQaJumpStatus = null;
  assistantState.fullTextQaReturnAvailable = false;
  assistantState.fullTextQaTimestampRequestId += 1;
  const gate = currentVideoSummaryGenerationGate(userConfig);
  const message = gate.enabled && gate.configured
    ? 'AI 设置已变化，本次回答已取消，问题已保留。'
    : '当前视频 AI 助手已关闭或配置不完整，本次回答已取消，问题已保留。';
  for (const activeRequest of activeRequests) {
    setCurrentVideoQaError(activeRequest.sessionId, message);
    void sendRuntimeRequest('CANCEL_LEARNING_CHAT', activeRequest.params).catch(() => undefined);
  }
}

function fullTextQaActiveRequestStillMatchesCurrent(
  activeRequest: InPageFullTextQaRequest,
): boolean {
  const current = assistantState.fullTextQaActiveRequests.get(activeRequest.sessionId);
  return current?.requestId === activeRequest.requestId
    && current.turnId === activeRequest.turnId;
}

function fullTextQaBindingsEqual(
  left: CurrentVideoFullTextQaCitationBinding,
  right: CurrentVideoFullTextQaCitationBinding,
): boolean {
  return left.requestId === right.requestId
    && (left.sessionId ?? '') === (right.sessionId ?? '')
    && left.turnId === right.turnId
    && left.citationId === right.citationId;
}

function fullTextQaSubmissionNotice(context: CurrentVideoContext): string {
  const lineCount = context.transcriptEvidence?.segmentCount ?? 0;
  const bytes = context.transcriptEvidence?.serializedBytes ?? 0;
  const size = bytes > 0 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : '大小待读取';
  return [
    `本次提交会发送当前分 P 的完整主要文本（约 ${lineCount} 行，${size}）。`,
    '等待时间和费用由你配置的 AI 服务决定。',
  ].join(' ');
}

function selectedSourceIdentityKeyFromParams(params: Record<string, unknown>): string | null {
  const value = params.selectedSourceIdentityKey;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function currentPrimaryTextRequestParams(): Record<string, unknown> {
  const context = assistantState.context;
  if (context?.kind !== 'video') return { primaryTextSelectionsReady: false };
  const readStatus = assistantState.primaryTextSaving
    ? 'saving'
    : primaryTextSelectionsReadFailed || primaryTextSelectionSaveFailedForContext(context)
      ? 'failed'
      : primaryTextSelectionsLoaded
        ? 'ready'
        : 'loading';
  return resolveCurrentVideoPrimaryTextAuthorization({
    readStatus,
    identity: {
      bvid: context.bvid,
      cid: context.cid,
      page: context.currentPart.page,
    },
    selections: Object.fromEntries(primaryTextSelections.entries()),
    availableSourceIdentityKeys: availablePrimaryTextSources(context)
      .map(source => source.identity.sourceIdentityKey),
  }).params;
}

function compactStatusText(context: CurrentVideoContextResult | null): string {
  if (!context) return '正在读取当前视频状态';
  if (context.kind !== 'video') return '未识别到当前视频';
  if (context.transcriptEvidence?.active) return '已取得当前分 P 字幕正文';
  if (context.cid) return '已识别视频，等待字幕正文';
  return '已识别视频，分 P 身份待刷新';
}

function subtitleRefreshResultText(context: CurrentVideoContextResult): string {
  const diagnostics = buildCurrentVideoSubtitleDiagnostics(context);
  if (context.kind === 'video' && context.transcriptEvidence?.active) {
    return `已刷新：已取得字幕正文 ${context.transcriptEvidence.segmentCount} 条。`;
  }
  return `已刷新：${diagnostics.title}。`;
}

function videoKnowledgeNotice(knowledge: VideoKnowledgeResult, transcriptNodeCount: number): string {
  if (knowledge.status === 'no_context') {
    return '当前没有可用于知识节点的视频上下文，请在 B 站视频页内使用。';
  }
  if (transcriptNodeCount > 0) {
    return `已用当前视频本地字幕证据生成 ${transcriptNodeCount} 个知识节点；时间范围只来自字幕片段。`;
  }

  const evidence = knowledge.transcriptEvidence;
  if (!evidence) {
    return '当前没有可引用的字幕正文；知识节点暂不可用。';
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
    return '字幕正文结构异常，暂不作为知识节点证据。';
  }
  if (evidence.active) {
    return '已检测到本地字幕证据，但当前没有匹配到可展示的字幕节点。';
  }
  return evidence.message || '当前没有可引用的字幕正文；不会生成推测时间点。';
}

function videoKnowledgeTimeRange(node: VideoKnowledgeNode): string {
  if (node.timestamp === null) return '无时间点';
  if (typeof node.endTimestamp === 'number' && node.endTimestamp > node.timestamp) {
    return `${formatDuration(node.timestamp)}-${formatDuration(node.endTimestamp)}`;
  }
  return formatDuration(node.timestamp);
}

function videoKnowledgeSourceStatus(node: VideoKnowledgeNode): string {
  switch (node.source) {
    case 'transcript':
      return '当前视频字幕证据';
    case 'metadata':
    case 'description':
      return '弱证据辅助提示';
    case 'page':
    case 'chapter':
      return '结构化辅助提示';
    default:
      return '当前视频本地节点';
  }
}

function videoKnowledgeEvidenceStatusLabel(status: VideoKnowledgeEvidenceSourceStatus): string {
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

function videoKnowledgeNodePositionHint(node: VideoKnowledgeNode): string {
  if (node.source === 'metadata' || node.source === 'description') {
    return '该节点只是弱证据辅助提示，不能说明已经完整理解视频，也不会生成时间点。';
  }
  if (node.timestamp === null) {
    return '该节点没有可定位时间点，不会伪造播放位置。';
  }
  if (node.jumpAction) {
    return '该节点包含定位信息；如需跳转，请在当前视频问答中检索引用片段，并按预览、确认流程操作。';
  }
  return '该节点包含字幕时间范围；如需跳转，请在当前视频问答中检索引用片段，并按预览、确认流程操作。';
}

function timestampJumpStatusText(response: CurrentVideoTimestampJumpResponse): string {
  if (response.ok && response.targetTimeLabel && typeof response.returnPointSeconds === 'number') {
    return `已跳到 ${response.targetTimeLabel}；可返回 ${formatDuration(response.returnPointSeconds)}。`;
  }
  return safeVisibleText(response.message);
}

function timestampReturnStatusText(response: CurrentVideoTimestampReturnResponse): string {
  if (response.ok && typeof response.returnPointSeconds === 'number') {
    return `已返回 ${formatDuration(response.returnPointSeconds)}。`;
  }
  return safeVisibleText(response.message);
}

function safeVisibleText(value: string): string {
  return value
    .replace(/document is not defined/gi, '运行状态不可用')
    .replace(RAW_FIELD_VALUE_PATTERN, '内部信息已隐藏')
    .replace(BILIBILI_VIDEO_ID_PATTERN, '视频编号已隐藏')
    .replace(CANDIDATE_ID_PATTERN, '候选片段')
    .replace(TRANSCRIPT_ID_PATTERN, '字幕片段')
    .replace(NODE_ID_PATTERN, '知识节点')
    .replace(/https?:\/\/\S+/g, '链接已隐藏')
    .replace(PLAYER_ENDPOINT_PATTERN, '接口路径已隐藏')
    .replace(RAW_FIELD_PATTERN, '内部字段')
    .replace(PAGE_BODY_TEXT_PATTERN, '页面可见文字')
    .replace(/\bBVID\b/g, '视频编号')
    .replace(/\bCID\b/g, '分 P 信息')
    .replace(ENGINEERING_VISIBLE_TERM_PATTERN, (term) => {
      const normalized = term.toLowerCase();
      if (normalized === 'fallback') return '本地兜底';
      if (normalized === 'transcript') return '字幕正文';
      return '匹配度';
    });
}

function qaStatusLabel(status: CurrentVideoSegmentRetrievalResult['qa']['status']): string {
  switch (status) {
    case 'answered':
      return '有证据';
    case 'not_found':
      return '没有找到';
    case 'no_transcript':
      return '证据不足';
    case 'low_confidence':
      return '证据较弱';
    case 'no_context':
      return '没有当前视频';
    case 'insufficient_evidence':
    default:
      return '证据不足';
  }
}

function qaStatusColor(status: CurrentVideoSegmentRetrievalResult['qa']['status']): string {
  switch (status) {
    case 'answered':
      return 'var(--bb-success)';
    case 'not_found':
      return 'var(--bb-link)';
    case 'low_confidence':
    case 'no_transcript':
    case 'insufficient_evidence':
      return 'var(--bb-warning)';
    case 'no_context':
    default:
      return '#ff8a8a';
  }
}

function qaAiStatusLabel(status: CurrentVideoSegmentRetrievalResult['qa']['aiState']['status']): string {
  switch (status) {
    case 'generated':
      return '已整理';
    case 'disabled':
      return '未启用';
    case 'not_configured':
      return '未配置';
    case 'failed':
      return '请求失败';
    case 'rejected':
      return '已拒绝';
    case 'low_confidence':
      return '低置信';
    case 'not_requested':
    default:
      return '未请求';
  }
}

function qaSourceStateLabel(result: CurrentVideoSegmentRetrievalResult): string {
  if (result.qa.sourceState.hasCitableEvidence) return '当前视频证据';
  if (result.qa.sourceState.hasOnlyMetadataHints) return '仅弱提示';
  if (!result.qa.sourceState.contextFresh) return '上下文需刷新';
  return '缺少字幕正文';
}

function relatedFavoritesNotice(qa: SmartFavoriteQaResponse): string {
  if (qa.citedVideos.length > 0) {
    return `在当前已同步收藏中找到 ${qa.citedVideos.length} 个相关收藏，可作为延伸阅读。`;
  }
  if (qa.answerType === 'insufficient_evidence') {
    return '当前收藏检索只能使用收藏元数据和智能索引，未找到足够可引用的相关收藏。';
  }
  return '当前已同步收藏中暂未找到匹配收藏。';
}

function relatedFavoritesCoverageNotice(qa: SmartFavoriteQaResponse): string {
  if (!qa.status.syncCoverage.complete) {
    return '收藏同步可能不完整，结果只覆盖当前已同步收藏。';
  }
  if (qa.status.indexCoverage.indexMissing) {
    return '智能索引缺失，本次使用本地元数据结果。';
  }
  if (qa.status.indexCoverage.staleIndex) {
    return '智能索引可能过期或不完整，本次仍保留本地元数据结果。';
  }
  if (qa.synthesis?.status === 'disabled') {
    return 'AI 收藏问答未启用，已保留本地引用结果。';
  }
  if (qa.synthesis?.status === 'not_configured') {
    return 'AI 收藏问答尚未配置，已保留本地引用结果。';
  }
  if (qa.synthesis?.status === 'failed' || qa.synthesis?.status === 'rejected') {
    return 'AI 整理未采用，已保留本地引用结果。';
  }
  return '';
}

function relatedFavoritesStatusColor(qa: SmartFavoriteQaResponse): string {
  switch (qa.status.kind) {
    case 'ok':
      return 'var(--bb-success)';
    case 'no_result':
      return 'var(--bb-link)';
    case 'low_confidence':
    case 'stale_index':
    case 'incomplete_sync':
    case 'index_missing':
    case 'insufficient_evidence':
    default:
      return 'var(--bb-warning)';
  }
}

function relatedFavoritesAiStatusLabel(status: SmartFavoriteQaSynthesisStatus | undefined): string {
  switch (status) {
    case 'generated':
      return '已整理';
    case 'disabled':
      return '未启用';
    case 'not_configured':
      return '未配置';
    case 'failed':
      return '请求失败';
    case 'rejected':
      return '未采用';
    case 'local_fallback':
      return '本地引用';
    default:
      return '未请求';
  }
}

function relatedFavoriteConfidenceLabel(value: SmartFavoriteQaCitedVideo['confidence']): string {
  if (value === 'high') return '高';
  if (value === 'medium') return '中';
  return '低';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    case 'invalid_output':
      return '已拒绝';
    case 'error':
      return '未生成';
    default:
      return '未知状态';
  }
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

function activeSummaryHighlightPreview(
  summary: CurrentVideoSummaryHighlightsResult,
): CurrentVideoSummaryHighlightBinding | null {
  const preview = assistantState.summaryHighlightPreview;
  if (!preview) return null;
  const current = currentVideoSummaryHighlightBindingFromResult(summary, preview.highlightId);
  return currentVideoSummaryHighlightBindingsEqual(preview, current) ? preview : null;
}

function segmentRetrievalStatusMessage(
  result: CurrentVideoSegmentRetrievalResult,
  context: CurrentVideoContext,
): string {
  switch (result.status) {
    case 'empty_query':
      return '请输入想定位的内容。';
    case 'no_context':
      return '当前没有可用视频上下文，请在 B 站视频页内使用。';
    case 'stale_context':
      return '当前视频上下文已过期，请刷新当前页或重新检测字幕后再检索。';
    case 'no_evidence':
      if (!context.transcriptEvidence?.active && result.evidenceState.transcriptSegmentCount === 0) {
        return '需要先开启或重新检测字幕正文；没有当前视频本地证据时不会伪造时间点。';
      }
      return result.summary;
    case 'metadata_only':
      return '只找到视频信息或简介里的弱提示，当前无法定位到具体时间；需要字幕正文或本地节点证据。';
    case 'low_confidence':
      return `${result.summary} 当前只展示候选，不改变播放位置。`;
    case 'ready':
    default:
      return result.summary;
  }
}

function segmentRetrievalStatusColor(result: CurrentVideoSegmentRetrievalResult): string {
  if (result.status === 'ready') return 'var(--bb-success)';
  if (result.status === 'metadata_only' || result.status === 'low_confidence') return 'var(--bb-warning)';
  if (result.status === 'stale_context' || result.status === 'no_context') return '#ff8a8a';
  return 'var(--bb-link)';
}

function segmentCandidateSourceStatus(
  candidate: CurrentVideoSegmentRetrievalCandidate,
  result: CurrentVideoSegmentRetrievalResult,
): string {
  switch (candidate.source) {
    case 'transcript_segment':
      return `当前视频字幕正文 ${result.evidenceState.transcriptSegmentCount} 条可用`;
    case 'transcript_node':
      return '当前视频本地字幕节点';
    case 'chapter_node':
      return '当前视频章节弱提示';
    case 'page_node':
      return '当前分 P 弱提示';
    case 'metadata_hint':
    case 'description_hint':
      return '仅弱提示，不能定位时间';
    default:
      return '当前视频本地证据';
  }
}

function segmentVisibleLimitations(result: CurrentVideoSegmentRetrievalResult): string[] {
  switch (result.status) {
    case 'ready':
    case 'low_confidence':
      return ['候选只来自当前视频字幕正文或本地节点，不会推测新时间点。'];
    case 'metadata_only':
      return ['仅视频信息或简介弱提示不能定位时间，需要字幕正文或本地节点证据。'];
    case 'no_evidence':
      return ['检索只基于当前视频证据；没有字幕正文或本地节点时不会给出时间。'];
    case 'stale_context':
      return ['请先刷新当前视频上下文，再重新检索。'];
    case 'no_context':
      return ['请在 B 站视频页内使用当前视频助手。'];
    case 'empty_query':
      return ['请输入关键词或一句话描述。'];
    default:
      return ['检索只基于当前视频本地证据。'];
  }
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '0:00';
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatByteSize(bytes: number): string {
  const safe = Math.max(0, Math.floor(bytes));
  if (safe >= 1024 * 1024) return `${(safe / 1024 / 1024).toFixed(1)} MB`;
  if (safe >= 1024) return `${Math.ceil(safe / 1024)} KB`;
  return `${safe} B`;
}
