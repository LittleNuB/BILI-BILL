import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildLocalDataDiagnosticExport,
  buildLocalDataOperationMessage,
  buildLocalDataSummaryCards,
  buildSmartFavoriteRebuildMessage,
  dangerousLocalDataClearScope,
  hasLocalDataCategoryContent,
  LOCAL_DATA_CLEAR_CONFIRMATION,
} from '../src/shared/local-data-privacy.ts';
import {
  runLocalDataCategoryLifecycle,
  runLocalDataCategoryLifecycles,
  validateLocalDataCategoryRegistration,
  type LocalDataCategoryRegistration,
  type LocalDataCategoryReadback,
} from '../src/shared/local-data-category-contract.ts';
import type {
  LocalDataOperationResult,
  LocalDataPrivacySummary,
  SmartFavoriteIndexRebuildResult,
} from '../src/shared/types/local-data-privacy.ts';
import {
  dynamicBillCreatorDisplayName,
  UNAVAILABLE_DYNAMIC_BILL_CREATOR_NAME,
} from '../src/shared/dynamic-bill-creator-name.ts';

test('settings local data cards expose natural Chinese summaries only', () => {
  const cards = buildLocalDataSummaryCards(makeSummary());
  assert.deepEqual(cards.map(card => card.title), [
    '观看历史',
    '收藏与智能索引',
    'B站字幕正文',
    '摘要与亮点',
    '问答会话',
    '动态账单',
    '盲盒抽取记录',
  ]);
  assert.match(cards.map(card => card.value).join('\n'), /128 条/);
  assert.match(cards.find(card => card.id === 'favorites')?.detail ?? '', /已同步 4 个收藏夹/);
  assert.equal(cards.find(card => card.id === 'blindBoxDrawHistory')?.value, '2 条');
  assert.match(cards.find(card => card.id === 'blindBoxDrawHistory')?.detail ?? '', /不提供单独开关或单独清理入口/);
  const copy = JSON.stringify(cards);
  assert.doesNotMatch(copy, /暂停|轮换|动态反馈/);
  assertCleanUserCopy(copy);
});

test('settings cards keep recent sync evidence visible in incomplete states', () => {
  const summary = makeSummary();
  summary.favorites.incompleteFolders = 2;
  summary.favorites.syncComplete = false;
  summary.history.syncing = true;

  const cards = buildLocalDataSummaryCards(summary);
  const favorites = cards.find(card => card.id === 'favorites');
  const dynamicBill = cards.find(card => card.id === 'dynamicBill');

  assert.match(favorites?.meta ?? '', /最近同步：/);
  assert.match(favorites?.meta ?? '', /2 个收藏夹可能尚未同步完整/);
  assert.match(cards.find(card => card.id === 'history')?.meta ?? '', /最近同步：/);
  assert.match(cards.find(card => card.id === 'history')?.meta ?? '', /正在同步观看历史/);
  assert.match(dynamicBill?.meta ?? '', /最近生成：/);
  assert.match(dynamicBill?.meta ?? '', /最近同步：/);
  assertCleanUserCopy([favorites?.meta ?? '', dynamicBill?.meta ?? ''].join('\n'));
});

test('settings clear availability follows registered category usage, including metadata-only data', () => {
  const summary = makeSummary();
  const history = summary.categories.find(category => category.id === 'history');
  const subtitles = summary.categories.find(category => category.id === 'currentVideoSubtitles');
  const dynamicBill = summary.categories.find(category => category.id === 'dynamicBill');
  assert.ok(history);
  assert.ok(subtitles);
  assert.ok(dynamicBill);

  Object.assign(history, { count: 0, usageBytes: 128 });
  Object.assign(subtitles, { count: 1, usageBytes: 64 });
  Object.assign(dynamicBill, { count: 0, usageBytes: 96 });
  summary.currentVideoSubtitles.segmentCount = 0;

  assert.equal(hasLocalDataCategoryContent(summary, 'history'), true);
  assert.equal(hasLocalDataCategoryContent(summary, 'currentVideoSubtitles'), true);
  assert.equal(hasLocalDataCategoryContent(summary, 'dynamicBill'), true);

  Object.assign(history, { count: 0, usageBytes: 0 });
  Object.assign(subtitles, { count: 0, usageBytes: 0 });
  Object.assign(dynamicBill, { count: 0, usageBytes: 0 });
  assert.equal(hasLocalDataCategoryContent(summary, 'history'), false);
  assert.equal(hasLocalDataCategoryContent(summary, 'currentVideoSubtitles'), false);
  assert.equal(hasLocalDataCategoryContent(summary, 'dynamicBill'), false);
});

