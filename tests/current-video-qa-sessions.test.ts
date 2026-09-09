import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/background/storage/db.ts';
import {
  buildCurrentVideoQaConversationContext,
  clearCurrentVideoQaSessions,
  collectCurrentVideoQaSessionUsage,
  completeCurrentVideoQaTurn,
  deleteCurrentVideoQaSession,
  getPersistedCurrentVideoQaCitation,
  getCurrentVideoQaSessionsView,
  isCurrentVideoQaSessionStorageLimitError,
  isCurrentVideoQaSessionWriteInvalidatedError,
  registerCurrentVideoQaSessionTurnWriteGuard,
  readCurrentVideoQaSessionsAfterClear,
  shouldRefuseCurrentVideoQaBeforeNetwork,
  upsertCurrentVideoQaPendingTurn,
} from '../src/background/storage/current-video-qa-session-repo.ts';
import type { CurrentVideoFullTextQaResult } from '../src/shared/types/current-video-full-text-qa.ts';
import {
  CURRENT_VIDEO_QA_SESSION_MAX_BYTES,
  type CurrentVideoQaSourceSnapshot,
} from '../src/shared/types/current-video-qa-session.ts';

test.beforeEach(async () => {
  db.close();
  await db.delete();
  await db.open();
});

test.afterEach(async () => {
  clearSessionRepoTestHook();
  db.close();
  await db.delete();
});

test('current-video QA sessions are created on first turn and save validated result without full text', async () => {
  await upsertCurrentVideoQaPendingTurn({
    sessionId: 'session-a',
    turnId: 'turn-a',
    requestId: 'request-a',
    question: '这个视频讲了什么？',
    source: source('source-a'),
    now: 1000,
  });
  assert.equal((await db.currentVideoQaSessions.count()), 1);
  let view = await getCurrentVideoQaSessionsView('session-a');
  assert.equal(view.activeSession?.turns[0]?.status, 'pending');
  assert.match(view.activeSession?.title ?? '', /^这个视频讲了什么/);

  await completeCurrentVideoQaTurn('session-a', 'turn-a', readyResult({
    sessionId: 'session-a',
    requestId: 'request-a',
    turnId: 'turn-a',
    sourceKey: 'source-a',
  }), 2000);

  view = await getCurrentVideoQaSessionsView('session-a');
  const turn = view.activeSession?.turns[0];
  assert.equal(turn?.status, 'ready');
  assert.equal(turn?.answer, '这是基于当前视频文本的回答。');
  assert.equal(turn?.rollingContext, '用户问了视频主旨，回答了核心方法。');
  assert.doesNotMatch(JSON.stringify(view.activeSession), /完整视频正文|sourceHash|segmentId|subtitle_url/i);
});

test('unverified answers survive readback but are not citation or conversation evidence', async () => {
  await upsertCurrentVideoQaPendingTurn({sessionId:'unverified',turnId:'turn',requestId:'request',question:'如何交付？',source:source('source-a')});
  const result = readyResult({sessionId:'unverified',turnId:'turn',requestId:'request',sourceKey:'source-a'});
  result.status='invalid_output'; result.answer='保留模型的完整回答'; result.citations=[]; result.answerEvidenceLineNumbers=[]; result.rollingContext=null;
  await completeCurrentVideoQaTurn('unverified','turn',result);
  db.close(); await db.open();
  const view = await getCurrentVideoQaSessionsView('unverified');
  assert.equal(view.activeSession?.turns[0]?.answer,'保留模型的完整回答');
  assert.equal(view.activeSession?.turns[0]?.status,'invalid_output');
  assert.deepEqual(view.activeSession?.turns[0]?.citations,[]);
});

test('retry uses same turn id with a new request id and drops late old completion', async () => {
  await upsertCurrentVideoQaPendingTurn({
    sessionId: 'session-retry',
    turnId: 'turn-1',
    requestId: 'request-old',
    question: '先回答一次',
    source: source('source-r'),
  });
  await upsertCurrentVideoQaPendingTurn({
    sessionId: 'session-retry',
    turnId: 'turn-1',
    requestId: 'request-new',
    question: '先回答一次',
    source: source('source-r'),
  });

  const late = await completeCurrentVideoQaTurn('session-retry', 'turn-1', readyResult({
    sessionId: 'session-retry',
    requestId: 'request-old',
    turnId: 'turn-1',
    sourceKey: 'source-r',
  }));
  assert.equal(late, null);

  await completeCurrentVideoQaTurn('session-retry', 'turn-1', readyResult({
    sessionId: 'session-retry',
    requestId: 'request-new',
    turnId: 'turn-1',
    sourceKey: 'source-r',
  }));
  const turn = (await getCurrentVideoQaSessionsView('session-retry')).activeSession?.turns[0];
  assert.equal(turn?.requestId, 'request-new');
  assert.equal(turn?.status, 'ready');
});

