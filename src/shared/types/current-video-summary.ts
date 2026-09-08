export type CurrentVideoSummarySourceTier = 'metadata_summary' | 'description_summary' | 'transcript_summary';
export type CurrentVideoSummaryStatus = 'ready' | 'no_context' | 'loading' | 'cancelled';
export type CurrentVideoSummaryConfidence = 'low' | 'medium' | 'high';
export type CurrentVideoSummaryGenerationMode = 'local_fallback' | 'ai';
export type CurrentVideoSummaryAiStatus =
  | 'not_requested'
  | 'disabled'
  | 'not_configured'
  | 'generated'
  | 'failed'
  | 'low_confidence'
  | 'invalid_output';

export interface CurrentVideoSummaryEvidence {
  source: 'metadata' | 'description' | 'page' | 'chapter' | 'transcript' | 'local_fallback';
  label: string;
  value: string;
  startSeconds?: number | null;
  endSeconds?: number | null;
  segmentIds?: string[];
  language?: string | null;
}

export interface CurrentVideoSummaryTimestampRange {
  startSeconds: number;
  endSeconds: number;
  label: string;
  evidenceSnippet: string;
  segmentIds: string[];
  language: string | null;
}

export interface CurrentVideoSummaryAiState {
  status: CurrentVideoSummaryAiStatus;
  model: string | null;
  error: string | null;
  note: string;
}

export interface CurrentVideoSummaryResult {
  status: CurrentVideoSummaryStatus;
  sourceTier: CurrentVideoSummarySourceTier | null;
  sourceTierLabel: '元数据摘要' | '简介摘要' | '字幕正文摘要' | null;
  confidence: CurrentVideoSummaryConfidence;
  generationMode: CurrentVideoSummaryGenerationMode;
  title: string;
  summary: string;
  bullets: string[];
  evidence: CurrentVideoSummaryEvidence[];
  timestampRanges: CurrentVideoSummaryTimestampRange[];
  missingSources: string[];
  warnings: string[];
  limitations: string[];
  nextQuestions: string[];
  ai: CurrentVideoSummaryAiState;
  generatedAt: number;
}

export type CurrentVideoSummaryHighlightsStatus =
  | 'not_requested'
  | 'ready'
  | 'no_context'
  | 'no_text'
  | 'loading'
  | 'generating'
  | 'cancelled'
  | 'error'
  | 'invalid_output';

export type CurrentVideoSummaryHighlightsAiStatus =
  | 'not_requested'
  | 'disabled'
  | 'not_configured'
  | 'generated'
  | 'failed'
  | 'invalid_output'
  | 'context_too_long'
  | 'cancelled';

export interface CurrentVideoSummaryHighlightsTextSize {
  lineCount: number;
  charCount: number | null;
  utf8Bytes: number;
}

export interface CurrentVideoSummaryHighlightsAiState {
  status: CurrentVideoSummaryHighlightsAiStatus;
  model: string | null;
  error: string | null;
  note: string;
}

export interface CurrentVideoSummarySentence {
  id: string;
  text: string;
  evidenceLineNumbers: number[];
}

export interface CurrentVideoSummaryKeyPoint {
  id: string;
  text: string;
  evidenceLineNumbers: number[];
}

export interface CurrentVideoSummaryHighlight {
  id: string;
  title: string;
  description: string;
  startSeconds: number;
  endSeconds: number;
  timeRangeLabel: string;
  evidenceLineNumbers: number[];
}

export interface CurrentVideoSummaryHighlightsResult {
  unverifiedText?: string;
  status: CurrentVideoSummaryHighlightsStatus;
  title: string;
  message: string;
  sourceLabel: 'B站字幕' | '本地转录' | null;
  textSize: CurrentVideoSummaryHighlightsTextSize;
  summarySentences: CurrentVideoSummarySentence[];
  keyPoints: CurrentVideoSummaryKeyPoint[];
  highlights: CurrentVideoSummaryHighlight[];
  limitations: string[];
  ai: CurrentVideoSummaryHighlightsAiState;
  generatedAt: number;
  model: string | null;
  cacheKey: string | null;
  cacheHit: boolean;
  current: boolean;
  requestId: string | null;
  canGenerate: boolean;
  priorGenerated: boolean;
  generationBlockedMessage: string | null;
}

export interface CurrentVideoSummaryHighlightsPrimaryTextAuditIdentity {
  bvid: string;
  cid: number;
  page: number;
  source: string;
  sourceType: string;
  language: string | null;
  bodyHash: string;
  timelineHash: string;
  sourceHash: string;
  sourceIdentityKey: string;
  lineCount: number;
}

export interface CurrentVideoSummaryHighlightsRequestAudit {
  requestId: string;
  operation: 'summary_highlights';
  submittedAt: number;
  model: string;
  primaryTextIdentity: CurrentVideoSummaryHighlightsPrimaryTextAuditIdentity;
  text: CurrentVideoSummaryHighlightsTextSize;
}

export interface CurrentVideoSummaryHighlightBinding {
  highlightId: string;
  cacheKey: string;
  generatedAt: number;
  requestId: string;
  model: string;
}

export interface CurrentVideoSummaryHighlightsCacheRecord {
  id?: number;
  cacheKey: string;
  sourceIdentityKey: string;
  model: string;
  bvid: string;
  cid: number;
  page: number;
  generatedAt: number;
  lastAccessedAt: number;
  serializedBytes: number;
  requestAudit: CurrentVideoSummaryHighlightsRequestAudit;
  result: CurrentVideoSummaryHighlightsResult;
}
