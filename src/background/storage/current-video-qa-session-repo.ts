import Dexie from 'dexie';
import type {
  CurrentVideoFullTextQaCitation,
  CurrentVideoFullTextQaResult,
} from '../../shared/types/current-video-full-text-qa.ts';
import {
  CURRENT_VIDEO_QA_ROLLING_CONTEXT_MAX_CHARS,
  CURRENT_VIDEO_QA_SESSION_MAX_BYTES,
  CURRENT_VIDEO_QA_SESSION_MAX_COUNT,
  type CurrentVideoQaConversationContext,
  type CurrentVideoQaSessionRecord,
  type CurrentVideoQaSessionSummary,
  type CurrentVideoQaSessionTurn,
  type CurrentVideoQaSourceSnapshot,
  type CurrentVideoQaSessionsView,
  type CurrentVideoQaSessionUsage,
} from '../../shared/types/current-video-qa-session.ts';
import type { LocalDataCategoryRegistration } from '../../shared/local-data-category-contract.ts';
import { invalidateCurrentVideoFullTextQaSources } from '../current-video-full-text-qa.ts';
import { cancelLearningChats } from '../learning-chat-control.ts';
import { CHAT_CONTEXT_STATE_BYTES, serializedBytes, type ChatContextState } from '../../shared/learning-chat-context.ts';
import { db } from './db.ts';

const DEFAULT_AI_STATE = {
  status: 'failed' as const,
  model: null,
  note: '',
  errorCode: null,
};

let currentVideoQaSessionMutationTail: Promise<void> = Promise.resolve();
let currentVideoQaSessionClearGeneration = 0;
let currentVideoQaSessionClearingDepth = 0;
const currentVideoQaSessionDeleteStates = new Map<string, {
  generation: number;
  deletingDepth: number;
}>();
const currentVideoQaSessionTurnAttempts = new Map<string, Map<string, {
  generation: number;
  requestId: string;
}>>();

export interface CurrentVideoQaSessionWriteGuard {
  sessionId: string;
  turnId: string;
  requestId: string;
  clearGeneration: number;
  sessionGeneration: number;
  turnGeneration: number;
  writable: boolean;
}

export const CURRENT_VIDEO_QA_SESSION_STORAGE_LIMIT_MESSAGE =
  '本地问答会话已达 25 MB 上限，本次内容未保存。请先删除部分会话后重试。';

export class CurrentVideoQaSessionStorageLimitError extends Error {
  constructor() {
    super('CURRENT_VIDEO_QA_SESSION_STORAGE_LIMIT');
    this.name = 'CurrentVideoQaSessionStorageLimitError';
  }
}

export class CurrentVideoQaSessionWriteInvalidatedError extends Error {
  constructor() {
    super('CURRENT_VIDEO_QA_SESSION_WRITE_INVALIDATED');
    this.name = 'CurrentVideoQaSessionWriteInvalidatedError';
  }
}

export function isCurrentVideoQaSessionStorageLimitError(
  error: unknown,
): error is CurrentVideoQaSessionStorageLimitError {
  return error instanceof CurrentVideoQaSessionStorageLimitError;
}

export function isCurrentVideoQaSessionWriteInvalidatedError(
  error: unknown,
): error is CurrentVideoQaSessionWriteInvalidatedError {
  return error instanceof CurrentVideoQaSessionWriteInvalidatedError;
}

export function registerCurrentVideoQaSessionTurnWriteGuard(input: {
  sessionId: string;
  turnId: string;
  requestId: string;
}): CurrentVideoQaSessionWriteGuard {
  const sessionId = normalizeRequired(input.sessionId, 'sessionId');
  const turnId = normalizeRequired(input.turnId, 'turnId');
  const requestId = normalizeRequired(input.requestId, 'requestId');
  let sessionAttempts = currentVideoQaSessionTurnAttempts.get(sessionId);
  if (!sessionAttempts) {
    sessionAttempts = new Map();
    currentVideoQaSessionTurnAttempts.set(sessionId, sessionAttempts);
  }
  const previous = sessionAttempts.get(turnId);
  const turnGeneration = (previous?.generation ?? 0) + 1;
  sessionAttempts.set(turnId, { generation: turnGeneration, requestId });
  const base = currentVideoQaSessionWriteBaseState(sessionId);
  return {
    sessionId,
    turnId,
    requestId,
    clearGeneration: base.clearGeneration,
    sessionGeneration: base.sessionGeneration,
    turnGeneration,
    writable: base.writable,
  };
}

