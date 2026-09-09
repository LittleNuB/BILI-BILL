import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAssistantPayloadAudit,
  auditAssistantPayload,
  currentVideoSummaryHighlightsPayloadContract,
} from '../src/shared/assistant-payload-audit.ts';
import {
  buildCurrentVideoFullTextRequestEnvelope,
  buildCurrentVideoTextSourceIdentity,
} from '../src/shared/current-video-primary-text.ts';
import {
  buildCurrentVideoSummaryHighlightsAiPayload,
  cancelledCurrentVideoSummaryHighlights,
  CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS,
  currentVideoSummaryHighlightBindingFromResult,
  currentVideoSummaryHighlightBindingMatchesRecord,
  invalidCurrentVideoSummaryHighlights,
  readyCurrentVideoSummaryHighlights,
  requestAuditFromEnvelope,
  requestCurrentVideoSummaryHighlightsAi,
  validateCurrentVideoSummaryHighlightsAiOutput,
} from '../src/shared/current-video-summary-highlights.ts';
import {
  cancelCurrentVideoSummaryHighlightsForSource,
  cancelCurrentVideoSummaryHighlightsRequest,
  generateCurrentVideoSummaryHighlights,
  invalidateCurrentVideoSummaryHighlightsAuthorization,
  readCachedCurrentVideoSummaryHighlights,
} from '../src/background/current-video-summary-highlights.ts';
import {
  buildCurrentVideoSummaryHighlightsCacheKey,
  clearCurrentVideoSummaryHighlightsCache,
  collectCurrentVideoSummaryHighlightsCacheUsage,
  getCurrentVideoSummaryHighlightsCache,
  putCurrentVideoSummaryHighlightsCache,
  readCurrentVideoSummaryHighlightsAfterClear,
  CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_BYTES,
  CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_RECORDS,
} from '../src/background/storage/current-video-summary-highlights-repo.ts';
import {
  canUseCurrentVideoSummaryHighlightsClearGeneration,
  getCurrentVideoSummaryHighlightsClearState,
  runCurrentVideoSummaryHighlightsClearCoordinator,
} from '../src/background/current-video-summary-highlights-clear-epoch.ts';
import { db } from '../src/background/storage/db.ts';
import type { UserConfig } from '../src/shared/types/config.ts';
import type { CurrentVideoContext } from '../src/shared/types/current-video-context.ts';
import type { CurrentVideoTranscriptSegment } from '../src/shared/types/current-video-transcript.ts';
import type { CurrentVideoSummaryHighlightsAiOutput } from '../src/shared/current-video-summary-highlights.ts';

test('validates all-or-nothing summary, key points, and highlight evidence references', () => {
  const envelope = fullTextEnvelope();
  const valid = validateCurrentVideoSummaryHighlightsAiOutput(validAiOutput(), envelope);

  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.result.summarySentences.length, 3);
  assert.equal(valid.result.keyPoints.length, 3);
  assert.equal(valid.result.highlights.length, 4);
  assert.deepEqual(valid.result.summarySentences[0].evidenceLineNumbers, [1, 2]);
  assert.equal(valid.result.highlights[0].timeRangeLabel, '0:00-0:09');

  const badReference = validateCurrentVideoSummaryHighlightsAiOutput({
    ...validAiOutput(),
    keyPoints: [
      { text: '错误要点引用了不存在的行。', evidenceLineNumbers: [99] },
      { text: '第二个要点。', evidenceLineNumbers: [2] },
      { text: '第三个要点。', evidenceLineNumbers: [3] },
    ],
  }, envelope);
  assert.deepEqual(badReference, { ok: false, reason: 'evidence_line_missing' });

  const malformedReference = validateCurrentVideoSummaryHighlightsAiOutput({
    ...validAiOutput(),
    summarySentences: [
      { text: '非整数证据引用不能被自动改写。', evidenceLineNumbers: [1.5] },
      { text: '第二句摘要仍然有效。', evidenceLineNumbers: [2] },
    ],
  }, envelope);
  assert.deepEqual(malformedReference, { ok: false, reason: 'summary_sentences_evidence_missing' });

});

test('orders key points and highlights locally by their earliest evidence line', () => {
  const envelope = fullTextEnvelope();
  const output = validAiOutput();
  output.keyPoints = [
    { text: '最后引用结尾结论。', evidenceLineNumbers: [6] },
    { text: '先引用开头的问题。', evidenceLineNumbers: [1] },
    { text: '再引用中段的方法。', evidenceLineNumbers: [4] },
  ];
  output.highlights = [
    { title: '结尾', description: '最后给出结论。', evidenceLineNumbers: [6] },
    { title: '开头', description: '先提出主要问题。', evidenceLineNumbers: [1] },
    { title: '中段二', description: '继续解释执行过程。', evidenceLineNumbers: [4] },
    { title: '中段一', description: '开始拆解解决方法。', evidenceLineNumbers: [3] },
  ];

  const validation = validateCurrentVideoSummaryHighlightsAiOutput(output, envelope);

  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.deepEqual(validation.result.keyPoints.map(item => item.text), [
    '先引用开头的问题。',
    '再引用中段的方法。',
    '最后引用结尾结论。',
  ]);
  assert.deepEqual(validation.result.highlights.map(item => item.title), [
    '开头',
    '中段一',
    '中段二',
    '结尾',
  ]);
});

test('normalizes positive integer evidence lines returned as JSON strings', () => {
  const envelope = fullTextEnvelope();
  const output = validAiOutput();
  output.summarySentences = [
    { text: '视频先说明问题背景和约束。', evidenceLineNumbers: ['1', 2, '2'] },
  ];
  output.keyPoints = [
    { text: '中段给出具体方法。', evidenceLineNumbers: ['3', '4'] },
  ];
  output.highlights = [
    { title: '方法拆解', description: '这里集中解释了解决方法。', evidenceLineNumbers: ['3', 4] },
  ];

  const validation = validateCurrentVideoSummaryHighlightsAiOutput(output, envelope);

  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.deepEqual(validation.result.summarySentences[0]?.evidenceLineNumbers, [1, 2]);
  assert.deepEqual(validation.result.keyPoints[0]?.evidenceLineNumbers, [3, 4]);
  assert.deepEqual(validation.result.highlights[0]?.evidenceLineNumbers, [3, 4]);
});

