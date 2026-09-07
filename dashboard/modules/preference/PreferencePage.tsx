import { useEffect, useState } from 'preact/hooks';
import type { CustomSeriesOption, EChartsOption } from 'echarts';
import { prefData, prefError, prefLoading } from '../../signals';
import { requestSW } from '../../utils/messaging';
import type {
  CategoryDistribution,
  DurationBucket,
  HistoryCoverage,
  InterestDriftGranularity,
  PreferenceAnalytics,
  PreferenceWindowOption,
  PreferenceWindowSummary,
} from '../../../src/shared/types/analytics';
import { ChartContainer } from '../../components/ChartContainer';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { CHART_COLORS } from '../../../src/shared/constants';

const GRANULARITY_OPTIONS: Array<{ value: InterestDriftGranularity; label: string }> = [
  { value: 'daily', label: '日' },
  { value: 'weekly', label: '周' },
  { value: 'monthly', label: '月' },
];

export function PreferencePage() {
  const [selectedGranularity, setSelectedGranularity] = useState<InterestDriftGranularity | null>(null);
  const [selectedWindows, setSelectedWindows] = useState<Partial<Record<InterestDriftGranularity, string>>>({});
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void fetchData();
  }, []);

  async function fetchData(
    granularity?: InterestDriftGranularity,
    windowStart?: string,
  ) {
    const isInitialLoad = prefData.value === null;
    if (isInitialLoad) {
      prefLoading.value = true;
    } else {
      setRefreshing(true);
    }
    prefError.value = null;

    try {
      const data = await requestSW<PreferenceAnalytics>('GET_PREFERENCE_DATA', {
        granularity,
        windowStart,
      });
      prefData.value = data;

      const activeGranularity = data.selectedWindow?.window.granularity ?? granularity ?? data.defaultGranularity;
      setSelectedGranularity(activeGranularity);
      if (data.selectedWindow) {
        setSelectedWindows(prev => ({
          ...prev,
          [data.selectedWindow!.window.granularity]: data.selectedWindow!.window.startDate,
        }));
      }
    } catch (error) {
      prefError.value = (error as Error).message;
    } finally {
      prefLoading.value = false;
      setRefreshing(false);
    }
  }

  const data = prefData.value;
  if (prefLoading.value) return <div style={{ padding: '16px' }}><LoadingSkeleton height={420} /></div>;
  if (prefError.value) return <div style={{ padding: '16px', color: '#FF6B6B' }}>{prefError.value}</div>;
  if (!data) return <EmptyState />;

  const activeGranularity = selectedGranularity ?? data.selectedWindow?.window.granularity ?? data.defaultGranularity;
  const activeWindows = data.windows[activeGranularity] ?? [];
  const selectedWindowStart = selectedWindows[activeGranularity]
    ?? data.selectedWindow?.window.startDate
    ?? activeWindows[0]?.startDate
    ?? '';
  const summary = data.selectedWindow;
  const summaryWindow = summary?.window ?? null;
  const coverageCaveat = summary ? buildCoverageCaveat(summary, data.coverage) : '';
  const currentData = data;

  const categoryPieOption = summary ? buildCategoryPieOption(summary.categories) : null;
  const durationBarOption = summary ? buildDurationBarOption(summary.durationBuckets) : null;
  const wordcloudOption = summary ? buildWordCloudOption(summary.topTags) : null;

  return (
    <ErrorBoundary>
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ background: '#FFFFFF', borderRadius: '6px', padding: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', margin: '0 0 10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <h3 style={{ color: '#EAEAF2', fontSize: '14px', margin: 0 }}>
                {getWindowTitle(activeGranularity)}
              </h3>
              <div style={{ color: '#61666D', fontSize: '12px', lineHeight: 1.6 }}>
                {summaryWindow ? (
                  <>
                    <div>{summaryWindow.label}</div>
                    <div>{summaryWindow.startDate} 至 {summaryWindow.endDate}</div>
                  </>
                ) : (
                  <div>本地还没有可分析的窗口</div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'inline-flex', border: '1px solid rgba(160, 160, 176, 0.28)', borderRadius: '8px', overflow: 'hidden' }} aria-label="兴趣窗口粒度选择">
                {GRANULARITY_OPTIONS.map(option => {
                  const selected = option.value === activeGranularity;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => void handleGranularityChange(option.value)}
                      disabled={refreshing}
                      style={{
                        minWidth: '42px',
                        height: '30px',
                        border: 0,
                        borderRight: option.value === 'monthly' ? 0 : '1px solid rgba(160, 160, 176, 0.2)',
                        background: selected ? '#6C5CE7' : 'transparent',
                        color: selected ? '#FFFFFF' : '#61666D',
                        cursor: refreshing ? 'wait' : 'pointer',
                        fontSize: '13px',
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <select
                value={selectedWindowStart}
                onChange={(event) => void handleWindowChange(event.currentTarget.value)}
                disabled={refreshing || activeWindows.length === 0}
                aria-label="兴趣窗口选择"
                style={{
                  minWidth: '220px',
                  height: '32px',
                  padding: '0 10px',
                  borderRadius: '8px',
                  border: '1px solid rgba(160, 160, 176, 0.28)',
                  background: '#1A1A36',
                  color: '#EAEAF2',
                }}
              >
                {activeWindows.map(window => (
                  <option key={window.key} value={window.startDate}>
                    {formatWindowOption(window)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {refreshing && (
            <div style={{ margin: '0 0 10px', color: '#61666D', fontSize: '12px' }}>
              正在切换窗口…
            </div>
          )}
          {summary ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '10px' }}>
                <MetricCard label="活跃天数" value={`${summary.window.activeDays} 天`} />
                <MetricCard label="样本数" value={`${summary.window.recordCount} 条`} />
                <MetricCard label="观看时长" value={formatWatchTime(summary.window.totalWatchTime)} />
                <MetricCard label="覆盖范围" value={summary.window.partialCoverage ? '窗口不完整' : '窗口内可算'} />
              </div>
              <div style={{ margin: '0 0 12px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(255, 210, 102, 0.1)', color: '#FFD166', fontSize: '12px', lineHeight: 1.6 }}>
                {coverageCaveat}
              </div>
              {summary.state === 'ready' && categoryPieOption ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 300px)', gap: '8px', alignItems: 'center' }}>
                  <ChartContainer option={categoryPieOption} height={300} />
                  <CategoryList categories={summary.categories.slice(0, 8)} />
                </div>
              ) : (
                <WindowStatePanel summary={summary} />
              )}
            </>
          ) : (
            <EmptyState message="本地还没有观看历史记录，无法分析某日、某周或某月的兴趣分布。" />
          )}
        </div>

        <div style={{ background: '#FFFFFF', borderRadius: '6px', padding: '12px' }}>
          <h3 style={{ color: '#EAEAF2', fontSize: '14px', margin: '0 0 10px' }}>视频时长偏好</h3>
          {summary ? (
            summary.state === 'ready' && durationBarOption ? (
              <ChartContainer option={durationBarOption} height={220} />
            ) : (
              <DurationList buckets={summary.durationBuckets} emptyMessage={getDurationEmptyMessage(summary)} />
            )
          ) : (
            <InlineEmpty message="当前没有可显示的时长分布。" />
          )}
        </div>

        <div style={{ background: '#FFFFFF', borderRadius: '6px', padding: '12px' }}>
          <h3 style={{ color: '#EAEAF2', fontSize: '14px', margin: '0 0 10px' }}>高频标签</h3>
          {summary ? (
            summary.state === 'ready' && summary.topTags.length > 0 && wordcloudOption ? (
              <ChartContainer option={wordcloudOption} height={280} />
            ) : summary.topTags.length > 0 ? (
              <TagList tags={summary.topTags.slice(0, 18)} />
            ) : (
              <InlineEmpty message={getTagEmptyMessage(summary)} />
            )
          ) : (
            <InlineEmpty message="当前没有可显示的标签分布。" />
          )}
        </div>
      </div>
    </ErrorBoundary>
  );

  async function handleGranularityChange(nextGranularity: InterestDriftGranularity) {
    if (nextGranularity === activeGranularity) return;

    const nextWindowStart = selectedWindows[nextGranularity] ?? currentData.windows[nextGranularity][0]?.startDate;
    setSelectedGranularity(nextGranularity);
    if (!nextWindowStart) return;
    setSelectedWindows(prev => ({ ...prev, [nextGranularity]: nextWindowStart }));
    await fetchData(nextGranularity, nextWindowStart);
  }

  async function handleWindowChange(nextWindowStart: string) {
    setSelectedWindows(prev => ({ ...prev, [activeGranularity]: nextWindowStart }));
    await fetchData(activeGranularity, nextWindowStart);
  }
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ borderRadius: '8px', background: 'rgba(26, 26, 54, 0.9)', padding: '10px 12px' }}>
      <div style={{ color: '#8E8E9E', fontSize: '11px', marginBottom: '4px' }}>{label}</div>
      <div style={{ color: '#F7F7FB', fontSize: '14px' }}>{value}</div>
    </div>
  );
}