export function settleCurrentVideoQaSessionTurnWriteGuard(
  guard: CurrentVideoQaSessionWriteGuard,
): void {
  const sessionAttempts = currentVideoQaSessionTurnAttempts.get(guard.sessionId);
  const current = sessionAttempts?.get(guard.turnId);
  if (
    !sessionAttempts
    || current?.generation !== guard.turnGeneration
    || current.requestId !== guard.requestId
  ) return;
  sessionAttempts.delete(guard.turnId);
  if (sessionAttempts.size === 0) currentVideoQaSessionTurnAttempts.delete(guard.sessionId);
}

export function canUseCurrentVideoQaSessionWriteGuard(
  sessionId: string,
  guard: CurrentVideoQaSessionWriteGuard,
): boolean {
  const normalized = sessionId.trim();
  const current = currentVideoQaSessionWriteBaseState(normalized);
  const currentTurn = currentVideoQaSessionTurnAttempts
    .get(normalized)
    ?.get(guard.turnId);
  return guard.writable
    && current.writable
    && guard.sessionId === normalized
    && guard.clearGeneration === current.clearGeneration
    && guard.sessionGeneration === current.sessionGeneration
    && currentTurn?.generation === guard.turnGeneration
    && currentTurn.requestId === guard.requestId;
}

export async function runCurrentVideoQaSessionClearCoordinator<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const endClearWindow = beginCurrentVideoQaSessionClearWindow();
  try {
    return await withCurrentVideoQaSessionMutation(operation);
  } finally {
    endClearWindow();
  }
}

export function beginCurrentVideoQaSessionClearWindow(): () => void {
  let ended = false;
  currentVideoQaSessionClearGeneration += 1;
  currentVideoQaSessionClearingDepth += 1;
  return () => {
    if (ended) return;
    ended = true;
    currentVideoQaSessionClearingDepth = Math.max(0, currentVideoQaSessionClearingDepth - 1);
    if (currentVideoQaSessionClearingDepth === 0) {
      currentVideoQaSessionClearGeneration += 1;
      currentVideoQaSessionTurnAttempts.clear();
    }
  };
}

export interface PersistedCurrentVideoQaCitationRecord {
  citation: CurrentVideoFullTextQaCitation;
  bvid: string;
  cid: number;
  page: number;
  sourceIdentityKey: string;
  generatedAt: number;
}

export async function getCurrentVideoQaSessionsView(
  activeSessionId?: string | null,
): Promise<CurrentVideoQaSessionsView> {
  const sessions = await readSessionsSorted();
  const normalizedActive = activeSessionId?.trim() || null;
  const activeSession = normalizedActive
    ? sessions.find(session => session.sessionId === normalizedActive) ?? null
    : sessions[0] ?? null;
  const actualActive = activeSession ?? sessions[0] ?? null;
  await currentVideoQaSessionRepoTestHook('after_sessions_view_initial_read');
  if (actualActive) await touchCurrentVideoQaSession(actualActive.sessionId);
  const latestSessions = await readSessionsSorted();
  const refreshed = actualActive
    ? latestSessions.find(session => session.sessionId === actualActive.sessionId) ?? latestSessions[0] ?? null
    : latestSessions[0] ?? null;
  return {
    sessions: latestSessions.map(toSummary),
    activeSession: refreshed,
    activeSessionId: refreshed?.sessionId ?? null,
    usage: currentVideoQaSessionUsageFromRows(latestSessions),
    limits: {
      maxSessions: CURRENT_VIDEO_QA_SESSION_MAX_COUNT,
      maxBytes: CURRENT_VIDEO_QA_SESSION_MAX_BYTES,
    },
  };
}

export async function touchCurrentVideoQaSession(sessionId: string, now = Date.now()): Promise<void> {
  const normalized = sessionId.trim();
  if (!normalized) return;
  await withCurrentVideoQaSessionMutation(async () => {
    await db.currentVideoQaSessions.where({ sessionId: normalized }).modify({
      lastAccessedAt: now,
      updatedAt: now,
    });
  });
}

