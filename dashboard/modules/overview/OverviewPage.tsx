import { useEffect, useState } from 'preact/hooks';
import { overviewData, overviewLoading, overviewError } from '../../signals';
import { requestSW } from '../../utils/messaging';
import type { DashboardOverview } from '../../../src/shared/types/analytics';
import type { HistorySyncProgress } from '../../../src/shared/types/history-sync';
import { ChartContainer } from '../../components/ChartContainer';
import { StatCard } from '../../components/StatCard';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { formatTimeHHMM, formatPercent, formatDate } from '../../../src/shared/utils/format';
import { HOUR_LABELS, WEEKDAY_LABELS, BILI_PINK } from '../../../src/shared/constants';
import type { EChartsOption } from 'echarts';

interface DeviceData {
  breakdown: { label: string; deviceType: number; watchTime: number; videoCount: number; avgCompletion: number; percentage: number }[];
  hourly: { mobile: number[]; pc: number[] };
  deviceCompletion: { mobile: number; pc: number };
}

export function OverviewPage() {
  const [device, setDevice] = useState<DeviceData | null>(null);

  useEffect(() => {
    fetchData();
    requestSW<DeviceData>('GET_DEVICE_DATA').then(setDevice).catch(() => {});
  }, []);

  async function fetchData() {
    overviewLoading.value = true;
    overviewError.value = null;
    try {
      overviewData.value = await requestSW<DashboardOverview>('GET_DASHBOARD_DATA');
    } catch (e) {
      overviewError.value = (e as Error).message;
    } finally {
      overviewLoading.value = false;
    }
  }

  if (overviewLoading.value) return <div style={{ padding: '16px' }}><LoadingSkeleton height={400} /></div>;
  if (overviewError.value) return <div style={{ padding: '16px', color: '#FF6B6B' }}>{overviewError.value}</div>;
  const d = overviewData.value;
  if (!d) return <EmptyState />;

  const maxHeat = Math.max(...d.hourlyHeatmap.flat(), 1);
  const heatmapOption: EChartsOption = {
    tooltip: { position: 'top' },
    grid: { top: 30, right: 20, bottom: 20, left: 50 },
    xAxis: { type: 'category', data: HOUR_LABELS, splitArea: { show: true } },
    yAxis: { type: 'category', data: WEEKDAY_LABELS, splitArea: { show: true } },
    visualMap: {
      min: 0,
      max: maxHeat,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      inRange: { color: ['#F6F7F8', '#00A1D6', '#FB7299'] },
    },
    series: [{
      type: 'heatmap' as const,
      data: d.hourlyHeatmap.flatMap((row, hour) => row.map((val, day) => [hour, day, val])),
      label: { show: false },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
    }],
  };

  const devicePieOption = device && device.breakdown.length > 0 ? {
    tooltip: { trigger: 'item' as const, formatter: '{b}: {d}%' },
    series: [{
      type: 'pie' as const,
      radius: ['40%', '70%'],
      center: ['50%', '50%'],
      data: device.breakdown.map(b => ({
        name: b.label,
        value: Math.round(b.watchTime / 60),
      })),
      label: { color: '#61666D', formatter: '{b}\n{d}%' },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
    }],
  } : null;

  const hourlyMax = device ? Math.max(...device.hourly.mobile, ...device.hourly.pc, 1) : 1;
  const deviceHourlyOption = device ? {
    tooltip: { trigger: 'axis' as const },
    legend: { textStyle: { color: '#61666D' }, top: 0, data: ['Mobile/Tablet', 'PC'] },
    grid: { top: 30, right: 10, bottom: 20, left: 40 },
    xAxis: { type: 'category' as const, data: HOUR_LABELS },
    yAxis: { type: 'value' as const, show: false, max: Math.ceil(hourlyMax / 60) },
    series: [
      {
        name: 'Mobile/Tablet',
        type: 'line' as const,
        data: device.hourly.mobile.map(v => Math.round(v / 60)),
        smooth: true,
        areaStyle: { opacity: 0.3 },
        lineStyle: { color: '#FB7299' },
        itemStyle: { color: '#FB7299' },
      },
      {
        name: 'PC',
        type: 'line' as const,
        data: device.hourly.pc.map(v => Math.round(v / 60)),
        smooth: true,
        areaStyle: { opacity: 0.3 },
        lineStyle: { color: '#00A1D6' },
        itemStyle: { color: '#00A1D6' },
      },
    ],
  } : null;

  const historyRangeText = d.oldestRecordDate && d.newestRecordDate
    ? `本地历史范围：${formatDate(d.oldestRecordDate)} - ${formatDate(d.newestRecordDate)}`
    : '本地历史范围：暂无记录';
  const coverageTone = d.historyCoverageStatus === 'complete' ? '#00D4AA' : d.historyCoverageStatus === 'partial' ? '#FFB347' : '#9090A0';

  return (
    <ErrorBoundary>
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
          <StatCard label="本周观看" value={formatTimeHHMM(d.weeklyWatchTime)} change={d.weeklyChange} accent={BILI_PINK} />
          <StatCard label="本月观看" value={formatTimeHHMM(d.monthlyWatchTime)} change={d.monthlyChange} accent="#00A1D6" />
          <StatCard label="平均完播率" value={formatPercent(d.avgCompletion)} accent="#00D4AA" />
        </div>

        <details className="bb-inline-diagnostics">
        <summary>数据覆盖：{coverageLabel(d.historyCoverageStatus)}</summary>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '8px',
          color: '#61666D',
          fontSize: '12px',
        }}>
          <div style={{ background: '#FFFFFF', borderRadius: '8px', padding: '10px 12px' }}>
            本周范围：{formatDate(d.weekStart)} - {formatDate(d.weekEnd)}，命中 {d.weeklyRecordCount} 条
          </div>
          <div style={{ background: '#FFFFFF', borderRadius: '8px', padding: '10px 12px' }}>
            本月范围：{formatDate(d.monthStart)} - {formatDate(d.monthEnd)}，命中 {d.monthlyRecordCount} 条
          </div>
        </div>

        <div style={{ color: '#707080', fontSize: '11px', padding: '0 2px' }}>
          {historyRangeText}；本周已计入 PC {formatTimeHHMM(d.weeklyLocalPcWatchTime)}，覆盖 {d.weeklyLocalPcDays} 天
        </div>
        <div style={{ color: '#606070', fontSize: '11px', padding: '0 2px' }}>
          数据来源：B 站历史用于跨设备估算，本机 PC 播放事件用于修正网页端有效观看。
        </div>

        <div style={{
          background: '#FFFFFF',
          borderRadius: '6px',
          padding: '12px',
          borderLeft: `3px solid ${coverageTone}`,
        }}>
          <div style={{ color: '#18191C', fontSize: '14px', fontWeight: 700, marginBottom: '6px' }}>
            历史覆盖诊断：{coverageLabel(d.historyCoverageStatus)}
          </div>
          <div style={{ color: '#61666D', fontSize: '12px', lineHeight: 1.6 }}>
            {d.historyCoverageNote}
          </div>
          <div style={{ color: d.streakTrustworthy ? '#00D4AA' : '#FFB347', fontSize: '12px', lineHeight: 1.6, marginTop: '6px' }}>
            连续天数可信度：{d.streakTrustworthy ? '可信' : '覆盖不足'}
          </div>
          <div style={{ color: '#9090A0', fontSize: '11px', lineHeight: 1.6 }}>
            {d.streakCoverageNote}
          </div>
          {d.historySyncDiagnostics && (
            <div style={{ marginTop: '8px', color: '#61666D', fontSize: '11px', lineHeight: 1.6 }}>
              {formatHistorySyncDiagnosticsV2(d.historySyncDiagnostics)}
            </div>
          )}
        </div>

        </details>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
          <DetailStatCard
            label="当前连续"
            value={`${d.streakDays} 天`}
            detail={formatDateRange(d.streakStartDate, d.streakEndDate)}
            accent={d.streakTrustworthy ? BILI_PINK : '#FFB347'}
          />
          <DetailStatCard
            label="最长连续"
            value={`${d.longestStreak} 天`}
            detail={formatDateRange(d.longestStreakStartDate, d.longestStreakEndDate)}
            accent={d.streakTrustworthy ? '#00A1D6' : '#FFB347'}
          />
          <StatCard label="效率评分" value={`${d.efficiencyScore} 分`} />
        </div>

        {device && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              {device.breakdown.map(b => (
                <StatCard
                  key={b.deviceType}
                  label={`${b.label} 端`}
                  value={formatTimeHHMM(b.watchTime)}
                  accent={b.deviceType <= 2 ? BILI_PINK : '#00A1D6'}
                />
              ))}
              {device.breakdown.length === 0 && <StatCard label="全部设备" value="-" />}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <StatCard label="手机端完播率" value={formatPercent(device.deviceCompletion.mobile)} accent={BILI_PINK} />
              <StatCard label="PC 端完播率" value={formatPercent(device.deviceCompletion.pc)} accent="#00A1D6" />
            </div>
            {devicePieOption && (
              <div style={{ background: '#FFFFFF', borderRadius: '6px', padding: '12px' }}>
                <h3 style={{ color: '#61666D', fontSize: '13px', margin: '0 0 4px 12px' }}>设备分布</h3>
                <ChartContainer option={devicePieOption} height={220} />
              </div>
            )}
            {deviceHourlyOption && (
              <div style={{ background: '#FFFFFF', borderRadius: '6px', padding: '12px' }}>
                <h3 style={{ color: '#61666D', fontSize: '13px', margin: '0 0 4px 12px' }}>
                  设备 × 时段（本月，单位：分钟）
                </h3>
                <ChartContainer option={deviceHourlyOption} height={240} />
              </div>
            )}
          </>
        )}

        <div style={{ background: '#FFFFFF', borderRadius: '6px', padding: '12px' }}>
          <h3 style={{ color: '#61666D', fontSize: '13px', margin: '0 0 8px 12px' }}>活跃时段热力图</h3>
          <ChartContainer option={heatmapOption} height={280} />
        </div>
      </div>
    </ErrorBoundary>
  );
}