test('retry with a different text identity drops the previous rolling context', async () => {
  const sessionId = 'session-retry-new-source';
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-old',
    question: '原来的问题',
    source: source('source-old'),
  });
  await completeCurrentVideoQaTurn(sessionId, 'turn-1', readyResult({
    sessionId,
    requestId: 'request-old',
    turnId: 'turn-1',
    sourceKey: 'source-old',
  }));

  const pending = await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-new',
    question: '原来的问题',
    source: source('source-new'),
  });
  assert.equal(pending.turns[0]?.rollingContext, null);

  const next = readyResult({
    sessionId,
    requestId: 'request-new',
    turnId: 'turn-1',
    sourceKey: 'source-new',
  });
  next.rollingContext = null;
  await completeCurrentVideoQaTurn(sessionId, 'turn-1', next);
  const completed = (await getCurrentVideoQaSessionsView(sessionId)).activeSession;
  assert.equal(completed?.turns[0]?.rollingContext, null);
  assert.equal(buildCurrentVideoQaConversationContext(completed, 'source-old'), null);
  assert.equal(buildCurrentVideoQaConversationContext(completed, 'source-new')?.rollingContext, null);
});

test('completion and delete serialize so a late result cannot recreate the deleted session', async () => {
  const sessionId = 'session-delete-race';
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-1',
    question: '删除竞态',
    source: source('source-1'),
  });
  let releaseCompletion!: () => void;
  let markCompletionRead!: () => void;
  const completionRead = new Promise<void>(resolve => { markCompletionRead = resolve; });
  const completionRelease = new Promise<void>(resolve => { releaseCompletion = resolve; });
  installSessionRepoTestHook(async phase => {
    if (phase !== 'after_complete_read') return;
    markCompletionRead();
    await completionRelease;
  });

  try {
    const completion = completeCurrentVideoQaTurn(sessionId, 'turn-1', readyResult({
      sessionId,
      requestId: 'request-1',
      turnId: 'turn-1',
      sourceKey: 'source-1',
    }));
    await completionRead;
    const deletion = deleteCurrentVideoQaSession(sessionId);
    releaseCompletion();
    await completion;
    await deletion;
    assert.equal(await db.currentVideoQaSessions.where({ sessionId }).count(), 0);
  } finally {
    clearSessionRepoTestHook();
  }
});

test('clear invalidates a request captured before its first session write', async () => {
  const sessionId = 'session-clear-before-first-write';
  const writeGuard = registerCurrentVideoQaSessionTurnWriteGuard({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-1',
  });

  await clearCurrentVideoQaSessions();

  await assert.rejects(
    upsertCurrentVideoQaPendingTurn({
      sessionId,
      turnId: 'turn-1',
      requestId: 'request-1',
      question: '清理前已开始的问题',
      source: source('source-1'),
      writeGuard,
    }),
    isCurrentVideoQaSessionWriteInvalidatedError,
  );
  assert.equal(await db.currentVideoQaSessions.where({ sessionId }).count(), 0);
});

test('clear invalidates a captured completion and leaves the session table empty', async () => {
  const sessionId = 'session-clear-before-completion';
  const writeGuard = registerCurrentVideoQaSessionTurnWriteGuard({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-1',
  });
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-1',
    question: '等待清理的回答',
    source: source('source-1'),
    writeGuard,
  });

  await clearCurrentVideoQaSessions();
  const completed = await completeCurrentVideoQaTurn(
    sessionId,
    'turn-1',
    readyResult({
      sessionId,
      requestId: 'request-1',
      turnId: 'turn-1',
      sourceKey: 'source-1',
    }),
    Date.now(),
    writeGuard,
  );

  assert.equal(completed, null);
  assert.equal(await db.currentVideoQaSessions.count(), 0);
});