export async function upsertCurrentVideoQaPendingTurn(input: {
  knowledgeStamp?: string;
  knowledgeReferences?: import('../../shared/knowledge-chat.ts').KnowledgeReference[];
  answerMode?: 'learning';
  sessionId: string;
  turnId: string;
  requestId: string;
  question: string;
  source: CurrentVideoQaSourceSnapshot | null;
  writeGuard?: CurrentVideoQaSessionWriteGuard;
  now?: number;
}): Promise<CurrentVideoQaSessionRecord> {
  const now = input.now ?? Date.now();
  const sessionId = normalizeRequired(input.sessionId, 'sessionId');
  const turnId = normalizeRequired(input.turnId, 'turnId');
  const requestId = normalizeRequired(input.requestId, 'requestId');
  const question = normalizeQuestion(input.question);
  const writeGuard = input.writeGuard ?? registerCurrentVideoQaSessionTurnWriteGuard({
    sessionId,
    turnId,
    requestId,
  });
  return await withCurrentVideoQaSessionMutation(async () => {
    if (!canUseCurrentVideoQaSessionWriteGuard(sessionId, writeGuard)) {
      throw new CurrentVideoQaSessionWriteInvalidatedError();
    }
    return await db.transaction('rw', db.currentVideoQaSessions, async () => {
      const existing = await db.currentVideoQaSessions.where({ sessionId }).first();
      const session: CurrentVideoQaSessionRecord = existing
        ? cloneSession(existing)
        : {
            sessionId,
            title: deterministicSessionTitle(question, now),
            customTitle: null,
            createdAt: now,
            updatedAt: now,
            lastAccessedAt: now,
            turns: [],
          };

      const index = session.turns.findIndex(turn => turn.turnId === turnId);
      const previous = index >= 0 ? session.turns[index]! : null;
      const priorTurn = index >= 0
        ? session.turns[index - 1] ?? null
        : session.turns[session.turns.length - 1] ?? null;
      const carriedRollingContext = previous
        ? matchingRollingContextForSource(previous, input.source)
        : matchingPriorRollingContext(priorTurn, input.source);
      const turn: CurrentVideoQaSessionTurn = {
        knowledgeStamp: input.knowledgeStamp,
        knowledgeReferences: input.knowledgeReferences,
        answerMode: input.answerMode ?? previous?.answerMode,
        turnId,
        requestId,
        question,
        status: 'pending',
        answer: previous?.answer ?? '',
        message: '正在核对全片内容...',
        citations: previous?.citations ?? [],
        canRetry: false,
        ai: previous?.ai ?? DEFAULT_AI_STATE,
        source: input.source ?? previous?.source ?? null,
        rollingContext: carriedRollingContext,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        submittedAt: now,
        generatedAt: null,
      };
      if (index >= 0) session.turns[index] = turn;
      else session.turns.push(turn);
      session.updatedAt = now;
      session.lastAccessedAt = now;
      if (!session.customTitle && session.turns.length === 1) {
        session.title = deterministicSessionTitle(question, session.createdAt);
      }
      const committed = await commitSessionWithinLimitsInTransaction(
        session,
        sessionId,
        () => canUseCurrentVideoQaSessionWriteGuard(sessionId, writeGuard),
        input.answerMode !== 'learning',
      );
      if (!committed) throw new CurrentVideoQaSessionStorageLimitError();
      return committed;
    });
  });
}

export async function saveLearningChatPartial(sessionId: string, turnId: string, requestId: string, answer: string, guard: CurrentVideoQaSessionWriteGuard): Promise<void> {
  await withCurrentVideoQaSessionMutation(async () => {
    if (!canUseCurrentVideoQaSessionWriteGuard(sessionId, guard)) return;
    await db.transaction('rw', db.currentVideoQaSessions, async () => {
      const existing = await db.currentVideoQaSessions.where({ sessionId }).first();
      if (!existing) return;
      const session = cloneSession(existing);
      const turn = session.turns.find(item => item.turnId === turnId && item.requestId === requestId && item.status === 'pending');
      if (!turn) return;
      turn.answer = answer; turn.answerMode = 'learning'; turn.citations = []; turn.updatedAt = Date.now();
      const committed = await commitSessionWithinLimitsInTransaction(session, sessionId, () => canUseCurrentVideoQaSessionWriteGuard(sessionId, guard), false);
      if (!committed) throw new CurrentVideoQaSessionStorageLimitError();
    });
  });
}

export async function saveLearningChatContext(sessionId: string, context: ChatContextState, guard: CurrentVideoQaSessionWriteGuard, valid: () => boolean): Promise<void> {
  if (serializedBytes(context) > CHAT_CONTEXT_STATE_BYTES) throw new CurrentVideoQaSessionStorageLimitError();
  await withCurrentVideoQaSessionMutation(async () => {
    const allowed = () => valid() && canUseCurrentVideoQaSessionWriteGuard(sessionId, guard);
    if (!allowed()) throw new Error('CHAT_CANCELLED');
    await db.transaction('rw', db.currentVideoQaSessions, async () => {
      const existing = await db.currentVideoQaSessions.where({ sessionId }).first();
      if (!existing || !allowed()) throw new Error('CHAT_CANCELLED');
      const next = cloneSession(existing);
      next.learningContext = structuredClone(context);
      const committed = await commitSessionWithinLimitsInTransaction(next, sessionId, allowed, false);
      if (!committed) throw new CurrentVideoQaSessionStorageLimitError();
    });
  });
}