function DetailStatCard({
  label,
  value,
  detail,
  accent = BILI_PINK,
}: {
  label: string;
  value: string;
  detail: string;
  accent?: string;
}) {
  return (
    <div style={{
      background: '#FFFFFF',
      borderRadius: '6px',
      padding: '14px 16px',
      textAlign: 'center',
      borderLeft: `3px solid ${accent}`,
    }}>
      <div style={{
        fontSize: '24px',
        fontWeight: 700,
        color: '#18191C',
        lineHeight: 1.3,
      }}>
        {value}
      </div>
      <div style={{ fontSize: '13px', color: '#61666D', marginTop: '2px' }}>
        {label}
      </div>
      <div style={{ fontSize: '11px', color: '#707080', marginTop: '6px', lineHeight: 1.4 }}>
        {detail}
      </div>
    </div>
  );
}

function coverageLabel(status: DashboardOverview['historyCoverageStatus']): string {
  switch (status) {
    case 'complete':
      return '已确认到达历史末尾';
    case 'partial':
      return '仅覆盖局部历史';
    default:
      return '尚无诊断';
  }
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate || !endDate) return '暂无连续时间段';
  if (startDate === endDate) return formatDate(startDate);
  return `${formatDate(startDate)} - ${formatDate(endDate)}`;
}