test('delete invalidates an earlier request before it can recreate that session', async () => {
  const sessionId = 'session-delete-before-first-write';
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'existing-turn',
    requestId: 'existing-request',
    question: '已有问题',
    source: source('source-1'),
  });
  const writeGuard = registerCurrentVideoQaSessionTurnWriteGuard({
    sessionId,
    turnId: 'late-turn',
    requestId: 'late-request',
  });

  await deleteCurrentVideoQaSession(sessionId);

  await assert.rejects(
    upsertCurrentVideoQaPendingTurn({
      sessionId,
      turnId: 'late-turn',
      requestId: 'late-request',
      question: '删除前已开始的问题',
      source: source('source-1'),
      writeGuard,
    }),
    isCurrentVideoQaSessionWriteInvalidatedError,
  );
  assert.equal(await db.currentVideoQaSessions.where({ sessionId }).count(), 0);
});

test('session view does not retain an active snapshot deleted during refresh', async () => {
  const sessionId = 'session-view-delete-race';
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-1',
    question: '读取期间删除',
    source: source('source-1'),
  });
  let releaseView!: () => void;
  let markInitialRead!: () => void;
  let held = false;
  const initialRead = new Promise<void>(resolve => { markInitialRead = resolve; });
  const viewRelease = new Promise<void>(resolve => { releaseView = resolve; });
  installSessionRepoTestHook(async phase => {
    if (phase !== 'after_sessions_view_initial_read' || held) return;
    held = true;
    markInitialRead();
    await viewRelease;
  });

  try {
    const viewing = getCurrentVideoQaSessionsView(sessionId);
    await initialRead;
    await deleteCurrentVideoQaSession(sessionId);
    releaseView();
    const view = await viewing;
    assert.deepEqual(view.sessions, []);
    assert.equal(view.activeSession, null);
    assert.equal(view.activeSessionId, null);
  } finally {
    releaseView();
    clearSessionRepoTestHook();
  }
});

test('session view falls back to the latest remaining session when the selected session is deleted during refresh', async () => {
  const remainingSessionId = 'session-view-delete-race-remaining';
  const deletedSessionId = 'session-view-delete-race-selected';
  await upsertCurrentVideoQaPendingTurn({
    sessionId: remainingSessionId,
    turnId: 'remaining-turn',
    requestId: 'remaining-request',
    question: '删除后保留的会话',
    source: source('source-1'),
    now: 1_000,
  });
  await upsertCurrentVideoQaPendingTurn({
    sessionId: deletedSessionId,
    turnId: 'selected-turn',
    requestId: 'selected-request',
    question: '读取期间删除的选中会话',
    source: source('source-1'),
    now: 2_000,
  });
  let releaseView!: () => void;
  let markInitialRead!: () => void;
  let held = false;
  const initialRead = new Promise<void>(resolve => { markInitialRead = resolve; });
  const viewRelease = new Promise<void>(resolve => { releaseView = resolve; });
  installSessionRepoTestHook(async phase => {
    if (phase !== 'after_sessions_view_initial_read' || held) return;
    held = true;
    markInitialRead();
    await viewRelease;
  });

  try {
    const viewing = getCurrentVideoQaSessionsView(deletedSessionId);
    await initialRead;
    await deleteCurrentVideoQaSession(deletedSessionId);
    releaseView();
    const view = await viewing;
    assert.deepEqual(view.sessions.map(session => session.sessionId), [remainingSessionId]);
    assert.equal(view.activeSession?.sessionId, remainingSessionId);
    assert.equal(view.activeSessionId, remainingSessionId);
  } finally {
    releaseView();
    clearSessionRepoTestHook();
  }
});

test('completion and retry serialize so the old result cannot overwrite the new request', async () => {
  const sessionId = 'session-retry-race';
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-old',
    question: '重试竞态',
    source: source('source-1'),
  });
  let releaseCompletion!: () => void;
  let markCompletionRead!: () => void;
  const completionRead = new Promise<void>(resolve => { markCompletionRead = resolve; });
  const completionRelease = new Promise<void>(resolve => { releaseCompletion = resolve; });
  installSessionRepoTestHook(async phase => {
    if (phase !== 'after_complete_read') return;
    markCompletionRead();
    await completionRelease;
  });

  try {
    const completion = completeCurrentVideoQaTurn(sessionId, 'turn-1', readyResult({
      sessionId,
      requestId: 'request-old',
      turnId: 'turn-1',
      sourceKey: 'source-1',
    }));
    await completionRead;
    const retry = upsertCurrentVideoQaPendingTurn({
      sessionId,
      turnId: 'turn-1',
      requestId: 'request-new',
      question: '重试竞态',
      source: source('source-1'),
    });
    releaseCompletion();
    await completion;
    await retry;
    const turn = (await getCurrentVideoQaSessionsView(sessionId)).activeSession?.turns[0];
    assert.equal(turn?.requestId, 'request-new');
    assert.equal(turn?.status, 'pending');
  } finally {
    clearSessionRepoTestHook();
  }
});