test('applies the evidence reference limit after deterministic de-duplication', () => {
  const envelope = fullTextEnvelope();
  const output = validAiOutput();
  output.summarySentences = [
    {
      text: '重复引用同一正文行仍然只算一条证据。',
      evidenceLineNumbers: Array.from({ length: 13 }, () => '1'),
    },
  ];

  const validation = validateCurrentVideoSummaryHighlightsAiOutput(output, envelope);

  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.deepEqual(validation.result.summarySentences[0]?.evidenceLineNumbers, [1]);
});

test('derives highlight time ranges from evidence lines instead of model-provided times', () => {
  const envelope = fullTextEnvelope();
  const output = validAiOutput();
  output.highlights = [
    {
      title: '问题提出',
      description: '开头集中说明要解决的问题。',
      evidenceLineNumbers: [1, 2, 2],
    },
    {
      title: '方法拆解',
      description: '中段按步骤解释方案。',
      startSeconds: 999,
      endSeconds: 1_000,
      evidenceLineNumbers: [3, 4],
    },
    {
      title: '结果收束',
      description: '结尾给出结论和行动。',
      startSeconds: '00:40',
      endSeconds: '00:59',
      evidenceLineNumbers: [5, 6],
    },
    {
      title: '后续行动',
      description: '最后补充可以继续执行的行动。',
      evidenceLineNumbers: [6],
    },
  ];

  const validation = validateCurrentVideoSummaryHighlightsAiOutput(output, envelope);

  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.deepEqual(validation.result.highlights.map(highlight => ({
    timeRangeLabel: highlight.timeRangeLabel,
    startSeconds: highlight.startSeconds,
    endSeconds: highlight.endSeconds,
    evidenceLineNumbers: highlight.evidenceLineNumbers,
  })), [
    { timeRangeLabel: '0:00-0:19', startSeconds: 0, endSeconds: 19, evidenceLineNumbers: [1, 2] },
    { timeRangeLabel: '0:20-0:39', startSeconds: 20, endSeconds: 39, evidenceLineNumbers: [3, 4] },
    { timeRangeLabel: '0:40-0:59', startSeconds: 40, endSeconds: 59, evidenceLineNumbers: [5, 6] },
    { timeRangeLabel: '0:50-0:59', startSeconds: 50, endSeconds: 59, evidenceLineNumbers: [6] },
  ]);
});

test('accepts a smaller evidence-backed result but rejects empty sections', () => {
  const envelope = fullTextEnvelope();
  const sparseOutput = {
    summarySentences: [
      { text: '视频围绕一个主要问题展开说明。', evidenceLineNumbers: [1, 2] },
    ],
    keyPoints: [
      { text: '核心方法集中在中段。', evidenceLineNumbers: [3, 4] },
    ],
    highlights: [
      { title: '方法演示', description: '这里展示了解决问题的方法。', evidenceLineNumbers: [3, 4] },
    ],
  };

  const validation = validateCurrentVideoSummaryHighlightsAiOutput(sparseOutput, envelope);

  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.equal(validation.result.summarySentences.length, 1);
  assert.equal(validation.result.keyPoints.length, 1);
  assert.equal(validation.result.highlights.length, 1);
  assert.equal(validation.result.highlights[0]?.timeRangeLabel, '0:20-0:39');

  for (const field of ['summarySentences', 'keyPoints', 'highlights'] as const) {
    const empty = validateCurrentVideoSummaryHighlightsAiOutput({
      ...sparseOutput,
      [field]: [],
    }, envelope);
    assert.equal(empty.ok, false, `${field} must not be empty`);
  }
});

test('accepts output limits at the boundary and rejects every oversized item', () => {
  const envelope = fullTextEnvelopeWithLineCount(
    CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.evidenceLineNumbersPerItem + 1,
  );
  const base = validAiOutput();
  const summarySentences = base.summarySentences as Array<{ text: string; evidenceLineNumbers: number[] }>;
  const keyPoints = base.keyPoints as Array<{ text: string; evidenceLineNumbers: number[] }>;
  const highlights = base.highlights as Array<{
    title: string;
    description: string;
    evidenceLineNumbers: number[];
  }>;
  const maxReferences = Array.from(
    { length: CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.evidenceLineNumbersPerItem },
    (_, index) => index + 1,
  );
  const boundary = {
    summarySentences: [
      {
        ...summarySentences[0],
        text: '摘'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.summarySentenceChars),
        evidenceLineNumbers: maxReferences,
      },
      ...summarySentences.slice(1),
    ],
    keyPoints: [
      {
        ...keyPoints[0],
        text: '点'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.keyPointChars),
        evidenceLineNumbers: maxReferences,
      },
      ...keyPoints.slice(1),
    ],
    highlights: [
      {
        ...highlights[0],
        title: '亮'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.highlightTitleChars),
        description: '述'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.highlightDescriptionChars),
        evidenceLineNumbers: maxReferences,
      },
      ...highlights.slice(1),
    ],
  };
  assert.equal(validateCurrentVideoSummaryHighlightsAiOutput(boundary, envelope).ok, true);

  const oversizedCases = [
    {
      output: { ...boundary, summarySentences: [{ ...boundary.summarySentences[0], text: '摘'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.summarySentenceChars + 1) }, ...boundary.summarySentences.slice(1)] },
      reason: 'summary_sentences_text_too_long',
    },
    {
      output: { ...boundary, summarySentences: [{ ...boundary.summarySentences[0], evidenceLineNumbers: [...maxReferences, maxReferences.length + 1] }, ...boundary.summarySentences.slice(1)] },
      reason: 'summary_sentences_evidence_too_many',
    },
    {
      output: { ...boundary, keyPoints: [{ ...boundary.keyPoints[0], text: '点'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.keyPointChars + 1) }, ...boundary.keyPoints.slice(1)] },
      reason: 'key_points_text_too_long',
    },
    {
      output: { ...boundary, keyPoints: [{ ...boundary.keyPoints[0], evidenceLineNumbers: [...maxReferences, maxReferences.length + 1] }, ...boundary.keyPoints.slice(1)] },
      reason: 'key_points_evidence_too_many',
    },
    {
      output: { ...boundary, highlights: [{ ...boundary.highlights[0], title: '亮'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.highlightTitleChars + 1) }, ...boundary.highlights.slice(1)] },
      reason: 'highlight_title_too_long',
    },
    {
      output: { ...boundary, highlights: [{ ...boundary.highlights[0], description: '述'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.highlightDescriptionChars + 1) }, ...boundary.highlights.slice(1)] },
      reason: 'highlight_description_too_long',
    },
    {
      output: { ...boundary, highlights: [{ ...boundary.highlights[0], evidenceLineNumbers: [...maxReferences, maxReferences.length + 1] }, ...boundary.highlights.slice(1)] },
      reason: 'highlight_evidence_too_many',
    },
  ];
  for (const testCase of oversizedCases) {
    assert.deepEqual(
      validateCurrentVideoSummaryHighlightsAiOutput(testCase.output, envelope),
      { ok: false, reason: testCase.reason },
    );
  }
});

