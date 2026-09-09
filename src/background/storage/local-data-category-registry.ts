import type {
  LocalDataCategoryId,
  LocalDataCategoryRegistration,
} from '../../shared/local-data-category-contract.ts';
import { getHistoryLocalDataCategoryRegistration } from './watch-history-repo.ts';
import { getFavoritesLocalDataCategoryRegistration } from './favorite-repo.ts';
import { getCurrentVideoTranscriptLocalDataCategoryRegistration } from './current-video-transcript-repo.ts';
import { getCurrentVideoSummaryHighlightsLocalDataCategoryRegistration } from './current-video-summary-highlights-repo.ts';
import { getCurrentVideoQaSessionsLocalDataCategoryRegistration } from './current-video-qa-session-repo.ts';
import { getDynamicBillLocalDataCategoryRegistration } from './dynamic-bill-repo.ts';
import { getBlindBoxDrawHistoryLocalDataCategoryRegistration } from './blind-box-draw-history-repo.ts';
import { getLocalSettingsDataCategoryRegistration } from './local-settings-data-category.ts';
import { getExplicitMemoryDataCategoryRegistration } from './explicit-memory-data-category.ts';

export function getRegisteredLocalDataCategories(): LocalDataCategoryRegistration[] {
  return [
    getHistoryLocalDataCategoryRegistration(),
    getFavoritesLocalDataCategoryRegistration(),
    getCurrentVideoTranscriptLocalDataCategoryRegistration(),
    getCurrentVideoSummaryHighlightsLocalDataCategoryRegistration(),
    getCurrentVideoQaSessionsLocalDataCategoryRegistration(),
    getDynamicBillLocalDataCategoryRegistration(),
    getBlindBoxDrawHistoryLocalDataCategoryRegistration(),
    getLocalSettingsDataCategoryRegistration(),
    getExplicitMemoryDataCategoryRegistration(),
  ];
}

export function getRegisteredLocalDataCategory(
  id: LocalDataCategoryId,
): LocalDataCategoryRegistration | null {
  return getRegisteredLocalDataCategories().find(category => category.id === id) ?? null;
}
