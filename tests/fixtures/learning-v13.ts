import Dexie from "dexie";

// Frozen production v13 schema from e2a7c5140d6574abc870d547f05eb4b2778a2b69.
export const V13_STORES = {
  watchHistory:
    "++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt",
  playerEvents: "++id, [bvid+cid], eventType, timestamp, tabId",
  dailyAggregates: "++id, &date",
  favoriteFolders: "++id, &mediaId, title, syncedAt",
  favoriteItems:
    "++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt",
  smartFavoriteIndex: "++id, &itemKey, status, indexedAt, contentHash",
  followedCreators:
    "++id, &mid, followedAt, followAgeKnown, isActive, firstSeenAt, syncedAt, lastSeenAt",
  followedVideoUpdates:
    "++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt",
  dynamicBillItems:
    "++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank",
  dynamicBillFeedback:
    "++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt",
  dynamicBillExplanations:
    "++id, &billKey, status, generatedAt, model, contentHash",
  dynamicBillCreatorPauses:
    "++id, &creatorMid, expiresAt, startedAt, source, actionKey, updatedAt",
  dynamicBillFeedbackActions:
    "++id, &actionKey, undoToken, billKey, creatorMid, [billKey+creatorMid], state, undoDeadlineAt, createdAt, finalizedAt",
  dynamicBillCreatorFeedbackCounts:
    "++id, &creatorMid, effectiveCount, updatedAt",
  dynamicBillCreatorReviewPrompts:
    "++id, &creatorMid, state, createdAt, updatedAt",
  dynamicBillRotationRecords:
    "++id, &creatorMid, lastShownAt, lastColumn, updatedAt",
  dynamicBillMigrations: "++id, &version, completedAt",
  currentVideoTranscriptSources:
    "++id, &identityKey, &sourceIdentityKey, partIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, bodyHash, timelineHash, stale, updatedAt, lastAccessedAt",
  currentVideoTranscriptSegments:
    "++id, &segmentId, sourceIdentityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt",
  currentVideoSummaryHighlights:
    "++id, &cacheKey, sourceIdentityKey, [sourceIdentityKey+model], model, bvid, [bvid+cid+page], generatedAt, lastAccessedAt, serializedBytes",
  currentVideoQaSessions: "++id, &sessionId, lastAccessedAt, updatedAt",
};
export async function seedLearningV13(name: string) {
  if (!/^lg[01]-[a-zA-Z0-9-]+$/.test(name))
    throw Error("synthetic_database_only");
  const db = new Dexie(name);
  db.version(13).stores(V13_STORES);
  try {
    await db.open();
    for (const table of db.tables)
      await table.put({ id: 1, lg0SyntheticMarker: table.name });
    const rows: Record<string, unknown[]> = {};
    for (const name of Object.keys(V13_STORES))
      rows[name] = await db.table(name).toArray();
    const before = JSON.stringify(rows, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
    return { stores: V13_STORES, before };
  } finally {
    db.close();
  }
}