test('rejects an oversized raw model result even when known fields are valid', () => {
  const envelope = fullTextEnvelope();
  const validation = validateCurrentVideoSummaryHighlightsAiOutput({
    ...validAiOutput(),
    debug: 'x'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.rawJsonBytes),
  }, envelope);

  assert.deepEqual(validation, { ok: false, reason: 'output_too_large' });
});

test('maps rejected model output to safe Chinese failure categories', () => {
  const textSize = { lineCount: 6, charCount: 120, utf8Bytes: 360 };
  const cases = [
    { reason: 'summary_sentences_not_array', expected: /结构不完整/ },
    { reason: 'highlight_evidence_line_missing', expected: /引用.*当前正文/ },
    { reason: 'highlight_description_too_long', expected: /超出.*范围/ },
    { reason: 'output_too_large', expected: /超出.*范围/ },
  ];

  for (const testCase of cases) {
    const result = invalidCurrentVideoSummaryHighlights(
      '测试视频',
      'test-model',
      testCase.reason,
      textSize,
      10_000,
    );
    const visibleText = [result.message, ...result.limitations, result.ai.note].join('\n');
    assert.match(visibleText, testCase.expected);
    assert.doesNotMatch(visibleText, /summary_|key_point|highlight_|evidenceLineNumbers|startSeconds|endSeconds/);
  }
});

test('full-primary-text payload is audited and does not include unrelated local ledgers', () => {
  const payload = buildCurrentVideoSummaryHighlightsAiPayload(fullTextEnvelope());
  const raw = JSON.stringify(payload);
  const audit = auditAssistantPayload(payload, currentVideoSummaryHighlightsPayloadContract);

  assert.equal(payload.intent, 'current_video_summary_highlights_v2');
  assert.equal(payload.textLines.length, 6);
  assert.ok(raw.includes('完整正文第 1 行'));
  assert.match(payload.outputRules.join('\n'), /只返回.*text.*evidenceLineNumbers.*title.*description/s);
  assert.doesNotMatch(payload.outputRules.join('\n'), /startSeconds|endSeconds/);
  assert.equal(audit.passed, true, JSON.stringify(audit.violations));
  assertAssistantPayloadAudit(payload, currentVideoSummaryHighlightsPayloadContract);
  assert.doesNotMatch(raw, /watchHistory|favoriteItems|followingList|feedbackRecords|Cookie|Key\.txt|Chrome\\User Data|sourceHash|segmentId|subtitle_url/i);
});

test('runtime payload audit blocks chat before an outbound call', async () => {
  const payload = {
    ...buildCurrentVideoSummaryHighlightsAiPayload(fullTextEnvelope()),
    watchHistory: [{ title: '不应发送的记录' }],
  };
  let chatCalls = 0;

  await assert.rejects(
    requestCurrentVideoSummaryHighlightsAi(
      userConfig({ enabled: true, apiKey: 'test-key' }).ai,
      payload as ReturnType<typeof buildCurrentVideoSummaryHighlightsAiPayload>,
      async () => {
        chatCalls += 1;
        return validAiOutput();
      },
    ),
    /Assistant payload privacy audit failed/,
  );
  assert.equal(chatCalls, 0);
});

test('runtime payload audit allows sensitive-looking words in authorized title and transcript content', async () => {
  const segments = transcriptSegments();
  const envelope = buildCurrentVideoFullTextRequestEnvelope({
    operation: 'summary_highlights',
    submittedAt: 10_000,
    model: 'Cookie-model',
    video: {
      bvid: 'BV1SummaryHi',
      cid: 6101,
      page: 1,
      title: 'Cookie、login-state 与 watchHistory 技术说明',
      partTitle: 'Key.txt 配置误区',
      durationSeconds: 120,
    },
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    sourceLabel: 'B站字幕',
    language: 'login-state-zh-CN',
    lines: segments.map((segment, index) => ({
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: index === 0
        ? '本节讨论 Cookie、login-state、watchHistory、Key.txt 与 browser profile 这些字符串。'
        : segment.text,
    })),
  });
  const payload = buildCurrentVideoSummaryHighlightsAiPayload(envelope);
  let chatCalls = 0;
  const output = await requestCurrentVideoSummaryHighlightsAi(
    userConfig({ enabled: true, apiKey: 'test-key' }).ai,
    payload,
    async () => {
      chatCalls += 1;
      return validAiOutput();
    },
  );

  assert.equal(chatCalls, 1);
  assert.equal(output.highlights.length, 4);
});

