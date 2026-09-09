import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditAssistantPayload,
  currentVideoFullTextQaPayloadContract,
} from '../src/shared/assistant-payload-audit.ts';
import {
  buildCurrentVideoFullTextRequestEnvelope,
} from '../src/shared/current-video-primary-text.ts';
import {
  buildCurrentVideoFullTextQaAiPayload,
  requestCurrentVideoFullTextQaAi,
  validateCurrentVideoFullTextQaAiOutput,
} from '../src/shared/current-video-full-text-qa.ts';
import type { AiConfig } from '../src/shared/types/config.ts';
import type { UserConfig } from '../src/shared/types/config.ts';
import type { CurrentVideoContext } from '../src/shared/types/current-video-context.ts';
import type { CurrentVideoTranscriptSegment } from '../src/shared/types/current-video-transcript.ts';
import {
  bindCurrentVideoFullTextQaPreflightPart,
  cancelCurrentVideoFullTextQaForSource,
  cancelCurrentVideoFullTextQaForSession,
  cancelCurrentVideoFullTextQaRequest,
  generateCurrentVideoFullTextQa,
  getCurrentVideoFullTextQaCitation,
  invalidateCurrentVideoFullTextQaConfig,
  invalidateCurrentVideoFullTextQaPart,
  registerCurrentVideoFullTextQaPreflightRequest,
  settleCurrentVideoFullTextQaPreflightRequest,
} from '../src/background/current-video-full-text-qa.ts';

test('full-text QA payload contains every captured line and excludes unrelated metadata', () => {
  const envelope = fullTextEnvelope();
  const payload = buildCurrentVideoFullTextQaAiPayload(envelope, '作者怎样解释这个方法？');
  const audit = auditAssistantPayload(payload, currentVideoFullTextQaPayloadContract);
  const raw = JSON.stringify(payload);

  assert.equal(payload.intent, 'current_video_full_text_qa_v1');
  assert.equal(payload.request.requestId, 'qa-request-1');
  assert.equal(payload.request.turnId, 'qa-turn-1');
  assert.equal(payload.textLines.length, envelope.text.lines.length);
  assert.deepEqual(payload.textLines, envelope.text.lines);
  assert.ok(raw.indexOf('"textLines"') < raw.indexOf('"request"'));
  assert.ok(raw.indexOf('"textLines"') < raw.indexOf('"question"'));
  assert.equal(audit.passed, true, JSON.stringify(audit.violations));
  assert.doesNotMatch(raw, /title|description|watchHistory|favoriteItems|followingList|feedbackRecords|Cookie|Key\.txt|sourceHash|segmentId|subtitle_url/i);
});

test('full-text QA payload carries session id and only the bounded rolling context', () => {
  const envelope = fullTextEnvelope({ sessionId: 'session-payload' });
  const payload = buildCurrentVideoFullTextQaAiPayload(envelope, '继续解释一下', {
    rollingContext: '上一轮问了视频主旨，回答聚焦方法边界。',
    previousTurn: {
      question: '这个视频讲了什么？',
      answer: '视频讲了如何界定工具能力。',
      citations: [{ timeRangeLabel: '0:00-0:12', evidenceText: '第一行说明问题背景。' }],
    },
  });
  const audit = auditAssistantPayload(payload, currentVideoFullTextQaPayloadContract);
  const raw = JSON.stringify(payload);

  assert.equal(payload.request.sessionId, 'session-payload');
  assert.equal(payload.conversationContext?.rollingContext, '上一轮问了视频主旨，回答聚焦方法边界。');
  assert.equal(payload.conversationContext?.previousTurn.question, '这个视频讲了什么？');
  assert.equal(audit.passed, true, JSON.stringify(audit.violations));
  assert.doesNotMatch(raw, /sourceHash|segmentId|subtitle_url|Cookie|Key\.txt/i);
});