export async function completeCurrentVideoQaTurn(
  sessionId: string,
  turnId: string,
  result: CurrentVideoFullTextQaResult,
  now = Date.now(),
  writeGuard?: CurrentVideoQaSessionWriteGuard,
): Promise<CurrentVideoQaSessionRecord | null> {
  const normalizedSessionId = sessionId.trim();
  const normalizedTurnId = turnId.trim();
  if (!normalizedSessionId || !normalizedTurnId) return null;
  const expectedWriteGuard = writeGuard ?? currentVideoQaSessionTurnWriteGuard(
    normalizedSessionId,
    normalizedTurnId,
    result.requestId,
  );
  if (!expectedWriteGuard) return null;
  let outcome: {
    session: CurrentVideoQaSessionRecord | null;
    storageLimitExceeded: boolean;
  };
  try {
    outcome = await withCurrentVideoQaSessionMutation(async () => {
      if (!canUseCurrentVideoQaSessionWriteGuard(normalizedSessionId, expectedWriteGuard)) {
        return { session: null, storageLimitExceeded: false };
      }
      return await db.transaction('rw', db.currentVideoQaSessions, async () => {
        const existing = await db.currentVideoQaSessions.where({ sessionId: normalizedSessionId }).first();
        if (!existing) return { session: null, storageLimitExceeded: false };
        await currentVideoQaSessionRepoTestHook('after_complete_read');
        const session = cloneSession(existing);
        const index = session.turns.findIndex(turn => turn.turnId === normalizedTurnId);
        if (index < 0) return { session: null, storageLimitExceeded: false };
        const previous = session.turns[index]!;
        if (previous.requestId !== result.requestId) {
          return { session: null, storageLimitExceeded: false };
        }
        const priorTurn = session.turns[index - 1] ?? null;
        const fallbackRollingContext = previous.rollingContext
          ?? matchingPriorRollingContext(priorTurn, previous.source);

        session.turns[index] = {
          ...previous,
          requestId: result.requestId,
          question: result.question || previous.question,
          status: result.status,
          answerMode: result.answerMode,
          contextNotice: result.contextNotice,
          knowledgeStamp: result.knowledgeStamp,
          knowledgeReferences: result.knowledgeReferences,
          answer: result.answer,
          message: result.message,
          citations: result.citations,
          canRetry: result.canRetry,
          ai: result.ai,
          source: result.answerMode === 'learning' ? normalizeSourceSnapshot(result.sourceReference) : normalizeSourceSnapshot(result.sourceReference) ?? previous.source,
          rollingContext: result.status === 'ready'
            ? normalizeRollingContext(result.rollingContext) ?? fallbackRollingContext
            : fallbackRollingContext,
          updatedAt: now,
          generatedAt: result.generatedAt,
        };
        session.updatedAt = now;
        session.lastAccessedAt = now;
        const committed = await commitSessionWithinLimitsInTransaction(
          session,
          normalizedSessionId,
          () => canUseCurrentVideoQaSessionWriteGuard(normalizedSessionId, expectedWriteGuard),
          result.answerMode !== 'learning',
        );
        if (committed) return { session: committed, storageLimitExceeded: false };

        const boundedFailure = cloneSession(existing);
        const pending = boundedFailure.turns[index]!;
        boundedFailure.turns[index] = {
          ...pending,
          status: 'error',
          answer: result.answerMode === 'learning' ? pending.answer : '',
          message: '本地会话空间已满。',
          citations: [],
          canRetry: true,
          rollingContext: null,
          updatedAt: now,
        };
        boundedFailure.updatedAt = now;
        boundedFailure.lastAccessedAt = now;
        const failure = await commitSessionWithinLimitsInTransaction(
          boundedFailure,
          normalizedSessionId,
          () => canUseCurrentVideoQaSessionWriteGuard(normalizedSessionId, expectedWriteGuard),
          result.answerMode !== 'learning',
        );
        return { session: failure, storageLimitExceeded: true };
      });
    });
  } catch (error) {
    if (isCurrentVideoQaSessionWriteInvalidatedError(error)) return null;
    throw error;
  }
  if (outcome.storageLimitExceeded) throw new CurrentVideoQaSessionStorageLimitError();
  return outcome.session;
}

