export type CurrentVideoFullTextQaStatus =
  | 'ready'
  | 'unsupported'
  | 'no_context'
  | 'no_text'
  | 'disabled'
  | 'not_configured'
  | 'context_too_long'
  | 'cancelled'
  | 'invalid_output'
  | 'error';

export type CurrentVideoFullTextQaAiStatus =
  | 'generated'
  | 'unsupported'
  | 'disabled'
  | 'not_configured'
  | 'context_too_long'
  | 'cancelled'
  | 'invalid_output'
  | 'failed';

export interface CurrentVideoFullTextQaTextSize {
  lineCount: number;
  charCount: number | null;
  utf8Bytes: number;
}

export interface CurrentVideoFullTextQaCitationBinding {
  sessionId?: string;
  requestId: string;
  turnId: string;
  citationId: string;
}

export interface CurrentVideoFullTextQaCitation {
  id: string;
  evidenceLineNumbers: number[];
  evidenceText: string;
  startSeconds: number;
  endSeconds: number;
  timeRangeLabel: string;
  sourceLabel: 'B站字幕' | '本地转录';
  binding: CurrentVideoFullTextQaCitationBinding;
}

export interface CurrentVideoFullTextQaAiState {
  status: CurrentVideoFullTextQaAiStatus;
  model: string | null;
  note: string;
  errorCode: string | null;
}

export interface CurrentVideoFullTextQaSourceReference {
  title: string;
  partTitle: string | null;
  page: number | null;
  bvid: string | null;
  cid: number | null;
  url: string | null;
  sourceLabel: 'B站字幕' | '本地转录' | null;
  language: string | null;
  sourceIdentityKey: string | null;
  textSize: CurrentVideoFullTextQaTextSize;
  capturedAt: number;
}

export interface CurrentVideoFullTextQaResult {
  answerMode?: 'learning';
  sessionId?: string;
  status: CurrentVideoFullTextQaStatus;
  requestId: string;
  turnId: string;
  question: string;
  title: string;
  partTitle: string | null;
  sourceLabel: 'B站字幕' | '本地转录' | null;
  textSize: CurrentVideoFullTextQaTextSize;
  answer: string;
  answerEvidenceLineNumbers: number[];
  citations: CurrentVideoFullTextQaCitation[];
  message: string;
  limitations: string[];
  ai: CurrentVideoFullTextQaAiState;
  sourceReference?: CurrentVideoFullTextQaSourceReference | null;
  rollingContext?: string | null;
  generatedAt: number;
  canRetry: boolean;
}