function formatHistorySyncDiagnostics(progress: HistorySyncProgress): string {
  const parts = [
    `mode=${progress.mode ?? 'unknown'}`,
    `requested=${progress.requestedPageLimit ?? 'default'} pages`,
    `normalized=${progress.pageLimit} pages`,
    `fetchedPages=${progress.fetchedPages}`,
    `fetchedItems=${progress.fetchedCount}`,
    `inserted=${progress.insertedCount}`,
    `updated=${progress.updatedCount}`,
    `skipped=${progress.skippedCount}`,
    `range=${formatViewAt(progress.oldestFetchedAt)} -> ${formatViewAt(progress.newestFetchedAt)}`,
    `stoppedReason=${progress.stoppedReason}`,
    `reachedEnd=${String(progress.reachedEnd)}`,
  ];
  if (progress.finalCursor) {
    parts.push(
      `cursor(max=${progress.finalCursor.max ?? 'null'}, view_at=${progress.finalCursor.viewAt ?? 'null'}, business=${progress.finalCursor.business ?? 'null'}, has_more=${progress.finalCursor.hasMore == null ? 'null' : String(progress.finalCursor.hasMore)})`,
    );
  }
  return parts.join(' · ');
}

function formatHistorySyncDiagnosticsV2(progress: HistorySyncProgress): string {
  const parts = [
    `模式=${progress.mode === 'full' ? '全量' : progress.mode === 'incremental' ? '增量' : '未知'}`,
    `页数=${progress.fetchedPages}/${progress.pageLimit}`,
    `获取=${progress.fetchedCount} 条`,
    `新增=${progress.insertedCount} 条`,
    `更新=${progress.updatedCount} 条`,
    `重复=${progress.duplicateCount} 条`,
    `直播排除=${progress.liveExcludedCount} 条`,
    `非视频/不支持=${progress.unsupportedBusinessCount} 条`,
    `缺少标识=${progress.missingIdCount} 条`,
    `总跳过=${progress.skippedCount} 条`,
    `范围=${formatViewAt(progress.oldestFetchedAt)} -> ${formatViewAt(progress.newestFetchedAt)}`,
    `停止原因=${progress.stoppedReason}`,
    `到达末尾=${String(progress.reachedEnd)}`,
  ];
  if (progress.finalCursor) {
    parts.push(
      `cursor(max=${progress.finalCursor.max ?? 'null'}, view_at=${progress.finalCursor.viewAt ?? 'null'}, business=${progress.finalCursor.business ?? 'null'}, has_more=${progress.finalCursor.hasMore == null ? 'null' : String(progress.finalCursor.hasMore)})`,
    );
  }
  return parts.join('；');
}

function formatViewAt(value: number | null): string {
  if (!value) return 'n/a';
  return new Date(value * 1000).toLocaleString('zh-CN');
}