test('generation succeeds only after validation and writes exact-identity model cache', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const segments = transcriptSegments();
  let chatCalls = 0;
  const result = await generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: segments,
    chat: async () => {
      chatCalls += 1;
      return validAiOutput();
    },
    currentIdentity: { sourceIdentityKey: context.transcriptEvidence?.sourceIdentityKey ?? '' },
    now: 10_000,
  });

  assert.equal(chatCalls, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.summarySentences.length, 3);
  assert.equal(result.keyPoints.length, 3);
  assert.equal(result.highlights.length, 4);
  assert.equal(result.cacheHit, false);
  assert.ok(result.cacheKey);

  const cached = await getCurrentVideoSummaryHighlightsCache({
    identity: { sourceIdentityKey: context.transcriptEvidence?.sourceIdentityKey ?? '' },
    model: 'test-model',
  });
  assert.equal(cached?.result.highlights.length, 4);
  assert.equal(cached?.requestAudit.requestId, result.requestId);
  assert.equal(cached?.requestAudit.text.lineCount, 6);
  assert.equal('lines' in (cached?.requestAudit.text ?? {}), false);
});

test('does not reuse a v1 cache entry after the summary protocol upgrade', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const config = userConfig({ enabled: true, apiKey: 'test-key' });
  const generated = await generateCurrentVideoSummaryHighlights(context, {
    config,
    transcriptSegments: transcriptSegments(),
    chat: async () => validAiOutput(),
  });
  assert.equal(generated.status, 'ready');

  const currentRecord = await db.currentVideoSummaryHighlights.toCollection().first();
  assert.ok(currentRecord);
  const legacyCacheKey = currentRecord.cacheKey.replace(
    'cv-summary-highlights:v2:',
    'cv-summary-highlights:v1:',
  );
  await resetSummaryCache();
  await putCurrentVideoSummaryHighlightsCache({
    cacheKey: legacyCacheKey,
    sourceIdentityKey: currentRecord.sourceIdentityKey,
    model: currentRecord.model,
    bvid: currentRecord.bvid,
    cid: currentRecord.cid,
    page: currentRecord.page,
    generatedAt: currentRecord.generatedAt,
    lastAccessedAt: currentRecord.lastAccessedAt,
    requestAudit: currentRecord.requestAudit,
    result: {
      ...currentRecord.result,
      cacheKey: legacyCacheKey,
    },
  });

  const currentCacheKey = buildCurrentVideoSummaryHighlightsCacheKey({
    identity: { sourceIdentityKey: context.transcriptEvidence?.sourceIdentityKey ?? '' },
    model: 'test-model',
  });
  assert.match(currentCacheKey, /^cv-summary-highlights:v2:/);
  const cached = await readCachedCurrentVideoSummaryHighlights(context, { config });
  assert.equal(cached.status, 'not_requested');
  assert.equal((await collectCurrentVideoSummaryHighlightsCacheUsage()).count, 1);
});

test('generation caches a sparse model result after local evidence normalization', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const result = await generateCurrentVideoSummaryHighlights(context, {
    requestId: 'normalized-sparse-result',
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: transcriptSegments(),
    chat: async () => ({
      summarySentences: [
        { text: '视频说明了问题、方法和结论。', evidenceLineNumbers: ['1', '3', '6'] },
      ],
      keyPoints: [
        { text: '结尾给出行动。', evidenceLineNumbers: ['6'] },
        { text: '开头提出问题。', evidenceLineNumbers: ['1'] },
      ],
      highlights: [
        { title: '结论', description: '这里给出最终行动。', evidenceLineNumbers: ['6'] },
        { title: '问题', description: '这里提出主要问题。', evidenceLineNumbers: ['1'] },
      ],
    }),
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.keyPoints.map(item => item.text), ['开头提出问题。', '结尾给出行动。']);
  assert.deepEqual(result.highlights.map(item => item.timeRangeLabel), ['0:00-0:09', '0:50-0:59']);
  const cached = await getCurrentVideoSummaryHighlightsCache({
    identity: { sourceIdentityKey: context.transcriptEvidence?.sourceIdentityKey ?? '' },
    model: 'test-model',
  });
  assert.equal(cached?.result.requestId, 'normalized-sparse-result');
  assert.deepEqual(cached?.result.highlights.map(item => item.timeRangeLabel), ['0:00-0:09', '0:50-0:59']);
});

test('late valid output stays on the captured cache identity and is not marked current', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const capturedIdentity = context.transcriptEvidence?.sourceIdentityKey ?? '';
  const changedIdentity = 'cv-text-source:v1:changed-after-submit';
  const result = await generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: transcriptSegments(),
    chat: async () => validAiOutput(),
    resolveCurrentIdentity: async () => ({ sourceIdentityKey: changedIdentity }),
    now: 11_000,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.current, false);
  assert.ok(await getCurrentVideoSummaryHighlightsCache({
    identity: { sourceIdentityKey: capturedIdentity },
    model: 'test-model',
  }));
  assert.equal(await getCurrentVideoSummaryHighlightsCache({
    identity: { sourceIdentityKey: changedIdentity },
    model: 'test-model',
  }), null);
});

test('oversized model output rejects the whole refresh and preserves the previous exact cache', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const config = userConfig({ enabled: true, apiKey: 'test-key' });
  const previous = await generateCurrentVideoSummaryHighlights(context, {
    requestId: 'bounded-previous',
    config,
    transcriptSegments: transcriptSegments(),
    chat: async () => validAiOutput({ suffix: '此前' }),
  });
  assert.equal(previous.status, 'ready');

  const oversized = validAiOutput();
  const summaries = oversized.summarySentences as Array<{ text: string; evidenceLineNumbers: number[] }>;
  oversized.summarySentences = [
    {
      ...summaries[0],
      text: '超'.repeat(CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_OUTPUT_LIMITS.summarySentenceChars + 1),
    },
    ...summaries.slice(1),
  ];
  const rejected = await generateCurrentVideoSummaryHighlights(context, {
    requestId: 'bounded-rejected',
    config,
    transcriptSegments: transcriptSegments(),
    chat: async () => oversized,
  });
  assert.equal(rejected.status, 'invalid_output');
  const cached = await getCurrentVideoSummaryHighlightsCache({
    identity: { sourceIdentityKey: context.transcriptEvidence?.sourceIdentityKey ?? '' },
    model: 'test-model',
  });
  assert.equal(cached?.result.requestId, 'bounded-previous');
  assert.match(cached?.result.summarySentences[0]?.text ?? '', /此前/);
});