test('validated answer is returned before one to three citations derived from captured lines', () => {
  const result = validateCurrentVideoFullTextQaAiOutput({
    supported: true,
    answerPoints: [
      { text: '作者先界定问题，再给出核心方法。', evidenceLineNumbers: [1, 2] },
      { text: '随后通过例子说明这套方法的适用边界。', evidenceLineNumbers: [3, 4] },
    ],
    citations: [
      { evidenceLineNumbers: [1, 2] },
      { evidenceLineNumbers: [3, 4] },
    ],
  }, fullTextEnvelope());

  assert.equal(result.ok, true);
  if (!result.ok || result.kind !== 'answered') return;
  assert.match(result.answer, /^作者先界定问题/);
  assert.equal(result.answerPoints.length, 2);
  assert.deepEqual(result.answerPoints[1]?.evidenceLineNumbers, [3, 4]);
  assert.deepEqual(result.answerEvidenceLineNumbers, [1, 2, 3, 4]);
  assert.equal(result.citations.length, 2);
  assert.deepEqual(result.citations[0]?.evidenceLineNumbers, [1, 2]);
  assert.equal(result.citations[0]?.evidenceText, '第一行说明问题背景。 第二行给出核心方法。');
  assert.equal(result.citations[0]?.startSeconds, 0);
  assert.equal(result.citations[0]?.endSeconds, 12);
  assert.equal(result.citations[0]?.timeRangeLabel, '0:00-0:12');
});

test('rolling context is accepted only when compact and never rejects an otherwise valid answer', () => {
  const envelope = fullTextEnvelope();
  const valid = validateCurrentVideoFullTextQaAiOutput({
    supported: true,
    answerPoints: [{ text: '回答来自当前视频文本。', evidenceLineNumbers: [1] }],
    citations: [{ evidenceLineNumbers: [1] }],
    rollingContext: '这一轮回答了工具能力边界。',
  }, envelope);
  assert.equal(valid.ok, true);
  if (valid.ok && valid.kind === 'answered') {
    assert.equal(valid.rollingContext, '这一轮回答了工具能力边界。');
  }

  const oversized = validateCurrentVideoFullTextQaAiOutput({
    supported: true,
    answerPoints: [{ text: '回答来自当前视频文本。', evidenceLineNumbers: [1] }],
    citations: [{ evidenceLineNumbers: [1] }],
    rollingContext: '很长'.repeat(1200),
  }, envelope);
  assert.equal(oversized.ok, true);
  if (oversized.ok && oversized.kind === 'answered') {
    assert.equal(oversized.rollingContext, null);
  }
});

test('unsupported output becomes a fixed refusal with no citations', () => {
  const result = validateCurrentVideoFullTextQaAiOutput({
    supported: false,
    citations: [],
  }, fullTextEnvelope());

  assert.deepEqual(result, {
    ok: true,
    kind: 'unsupported',
    answer: '当前视频文本没有足够内容回答这个问题。',
    answerEvidenceLineNumbers: [],
    citations: [],
  });
});

test('invalid, missing, or non-contiguous evidence rejects the whole answer', () => {
  const envelope = fullTextEnvelope();
  const base = {
    supported: true,
    answerPoints: [{ text: '这个回答有当前视频文本支持。', evidenceLineNumbers: [1] }],
    citations: [{ evidenceLineNumbers: [1] }],
  };

  assert.deepEqual(
    validateCurrentVideoFullTextQaAiOutput({
      ...base,
      answerPoints: [{ text: '这个回答有当前视频文本支持。', evidenceLineNumbers: [99] }],
    }, envelope),
    { ok: false, reason: 'answer_point_evidence_line_missing' },
  );
  assert.deepEqual(
    validateCurrentVideoFullTextQaAiOutput({ ...base, citations: [{ evidenceLineNumbers: [1, 3] }] }, envelope),
    { ok: false, reason: 'citation_lines_not_contiguous' },
  );
  assert.deepEqual(
    validateCurrentVideoFullTextQaAiOutput({ ...base, citations: [] }, envelope),
    { ok: false, reason: 'citation_count' },
  );
  assert.deepEqual(
    validateCurrentVideoFullTextQaAiOutput({
      ...base,
      answerPoints: [{ text: '这个回答有当前视频文本支持。', evidenceLineNumbers: [1, 2] }],
      citations: [{ evidenceLineNumbers: [1] }],
    }, envelope),
    { ok: false, reason: 'answer_point_evidence_not_cited' },
  );
});