test('conversation context only includes immediate previous ready turn from the same source', async () => {
  await upsertCurrentVideoQaPendingTurn({
    sessionId: 'session-context',
    turnId: 'turn-1',
    requestId: 'request-1',
    question: '第一问',
    source: source('source-1'),
  });
  await completeCurrentVideoQaTurn('session-context', 'turn-1', readyResult({
    sessionId: 'session-context',
    requestId: 'request-1',
    turnId: 'turn-1',
    sourceKey: 'source-1',
  }));

  const session = (await getCurrentVideoQaSessionsView('session-context')).activeSession;
  const context = buildCurrentVideoQaConversationContext(session, 'source-1');
  assert.equal(context?.rollingContext, '用户问了视频主旨，回答了核心方法。');
  assert.equal(context?.previousTurn.citations.length, 1);
  assert.equal(buildCurrentVideoQaConversationContext(session, 'source-2'), null);

  await upsertCurrentVideoQaPendingTurn({
    sessionId: 'session-context',
    turnId: 'turn-2',
    requestId: 'request-2',
    question: '第二问',
    source: source('source-1'),
  });
  const withPendingTail = (await getCurrentVideoQaSessionsView('session-context')).activeSession;
  assert.equal(buildCurrentVideoQaConversationContext(withPendingTail, 'source-1'), null);
});

test('same-source previous answer is sent even when the model omitted rolling context', async () => {
  await upsertCurrentVideoQaPendingTurn({
    sessionId: 'session-context-without-rollup',
    turnId: 'turn-1',
    requestId: 'request-1',
    question: '第一问',
    source: source('source-1'),
  });
  const first = readyResult({
    sessionId: 'session-context-without-rollup',
    requestId: 'request-1',
    turnId: 'turn-1',
    sourceKey: 'source-1',
  });
  first.rollingContext = null;
  await completeCurrentVideoQaTurn('session-context-without-rollup', 'turn-1', first);

  const session = (await getCurrentVideoQaSessionsView('session-context-without-rollup')).activeSession;
  const context = buildCurrentVideoQaConversationContext(session, 'source-1');
  assert.equal(context?.rollingContext, null);
  assert.equal(context?.previousTurn.answer, '这是基于当前视频文本的回答。');
});

test('missing next rolling context preserves the previous same-source context', async () => {
  const sessionId = 'session-context-carry';
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-1',
    question: '第一问',
    source: source('source-1'),
  });
  await completeCurrentVideoQaTurn(sessionId, 'turn-1', readyResult({
    sessionId,
    requestId: 'request-1',
    turnId: 'turn-1',
    sourceKey: 'source-1',
  }));
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-2',
    requestId: 'request-2',
    question: '第二问',
    source: source('source-1'),
  });
  const second = readyResult({
    sessionId,
    requestId: 'request-2',
    turnId: 'turn-2',
    sourceKey: 'source-1',
  });
  second.rollingContext = null;
  await completeCurrentVideoQaTurn(sessionId, 'turn-2', second);

  const turns = (await getCurrentVideoQaSessionsView(sessionId)).activeSession?.turns ?? [];
  assert.equal(turns[1]?.rollingContext, '用户问了视频主旨，回答了核心方法。');
});

test('persisted citations remain resolvable after the in-memory request registry is unavailable', async () => {
  const sessionId = 'session-persisted-citation';
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-1',
    question: '引用在哪里？',
    source: source('source-1'),
  });
  await completeCurrentVideoQaTurn(sessionId, 'turn-1', readyResult({
    sessionId,
    requestId: 'request-1',
    turnId: 'turn-1',
    sourceKey: 'source-1',
  }));

  const record = await getPersistedCurrentVideoQaCitation({
    sessionId,
    requestId: 'request-1',
    turnId: 'turn-1',
    citationId: 'citation-1',
    sourceIdentityKey: 'source-1',
  });
  assert.equal(record?.citation.evidenceText, '第一行说明问题背景。 第二行给出核心方法。');
  assert.equal(record?.bvid, 'BVQA');
});

