import Dexie, { type Table } from 'dexie';
import type { WatchHistoryRecord, PlayerEvent, DailyAggregate } from '../../shared/types/watch-event.ts';
import type { FavoriteFolder, FavoriteItem, SmartFavoriteIndex } from '../../shared/types/favorite.ts';
import type {
  DynamicBillCreatorFeedbackCountRecord,
  DynamicBillCreatorPauseRecord,
  DynamicBillExplanation,
  DynamicBillFeedbackActionRecord,
  DynamicBillFeedbackRecord,
  DynamicBillItem,
  DynamicBillMigrationRecord,
  DynamicBillCreatorReviewPromptRecord,
  DynamicBillRotationRecord,
  FollowedCreator,
  FollowedVideoUpdate,
} from '../../shared/types/dynamic-bill.ts';
import type {
  CurrentVideoTranscriptSegment,
  CurrentVideoTranscriptSourceRecord,
} from '../../shared/types/current-video-transcript.ts';
import type { CurrentVideoSummaryHighlightsCacheRecord } from '../../shared/types/current-video-summary.ts';
import type { CurrentVideoQaSessionRecord } from '../../shared/types/current-video-qa-session.ts';
import { clearLegacyCurrentVideoTranscriptCache } from './current-video-transcript-migration.ts';
import type { LearningAsset, LearningMeta } from '../../shared/learning.ts';
import type { WikiState } from '../../shared/video-wiki.ts';
import type { MemoryState } from '../../shared/explicit-memory.ts';

export class BiliAnalyticsDB extends Dexie {
  lgAssets!: Table<LearningAsset, string>;
  lgMeta!: Table<LearningMeta, string>;
  lgWiki!: Table<WikiState, string>;
  explicitMemory!: Table<MemoryState, string>;
  watchHistory!: Table<WatchHistoryRecord, number>;
  playerEvents!: Table<PlayerEvent, number>;
  dailyAggregates!: Table<DailyAggregate, number>;
  favoriteFolders!: Table<FavoriteFolder, number>;
  favoriteItems!: Table<FavoriteItem, number>;
  smartFavoriteIndex!: Table<SmartFavoriteIndex, number>;
  followedCreators!: Table<FollowedCreator, number>;
  followedVideoUpdates!: Table<FollowedVideoUpdate, number>;
  dynamicBillItems!: Table<DynamicBillItem, number>;
  dynamicBillExplanations!: Table<DynamicBillExplanation, number>;
  dynamicBillFeedback!: Table<DynamicBillFeedbackRecord, number>;
  dynamicBillCreatorPauses!: Table<DynamicBillCreatorPauseRecord, number>;
  dynamicBillFeedbackActions!: Table<DynamicBillFeedbackActionRecord, number>;
  dynamicBillCreatorFeedbackCounts!: Table<DynamicBillCreatorFeedbackCountRecord, number>;
  dynamicBillCreatorReviewPrompts!: Table<DynamicBillCreatorReviewPromptRecord, number>;
  dynamicBillRotationRecords!: Table<DynamicBillRotationRecord, number>;
  dynamicBillMigrations!: Table<DynamicBillMigrationRecord, number>;
  currentVideoTranscriptSources!: Table<CurrentVideoTranscriptSourceRecord, number>;
  currentVideoTranscriptSegments!: Table<CurrentVideoTranscriptSegment, number>;
  currentVideoSummaryHighlights!: Table<CurrentVideoSummaryHighlightsCacheRecord, number>;
  currentVideoQaSessions!: Table<CurrentVideoQaSessionRecord, number>;