test('runtime completeness audit blocks a missing full-text line before chat', async () => {
  const envelope = fullTextEnvelope();
  const payload = buildCurrentVideoFullTextQaAiPayload(envelope, '这个视频说了什么？');
  payload.textLines.pop();
  let chatCalls = 0;

  await assert.rejects(
    requestCurrentVideoFullTextQaAi(defaultAiConfig(), payload, envelope, async () => {
      chatCalls += 1;
      return { supported: false, citations: [] };
    }),
    /完整文本问答请求未包含本次捕获的全部正文/,
  );
  assert.equal(chatCalls, 0);
});

test('background generation sends all lines and registers exact citation bindings only after validation', async () => {
  const context = videoContext();
  const segments = transcriptSegments();
  let sentLineCount = 0;
  const result = await generateCurrentVideoFullTextQa(context, {
    requestId: 'background-request-1',
    turnId: 'background-turn-1',
    question: '作者提出了什么方法？',
    config: userConfig(),
    transcriptSegments: segments,
    chat: async (_config, messages) => {
      const payload = JSON.parse(messages[1]!.content) as { textLines: unknown[] };
      sentLineCount = payload.textLines.length;
      return {
        supported: true,
        answerPoints: [{
          text: '作者先界定问题，再给出方法和适用边界。',
          evidenceLineNumbers: [1, 2, 3],
        }],
        citations: [{ evidenceLineNumbers: [1, 2, 3] }],
      };
    },
  });

  assert.equal(sentLineCount, segments.length);
  assert.equal(result.status, 'ready');
  assert.equal(result.answer, '作者先界定问题，再给出方法和适用边界。');
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0]?.binding.turnId, 'background-turn-1');
  assert.equal(getCurrentVideoFullTextQaCitation({
    requestId: 'background-request-1',
    turnId: 'background-turn-1',
    citationId: 'citation-1',
    sourceIdentityKey: context.transcriptEvidence!.sourceIdentityKey!,
  })?.citation.evidenceText, '第一行说明问题背景。 第二行给出核心方法。 第三行展示第一个例子。');
});

test('unverified output remains readable without citation bindings', async () => {
  const context = videoContext();
  const answer = '模型已经完成的回答不应该因为引用格式错误而消失。';
  const result = await generateCurrentVideoFullTextQa(context, {
    requestId: 'unverified-request', turnId: 'unverified-turn', question: '如何交付产品？',
    config: userConfig(), transcriptSegments: transcriptSegments(),
    chat: async () => ({ supported: true, answerPoints: [{text:answer,evidenceLineNumbers:[999]}], citations:[] }),
  });
  assert.equal(result.status,'invalid_output');
  assert.equal(result.answer,answer);
  assert.deepEqual(result.citations,[]);
  assert.deepEqual(result.answerEvidenceLineNumbers,[]);
  assert.equal(getCurrentVideoFullTextQaCitation({requestId:'unverified-request',turnId:'unverified-turn',citationId:'citation-1',sourceIdentityKey:context.transcriptEvidence!.sourceIdentityKey!}),null);
});