export async function deleteCurrentVideoQaSession(sessionId: string): Promise<CurrentVideoQaSessionsView> {
  const normalized = sessionId.trim();
  if (normalized) {
    cancelLearningChats(chat => chat.sessionId === normalized);
    await runCurrentVideoQaSessionDeleteCoordinator(normalized, () => db.transaction(
      'rw', db.currentVideoQaSessions, async () => {
        await db.currentVideoQaSessions.where({ sessionId: normalized }).delete();
      },
    ));
  }
  return await getCurrentVideoQaSessionsView(null);
}

export async function renameCurrentVideoQaSession(
  sessionId: string,
  title: string,
): Promise<CurrentVideoQaSessionRecord | null> {
  const normalized = sessionId.trim();
  const cleanTitle = normalizeTitle(title);
  if (!normalized || !cleanTitle) return null;
  return await withCurrentVideoQaSessionMutation(() => db.transaction(
    'rw',
    db.currentVideoQaSessions,
    async () => {
      const session = await db.currentVideoQaSessions.where({ sessionId: normalized }).first();
      if (!session) return null;
      const next = {
        ...cloneSession(session),
        title: cleanTitle,
        customTitle: cleanTitle,
        updatedAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
      const committed = await commitSessionWithinLimitsInTransaction(next, normalized);
      if (!committed) throw new CurrentVideoQaSessionStorageLimitError();
      return committed;
    },
  ));
}

export async function clearCurrentVideoQaSessions(): Promise<number> {
  cancelLearningChats();
  return await runCurrentVideoQaSessionClearCoordinator(() => db.transaction(
    'rw',
    db.currentVideoQaSessions,
    async () => {
      const count = await db.currentVideoQaSessions.count();
      await db.currentVideoQaSessions.clear();
      return count;
    },
  ));
}

export async function collectCurrentVideoQaSessionUsage(): Promise<CurrentVideoQaSessionUsage> {
  const sessions = await db.currentVideoQaSessions.toArray();
  return currentVideoQaSessionUsageFromRows(sessions);
}

function currentVideoQaSessionUsageFromRows(
  sessions: CurrentVideoQaSessionRecord[],
): CurrentVideoQaSessionUsage {
  const latestUsedAt = sessions.reduce<number | null>((latest, session) => {
    const value = normalizeTimestamp(session.lastAccessedAt);
    if (!value) return latest;
    return latest === null ? value : Math.max(latest, value);
  }, null);
  return {
    count: sessions.length,
    usageBytes: sessions.length > 0 ? serializedRowsSize(sessions) : 0,
    latestUsedAt,
  };
}

export async function readCurrentVideoQaSessionsAfterClear() {
  const usage = await collectCurrentVideoQaSessionUsage();
  return {
    ...usage,
    empty: usage.count === 0 && usage.usageBytes === 0,
  };
}

export function getCurrentVideoQaSessionsLocalDataCategoryRegistration(): LocalDataCategoryRegistration {
  return {
    id: 'currentVideoQaSessions',
    label: '问答会话',
    includeInClearAll: true,
    collectUsage: async () => {
      const usage = await collectCurrentVideoQaSessionUsage();
      return {
        ...usage,
        details: {
          currentVideoQaSessions: usage.count,
          currentVideoQaSessionBytes: usage.usageBytes,
        },
      };
    },
    clear: async () => {
      invalidateCurrentVideoFullTextQaSources();
      const usage = await collectCurrentVideoQaSessionUsage();
      await clearCurrentVideoQaSessions();
      return {
        cleared: {
          currentVideoQaSessions: usage.count,
          currentVideoQaSessionBytes: usage.usageBytes,
        },
      };
    },
    readAfterClear: readCurrentVideoQaSessionsAfterClear,
  };
}

export async function getPersistedCurrentVideoQaCitation(input: {
  sessionId: string;
  requestId: string;
  turnId: string;
  citationId: string;
  sourceIdentityKey: string;
}): Promise<PersistedCurrentVideoQaCitationRecord | null> {
  const sessionId = input.sessionId.trim();
  const requestId = input.requestId.trim();
  const turnId = input.turnId.trim();
  const citationId = input.citationId.trim();
  const sourceIdentityKey = input.sourceIdentityKey.trim();
  if (!sessionId || !requestId || !turnId || !citationId || !sourceIdentityKey) return null;

  const session = await db.currentVideoQaSessions.where({ sessionId }).first();
  const turn = session?.turns.find(candidate => candidate.turnId === turnId) ?? null;
  const source = turn?.source ?? null;
  if (
    !turn
    || turn.status !== 'ready'
    || turn.requestId !== requestId
    || !source
    || source.sourceIdentityKey !== sourceIdentityKey
    || !source.bvid
    || !Number.isInteger(source.cid)
    || Number(source.cid) <= 0
    || !Number.isInteger(source.page)
    || Number(source.page) <= 0
  ) return null;

  const citation = turn.citations.find(candidate => (
    candidate.id === citationId
    && candidate.binding.requestId === requestId
    && candidate.binding.turnId === turnId
    && candidate.binding.citationId === citationId
    && candidate.binding.sessionId === sessionId
  ));
  if (!citation) return null;
  return {
    citation: { ...citation, binding: { ...citation.binding } },
    bvid: source.bvid,
    cid: Number(source.cid),
    page: Number(source.page),
    sourceIdentityKey,
    generatedAt: normalizeTimestamp(turn.generatedAt) ?? turn.updatedAt,
  };
}

export function buildCurrentVideoQaConversationContext(
  session: CurrentVideoQaSessionRecord | null,
  sourceIdentityKey: string | null,
): CurrentVideoQaConversationContext | null {
  const normalizedSource = sourceIdentityKey?.trim() || null;
  if (!session || !normalizedSource || session.turns.length === 0) return null;
  const previous = session.turns[session.turns.length - 1] ?? null;
  if (
    !previous
    || previous.status !== 'ready'
    || previous.source?.sourceIdentityKey !== normalizedSource
  ) {
    return null;
  }
  return {
    rollingContext: previous.rollingContext
      ? previous.rollingContext.slice(0, CURRENT_VIDEO_QA_ROLLING_CONTEXT_MAX_CHARS)
      : null,
    previousTurn: {
      question: previous.question,
      answer: previous.answer,
      citations: previous.citations.slice(0, 3).map(citation => ({
        timeRangeLabel: citation.timeRangeLabel,
        evidenceText: citation.evidenceText.slice(0, 240),
      })),
    },
  };
}

export function shouldRefuseCurrentVideoQaBeforeNetwork(input: {
  session: CurrentVideoQaSessionRecord | null;
  question: string;
  sourceIdentityKey: string | null;
}): string | null {
  const question = normalizeQuestion(input.question);
  if (!question) return null;
  if (/(多视频|多个视频|两个视频|跨视频|上个视频|上一个视频|之前的视频|前一个视频|另一个视频)/u.test(question)) {
    return '当前版本只能按本次参考视频回答，不能把会话里的其他视频当作完整证据来比较。请把问题改成只问当前视频，或在对应视频里单独提问。';
  }
  const previousReady = [...(input.session?.turns ?? [])].reverse()
    .find(turn => turn.status === 'ready');
  const currentSource = input.sourceIdentityKey?.trim() || null;
  if (
    previousReady
    && currentSource
    && previousReady.source?.sourceIdentityKey
    && previousReady.source.sourceIdentityKey !== currentSource
    && /^(那|那么)?(这个|这段|它|这里|刚才这个)(呢|怎么样|是什么意思|怎么理解)?[？?。!！]*$/u.test(question)
  ) {
    return '这个问题需要补全指代对象。请把要问的内容说完整，Bili-Bill 才能只按本次参考视频回答。';
  }
  return null;
}

export function buildRefusedCurrentVideoQaResult(input: {
  sessionId: string;
  requestId: string;
  turnId: string;
  question: string;
  message: string;
  source: CurrentVideoQaSourceSnapshot | null;
  model: string | null;
  now?: number;
}): CurrentVideoFullTextQaResult {
  const now = input.now ?? Date.now();
  return {
    sessionId: input.sessionId,
    status: 'unsupported',
    requestId: input.requestId,
    turnId: input.turnId,
    question: normalizeQuestion(input.question),
    title: input.source?.title ?? '当前视频',
    partTitle: input.source?.partTitle ?? null,
    sourceLabel: input.source?.sourceLabel ?? null,
    textSize: input.source?.textSize ?? { lineCount: 0, charCount: null, utf8Bytes: 0 },
    answer: input.message,
    answerEvidenceLineNumbers: [],
    citations: [],
    message: input.message,
    limitations: ['本次没有使用其他视频的历史回答补全问题。'],
    ai: {
      status: 'unsupported',
      model: input.model,
      note: input.message,
      errorCode: null,
    },
    sourceReference: input.source ? {
      title: input.source.title,
      partTitle: input.source.partTitle,
      page: input.source.page,
      bvid: input.source.bvid,
      cid: input.source.cid,
      url: input.source.url,
      sourceLabel: input.source.sourceLabel,
      language: input.source.language,
      sourceIdentityKey: input.source.sourceIdentityKey,
      textSize: input.source.textSize,
      capturedAt: input.source.capturedAt,
    } : null,
    rollingContext: null,
    generatedAt: now,
    canRetry: false,
  };
}

function cloneSession(session: CurrentVideoQaSessionRecord): CurrentVideoQaSessionRecord {
  return {
    ...session,
    turns: session.turns.map(turn => ({
      ...turn,
      citations: turn.citations.map(citation => ({ ...citation, binding: { ...citation.binding } })),
      ai: { ...turn.ai },
      source: turn.source ? { ...turn.source, textSize: { ...turn.source.textSize } } : null,
    })),
  };
}

async function withCurrentVideoQaSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const previous = currentVideoQaSessionMutationTail;
  currentVideoQaSessionMutationTail = previous.then(() => gate, () => gate);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function runCurrentVideoQaSessionDeleteCoordinator<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = currentVideoQaSessionDeleteStates.get(sessionId) ?? {
    generation: 0,
    deletingDepth: 0,
  };
  const deleting = {
    generation: previous.generation + 1,
    deletingDepth: previous.deletingDepth + 1,
  };
  currentVideoQaSessionDeleteStates.set(sessionId, deleting);
  try {
    return await withCurrentVideoQaSessionMutation(operation);
  } finally {
    const current = currentVideoQaSessionDeleteStates.get(sessionId) ?? deleting;
    const deletingDepth = Math.max(0, current.deletingDepth - 1);
    currentVideoQaSessionDeleteStates.set(sessionId, {
      generation: deletingDepth === 0 ? current.generation + 1 : current.generation,
      deletingDepth,
    });
    if (deletingDepth === 0) currentVideoQaSessionTurnAttempts.delete(sessionId);
  }
}

