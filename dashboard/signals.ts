import { signal } from '@preact/signals';
import { DEFAULT_DASHBOARD_TAB, dashboardIndexForHash } from './navigation.ts';
import type {
  DashboardOverview,
  PreferenceAnalytics,
  CreatorFollowDataCoverage, CreatorFollowStatusGroup, CreatorRanking, NewCreator,
  BehaviorMetrics,
  ExperimentData,
} from '../src/shared/types/analytics';

// Module 1: Overview
export const overviewData = signal<DashboardOverview | null>(null);
export const overviewLoading = signal(true);
export const overviewError = signal<string | null>(null);

// Module 2: Preference
export const prefData = signal<PreferenceAnalytics | null>(null);
export const prefLoading = signal(true);
export const prefError = signal<string | null>(null);

// Module 3: Creator
export const creatorData = signal<{
  topCreators: CreatorRanking[];
  deepBondCreators: CreatorRanking[];
  newCreators: NewCreator[];
  followGroups: CreatorFollowStatusGroup[];
  followDataCoverage: CreatorFollowDataCoverage;
  overDependency: { creator: CreatorRanking; percentage: number } | null;
} | null>(null);
export const creatorLoading = signal(true);
export const creatorError = signal<string | null>(null);

// Module 4: Behavior
export const behaviorData = signal<BehaviorMetrics | null>(null);
export const behaviorLoading = signal(true);
export const behaviorError = signal<string | null>(null);

// Module 5: Experiments
export const expData = signal<ExperimentData | null>(null);
export const expLoading = signal(true);
export const expError = signal<string | null>(null);

// Tab navigation
export const activeTab = signal(typeof window === 'undefined' ? DEFAULT_DASHBOARD_TAB : dashboardIndexForHash(window.location.hash));