test('unsupported video question returns a controlled refusal without a binding', async () => {
  const context = videoContext();
  const result = await generateCurrentVideoFullTextQa(context, {
    requestId: 'unsupported-request',
    turnId: 'unsupported-turn',
    question: '视频有没有讨论火星天气？',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: async () => ({ supported: false, citations: [] }),
  });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.answer, '当前视频文本没有足够内容回答这个问题。');
  assert.equal(result.citations.length, 0);
  assert.equal(getCurrentVideoFullTextQaCitation({
    requestId: 'unsupported-request',
    turnId: 'unsupported-turn',
    citationId: 'citation-1',
    sourceIdentityKey: context.transcriptEvidence!.sourceIdentityKey!,
  }), null);
});

test('cancel, retry replacement, source clear, and config change abort in-flight network work', async () => {
  const context = videoContext();
  const sourceIdentityKey = context.transcriptEvidence!.sourceIdentityKey!;

  const explicit = abortAwareChat();
  const explicitResult = generateCurrentVideoFullTextQa(context, {
    requestId: 'cancel-request',
    turnId: 'cancel-turn',
    question: '请回答这个问题。',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: explicit.chat,
  });
  await explicit.started;
  cancelCurrentVideoFullTextQaRequest('cancel-request');
  assert.equal((await explicitResult).status, 'cancelled');
  assert.equal(explicit.aborted(), true);

  const replaced = abortAwareChat();
  const oldAttempt = generateCurrentVideoFullTextQa(context, {
    requestId: 'retry-old',
    turnId: 'retry-turn',
    question: '同一个逻辑轮次。',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: replaced.chat,
  });
  await replaced.started;
  const newAttempt = await generateCurrentVideoFullTextQa(context, {
    requestId: 'retry-new',
    turnId: 'retry-turn',
    question: '同一个逻辑轮次。',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: async () => ({
      supported: true,
      answerPoints: [{ text: '这是重试后的新回答。', evidenceLineNumbers: [1] }],
      citations: [{ evidenceLineNumbers: [1] }],
    }),
  });
  assert.equal((await oldAttempt).status, 'cancelled');
  assert.equal(replaced.aborted(), true);
  assert.equal(newAttempt.status, 'ready');

  const sourceClear = abortAwareChat();
  const sourceAttempt = generateCurrentVideoFullTextQa(context, {
    requestId: 'source-request',
    turnId: 'source-turn',
    question: '来源清理测试。',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: sourceClear.chat,
  });
  await sourceClear.started;
  cancelCurrentVideoFullTextQaForSource(sourceIdentityKey);
  assert.equal((await sourceAttempt).status, 'cancelled');
  assert.equal(sourceClear.aborted(), true);

  const configChange = abortAwareChat();
  const configAttempt = generateCurrentVideoFullTextQa(context, {
    requestId: 'config-request',
    turnId: 'config-turn',
    question: '配置变化测试。',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: configChange.chat,
  });
  await configChange.started;
  invalidateCurrentVideoFullTextQaConfig();
  assert.equal((await configAttempt).status, 'cancelled');
  assert.equal(configChange.aborted(), true);
});