function currentVideoQaSessionWriteBaseState(sessionId: string): {
  clearGeneration: number;
  sessionGeneration: number;
  writable: boolean;
} {
  const deleteState = sessionId ? currentVideoQaSessionDeleteStates.get(sessionId) : null;
  return {
    clearGeneration: currentVideoQaSessionClearGeneration,
    sessionGeneration: deleteState?.generation ?? 0,
    writable: currentVideoQaSessionClearingDepth === 0
      && (deleteState?.deletingDepth ?? 0) === 0,
  };
}

function currentVideoQaSessionTurnWriteGuard(
  sessionId: string,
  turnId: string,
  requestId: string,
): CurrentVideoQaSessionWriteGuard | null {
  const current = currentVideoQaSessionTurnAttempts.get(sessionId)?.get(turnId);
  if (!current || current.requestId !== requestId) return null;
  const base = currentVideoQaSessionWriteBaseState(sessionId);
  return {
    sessionId,
    turnId,
    requestId,
    clearGeneration: base.clearGeneration,
    sessionGeneration: base.sessionGeneration,
    turnGeneration: current.generation,
    writable: base.writable,
  };
}

async function readSessionsSorted(): Promise<CurrentVideoQaSessionRecord[]> {
  return (await db.currentVideoQaSessions.toArray())
    .map(cloneSession)
    .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
}

