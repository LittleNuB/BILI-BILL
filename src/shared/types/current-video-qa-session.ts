import type {
  CurrentVideoFullTextQaCitation,
  CurrentVideoFullTextQaResult,
  CurrentVideoFullTextQaStatus,
  CurrentVideoFullTextQaTextSize,
} from './current-video-full-text-qa.ts';

export const CURRENT_VIDEO_QA_SESSION_MAX_COUNT = 200;
export const CURRENT_VIDEO_QA_SESSION_MAX_BYTES = 25 * 1024 * 1024;
export const CURRENT_VIDEO_QA_ROLLING_CONTEXT_MAX_CHARS = 2_000;

export type CurrentVideoQaSessionTurnStatus = CurrentVideoFullTextQaStatus | 'pending';

export interface CurrentVideoQaSourceSnapshot {
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

export interface CurrentVideoQaSessionTurn {
  answerMode?: 'learning';
  turnId: string;
  requestId: string;
  question: string;
  status: CurrentVideoQaSessionTurnStatus;
  answer: string;
  message: string;
  citations: CurrentVideoFullTextQaCitation[];
  canRetry: boolean;
  ai: CurrentVideoFullTextQaResult['ai'];
  source: CurrentVideoQaSourceSnapshot | null;
  rollingContext: string | null;
  createdAt: number;
  updatedAt: number;
  submittedAt: number;
  generatedAt: number | null;
}

export interface CurrentVideoQaSessionRecord {
  id?: number;
  sessionId: string;
  title: string;
  customTitle: string | null;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  turns: CurrentVideoQaSessionTurn[];
}

export interface CurrentVideoQaSessionSummary {
  sessionId: string;
  title: string;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
}

export interface CurrentVideoQaSessionUsage {
  count: number;
  usageBytes: number;
  latestUsedAt: number | null;
}

export interface CurrentVideoQaSessionsView {
  sessions: CurrentVideoQaSessionSummary[];
  activeSession: CurrentVideoQaSessionRecord | null;
  activeSessionId: string | null;
  usage: CurrentVideoQaSessionUsage;
  limits: {
    maxSessions: number;
    maxBytes: number;
  };
}

export interface CurrentVideoQaConversationContext {
  rollingContext: string | null;
  previousTurn: {
    question: string;
    answer: string;
    citations: Array<{
      timeRangeLabel: string;
      evidenceText: string;
    }>;
  };
}

export interface CurrentVideoQaSubmitContext {
  sessionId: string;
  turnId: string;
  requestId: string;
  question: string;
  source: CurrentVideoQaSourceSnapshot | null;
  conversationContext: CurrentVideoQaConversationContext | null;
}