  constructor(databaseName = 'BiliAnalyticsDB') {
    super(databaseName);
    this.version(1).stores({
      watchHistory:
        '++id, &kid, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
    });

    this.version(2).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
    }).upgrade(async (tx) => {
      const table = tx.table('watchHistory');
      await table.toCollection().modify((record) => {
        if (!record.sessionKey) {
          record.sessionKey = record.kid
            ? `${record.kid}:${record.viewAt}`
            : `${record.bvid ?? ''}:${record.cid ?? 0}:${record.viewAt}`;
        }
      });
    });

    this.version(3).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
    });

    this.version(4).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
    });

    this.version(5).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
    });

    this.version(6).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
      dynamicBillFeedback:
        '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
    });

    this.version(7).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
      dynamicBillFeedback:
        '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
      dynamicBillExplanations:
        '++id, &billKey, status, generatedAt, model, contentHash',
    });

    this.version(8).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
      dynamicBillFeedback:
        '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
      dynamicBillExplanations:
        '++id, &billKey, status, generatedAt, model, contentHash',
      currentVideoTranscriptSources:
        '++id, &identityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
      currentVideoTranscriptSegments:
        '++id, &segmentId, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
    });

    this.version(9).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, firstSeenAt, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
      dynamicBillFeedback:
        '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
      dynamicBillExplanations:
        '++id, &billKey, status, generatedAt, model, contentHash',
      dynamicBillCreatorPauses:
        '++id, &creatorMid, expiresAt, startedAt, source, updatedAt',
      dynamicBillRotationRecords:
        '++id, &creatorMid, lastShownAt, lastColumn, updatedAt',
      dynamicBillMigrations:
        '++id, &version, completedAt',
      currentVideoTranscriptSources:
        '++id, &identityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
      currentVideoTranscriptSegments:
        '++id, &segmentId, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
    }).upgrade(async (tx) => {
      const followedCreators = tx.table('followedCreators');
      await followedCreators.toCollection().modify((creator) => {
        if (!creator.firstSeenAt) {
          creator.firstSeenAt = creator.syncedAt || creator.lastSeenAt || Date.now();
        }
      });
    });

    this.version(10).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, firstSeenAt, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
      dynamicBillFeedback:
        '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
      dynamicBillExplanations:
        '++id, &billKey, status, generatedAt, model, contentHash',
      dynamicBillCreatorPauses:
        '++id, &creatorMid, expiresAt, startedAt, source, updatedAt',
      dynamicBillRotationRecords:
        '++id, &creatorMid, lastShownAt, lastColumn, updatedAt',
      dynamicBillMigrations:
        '++id, &version, completedAt',
      currentVideoTranscriptSources:
        '++id, &identityKey, &sourceIdentityKey, partIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, bodyHash, timelineHash, stale, updatedAt, lastAccessedAt',
      currentVideoTranscriptSegments:
        '++id, &segmentId, sourceIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
    }).upgrade(clearLegacyCurrentVideoTranscriptCache);

    this.version(11).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, firstSeenAt, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
      dynamicBillFeedback:
        '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
      dynamicBillExplanations:
        '++id, &billKey, status, generatedAt, model, contentHash',
      dynamicBillCreatorPauses:
        '++id, &creatorMid, expiresAt, startedAt, source, actionKey, updatedAt',
      dynamicBillFeedbackActions:
        '++id, &actionKey, undoToken, billKey, creatorMid, [billKey+creatorMid], state, undoDeadlineAt, createdAt, finalizedAt',
      dynamicBillCreatorFeedbackCounts:
        '++id, &creatorMid, effectiveCount, updatedAt',
      dynamicBillCreatorReviewPrompts:
        '++id, &creatorMid, state, createdAt, updatedAt',
      dynamicBillRotationRecords:
        '++id, &creatorMid, lastShownAt, lastColumn, updatedAt',
      dynamicBillMigrations:
        '++id, &version, completedAt',
      currentVideoTranscriptSources:
        '++id, &identityKey, &sourceIdentityKey, partIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, bodyHash, timelineHash, stale, updatedAt, lastAccessedAt',
      currentVideoTranscriptSegments:
        '++id, &segmentId, sourceIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
    });

    this.version(12).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, firstSeenAt, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
      dynamicBillFeedback:
        '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
      dynamicBillExplanations:
        '++id, &billKey, status, generatedAt, model, contentHash',
      dynamicBillCreatorPauses:
        '++id, &creatorMid, expiresAt, startedAt, source, actionKey, updatedAt',
      dynamicBillFeedbackActions:
        '++id, &actionKey, undoToken, billKey, creatorMid, [billKey+creatorMid], state, undoDeadlineAt, createdAt, finalizedAt',
      dynamicBillCreatorFeedbackCounts:
        '++id, &creatorMid, effectiveCount, updatedAt',
      dynamicBillCreatorReviewPrompts:
        '++id, &creatorMid, state, createdAt, updatedAt',
      dynamicBillRotationRecords:
        '++id, &creatorMid, lastShownAt, lastColumn, updatedAt',
      dynamicBillMigrations:
        '++id, &version, completedAt',
      currentVideoTranscriptSources:
        '++id, &identityKey, &sourceIdentityKey, partIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, bodyHash, timelineHash, stale, updatedAt, lastAccessedAt',
      currentVideoTranscriptSegments:
        '++id, &segmentId, sourceIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
      currentVideoSummaryHighlights:
        '++id, &cacheKey, sourceIdentityKey, [sourceIdentityKey+model], model, bvid, [bvid+cid+page], generatedAt, lastAccessedAt, serializedBytes',
    });

    this.version(13).stores({
      watchHistory:
        '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
      playerEvents:
        '++id, [bvid+cid], eventType, timestamp, tabId',
      dailyAggregates:
        '++id, &date',
      favoriteFolders:
        '++id, &mediaId, title, syncedAt',
      favoriteItems:
        '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
      smartFavoriteIndex:
        '++id, &itemKey, status, indexedAt, contentHash',
      followedCreators:
        '++id, &mid, followedAt, followAgeKnown, isActive, firstSeenAt, syncedAt, lastSeenAt',
      followedVideoUpdates:
        '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
      dynamicBillItems:
        '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
      dynamicBillFeedback:
        '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
      dynamicBillExplanations:
        '++id, &billKey, status, generatedAt, model, contentHash',
      dynamicBillCreatorPauses:
        '++id, &creatorMid, expiresAt, startedAt, source, actionKey, updatedAt',
      dynamicBillFeedbackActions:
        '++id, &actionKey, undoToken, billKey, creatorMid, [billKey+creatorMid], state, undoDeadlineAt, createdAt, finalizedAt',
      dynamicBillCreatorFeedbackCounts:
        '++id, &creatorMid, effectiveCount, updatedAt',
      dynamicBillCreatorReviewPrompts:
        '++id, &creatorMid, state, createdAt, updatedAt',
      dynamicBillRotationRecords:
        '++id, &creatorMid, lastShownAt, lastColumn, updatedAt',
      dynamicBillMigrations:
        '++id, &version, completedAt',
      currentVideoTranscriptSources:
        '++id, &identityKey, &sourceIdentityKey, partIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, bodyHash, timelineHash, stale, updatedAt, lastAccessedAt',
      currentVideoTranscriptSegments:
        '++id, &segmentId, sourceIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
      currentVideoSummaryHighlights:
        '++id, &cacheKey, sourceIdentityKey, [sourceIdentityKey+model], model, bvid, [bvid+cid+page], generatedAt, lastAccessedAt, serializedBytes',
      currentVideoQaSessions:
        '++id, &sessionId, lastAccessedAt, updatedAt',
    });
    this.version(14).stores({ lgAssets: 'id', lgMeta: 'key' });
    this.version(15).stores({ lgWiki: 'key' }).upgrade(async transaction => {
      const assets = await transaction.table<LearningAsset>('lgAssets').toArray();
      const pages = new Map<string, { bvid: string; createdAt: number; deleted: boolean }>();
      for (const asset of assets) {
        const prior = pages.get(asset.video.bvid);
        if (!prior || asset.createdAt < prior.createdAt) pages.set(asset.video.bvid, { bvid: asset.video.bvid, createdAt: asset.createdAt, deleted: false });
      }
      await transaction.table('lgWiki').put({ key: 'state', revision: 0, pages: [...pages.values()], topics: [], relations: [] });
    });
    this.version(16).stores({ explicitMemory: 'key' });
  }
}

export const db = new BiliAnalyticsDB();