async function commitSessionWithinLimitsInTransaction(
  session: CurrentVideoQaSessionRecord,
  currentSessionId: string,
  canCommit: () => boolean = () => true,
  allowEviction = true,
): Promise<CurrentVideoQaSessionRecord | null> {
  const stored = await db.currentVideoQaSessions.toArray();
  const existing = stored.find(candidate => candidate.sessionId === session.sessionId) ?? null;
  const candidate = cloneSession(session);
  const hasStoredId = existing?.id !== undefined;
  candidate.id = hasStoredId ? existing.id : Number.MAX_SAFE_INTEGER;
  let sessions = [
    ...stored.filter(item => item.sessionId !== candidate.sessionId).map(cloneSession),
    candidate,
  ];
  const removedSessionIds: string[] = [];
  let usageBytes = serializedRowsSize(sessions);
  while (
    allowEviction &&
    (sessions.length > CURRENT_VIDEO_QA_SESSION_MAX_COUNT || usageBytes > CURRENT_VIDEO_QA_SESSION_MAX_BYTES)
    && sessions.some(session => session.sessionId !== currentSessionId)
  ) {
    const removable = [...sessions]
      .filter(session => session.sessionId !== currentSessionId)
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)[0];
    if (!removable) break;
    removedSessionIds.push(removable.sessionId);
    sessions = sessions.filter(item => item.sessionId !== removable.sessionId);
    usageBytes = serializedRowsSize(sessions);
  }
  if (
    sessions.length > CURRENT_VIDEO_QA_SESSION_MAX_COUNT
    || usageBytes > CURRENT_VIDEO_QA_SESSION_MAX_BYTES
  ) return null;

  if (!hasStoredId) delete candidate.id;
  if (!canCommit()) throw new CurrentVideoQaSessionWriteInvalidatedError();
  const id = await db.currentVideoQaSessions.put(candidate);
  candidate.id = Number(id);
  for (const sessionId of removedSessionIds) {
    await db.currentVideoQaSessions.where({ sessionId }).delete();
  }
  return candidate;
}