test('authorization-off keeps an exact cache readable as prior generation and blocks refresh', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const enabledConfig = userConfig({ enabled: true, apiKey: 'test-key' });
  const generated = await generateCurrentVideoSummaryHighlights(context, {
    config: enabledConfig,
    transcriptSegments: transcriptSegments(),
    chat: async () => validAiOutput(),
    currentIdentity: { sourceIdentityKey: context.transcriptEvidence?.sourceIdentityKey ?? '' },
  });
  assert.equal(generated.status, 'ready');

  const cached = await readCachedCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: false, apiKey: 'test-key' }),
  });
  assert.equal(cached.status, 'ready');
  assert.equal(cached.priorGenerated, true);
  assert.equal(cached.canGenerate, false);
  assert.match(cached.message, /此前生成/);

  let chatCalls = 0;
  const blocked = await generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: false, apiKey: 'test-key' }),
    transcriptSegments: transcriptSegments(),
    chat: async () => {
      chatCalls += 1;
      return validAiOutput({ suffix: '不应生成' });
    },
  });
  assert.equal(blocked.ai.status, 'disabled');
  assert.equal(chatCalls, 0);
  assert.equal((await collectCurrentVideoSummaryHighlightsCacheUsage()).count, 1);
});

test('disabled, unconfigured, and invalid output do not call or replace cache', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const segments = transcriptSegments();
  let chatCalls = 0;

  const disabled = await generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: false, apiKey: 'test-key' }),
    transcriptSegments: segments,
    chat: async () => {
      chatCalls += 1;
      return validAiOutput();
    },
  });
  const unconfigured = await generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: true, apiKey: '' }),
    transcriptSegments: segments,
    chat: async () => {
      chatCalls += 1;
      return validAiOutput();
    },
  });
  const invalid = await generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: segments,
    chat: async () => ({
      ...validAiOutput(),
      summarySentences: [{ text: '引用了不存在正文行的摘要。', evidenceLineNumbers: [99] }],
    }),
  });

  assert.equal(chatCalls, 0);
  assert.equal(disabled.ai.status, 'disabled');
  assert.equal(unconfigured.ai.status, 'not_configured');
  assert.equal(invalid.status, 'invalid_output');
  assert.match(invalid.unverifiedText ?? '', /引用了不存在正文行的摘要/);
  assert.deepEqual(invalid.highlights, []);
  assert.equal((await collectCurrentVideoSummaryHighlightsCacheUsage()).count, 0);
});

test('replacement, cancellation, and clear reject late responses without partial writes', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const segments = transcriptSegments();

  const firstGate = deferredChat();
  const first = generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: segments,
    chat: firstGate.chat,
  });
  await firstGate.ready;
  const second = await generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: segments,
    chat: async () => validAiOutput({ suffix: '较新' }),
  });
  firstGate.resolve(validAiOutput({ suffix: '较旧' }));
  const firstResult = await first;
  assert.equal(second.status, 'ready');
  assert.equal(firstResult.status, 'cancelled');
  assert.equal((await collectCurrentVideoSummaryHighlightsCacheUsage()).count, 1);

  await resetSummaryCache();
  const cancelGate = deferredChat();
  const cancelRun = generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: segments,
    chat: cancelGate.chat,
  });
  const requestId = await cancelGate.requestId;
  cancelCurrentVideoSummaryHighlightsRequest(requestId);
  cancelGate.resolve(validAiOutput());
  assert.equal((await cancelRun).status, 'cancelled');
  assert.equal((await collectCurrentVideoSummaryHighlightsCacheUsage()).count, 0);

  const clearGate = deferredChat();
  const clearRun = generateCurrentVideoSummaryHighlights(context, {
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: segments,
    chat: clearGate.chat,
  });
  await clearGate.ready;
  await clearCurrentVideoSummaryHighlightsCache();
  clearGate.resolve(validAiOutput());
  assert.equal((await clearRun).status, 'cancelled');
  assert.deepEqual(await readCurrentVideoSummaryHighlightsAfterClear(), {
    count: 0,
    usageBytes: 0,
    latestGeneratedAt: null,
    empty: true,
  });

  cancelCurrentVideoSummaryHighlightsForSource(context.transcriptEvidence?.sourceIdentityKey ?? '');
});

test('same-source replacement with a changed model aborts the old network request', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const oldGate = deferredRejectingChat();
  const oldConfig = userConfig({ enabled: true, apiKey: 'test-key' });
  oldConfig.ai.chatModel = 'old-model';
  const oldRun = generateCurrentVideoSummaryHighlights(context, {
    requestId: 'old-model-request',
    config: oldConfig,
    transcriptSegments: transcriptSegments(),
    chat: oldGate.chat,
  });
  await oldGate.ready;

  const newConfig = userConfig({ enabled: true, apiKey: 'test-key' });
  newConfig.ai.chatModel = 'new-model';
  const replacement = await generateCurrentVideoSummaryHighlights(context, {
    requestId: 'new-model-request',
    config: newConfig,
    transcriptSegments: transcriptSegments(),
    chat: async () => validAiOutput({ suffix: '新模型' }),
  });

  assert.equal(oldGate.signal?.aborted, true);
  oldGate.reject(new Error('old model request aborted by replacement'));
  assert.equal((await oldRun).status, 'cancelled');
  assert.equal(replacement.status, 'ready');
  const rows = await db.currentVideoSummaryHighlights.toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.model, 'new-model');
  assert.equal(rows[0]?.requestAudit.requestId, 'new-model-request');
});

