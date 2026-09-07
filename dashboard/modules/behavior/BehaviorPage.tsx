import { useEffect } from 'preact/hooks';
import { behaviorData, behaviorLoading, behaviorError } from '../../signals';
import { requestSW } from '../../utils/messaging';
import type { BehaviorMetrics } from '../../../src/shared/types/analytics';
import { ChartContainer } from '../../components/ChartContainer';
import { StatCard } from '../../components/StatCard';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { CHART_COLORS, HOUR_LABELS } from '../../../src/shared/constants';
import { formatTimeHHMM } from '../../../src/shared/utils/format';

export function BehaviorPage() {
  useEffect(() => { fetchData(); }, []);

  async function fetchData() {
    behaviorLoading.value = true;
    behaviorError.value = null;
    try {
      behaviorData.value = await requestSW<BehaviorMetrics>('GET_BEHAVIOR_DATA');
    } catch (e) {
      behaviorError.value = (e as Error).message;
    } finally {
      behaviorLoading.value = false;
    }
  }

  if (behaviorLoading.value) return <div style={{ padding: '16px' }}><LoadingSkeleton height={400} /></div>;
  if (behaviorError.value) return <div style={{ padding: '16px', color: '#FF6B6B' }}>{behaviorError.value}</div>;
  const d = behaviorData.value;
  if (!d) return <EmptyState />;

  const completionOption = {
    tooltip: { trigger: 'axis' as const },
    grid: { top: 10, right: 10, bottom: 20, left: 40 },
    xAxis: { type: 'category' as const, data: d.completionDistribution.map(b => b.label) },
    yAxis: { type: 'value' as const },
    series: [{
      type: 'bar' as const,
      data: d.completionDistribution.map((b, i) => ({
        value: b.count,
        itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length], borderRadius: [4, 4, 0, 0] },
      })),
    }],
  };

  const peakHours = d.sessionPattern.peakHours;
  const hourData = Array(24).fill(0);
  peakHours.forEach(h => { if (h >= 0 && h < 24) hourData[h] = 1; });

  const peakOption = {
    tooltip: { trigger: 'axis' as const },
    grid: { top: 10, right: 10, bottom: 20, left: 40 },
    xAxis: { type: 'category' as const, data: HOUR_LABELS },
    yAxis: { type: 'value' as const, max: 1 },
    series: [{
      type: 'bar' as const,
      data: hourData.map((v, i) => ({ value: v, itemStyle: { color: v ? '#FB7299' : '#E3E5E7', borderRadius: [2, 2, 0, 0] } })),
    }],
  };

  const { sessionPattern: s } = d;

  return (
    <ErrorBoundary>
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
          <StatCard label="平均每Session视频" value={`${s.avgVideosPerSession}个`} accent="#FB7299" />
          <StatCard label="平均Session时长" value={formatTimeHHMM(s.avgSessionDuration)} accent="#00A1D6" />
          <StatCard
            label="工作日vs周末"
            value={`${Math.round(s.weekdayAvg / Math.max(s.weekendAvg, 1) * 10) / 10}x`}
            accent="#00D4AA"
          />
        </div>
        <div style={{ background: '#FFFFFF', borderRadius: '6px', padding: '12px' }}>
          <h3 style={{ color: '#61666D', fontSize: '13px', margin: '0 0 4px 12px' }}>完播率分布</h3>
          <ChartContainer option={completionOption} height={220} />
        </div>
        <div style={{ background: '#FFFFFF', borderRadius: '6px', padding: '12px' }}>
          <h3 style={{ color: '#61666D', fontSize: '13px', margin: '0 0 4px 12px' }}>高峰时段</h3>
          <ChartContainer option={peakOption} height={180} />
        </div>
      </div>
    </ErrorBoundary>
  );
}