test('session-scoped requests block only the same session and keep different sessions independent', async () => {
  const first = registerCurrentVideoFullTextQaPreflightRequest({
    sessionId: 'session-one',
    requestId: 'session-one-request',
    turnId: 'session-one-turn',
  });
  const blocked = registerCurrentVideoFullTextQaPreflightRequest({
    sessionId: 'session-one',
    requestId: 'session-one-other-request',
    turnId: 'session-one-other-turn',
  });
  const second = registerCurrentVideoFullTextQaPreflightRequest({
    sessionId: 'session-two',
    requestId: 'session-two-request',
    turnId: 'session-two-turn',
  });
  assert.equal(first.accepted, true);
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.blockedReason, 'session_busy');
  assert.equal(second.accepted, true);
  const sharedPart = { bvid: 'BV1SharedScope', cid: 1001, page: 1, requestScopeId: 'tab-42' };
  assert.equal(bindCurrentVideoFullTextQaPreflightPart('session-one-request', sharedPart), true);
  assert.equal(bindCurrentVideoFullTextQaPreflightPart('session-two-request', sharedPart), true);
  assert.equal(bindCurrentVideoFullTextQaPreflightPart('session-one-request', sharedPart), true);
  settleCurrentVideoFullTextQaPreflightRequest('session-one-request');
  settleCurrentVideoFullTextQaPreflightRequest('session-two-request');

  const context = videoContext();
  const one = abortAwareChat();
  const two = abortAwareChat();
  const firstAttempt = generateCurrentVideoFullTextQa(context, {
    sessionId: 'session-one',
    requestId: 'active-one-request',
    turnId: 'active-one-turn',
    question: '第一会话问题。',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: one.chat,
  });
  const secondAttempt = generateCurrentVideoFullTextQa(context, {
    sessionId: 'session-two',
    requestId: 'active-two-request',
    turnId: 'active-two-turn',
    question: '第二会话问题。',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: two.chat,
  });
  await Promise.all([one.started, two.started]);
  cancelCurrentVideoFullTextQaForSession('session-one');
  assert.equal((await firstAttempt).status, 'cancelled');
  assert.equal(one.aborted(), true);
  assert.equal(two.aborted(), false);
  cancelCurrentVideoFullTextQaForSession('session-two');
  assert.equal((await secondAttempt).status, 'cancelled');
  assert.equal(two.aborted(), true);
});

test('part invalidation removes only matching requests and citation bindings', async () => {
  const first = { context: videoContext(), segments: transcriptSegments() };
  const second = alternateVideoFixture();
  const chat = async () => ({
    supported: true,
    answerPoints: [{ text: '这是由当前视频正文支持的回答。', evidenceLineNumbers: [1] }],
    citations: [{ evidenceLineNumbers: [1] }],
  });
  const firstResult = await generateCurrentVideoFullTextQa(first.context, {
    requestId: 'part-first-request',
    turnId: 'part-first-turn',
    question: '第一个视频说了什么？',
    config: userConfig(),
    transcriptSegments: first.segments,
    chat,
  });
  const secondResult = await generateCurrentVideoFullTextQa(second.context, {
    requestId: 'part-second-request',
    turnId: 'part-second-turn',
    question: '第二个视频说了什么？',
    config: userConfig(),
    transcriptSegments: second.segments,
    chat,
  });

  invalidateCurrentVideoFullTextQaPart({ bvid: first.context.bvid, cid: first.context.cid!, page: 1 });

  assert.equal(getCurrentVideoFullTextQaCitation({
    requestId: firstResult.requestId,
    turnId: firstResult.turnId,
    citationId: firstResult.citations[0]!.id,
    sourceIdentityKey: first.context.transcriptEvidence!.sourceIdentityKey!,
  }), null);
  assert.notEqual(getCurrentVideoFullTextQaCitation({
    requestId: secondResult.requestId,
    turnId: secondResult.turnId,
    citationId: secondResult.citations[0]!.id,
    sourceIdentityKey: second.context.transcriptEvidence!.sourceIdentityKey!,
  }), null);

  registerCurrentVideoFullTextQaPreflightRequest({
    requestId: 'part-second-retry',
    turnId: secondResult.turnId,
    sourceIdentityKey: second.context.transcriptEvidence!.sourceIdentityKey!,
  });
  assert.equal(getCurrentVideoFullTextQaCitation({
    requestId: secondResult.requestId,
    turnId: secondResult.turnId,
    citationId: secondResult.citations[0]!.id,
    sourceIdentityKey: second.context.transcriptEvidence!.sourceIdentityKey!,
  }), null);
  settleCurrentVideoFullTextQaPreflightRequest('part-second-retry');
});