test('late rejection after exact cancel or authorization disable resolves cancelled and never persists', async () => {
  await resetSummaryCache();
  const context = videoContext();
  const cancelGate = deferredRejectingChat();
  const cancelRun = generateCurrentVideoSummaryHighlights(context, {
    requestId: 'client-captured-source-request',
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: transcriptSegments(),
    chat: cancelGate.chat,
  });
  await cancelGate.ready;
  cancelCurrentVideoSummaryHighlightsRequest('client-captured-source-request');
  assert.equal(cancelGate.signal?.aborted, true);
  cancelGate.reject(new Error('late network rejection after source changed'));
  assert.equal((await cancelRun).status, 'cancelled');
  assert.equal((await collectCurrentVideoSummaryHighlightsCacheUsage()).count, 0);

  const disabledGate = deferredRejectingChat();
  let authorizationEnabled = true;
  const disabledRun = generateCurrentVideoSummaryHighlights(context, {
    requestId: 'authorization-disabled-request',
    config: userConfig({ enabled: true, apiKey: 'test-key' }),
    transcriptSegments: transcriptSegments(),
    chat: disabledGate.chat,
    authorizationStillEnabled: async () => authorizationEnabled,
  });
  await disabledGate.ready;
  authorizationEnabled = false;
  invalidateCurrentVideoSummaryHighlightsAuthorization();
  assert.equal(disabledGate.signal?.aborted, true);
  disabledGate.reject(new Error('late rejection after authorization disabled'));
  assert.equal((await disabledRun).status, 'cancelled');
  assert.equal((await collectCurrentVideoSummaryHighlightsCacheUsage()).count, 0);
});

test('cache clear generation is checked inside the write transaction', async () => {
  await resetSummaryCache();
  const envelope = fullTextEnvelope();
  let releaseWrite!: () => void;
  let markPaused!: () => void;
  const paused = new Promise<void>(resolve => { markPaused = resolve; });
  const resume = new Promise<void>(resolve => { releaseWrite = resolve; });
  const expectedClearGeneration = getCurrentVideoSummaryHighlightsClearState().generation;
  const lateWrite = putCurrentVideoSummaryHighlightsCache(
    cacheRecord(envelope, { suffix: 'clear-race', model: 'clear-race-model', lastAccessedAt: 1 }),
    {
      expectedClearGeneration,
      beforeWrite: async () => {
        markPaused();
        await resume;
      },
    },
  );
  await paused;
  await clearCurrentVideoSummaryHighlightsCache();
  releaseWrite();

  const result = await lateWrite;
  assert.equal(result.cached, false);
  assert.equal(result.rejectedReason, 'cleared');
  assert.equal((await collectCurrentVideoSummaryHighlightsCacheUsage()).count, 0);
});

test('overlapping summary clear coordinators keep the write barrier until the last clear finishes', async () => {
  let markOuterStarted!: () => void;
  let releaseOuter!: () => void;
  const outerStarted = new Promise<void>(resolve => { markOuterStarted = resolve; });
  const outerRelease = new Promise<void>(resolve => { releaseOuter = resolve; });

  const outer = runCurrentVideoSummaryHighlightsClearCoordinator(async () => {
    markOuterStarted();
    await outerRelease;
  });
  await outerStarted;
  await runCurrentVideoSummaryHighlightsClearCoordinator(async () => undefined);

  const duringOverlap = getCurrentVideoSummaryHighlightsClearState();
  assert.equal(duringOverlap.clearing, true);
  assert.equal(
    canUseCurrentVideoSummaryHighlightsClearGeneration(duringOverlap.generation),
    false,
  );

  releaseOuter();
  await outer;
  assert.equal(getCurrentVideoSummaryHighlightsClearState().clearing, false);
});

test('post-write invalidation rolls back a replacement and preserves the previous cache row', async () => {
  await resetSummaryCache();
  const envelope = fullTextEnvelope();
  const previous = cacheRecord(envelope, {
    suffix: 'post-write-race',
    model: 'post-write-model',
    message: '此前有效结果',
    lastAccessedAt: 10,
  });
  await putCurrentVideoSummaryHighlightsCache(previous);

  let releaseWrite!: () => void;
  let markPaused!: () => void;
  let authorizationEnabled = true;
  const paused = new Promise<void>(resolve => { markPaused = resolve; });
  const resume = new Promise<void>(resolve => { releaseWrite = resolve; });
  const replacement = {
    ...previous,
    generatedAt: 20,
    lastAccessedAt: 20,
    requestAudit: {
      ...previous.requestAudit,
      requestId: 'post-write-replacement',
    },
    result: {
      ...previous.result,
      generatedAt: 20,
      requestId: 'post-write-replacement',
      message: '不应保留的新结果',
    },
  };
  const lateWrite = putCurrentVideoSummaryHighlightsCache(replacement, {
    canWrite: () => authorizationEnabled,
    afterWrite: async () => {
      markPaused();
      await resume;
    },
  });

  await paused;
  authorizationEnabled = false;
  releaseWrite();
  const result = await lateWrite;
  assert.equal(result.cached, false);
  assert.equal(result.rejectedReason, 'invalidated');
  const rows = await db.currentVideoSummaryHighlights.toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.result.message, '此前有效结果');
  assert.equal(rows[0]?.result.requestId, previous.result.requestId);
  assert.equal(rows[0]?.requestAudit.requestId, previous.requestAudit.requestId);
});

test('cache prunes by 50 records and 5 MB LRU, then reports clear readback', async () => {
  await resetSummaryCache();
  const envelope = fullTextEnvelope();
  for (let index = 0; index < CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_RECORDS + 3; index += 1) {
    await putCurrentVideoSummaryHighlightsCache(cacheRecord(envelope, {
      suffix: `r${index}`,
      model: `model-${index}`,
      lastAccessedAt: index + 1,
    }));
  }
  const usageByCount = await collectCurrentVideoSummaryHighlightsCacheUsage();
  assert.equal(usageByCount.count, CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_RECORDS);

  await resetSummaryCache();
  const largeMessage = '超大缓存'.repeat(160_000);
  for (let index = 0; index < 8; index += 1) {
    await putCurrentVideoSummaryHighlightsCache(cacheRecord(envelope, {
      suffix: `large-${index}`,
      model: `large-model-${index}`,
      message: largeMessage,
      lastAccessedAt: index + 1,
    }));
  }
  const usageBySize = await collectCurrentVideoSummaryHighlightsCacheUsage();
  assert.ok(usageBySize.usageBytes <= CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_BYTES);
  assert.ok(usageBySize.count < 8);
  const storedRows = await db.currentVideoSummaryHighlights.toArray();
  const actualStoredBytes = storedRows.reduce(
    (sum, row) => sum + new TextEncoder().encode(JSON.stringify(row)).byteLength,
    0,
  );
  assert.equal(actualStoredBytes, usageBySize.usageBytes);
  assert.ok(actualStoredBytes <= CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_BYTES);
  for (const row of storedRows) {
    assert.equal(row.serializedBytes, new TextEncoder().encode(JSON.stringify(row)).byteLength);
  }

  const cleared = await clearCurrentVideoSummaryHighlightsCache();
  assert.equal(cleared.currentVideoSummaryHighlightParts, usageBySize.count);
  assert.equal((await readCurrentVideoSummaryHighlightsAfterClear()).empty, true);
});