test('delete and clear prevent late completion and expose count/readback hooks', async () => {
  await upsertCurrentVideoQaPendingTurn({
    sessionId: 'session-delete',
    turnId: 'turn-delete',
    requestId: 'request-delete',
    question: '删除测试',
    source: source('source-delete'),
  });
  const usageBefore = await collectCurrentVideoQaSessionUsage();
  assert.equal(usageBefore.count, 1);

  await deleteCurrentVideoQaSession('session-delete');
  const late = await completeCurrentVideoQaTurn('session-delete', 'turn-delete', readyResult({
    sessionId: 'session-delete',
    requestId: 'request-delete',
    turnId: 'turn-delete',
    sourceKey: 'source-delete',
  }));
  assert.equal(late, null);
  assert.equal((await collectCurrentVideoQaSessionUsage()).count, 0);

  await upsertCurrentVideoQaPendingTurn({
    sessionId: 'session-clear',
    turnId: 'turn-clear',
    requestId: 'request-clear',
    question: '清理测试',
    source: source('source-clear'),
  });
  assert.equal(await clearCurrentVideoQaSessions(), 1);
  assert.deepEqual(await readCurrentVideoQaSessionsAfterClear(), {
    count: 0,
    usageBytes: 0,
    latestUsedAt: null,
    empty: true,
  });
});

test('oldest non-current session is cleaned when count limit is exceeded', async () => {
  for (let index = 0; index < 201; index += 1) {
    await upsertCurrentVideoQaPendingTurn({
      sessionId: `session-${index}`,
      turnId: `turn-${index}`,
      requestId: `request-${index}`,
      question: `问题 ${index}`,
      source: source(`source-${index}`),
      now: 1000 + index,
    });
  }
  const view = await getCurrentVideoQaSessionsView('session-200');
  assert.equal(view.usage.count, 200);
  assert.equal(Boolean(await db.currentVideoQaSessions.where({ sessionId: 'session-0' }).first()), false);
  assert.equal(Boolean(await db.currentVideoQaSessions.where({ sessionId: 'session-200' }).first()), true);
});

test('oldest non-current session is cleaned when serialized bytes exceed the limit', async () => {
  const largeAnswer = 'a'.repeat(9 * 1024 * 1024);
  for (let index = 0; index < 3; index += 1) {
    const sessionId = `session-bytes-${index}`;
    const requestId = `request-bytes-${index}`;
    const turnId = `turn-bytes-${index}`;
    await upsertCurrentVideoQaPendingTurn({
      sessionId,
      turnId,
      requestId,
      question: `容量问题 ${index}`,
      source: source(`source-${index}`),
      now: 1000 + index,
    });
    const result = readyResult({ sessionId, requestId, turnId, sourceKey: `source-${index}` });
    result.answer = largeAnswer;
    await completeCurrentVideoQaTurn(sessionId, turnId, result, 2000 + index);
  }

  const usage = await collectCurrentVideoQaSessionUsage();
  assert.equal(usage.count, 2);
  assert.ok(usage.usageBytes <= CURRENT_VIDEO_QA_SESSION_MAX_BYTES);
  assert.equal(Boolean(await db.currentVideoQaSessions.where({ sessionId: 'session-bytes-0' }).first()), false);
  assert.equal(Boolean(await db.currentVideoQaSessions.where({ sessionId: 'session-bytes-2' }).first()), true);
});

test('a single current session cannot grow past the serialized byte limit', async () => {
  const sessionId = 'session-current-byte-limit';
  await upsertCurrentVideoQaPendingTurn({
    sessionId,
    turnId: 'turn-1',
    requestId: 'request-1',
    question: '容量上限',
    source: source('source-1'),
  });
  const oversized = readyResult({
    sessionId,
    requestId: 'request-1',
    turnId: 'turn-1',
    sourceKey: 'source-1',
  });
  oversized.answer = 'a'.repeat(CURRENT_VIDEO_QA_SESSION_MAX_BYTES);
  oversized.citations = [];
  oversized.rollingContext = null;

  await assert.rejects(
    () => completeCurrentVideoQaTurn(sessionId, 'turn-1', oversized),
    error => isCurrentVideoQaSessionStorageLimitError(error),
  );
  const view = await getCurrentVideoQaSessionsView(sessionId);
  assert.ok(view.usage.usageBytes <= CURRENT_VIDEO_QA_SESSION_MAX_BYTES);
  assert.equal(view.activeSession?.turns[0]?.status, 'error');
  assert.match(view.activeSession?.turns[0]?.message ?? '', /空间已满/);
  assert.equal(view.activeSession?.turns[0]?.answer, '');
});