test('HTTP 413 maps to controlled context-too-long copy without raw provider text', async () => {
  const result = await generateCurrentVideoFullTextQa(videoContext(), {
    requestId: 'too-long-request',
    turnId: 'too-long-turn',
    question: '请总结完整内容。',
    config: userConfig(),
    transcriptSegments: transcriptSegments(),
    chat: async () => {
      throw new Error('AI_REQUEST_FAILED_413 provider-secret-body');
    },
  });
  const visible = JSON.stringify({ message: result.message, answer: result.answer, limitations: result.limitations });

  assert.equal(result.status, 'context_too_long');
  assert.match(result.message, /正文过长/);
  assert.match(result.message, /不会截断/);
  assert.doesNotMatch(visible, /AI_REQUEST|provider-secret|413/i);
  assert.equal(result.question, '请总结完整内容。');
});

function fullTextEnvelope(options: { sessionId?: string } = {}) {
  return buildCurrentVideoFullTextRequestEnvelope({
    requestId: 'qa-request-1',
    operation: 'qa',
    submittedAt: 10_000,
    model: 'test-model',
    video: {
      bvid: 'BV1FullTextQa',
      cid: 7301,
      page: 1,
      title: '不应进入问答请求的标题',
      partTitle: '第一分 P',
      durationSeconds: 120,
    },
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    sourceLabel: 'B站字幕',
    language: 'zh-CN',
    lines: [
      { startSeconds: 0, endSeconds: 6, text: '第一行说明问题背景。' },
      { startSeconds: 6, endSeconds: 12, text: '第二行给出核心方法。' },
      { startSeconds: 12, endSeconds: 18, text: '第三行展示第一个例子。' },
      { startSeconds: 18, endSeconds: 24, text: '第四行说明适用边界。' },
    ],
    sessionId: options.sessionId,
    turnId: 'qa-turn-1',
  });
}

function defaultAiConfig(): AiConfig {
  return {
    baseURL: 'https://example.invalid',
    apiKey: 'test-key',
    chatModel: 'test-model',
    embeddingModel: '',
  };
}

function userConfig(): UserConfig {
  return {
    historySync: { mode: 'auto', pageLimit: 3 },
    assistant: {
      currentVideoAiAssistantEnabled: true,
      currentVideoSummaryEnabled: true,
      currentVideoSegmentRerankEnabled: true,
      currentVideoQaEnabled: true,
      smartFavoritesQaEnabled: true,
      dynamicBillExplanationEnabled: true,
    },
    ai: defaultAiConfig(),
  };
}

function videoContext(): CurrentVideoContext {
  const envelope = fullTextEnvelope();
  return {
    kind: 'video',
    url: 'https://www.bilibili.com/video/BV1FullTextQa?p=1',
    bvid: 'BV1FullTextQa',
    aid: 73,
    cid: 7301,
    title: '用于后台测试的视频标题',
    authorName: '测试作者',
    authorMid: 123,
    durationSeconds: 120,
    currentPart: { page: 1, cid: 7301, title: '第一分 P', durationSeconds: 120 },
    parts: [{ page: 1, cid: 7301, title: '第一分 P', durationSeconds: 120 }],
    description: { availability: 'available', text: '不应进入问答证据。', length: 9 },
    chapters: [],
    sources: {
      metadata: 'available',
      description: 'available',
      pages: 'available',
      chapters: 'missing',
      transcript: 'available',
      contentText: 'available',
    },
    subtitleProbe: null,
    transcriptEvidence: {
      status: 'cached',
      active: true,
      checkedAt: 10_000,
      bvid: 'BV1FullTextQa',
      cid: 7301,
      page: 1,
      language: 'zh-CN',
      source: 'bilibili_subtitle',
      sourceType: 'bilibili_player_wbi_v2',
      sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey,
      sourceHash: envelope.primaryTextIdentity.sourceHash,
      bodyHash: envelope.primaryTextIdentity.bodyHash,
      timelineHash: envelope.primaryTextIdentity.timelineHash,
      segmentCount: envelope.text.lineCount,
      staleSegmentCount: 0,
      serializedBytes: envelope.text.utf8Bytes,
      coverageStartSeconds: 0,
      coverageEndSeconds: 24,
      fetchedAt: 10_000,
      updatedAt: 10_000,
      reason: 'cached',
      message: '已读取正文。',
      warnings: [],
    },
    collectedAt: 10_000,
    warnings: [],
  };
}