test('settings page keeps Dynamic Bill storage internals out of ordinary copy', async () => {
  const source = await readFile(
    new URL('../dashboard/modules/settings/SettingsPage.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /账单暂停记录|账单轮换记录/);
  assert.doesNotMatch(source, /dynamicBill\.(creatorPauseCount|rotationRecordCount|feedbackCount)/);
  assert.match(source, /当前暂停 \{pauses\.length\} 位 UP/);
  assert.match(source, /当前视频 AI 助手只在功能已开启且你主动发起任务时/);
  assert.doesNotMatch(source, /AI 请求只发送当前功能需要的最小证据片段/);
});

test('settings hides missing or identifier-only paused creator names', async () => {
  for (const creatorName of [
    '',
    '9527',
    'UP 9527',
    '  up   9527  ',
    'UP9527',
    'UP主9527',
    'UP-9527',
    'UP 主 - 9527',
    '９５２７',
    'UP 主 ９５２７',
  ]) {
    assert.equal(
      dynamicBillCreatorDisplayName({ creatorMid: 9527, creatorName }),
      UNAVAILABLE_DYNAMIC_BILL_CREATOR_NAME,
    );
  }
  assert.equal(
    dynamicBillCreatorDisplayName({ creatorMid: 9527, creatorName: '自然名称' }),
    '自然名称',
  );

  const source = await readFile(
    new URL('../dashboard/modules/settings/SettingsPage.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /dynamicBillCreatorDisplayName\(pause\)/);
  assert.doesNotMatch(source, /UP \$\{pause\.creatorMid\}/);
});

test('full clear coordinates config and popup-window writes through final readback', async () => {
  const [privacySource, configSource, indexSource] = await Promise.all([
    readFile(new URL('../src/background/storage/local-data-privacy-repo.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/background/storage/config-store.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/background/index.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(privacySource, /runLocalSettingsClearDataOperation\(clearAllLocalDataExclusive\)/);
  assert.match(configSource, /runLocalSettingsWriteOperation\(async \(\) =>/);
  assert.match(configSource, /tryRunLocalSettingsWriteOperation/);
  assert.equal((indexSource.match(/tryRunLocalSettingsWriteOperation/g) ?? []).length, 3);
});

test('settings page exposes six independently clearable categories and keeps blind-box history count-only', async () => {
  const source = await readFile(
    new URL('../dashboard/modules/settings/SettingsPage.tsx', import.meta.url),
    'utf8',
  );

  for (const categoryId of [
    'history',
    'favorites',
    'currentVideoSubtitles',
    'currentVideoSummaryHighlights',
    'currentVideoQaSessions',
    'dynamicBill',
  ]) {
    assert.match(source, new RegExp(`clearCategory\\('${categoryId}'`), categoryId);
  }
  for (const label of [
    '清理观看历史',
    '清理收藏与索引',
    '清理字幕缓存',
    '清理摘要亮点缓存',
    '清理问答会话',
    '清理动态账单',
  ]) {
    assert.match(source, new RegExp(label), label);
  }
  assert.doesNotMatch(source, /clearCategory\('blindBoxDrawHistory'/);
  assert.match(source, /hasLocalDataCategoryContent/);
  assert.doesNotMatch(source, /currentVideoSubtitles\.segmentCount === 0/);
});

test('settings local data operation messages stay bounded to counts', () => {
  const subtitleMessage = buildLocalDataOperationMessage({
    operation: 'clear_current_video_subtitle_cache',
    completedAt: 1_718_000_000_000,
    cleared: {
      currentVideoSubtitleSources: 3,
      currentVideoSubtitleSegments: 42,
    },
  });
  assert.equal(subtitleMessage, '已清理B站字幕正文：移除 3 条来源记录和 42 段字幕正文。');

  const categoryMessage = buildLocalDataOperationMessage({
    operation: 'clear_local_data_category',
    status: 'completed',
    completedAt: 1_718_000_000_000,
    cleared: { favoriteItems: 24 },
    categoryResults: {
      completed: [{
        id: 'favorites',
        label: '收藏与智能索引',
        beforeCount: 28,
        beforeUsageBytes: 2048,
        afterCount: 0,
        afterUsageBytes: 0,
      }],
      failed: [],
    },
  });
  assert.equal(categoryMessage, '已清理收藏与智能索引：清理前共 28 项本地数据，回读后为 0。');

  const metadataOnlyCategoryMessage = buildLocalDataOperationMessage({
    operation: 'clear_local_data_category',
    status: 'completed',
    completedAt: 1_718_000_000_000,
    cleared: { dynamicBillItems: 0 },
    categoryResults: {
      completed: [{
        id: 'dynamicBill',
        label: '动态账单',
        beforeCount: 0,
        beforeUsageBytes: 160,
        afterCount: 0,
        afterUsageBytes: 0,
      }],
      failed: [],
    },
  });
  assert.equal(metadataOnlyCategoryMessage, '已清理动态账单：清理前存在本地状态，回读后已清空。');

  const clearAllMessage = buildLocalDataOperationMessage({
    operation: 'clear_all_local_data',
    status: 'completed',
    completedAt: 1_718_000_000_000,
    cleared: {
      historyRecords: 128,
      favoriteItems: 24,
      currentVideoSubtitleSegments: 42,
      currentVideoSummaryHighlightParts: 2,
      currentVideoQaSessions: 1,
      dynamicBillItems: 6,
      blindBoxDrawHistory: 2,
      localSettings: true,
    },
    categoryResults: {
      completed: [
        { id: 'history', label: '观看历史', beforeCount: 128, beforeUsageBytes: 4096, afterCount: 0, afterUsageBytes: 0 },
        { id: 'favorites', label: '收藏与智能索引', beforeCount: 24, beforeUsageBytes: 2048, afterCount: 0, afterUsageBytes: 0 },
        { id: 'currentVideoSubtitles', label: 'B站字幕正文', beforeCount: 1, beforeUsageBytes: 96, afterCount: 0, afterUsageBytes: 0 },
        { id: 'currentVideoSummaryHighlights', label: '摘要与亮点', beforeCount: 2, beforeUsageBytes: 2048, afterCount: 0, afterUsageBytes: 0 },
        { id: 'currentVideoQaSessions', label: '问答会话', beforeCount: 1, beforeUsageBytes: 1024, afterCount: 0, afterUsageBytes: 0 },
        { id: 'dynamicBill', label: '动态账单', beforeCount: 0, beforeUsageBytes: 160, afterCount: 0, afterUsageBytes: 0 },
        { id: 'blindBoxDrawHistory', label: '盲盒抽取记录', beforeCount: 2, beforeUsageBytes: 96, afterCount: 0, afterUsageBytes: 0 },
        { id: 'localSettings', label: '本地 AI 设置', beforeCount: 3, beforeUsageBytes: 512, afterCount: 0, afterUsageBytes: 0 },
      ],
      failed: [],
    },
  } satisfies LocalDataOperationResult);
  assert.match(clearAllMessage, /已完成类别：观看历史、收藏与智能索引、B站字幕正文/);
  assert.match(clearAllMessage, /当前视频主要文本选择和浮窗状态也已恢复为默认状态/);
  assert.doesNotMatch(clearAllMessage, /字幕正文 0 段|动态账单 0 项/);
  assert.doesNotMatch(clearAllMessage, /暂停|轮换|动态反馈/);
  assertCleanUserCopy([subtitleMessage, categoryMessage, metadataOnlyCategoryMessage, clearAllMessage].join('\n'));
});

test('settings clear-all partial failure message names failed categories and keeps successes completed', () => {
  const message = buildLocalDataOperationMessage({
    operation: 'clear_all_local_data',
    status: 'partial_failure',
    completedAt: 1_718_000_000_000,
    cleared: {
      historyRecords: 128,
      currentVideoSubtitleSegments: 42,
      dynamicBillItems: 6,
    },
    categoryResults: {
      completed: [
        {
          id: 'history',
          label: '观看历史',
          beforeCount: 128,
          beforeUsageBytes: 4096,
          afterCount: 0,
          afterUsageBytes: 0,
        },
        {
          id: 'currentVideoSubtitles',
          label: 'B站字幕正文',
          beforeCount: 3,
          beforeUsageBytes: 8192,
          afterCount: 0,
          afterUsageBytes: 0,
        },
        {
          id: 'dynamicBill',
          label: '动态账单',
          beforeCount: 9,
          beforeUsageBytes: 2048,
          afterCount: 0,
          afterUsageBytes: 0,
        },
      ],
      failed: [
        {
          id: 'favorites',
          label: '收藏与智能索引',
          message: '收藏与智能索引清理失败，已完成的其他类别不会受影响。',
        },
        {
          id: 'currentVideoQaSessions',
          label: '问答会话',
          message: '问答会话已执行清理，但结果回读失败，请刷新后核对。',
        },
      ],
    },
  });

  assert.match(message, /已完成 3 类数据清理并完成回读/);
  assert.match(message, /收藏与智能索引、问答会话/);
  assertCleanUserCopy(message);
});

test('settings diagnostic export is aggregate-only and does not expose raw records', () => {
  const diagnostic = buildLocalDataDiagnosticExport(makeSummary());
  const text = JSON.stringify(diagnostic);

  assert.deepEqual(diagnostic['本地数据类别'].map(category => category['类别']), [
    '观看历史',
    '收藏与智能索引',
    'B站字幕正文',
    '摘要与亮点',
    '问答会话',
    '动态账单',
    '盲盒抽取记录',
    '本地 AI 设置',
  ]);
  assert.equal(diagnostic['功能状态']['视频盲盒']['最近抽取'], 2);
  assert.deepEqual(diagnostic['隐私边界']['包含'], [
    '本地数据类别名称、数量和占用',
    '动态账单与盲盒的宽泛状态和必要时间',
  ]);
  assert.ok(diagnostic['隐私边界']['不包含'].length > 0);
  assert.doesNotMatch(text, /完整字幕|完整记录正文|原文片段/);
  assert.doesNotMatch(text, /exportedAt|diagnosticSchema|usageBytes|bilibiliSubtitleSources|syncStatus/);
  assert.doesNotMatch(text, /Cookie|Key|BVID|CID|transcript|confidence|sourceHash|segmentId|subtitle_url|C:\\|\/Users\//i);
  assertCleanUserCopy(text);
});

test('settings local data surface does not advertise unavailable local transcription hooks', async () => {
  const surface = (await Promise.all([
    readFile(new URL('../dashboard/modules/settings/SettingsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/shared/local-data-privacy.ts', import.meta.url), 'utf8'),
  ])).join('\n');

  assert.doesNotMatch(surface, /ASR|本地转录|本地转写|转录模型|local_transcript|localTranscript/i);
});

test('settings dangerous clear scope requires explicit Chinese confirmation', () => {
  assert.equal(LOCAL_DATA_CLEAR_CONFIRMATION, '清理本地数据');
  const scope = dangerousLocalDataClearScope().join('\n');
  assert.match(scope, /本地 AI 服务设置/);
  assert.match(scope, /当前视频主要文本选择/);
  assert.match(scope, /浮窗状态/);
  assertCleanUserCopy(scope);
});

test('settings smart favorite rebuild message summarizes the run', () => {
  const message = buildSmartFavoriteRebuildMessage({
    totalItems: 24,
    clearedIndexes: 21,
    processed: 24,
    indexed: 22,
    failed: 2,
    skipped: 0,
    notes: [],
    completedAt: 1_718_000_000_000,
  } satisfies SmartFavoriteIndexRebuildResult);
  assert.match(message, /本地收藏 24 条/);
  assert.match(message, /失败项可在确认 AI 设置后再次重建/);
  assertCleanUserCopy(message);
});

test('local data categories expose the shared lifecycle contract', async () => {
  const source = await readFile(
    new URL('../src/background/storage/local-data-category-registry.ts', import.meta.url),
    'utf8',
  );
  const returnBlock = source.match(/return \[([\s\S]*?)\];/)?.[1] ?? '';
  const getters = [...returnBlock.matchAll(/\b(get[A-Za-z]+CategoryRegistration)\(\)/g)]
    .map(match => match[1]);
  assert.deepEqual(getters, [
    'getHistoryLocalDataCategoryRegistration',
    'getFavoritesLocalDataCategoryRegistration',
    'getCurrentVideoTranscriptLocalDataCategoryRegistration',
    'getCurrentVideoSummaryHighlightsLocalDataCategoryRegistration',
    'getCurrentVideoQaSessionsLocalDataCategoryRegistration',
    'getDynamicBillLocalDataCategoryRegistration',
    'getBlindBoxDrawHistoryLocalDataCategoryRegistration',
    'getLocalSettingsDataCategoryRegistration',
    'getExplicitMemoryDataCategoryRegistration',
  ]);

  const ids: LocalDataCategoryRegistration['id'][] = [
    'history',
    'favorites',
    'currentVideoSubtitles',
    'currentVideoSummaryHighlights',
    'currentVideoQaSessions',
    'dynamicBill',
    'blindBoxDrawHistory',
    'localSettings',
    'explicitMemory',
  ];
  const categories = ids.map(id => lifecycleRegistration(id, id, []));

  for (const category of categories) {
    assert.deepEqual(validateLocalDataCategoryRegistration(category), []);
    assert.equal(category.includeInClearAll, true);
  }
});

test('registered category registry composes module-owned hooks without private table knowledge', async () => {
  const source = await readFile(
    new URL('../src/background/storage/local-data-category-registry.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /getHistoryLocalDataCategoryRegistration/);
  assert.match(source, /getCurrentVideoTranscriptLocalDataCategoryRegistration/);
  assert.match(source, /getDynamicBillLocalDataCategoryRegistration/);
  assert.match(source, /getLocalSettingsDataCategoryRegistration/);
  assert.doesNotMatch(source, /\bdb\./);
  assert.doesNotMatch(source, /currentVideoTranscriptSources|dynamicBillItems|favoriteItems/);
});

test('lifecycle results retain completed categories and name a failed category in natural Chinese', async () => {
  const calls: string[] = [];
  const registrations = [
    lifecycleRegistration('history', '观看历史', calls),
    lifecycleRegistration('favorites', '收藏与智能索引', calls, 'clear'),
    lifecycleRegistration('dynamicBill', '动态账单', calls),
  ];

  const results = await runLocalDataCategoryLifecycles(registrations);

  assert.deepEqual(results.map(result => result.status), ['success', 'failure', 'success']);
  assert.deepEqual(calls, [
    '观看历史:usage',
    '观看历史:clear',
    '观看历史:readback',
    '收藏与智能索引:usage',
    '收藏与智能索引:clear',
    '动态账单:usage',
    '动态账单:clear',
    '动态账单:readback',
  ]);
  assert.equal(results[0].status === 'success' && results[0].after.empty, true);
  assert.equal(results[1].status, 'failure');
  if (results[1].status === 'failure') {
    assert.equal(results[1].failedStage, 'clear');
    assert.match(results[1].message, /收藏与智能索引清理失败/);
    assert.equal(results[1].before?.count, 1);
  }
});

test('lifecycle reports a readback failure whenever cleared data remains', async t => {
  const cases: Array<{ name: string; after: LocalDataCategoryReadback }> = [
    {
      name: 'empty is false',
      after: { count: 0, usageBytes: 0, empty: false },
    },
    {
      name: 'count is non-zero',
      after: { count: 1, usageBytes: 0, empty: true },
    },
    {
      name: 'usage is non-zero',
      after: { count: 0, usageBytes: 16, empty: true },
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, async () => {
      const registration = lifecycleRegistration('history', '观看历史', []);
      registration.readAfterClear = async () => currentCase.after;

      const result = await runLocalDataCategoryLifecycle(registration);

      assert.equal(result.status, 'failure');
      if (result.status === 'failure') {
        assert.equal(result.failedStage, 'readback');
        assert.equal(result.failureReason, 'data_remaining');
        assert.deepEqual(result.after, currentCase.after);
        assert.match(result.message, /观看历史已执行清理，但回读后仍有本地数据/);
        assertCleanUserCopy(result.message);
      }
    });
  }
});

test('SET-013-B clear-all production path invokes registered category hooks', async () => {
  const source = await readFile(
    new URL('../src/background/storage/local-data-privacy-repo.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /runLocalDataCategoryLifecycles\(categories\)/);
  assert.match(source, /summarizeLifecycleResults\(results\)/);
  assert.match(source, /id === 'favorites'[\s\S]*?runFavoriteDataOperation/);
  assert.match(source, /runFavoriteDataOperation\([\s\S]*?clearAllLocalDataExclusive/);
  assert.match(source, /runLocalSettingsClearDataOperation\(clearAllLocalDataExclusive\)/);
  assert.doesNotMatch(source, /db\.transaction\(\s*'rw',\s*db\.tables/);
  assert.doesNotMatch(source, /chrome\.storage\.local\.clear\(\)/);
  assert.doesNotMatch(source, /coordinateBlindBoxDrawHistoryClear/);
});

test('independent QA session clear uses the shared write coordinator', async () => {
  const source = await readFile(
    new URL('../src/background/storage/current-video-qa-session-repo.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /getCurrentVideoQaSessionsLocalDataCategoryRegistration/);
  assert.match(source, /clear:[\s\S]*?invalidateCurrentVideoFullTextQaSources\(\)/);
  assert.match(source, /clear:[\s\S]*?clearCurrentVideoQaSessions\(\)/);
});

function makeSummary(): LocalDataPrivacySummary {
  return {
    checkedAt: 1_718_000_000_000,
    categories: [
      { id: 'history', label: '观看历史', count: 128, usageBytes: 4096 },
      { id: 'favorites', label: '收藏与智能索引', count: 24, usageBytes: 2048 },
      { id: 'currentVideoSubtitles', label: 'B站字幕正文', count: 3, usageBytes: 8192 },
      { id: 'currentVideoSummaryHighlights', label: '摘要与亮点', count: 2, usageBytes: 2048 },
      { id: 'currentVideoQaSessions', label: '问答会话', count: 1, usageBytes: 1024 },
      { id: 'dynamicBill', label: '动态账单', count: 9, usageBytes: 3072 },
      { id: 'blindBoxDrawHistory', label: '盲盒抽取记录', count: 2, usageBytes: 96 },
      { id: 'localSettings', label: '本地 AI 设置', count: 3, usageBytes: 512 },
    ],
    history: {
      totalRecords: 128,
      oldestViewAt: 1_700_000_000,
      newestViewAt: 1_718_000_000,
      lastSyncedAt: 1_718_000_000_000,
      syncing: false,
      backfillComplete: true,
    },
    favorites: {
      folderCount: 4,
      reportedItems: 28,
      storedItems: 24,
      indexedItems: 21,
      failedIndexItems: 1,
      pendingIndexItems: 2,
      incompleteFolders: 0,
      syncComplete: true,
      lastSyncedAt: 1_718_000_000_000,
      lastIndexedAt: 1_718_000_000_000,
    },
    currentVideoSubtitles: {
      sourceCount: 3,
      sourceIdentityCount: 3,
      segmentCount: 42,
      staleSegmentCount: 4,
      cachedVideoCount: 2,
      usageBytes: 8192,
      lastUpdatedAt: 1_718_000_000_000,
    },
    currentVideoSummaryHighlights: {
      cachedPartCount: 2,
      usageBytes: 2048,
      latestGeneratedAt: 1_718_000_000_000,
    },
    currentVideoQaSessions: {
      sessionCount: 1,
      usageBytes: 1024,
      latestUsedAt: 1_718_000_000_000,
    },
    dynamicBill: {
      activeFollowedCreatorCount: 12,
      followedVideoUpdateCount: 8,
      billItemCount: 6,
      rotationRecordCount: 4,
      creatorPauseCount: 1,
      feedbackActionCount: 0,
      creatorFeedbackCount: 0,
      creatorReviewPromptCount: 0,
      activeCreatorPauses: [],
      unopenedItems: 2,
      openedItems: 1,
      consumedItems: 2,
      processedItems: 1,
      explanationCount: 5,
      lastGeneratedAt: 1_718_000_000_000,
      lastSyncedAt: 1_718_000_000_000,
      syncStatus: 'success',
    },
    blindBoxDrawHistory: {
      recentDrawCount: 2,
      maxRecentDraws: 50,
      usageBytes: 96,
      lastUpdatedAt: 1_718_000_000_000,
    },
  };
}

function lifecycleRegistration(
  id: LocalDataCategoryRegistration['id'],
  label: string,
  calls: string[],
  failAt?: 'usage' | 'clear' | 'readback',
): LocalDataCategoryRegistration {
  return {
    id,
    label,
    includeInClearAll: true,
    collectUsage: async () => {
      calls.push(`${label}:usage`);
      if (failAt === 'usage') throw new Error('raw usage failure');
      return { count: 1, usageBytes: 10 };
    },
    clear: async () => {
      calls.push(`${label}:clear`);
      if (failAt === 'clear') throw new Error('raw clear failure');
      return { cleared: {} };
    },
    readAfterClear: async () => {
      calls.push(`${label}:readback`);
      if (failAt === 'readback') throw new Error('raw readback failure');
      return { count: 0, usageBytes: 0, empty: true };
    },
  };
}

function assertCleanUserCopy(text: string): void {
  const forbidden = [
    'G' + 'ET_',
    'C' + 'LEAR_',
    'R' + 'EBUILD_',
    'source' + 'Hash',
    'segment' + 'Id',
    'subtitle' + '_url',
    'DB ' + 'table',
    'Key' + '.txt',
  ];
  for (const token of forbidden) {
    assert.doesNotMatch(text, new RegExp(escapeRegExp(token), 'i'));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