test('persisted cache rows contain no second copy of primary text', async () => {
  await resetSummaryCache();
  const envelope = fullTextEnvelope();
  await putCurrentVideoSummaryHighlightsCache(cacheRecord(envelope, {
    suffix: 'no-primary-text-copy',
    model: 'privacy-model',
    lastAccessedAt: 100,
  }));

  const rows = await db.currentVideoSummaryHighlights.toArray();
  assert.equal(rows.length, 1);
  const persisted = JSON.stringify(rows[0]);
  assert.doesNotMatch(persisted, /完整正文第 [1-6] 行/);
  assert.equal('requestSnapshot' in rows[0], false);
  assert.equal('lines' in rows[0].requestAudit.text, false);
  assert.equal(rows[0].requestAudit.primaryTextIdentity.lineCount, 6);
});

test('highlight confirmation binding rejects same-key regeneration until a new preview', () => {
  const envelope = fullTextEnvelope();
  const oldRecord = cacheRecord(envelope, {
    suffix: 'binding',
    model: 'binding-model',
    lastAccessedAt: 100,
  });
  const oldBinding = currentVideoSummaryHighlightBindingFromResult(oldRecord.result, 'highlight-1');
  assert.ok(oldBinding);
  assert.equal(currentVideoSummaryHighlightBindingMatchesRecord(oldBinding, oldRecord), true);

  const replacement = {
    ...oldRecord,
    generatedAt: 101,
    requestAudit: {
      ...oldRecord.requestAudit,
      requestId: 'replacement-request',
    },
    result: {
      ...oldRecord.result,
      generatedAt: 101,
      requestId: 'replacement-request',
      highlights: oldRecord.result.highlights.map((highlight, index) => index === 0
        ? { ...highlight, title: '替换后的第一个亮点', startSeconds: 8, endSeconds: 14 }
        : highlight),
    },
  };
  assert.equal(currentVideoSummaryHighlightBindingMatchesRecord(oldBinding, replacement), false);
});

function fullTextEnvelope() {
  const segments = transcriptSegments();
  return buildCurrentVideoFullTextRequestEnvelope({
    operation: 'summary_highlights',
    submittedAt: 10_000,
    model: 'test-model',
    video: {
      bvid: 'BV1SummaryHi',
      cid: 6101,
      page: 1,
      title: '摘要亮点测试视频',
      partTitle: '主视频',
      durationSeconds: 120,
    },
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    sourceLabel: 'B站字幕',
    language: 'zh-CN',
    lines: segments.map(segment => ({
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: segment.text,
    })),
  });
}

function fullTextEnvelopeWithLineCount(lineCount: number) {
  return buildCurrentVideoFullTextRequestEnvelope({
    operation: 'summary_highlights',
    submittedAt: 10_000,
    model: 'test-model',
    video: {
      bvid: 'BV1SummaryHi',
      cid: 6101,
      page: 1,
      title: '摘要亮点测试视频',
      partTitle: '主视频',
      durationSeconds: Math.max(120, lineCount * 10),
    },
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    sourceLabel: 'B站字幕',
    language: 'zh-CN',
    lines: Array.from({ length: lineCount }, (_, index) => ({
      startSeconds: index * 10,
      endSeconds: index * 10 + 9,
      text: `扩展正文第 ${index + 1} 行。`,
    })),
  });
}

function validAiOutput(options: { suffix?: string } = {}): CurrentVideoSummaryHighlightsAiOutput {
  const suffix = options.suffix ? ` ${options.suffix}` : '';
  return {
    summarySentences: [
      { text: `视频先说明问题背景和约束。${suffix}`, evidenceLineNumbers: [1, 2] },
      { text: `随后讲解方法和执行步骤。${suffix}`, evidenceLineNumbers: [3, 4] },
      { text: `最后总结结果和后续行动。${suffix}`, evidenceLineNumbers: [5, 6] },
    ],
    keyPoints: [
      { text: `先明确主要问题。${suffix}`, evidenceLineNumbers: [1] },
      { text: `再拆解方法步骤。${suffix}`, evidenceLineNumbers: [3, 4] },
      { text: `最后给出结论。${suffix}`, evidenceLineNumbers: [6] },
    ],
    highlights: [
      { title: `问题提出${suffix}`, description: `开头集中说明要解决的问题。${suffix}`, evidenceLineNumbers: [1] },
      { title: `背景约束${suffix}`, description: `这一段补充限制条件。${suffix}`, evidenceLineNumbers: [2] },
      { title: `方法拆解${suffix}`, description: `中段按步骤解释方案。${suffix}`, evidenceLineNumbers: [3, 4] },
      { title: `结果收束${suffix}`, description: `结尾给出结论和行动。${suffix}`, evidenceLineNumbers: [5, 6] },
    ],
  };
}