test('cross-video vague follow-up and comparison questions are naturally refused before network', () => {
  const session = {
    sessionId: 'session-refuse',
    title: '拒答测试',
    customTitle: null,
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    turns: [{
      turnId: 'turn-1',
      requestId: 'request-1',
      question: '这个视频讲了什么？',
      status: 'ready' as const,
      answer: '旧回答',
      message: '已回答',
      citations: [],
      canRetry: true,
      ai: { status: 'generated' as const, model: 'model', note: '', errorCode: null },
      source: source('source-old'),
      rollingContext: '旧脉络',
      createdAt: 1,
      updatedAt: 1,
      submittedAt: 1,
      generatedAt: 1,
    }],
  };
  assert.match(
    shouldRefuseCurrentVideoQaBeforeNetwork({ session, question: '那这个呢？', sourceIdentityKey: 'source-new' }) ?? '',
    /补全指代对象/,
  );
  assert.match(
    shouldRefuseCurrentVideoQaBeforeNetwork({ session, question: '和上一个视频比较一下', sourceIdentityKey: 'source-old' }) ?? '',
    /只能按本次参考视频回答/,
  );
  assert.equal(
    shouldRefuseCurrentVideoQaBeforeNetwork({ session, question: '作者比较了哪两种方法？', sourceIdentityKey: 'source-old' }),
    null,
  );
});

function source(sourceIdentityKey: string): CurrentVideoQaSourceSnapshot {
  return {
    title: '测试视频',
    partTitle: 'P1',
    page: 1,
    bvid: 'BVQA',
    cid: 101,
    url: 'https://www.bilibili.com/video/BVQA?p=1',
    sourceLabel: 'B站字幕',
    language: 'zh-CN',
    sourceIdentityKey,
    textSize: { lineCount: 3, charCount: 24, utf8Bytes: 72 },
    capturedAt: 1000,
  };
}

function readyResult(input: {
  sessionId: string;
  requestId: string;
  turnId: string;
  sourceKey: string;
}): CurrentVideoFullTextQaResult {
  const sourceSnapshot = source(input.sourceKey);
  return {
    sessionId: input.sessionId,
    status: 'ready',
    requestId: input.requestId,
    turnId: input.turnId,
    question: '这个视频讲了什么？',
    title: sourceSnapshot.title,
    partTitle: sourceSnapshot.partTitle,
    sourceLabel: sourceSnapshot.sourceLabel,
    textSize: sourceSnapshot.textSize,
    answer: '这是基于当前视频文本的回答。',
    answerEvidenceLineNumbers: [1, 2],
    citations: [{
      id: 'citation-1',
      evidenceLineNumbers: [1, 2],
      evidenceText: '第一行说明问题背景。 第二行给出核心方法。',
      sourceText: '第一行说明问题背景。 第二行给出核心方法。',
      startSeconds: 0,
      endSeconds: 12,
      timeRangeLabel: '0:00-0:12',
      sourceLabel: 'B站字幕',
      binding: {
        sessionId: input.sessionId,
        requestId: input.requestId,
        turnId: input.turnId,
        citationId: 'citation-1',
      },
    }],
    message: '回答已基于当前分 P 的完整主要文本生成。',
    limitations: [],
    ai: { status: 'generated', model: 'test-model', note: '', errorCode: null },
    sourceReference: sourceSnapshot,
    rollingContext: '用户问了视频主旨，回答了核心方法。',
    generatedAt: 2000,
    canRetry: true,
  };
}

type SessionRepoTestPhase =
  | 'after_complete_read'
  | 'after_sessions_view_initial_read';

function installSessionRepoTestHook(
  hook: (phase: SessionRepoTestPhase) => void | Promise<void>,
): void {
  (globalThis as typeof globalThis & {
    __biliBillCurrentVideoQaSessionRepoTestHook__?: (
      phase: SessionRepoTestPhase,
    ) => void | Promise<void>;
  }).__biliBillCurrentVideoQaSessionRepoTestHook__ = hook;
}

function clearSessionRepoTestHook(): void {
  delete (globalThis as typeof globalThis & {
    __biliBillCurrentVideoQaSessionRepoTestHook__?: (
      phase: SessionRepoTestPhase,
    ) => void | Promise<void>;
  }).__biliBillCurrentVideoQaSessionRepoTestHook__;
}