function transcriptSegments(): CurrentVideoTranscriptSegment[] {
  const envelope = fullTextEnvelope();
  return envelope.text.lines.map(line => ({
    segmentId: `segment-${line.lineNo}`,
    sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey,
    bvid: envelope.video.bvid,
    cid: envelope.video.cid,
    page: envelope.video.page,
    startSeconds: line.startSeconds,
    endSeconds: line.endSeconds,
    text: line.text,
    language: envelope.language,
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    sourceHash: envelope.primaryTextIdentity.sourceHash,
    stale: false,
    fetchedAt: 10_000,
  }));
}

function alternateVideoFixture(): {
  context: CurrentVideoContext;
  segments: CurrentVideoTranscriptSegment[];
} {
  const envelope = buildCurrentVideoFullTextRequestEnvelope({
    requestId: 'qa-request-alternate',
    operation: 'qa',
    submittedAt: 10_001,
    model: 'test-model',
    video: {
      bvid: 'BV1FullTextQaAlternate',
      cid: 7302,
      page: 1,
      title: '第二个测试视频',
      partTitle: null,
      durationSeconds: 60,
    },
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    sourceLabel: 'B站字幕',
    language: 'zh-CN',
    lines: [{ startSeconds: 0, endSeconds: 6, text: '第二个视频的第一行正文。' }],
    turnId: 'qa-turn-alternate',
  });
  const context = structuredClone(videoContext());
  context.url = 'https://www.bilibili.com/video/BV1FullTextQaAlternate?p=1';
  context.bvid = envelope.video.bvid;
  context.cid = envelope.video.cid;
  context.title = envelope.video.title;
  context.durationSeconds = envelope.video.durationSeconds;
  context.currentPart = { page: 1, cid: envelope.video.cid, title: null, durationSeconds: 60 };
  context.parts = [{ page: 1, cid: envelope.video.cid, title: null, durationSeconds: 60 }];
  context.transcriptEvidence = {
    ...context.transcriptEvidence!,
    bvid: envelope.video.bvid,
    cid: envelope.video.cid,
    page: envelope.video.page,
    sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey,
    sourceHash: envelope.primaryTextIdentity.sourceHash,
    bodyHash: envelope.primaryTextIdentity.bodyHash,
    timelineHash: envelope.primaryTextIdentity.timelineHash,
    segmentCount: envelope.text.lineCount,
    serializedBytes: envelope.text.utf8Bytes,
    coverageEndSeconds: 6,
  };
  const segments = envelope.text.lines.map(line => ({
    segmentId: `alternate-${line.lineNo}`,
    sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey,
    bvid: envelope.video.bvid,
    cid: envelope.video.cid,
    page: envelope.video.page,
    startSeconds: line.startSeconds,
    endSeconds: line.endSeconds,
    text: line.text,
    language: envelope.language,
    source: 'bilibili_subtitle' as const,
    sourceType: 'bilibili_player_wbi_v2' as const,
    sourceHash: envelope.primaryTextIdentity.sourceHash,
    stale: false,
    fetchedAt: 10_001,
  }));
  return { context, segments };
}

function abortAwareChat() {
  let resolveStarted!: () => void;
  let aborted = false;
  const started = new Promise<void>(resolve => {
    resolveStarted = resolve;
  });
  return {
    started,
    aborted: () => aborted,
    chat: async (
      _config: AiConfig,
      _messages: Array<{ role: 'system' | 'user'; content: string }>,
      options?: { signal?: AbortSignal },
    ) => {
      resolveStarted();
      return await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('AI_REQUEST_ABORTED'));
        }, { once: true });
      });
    },
  };
}