function videoContext(): CurrentVideoContext {
  const segments = transcriptSegments();
  const identity = buildCurrentVideoTextSourceIdentity({
    bvid: 'BV1SummaryHi',
    cid: 6101,
    page: 1,
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    lines: segments,
  });
  return {
    kind: 'video',
    url: 'https://www.bilibili.com/video/BV1SummaryHi',
    collectedAt: 10_000,
    bvid: 'BV1SummaryHi',
    cid: 6101,
    title: '摘要亮点测试视频',
    authorName: 'Test UP',
    authorMid: 100,
    durationSeconds: 120,
    currentPart: { page: 1, title: '主视频', total: 1 },
    parts: [{ page: 1, cid: 6101, title: '主视频', durationSeconds: 120 }],
    chapters: [],
    description: { availability: 'available', text: '匿名测试简介。', length: 7 },
    sources: {
      metadata: 'available',
      description: 'available',
      pages: 'available',
      chapters: 'unknown',
      transcript: 'available',
      contentText: 'available',
    },
    transcriptEvidence: {
      status: 'cached',
      active: true,
      checkedAt: 10_000,
      bvid: 'BV1SummaryHi',
      cid: 6101,
      page: 1,
      language: 'zh-CN',
      source: 'bilibili_subtitle',
      sourceType: 'bilibili_player_wbi_v2',
      sourceIdentityKey: identity.sourceIdentityKey,
      sourceHash: identity.sourceHash,
      bodyHash: identity.bodyHash,
      timelineHash: identity.timelineHash,
      segmentCount: segments.length,
      staleSegmentCount: 0,
      serializedBytes: 2048,
      coverageStartSeconds: 0,
      coverageEndSeconds: 59,
      fetchedAt: 10_000,
      updatedAt: 10_000,
      reason: 'cached',
      message: '已缓存当前正文。',
      warnings: [],
    },
    warnings: [],
  };
}

function transcriptSegments(): CurrentVideoTranscriptSegment[] {
  return Array.from({ length: 6 }, (_, index) => {
    const startSeconds = index * 10;
    return {
      segmentId: `summary-hi-${index}`,
      sourceIdentityKey: 'filled-by-identity',
      bvid: 'BV1SummaryHi',
      cid: 6101,
      page: 1,
      startSeconds,
      endSeconds: startSeconds + 9,
      text: `完整正文第 ${index + 1} 行，用于摘要亮点测试。`,
      language: 'zh-CN',
      source: 'bilibili_subtitle',
      sourceType: 'bilibili_player_wbi_v2',
      sourceHash: 'test-source',
      stale: false,
      fetchedAt: 10_000,
      updatedAt: 10_000,
    };
  });
}

function userConfig(options: { enabled: boolean; apiKey: string }): UserConfig {
  return {
    dailyWatchGoal: 60,
    weeklyWatchGoal: 420,
    overDependencyThreshold: 0.3,
    syncIntervalMinutes: 5,
    retentionDays: 90,
    showSidebar: true,
    theme: 'dark',
    ai: {
      baseURL: 'https://example.invalid',
      apiKey: options.apiKey,
      chatModel: 'test-model',
    },
    assistant: {
      currentVideoAiAssistantEnabled: options.enabled,
      smartFavoritesQaAiEnabled: false,
    },
    dynamicBill: {
      aiExplanationsEnabled: false,
    },
  };
}

function deferredChat() {
  let resolveOutput!: (value: CurrentVideoSummaryHighlightsAiOutput) => void;
  let resolveReady!: () => void;
  let resolveRequestId!: (requestId: string) => void;
  const output = new Promise<CurrentVideoSummaryHighlightsAiOutput>((resolve) => {
    resolveOutput = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const requestId = new Promise<string>((resolve) => {
    resolveRequestId = resolve;
  });
  return {
    ready,
    requestId,
    resolve: resolveOutput,
    chat: async (_config: unknown, messages: Array<{ content: string }>) => {
      const payload = JSON.parse(messages[1].content) as { request: { requestId: string } };
      resolveRequestId(payload.request.requestId);
      resolveReady();
      return await output;
    },
  };
}

function deferredRejectingChat() {
  let rejectOutput!: (error: Error) => void;
  let resolveReady!: () => void;
  let signal: AbortSignal | undefined;
  const output = new Promise<CurrentVideoSummaryHighlightsAiOutput>((_resolve, reject) => {
    rejectOutput = reject;
  });
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    ready,
    reject: rejectOutput,
    get signal() {
      return signal;
    },
    chat: async (
      _config: unknown,
      _messages: Array<{ content: string }>,
      options?: { signal?: AbortSignal },
    ) => {
      signal = options?.signal;
      resolveReady();
      return await output;
    },
  };
}

function cacheRecord(
  envelope: ReturnType<typeof fullTextEnvelope>,
  options: {
    suffix: string;
    model: string;
    message?: string;
    lastAccessedAt: number;
  },
) {
  const identity = {
    ...envelope.primaryTextIdentity,
    sourceIdentityKey: `${envelope.primaryTextIdentity.sourceIdentityKey}:${options.suffix}`,
  };
  const cacheKey = buildCurrentVideoSummaryHighlightsCacheKey({ identity, model: options.model });
  const validation = validateCurrentVideoSummaryHighlightsAiOutput(validAiOutput(), envelope);
  if (!validation.ok) throw new Error(`invalid cache fixture: ${validation.reason}`);
  const result = readyCurrentVideoSummaryHighlights({
    title: '缓存测试',
    sourceLabel: 'B站字幕',
    textSize: { lineCount: 6, charCount: 300, utf8Bytes: 600 },
    summarySentences: validation.result.summarySentences,
    keyPoints: validation.result.keyPoints,
    highlights: validation.result.highlights,
    model: options.model,
    cacheKey,
    cacheHit: false,
    current: true,
    requestId: `request-${options.suffix}`,
    generatedAt: options.lastAccessedAt,
  });
  return {
    cacheKey,
    sourceIdentityKey: identity.sourceIdentityKey,
    model: options.model,
    bvid: envelope.video.bvid,
    cid: envelope.video.cid,
    page: envelope.video.page,
    generatedAt: options.lastAccessedAt,
    lastAccessedAt: options.lastAccessedAt,
    requestAudit: {
      ...requestAuditFromEnvelope(envelope),
      primaryTextIdentity: identity,
    },
    result: {
      ...result,
      message: options.message ?? result.message,
    },
  };
}

async function resetSummaryCache(): Promise<void> {
  await db.currentVideoSummaryHighlights.clear();
}