function WindowStatePanel({ summary }: { summary: PreferenceWindowSummary }) {
  return (
    <div style={{ minHeight: '240px', borderRadius: '6px', border: '1px dashed rgba(160, 160, 176, 0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ maxWidth: '420px', textAlign: 'center', color: '#61666D' }}>
        <div style={{ fontSize: '14px', marginBottom: '8px', color: '#F0F0F7' }}>
          {getWindowStateMessage(summary)}
        </div>
        <div style={{ fontSize: '12px', lineHeight: 1.6, color: '#9FA0B4' }}>
          {summary.state === 'insufficient_sample'
            ? '样本偏少时只展示摘要，避免把单个视频或单次短观看误当成稳定偏好。'
            : '切换到相邻日期、周或月后，会按那个自然窗口重新计算。'}
        </div>
        {summary.categories.length > 0 && (
          <div style={{ marginTop: '14px', textAlign: 'left' }}>
            <CategoryList categories={summary.categories.slice(0, 5)} compact />
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryList(
  { categories, compact = false }: { categories: CategoryDistribution[]; compact?: boolean },
) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? '6px' : '8px' }}>
      {categories.map((category, index) => (
        <div key={`${category.name}-${index}`} style={{ display: 'grid', gridTemplateColumns: compact ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr) auto auto', gap: '8px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '999px', background: CHART_COLORS[index % CHART_COLORS.length], flex: '0 0 auto' }} />
            <span style={{ color: '#EAEAF2', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{category.name}</span>
          </div>
          {!compact && (
            <span style={{ color: '#8E8E9E', fontSize: '12px' }}>{formatWatchTime(category.watchTime)}</span>
          )}
          <span style={{ color: '#61666D', fontSize: '12px' }}>{formatPercentage(category.percentage)}</span>
        </div>
      ))}
    </div>
  );
}

function DurationList({ buckets, emptyMessage }: { buckets: DurationBucket[]; emptyMessage: string }) {
  const nonZeroBuckets = buckets.filter(bucket => bucket.count > 0);
  if (nonZeroBuckets.length === 0) {
    return <InlineEmpty message={emptyMessage} />;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px' }}>
      {nonZeroBuckets.map(bucket => (
        <div key={bucket.label} style={{ borderRadius: '8px', background: 'rgba(26, 26, 54, 0.9)', padding: '10px 12px' }}>
          <div style={{ color: '#F2F2F8', fontSize: '13px', marginBottom: '4px' }}>{bucket.label}</div>
          <div style={{ color: '#9FA0B4', fontSize: '12px' }}>{bucket.count} 条视频</div>
        </div>
      ))}
    </div>
  );
}

function TagList({ tags }: { tags: Array<{ name: string; count: number }> }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {tags.map((tag, index) => (
        <div
          key={`${tag.name}-${index}`}
          style={{
            padding: '6px 10px',
            borderRadius: '999px',
            background: 'rgba(108, 92, 231, 0.14)',
            border: '1px solid rgba(108, 92, 231, 0.3)',
            color: '#EAEAF2',
            fontSize: '12px',
          }}
        >
          {tag.name} · {tag.count}
        </div>
      ))}
    </div>
  );
}

function InlineEmpty({ message }: { message: string }) {
  return (
    <div style={{ minHeight: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#61666D', fontSize: '13px', textAlign: 'center', padding: '0 16px' }}>
      {message}
    </div>
  );
}

function buildCategoryPieOption(categories: CategoryDistribution[]) {
  return {
    tooltip: { trigger: 'item' as const, formatter: '{b}: {d}%' },
    series: [{
      type: 'pie' as const,
      radius: ['42%', '72%'],
      data: categories.slice(0, 8).map(category => ({ name: category.name, value: category.watchTime })),
      label: { color: '#61666D' },
    }],
  };
}

function buildDurationBarOption(buckets: DurationBucket[]) {
  return {
    tooltip: { trigger: 'axis' as const },
    grid: { top: 12, right: 10, bottom: 20, left: 40 },
    xAxis: { type: 'category' as const, data: buckets.map(bucket => bucket.label) },
    yAxis: { type: 'value' as const },
    series: [{
      type: 'bar' as const,
      data: buckets.map((bucket, index) => ({
        value: bucket.count,
        itemStyle: { color: CHART_COLORS[index % CHART_COLORS.length], borderRadius: [4, 4, 0, 0] },
      })),
    }],
  };
}

function buildWordCloudOption(tags: Array<{ name: string; count: number }>): EChartsOption {
  const wordCloudSeries = {
    type: 'custom' as const,
    renderItem: 'wordCloud',
    coordinateSystem: 'none' as const,
    itemPayload: {
      shape: 'circle',
      sizeRange: [12, 40],
      rotationRange: [-45, 45],
    },
    label: {
      fontFamily: '"Noto Sans SC", sans-serif',
    },
    data: tags.slice(0, 50).map((tag, index) => ({
      name: tag.name,
      value: [tag.name, tag.count],
      itemStyle: { color: CHART_COLORS[index % CHART_COLORS.length] },
    })),
  };

  return {
    tooltip: { show: true },
    // The plugin registers a named custom renderer that ECharts core does not expose in its union type.
    series: [wordCloudSeries as unknown as CustomSeriesOption],
  };
}

function buildCoverageCaveat(summary: PreferenceWindowSummary, coverage: HistoryCoverage): string {
  const caveats = ['仅基于本地已同步历史计算，不代表账号完整观看史。'];
  if (summary.window.partialCoverage && coverage.earliestDate && coverage.latestDate) {
    const observedStart = maxDate(summary.window.startDate, coverage.earliestDate);
    const observedEnd = minDate(summary.window.endDate, coverage.latestDate);
    caveats.push(`这个自然${granularityLabel(summary.window.granularity)}窗口目前只覆盖本地记录中的 ${observedStart} 至 ${observedEnd}。`);
  }
  if (!summary.window.partialCoverage && coverage.earliestDate && coverage.latestDate) {
    caveats.push(`当前本地历史覆盖 ${coverage.earliestDate} 至 ${coverage.latestDate}，窗口外的偏好不会纳入这次分析。`);
  }
  if (summary.stateReason === 'too_few_records' || summary.stateReason === 'too_little_watch_time') {
    caveats.push('样本偏少，暂不绘制图表，避免把单个视频放大成稳定兴趣。');
  }
  if (summary.stateReason === 'no_watch_time') {
    caveats.push('这个窗口只有浏览记录，没有足够的有效观看时长。');
  }
  return caveats.join(' ');
}

function getWindowStateMessage(summary: PreferenceWindowSummary): string {
  const noun = windowNoun(summary.window.granularity);
  switch (summary.stateReason) {
    case 'no_records':
      return `${noun}暂无本地观看记录。`;
    case 'no_watch_time':
      return `${noun}有历史记录，但缺少有效观看时长，暂不生成兴趣分布。`;
    case 'too_few_records':
      return `${noun}样本太少，暂不绘制兴趣图表。`;
    case 'too_little_watch_time':
      return `${noun}观看时长太少，暂不绘制兴趣图表。`;
    default:
      return '当前窗口可正常生成兴趣分布。';
  }
}

function getDurationEmptyMessage(summary: PreferenceWindowSummary): string {
  if (summary.stateReason === 'no_records') return `${windowNoun(summary.window.granularity)}暂无本地观看记录。`;
  if (summary.stateReason === 'no_watch_time') return '这个窗口没有可统计的有效观看时长。';
  return '样本偏少，仅保留简化的时长摘要。';
}

function getTagEmptyMessage(summary: PreferenceWindowSummary): string {
  if (summary.stateReason === 'no_records') return `${windowNoun(summary.window.granularity)}暂无标签记录。`;
  if (summary.stateReason === 'no_watch_time') return '这个窗口没有足够的标签样本。';
  return '样本偏少，仅保留简化的标签摘要。';
}

function getWindowTitle(granularity: InterestDriftGranularity): string {
  if (granularity === 'weekly') return '当周兴趣分布';
  if (granularity === 'monthly') return '当月兴趣分布';
  return '当天兴趣分布';
}

function formatWindowOption(window: PreferenceWindowOption): string {
  const flags = [];
  if (window.recordCount === 0) flags.push('空窗口');
  if (window.partialCoverage) flags.push('覆盖不完整');
  const suffix = flags.length > 0 ? `（${flags.join('，')}）` : '';
  return `${window.label}${suffix}`;
}

function granularityLabel(granularity: InterestDriftGranularity): string {
  if (granularity === 'weekly') return '周';
  if (granularity === 'monthly') return '月';
  return '日';
}

function windowNoun(granularity: InterestDriftGranularity): string {
  if (granularity === 'weekly') return '当周';
  if (granularity === 'monthly') return '当月';
  return '当天';
}

function formatWatchTime(seconds: number): string {
  if (seconds <= 0) return '0 分钟';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
  return `${Math.round((seconds / 3600) * 10) / 10} 小时`;
}

function formatPercentage(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}