type CurrentVideoQaSessionRepoTestPhase =
  | 'after_complete_read'
  | 'after_sessions_view_initial_read';

async function currentVideoQaSessionRepoTestHook(
  phase: CurrentVideoQaSessionRepoTestPhase,
): Promise<void> {
  const hook = (globalThis as typeof globalThis & {
    __biliBillCurrentVideoQaSessionRepoTestHook__?: (
      phase: CurrentVideoQaSessionRepoTestPhase,
    ) => void | Promise<void>;
  }).__biliBillCurrentVideoQaSessionRepoTestHook__;
  if (!hook) return;
  const pending = Promise.resolve(hook(phase));
  if (phase === 'after_complete_read') await Dexie.waitFor(pending);
  else await pending;
}

function matchingPriorRollingContext(
  priorTurn: CurrentVideoQaSessionTurn | null,
  source: CurrentVideoQaSourceSnapshot | null,
): string | null {
  if (
    !priorTurn
    || priorTurn.status !== 'ready'
    || !source?.sourceIdentityKey
    || priorTurn.source?.sourceIdentityKey !== source.sourceIdentityKey
  ) return null;
  return normalizeRollingContext(priorTurn.rollingContext);
}

function matchingRollingContextForSource(
  turn: CurrentVideoQaSessionTurn,
  source: CurrentVideoQaSourceSnapshot | null,
): string | null {
  if (
    !source?.sourceIdentityKey
    || turn.source?.sourceIdentityKey !== source.sourceIdentityKey
  ) return null;
  return normalizeRollingContext(turn.rollingContext);
}

function toSummary(session: CurrentVideoQaSessionRecord): CurrentVideoQaSessionSummary {
  return {
    sessionId: session.sessionId,
    title: session.title,
    turnCount: session.turns.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastAccessedAt: session.lastAccessedAt,
  };
}

function normalizeSourceSnapshot(
  source: CurrentVideoFullTextQaResult['sourceReference'] | undefined | null,
): CurrentVideoQaSourceSnapshot | null {
  if (!source) return null;
  return {
    title: source.title?.trim() || '当前视频',
    partTitle: source.partTitle?.trim() || null,
    page: Number.isInteger(source.page) ? source.page : null,
    bvid: source.bvid?.trim() || null,
    cid: Number.isInteger(source.cid) ? source.cid : null,
    url: source.url?.trim() || null,
    sourceLabel: source.sourceLabel ?? null,
    language: source.language?.trim() || null,
    sourceIdentityKey: source.sourceIdentityKey?.trim() || null,
    textSize: source.textSize,
    capturedAt: normalizeTimestamp(source.capturedAt) ?? Date.now(),
  };
}

function normalizeRollingContext(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, CURRENT_VIDEO_QA_ROLLING_CONTEXT_MAX_CHARS);
}

function deterministicSessionTitle(question: string, createdAt: number): string {
  return `${truncateTitle(question || '新问答会话', 24)} · ${formatSessionDate(createdAt)}`;
}

function truncateTitle(value: string, maxLength: number): string {
  const normalized = normalizeTitle(value) || '新问答会话';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function normalizeQuestion(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function normalizeRequired(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`MISSING_${name.toUpperCase()}`);
  return normalized;
}

function formatSessionDate(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}/${month}/${day}`;
}

function serializedRowsSize(rows: unknown[]): number {
  return rows.reduce<number>((sum, row) => sum + serializedSize(row), 0);
}

function serializedSize(value: unknown): number {
  const text = JSON.stringify(value ?? null);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
  return text.length;
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
