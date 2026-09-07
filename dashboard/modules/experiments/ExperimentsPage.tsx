import { useEffect, useState } from 'preact/hooks';
import { expData, expLoading, expError } from '../../signals';
import { requestSW } from '../../utils/messaging';
import type { ExperimentBlindBox } from '../../../src/shared/types/analytics';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { BILI_BLUE, BILI_PINK } from '../../../src/shared/constants';
import { formatExperimentLoadError } from './experiment-copy';

const CARD_ACCENT: Record<ExperimentBlindBox['id'], string> = {
  random_explore: '#A78BFA',
  cross_region: '#FF9F6E',
  hidden_favorite: '#FFD166',
  creator_archive: '#7FD1FF',
};

export function ExperimentsPage() {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void fetchData();
  }, []);

  async function fetchData() {
    expLoading.value = true;
    expError.value = null;
    try {
      expData.value = await requestSW<typeof expData.value>('GET_EXPERIMENT_DATA');
      setRevealed({});
      setOpened({});
    } catch (error) {
      expError.value = formatExperimentLoadError(error);
    } finally {
      expLoading.value = false;
    }
  }

  function revealBox(boxId: string) {
    setRevealed(current => ({ ...current, [boxId]: true }));
  }

  function markOpened(boxId: string) {
    setOpened(current => ({ ...current, [boxId]: true }));
  }

  if (expLoading.value) return <div style={{ padding: '16px' }}><LoadingSkeleton height={460} /></div>;
  if (expError.value) return <div style={{ padding: '16px', color: '#FF6B6B' }}>{expError.value}</div>;
  const data = expData.value;
  if (!data) return <EmptyState />;

  return (
    <ErrorBoundary>
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <section style={{
          background: 'linear-gradient(135deg, rgba(251,114,153,0.18), rgba(0,161,214,0.14))',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '16px',
          padding: '16px',
        }}>
          <div style={{ color: '#18191C', fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>视频盲盒</div>
          <div style={{ color: '#D4D8E8', fontSize: '13px', lineHeight: 1.7 }}>
            随机探索使用本地近期种子请求真实相关视频候选；跨区漫游避开最近高频分区，从 B 站公开分区新视频候选池抽取。冷门收藏只回访本地收藏；UP 主考古从已关注 UP 的公开较早投稿里抽取。这里不按点击偏好排队，也不会写回 B 站。
          </div>
          <div style={{ color: '#8F97B5', fontSize: '12px', marginTop: '8px' }}>
            最近生成时间：{new Date(data.generatedAt).toLocaleString('zh-CN')}
          </div>
        </section>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '12px',
        }}>
          {data.blindBoxes.map(box => {
            const isRevealed = revealed[box.id] === true;
            const isReady = box.state === 'ready';
            const accent = CARD_ACCENT[box.id];
            const statusLabel = box.statusLabel ?? (isReady ? '可揭晓' : '本地证据不足');
            const dependsOnRealCandidateSource = box.candidateSource.includes('B 站');
            return (
              <article
                key={box.id}
                data-box-id={box.id}
                style={{
                  background: '#171B2E',
                  borderRadius: '16px',
                  border: `1px solid ${accent}33`,
                  boxShadow: `0 10px 24px ${accent}18`,
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: '320px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                  <div>
                    <div style={{ color: '#18191C', fontSize: '16px', fontWeight: 700 }}>{box.title}</div>
                    <div style={{ color: '#A8B0CE', fontSize: '12px', lineHeight: 1.5, marginTop: '4px' }}>{box.teaser}</div>
                  </div>
                  <span style={{
                    color: accent,
                    background: `${accent}1A`,
                    border: `1px solid ${accent}40`,
                    borderRadius: '999px',
                    padding: '4px 8px',
                    fontSize: '11px',
                    whiteSpace: 'nowrap',
                  }}>
                    {statusLabel}
                  </span>
                </div>

                {!isRevealed ? (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    flex: 1,
                    gap: '12px',
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01))',
                    borderRadius: '14px',
                    padding: '16px',
                    border: '1px dashed rgba(255,255,255,0.08)',
                  }}>
                    <div style={{ color: '#DCE2F8', fontSize: '13px', lineHeight: 1.7 }}>
                      {isReady
                        ? '这盒里是一个可以直接打开的具体视频。揭晓后会显示标题、UP 主、候选来源、真实候选状态、理由和证据。'
                        : dependsOnRealCandidateSource
                          ? '这盒不会显示空卡，也不会用本地库存冒充真实候选。揭晓后会说明为什么当前没有可抽取视频。'
                          : '这盒不会拿泛泛建议充数。揭晓后只会告诉你为什么本地证据还不够。'}
                    </div>
                    <div style={sourceMetaStyle()}>
                      <div>候选来源：{box.candidateSource}</div>
                      <div>真实 B 站候选：{box.realCandidateLabel}</div>
                    </div>
                    <button
                      type="button"
                      data-action={isReady ? 'reveal' : 'explain'}
                      onClick={() => revealBox(box.id)}
                      style={primaryButtonStyle(accent)}
                    >
                      {isReady ? '揭晓视频' : '查看原因'}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1 }}>
                    <div style={sourceMetaStyle()}>
                      <div>候选来源：{box.candidateSource}</div>
                      <div>真实 B 站候选：{box.realCandidateLabel}</div>
                      <div style={{ color: accent, fontWeight: 600 }}>来源：{box.source}</div>
                    </div>
                    <div style={{
                      background: 'rgba(255,255,255,0.03)',
                      borderRadius: '12px',
                      padding: '12px',
                      border: '1px solid rgba(255,255,255,0.05)',
                      flex: 1,
                    }}>
                      {isReady && box.video ? (
                        <>
                          <div style={{ color: '#18191C', fontSize: '15px', fontWeight: 700, lineHeight: 1.5 }}>{box.video.title}</div>
                          <div style={{ color: '#C7CEE7', fontSize: '12px', marginTop: '6px' }}>UP 主：{box.video.authorName}</div>
                          <div style={{ color: '#DCE2F8', fontSize: '13px', lineHeight: 1.7, marginTop: '10px' }}>
                            理由：{box.reason}
                          </div>
                          <ul style={{ color: '#AAB3D2', fontSize: '12px', lineHeight: 1.7, paddingLeft: '18px', margin: '10px 0 0 0' }}>
                            {box.evidence.map(line => <li key={line}>{line}</li>)}
                          </ul>
                        </>
                      ) : (
                        <>
                          <div style={{ color: '#18191C', fontSize: '15px', fontWeight: 700, lineHeight: 1.5 }}>
                            {box.emptyTitle ?? '这盒暂时开不出来'}
                          </div>
                          <div style={{ color: '#DCE2F8', fontSize: '13px', lineHeight: 1.7, marginTop: '10px' }}>
                            {box.emptyDescription ?? box.reason}
                          </div>
                          <ul style={{ color: '#AAB3D2', fontSize: '12px', lineHeight: 1.7, paddingLeft: '18px', margin: '10px 0 0 0' }}>
                            {box.evidence.map(line => <li key={line}>{line}</li>)}
                          </ul>
                        </>
                      )}
                    </div>

                    {isReady && box.video ? (
                      <a
                        href={box.video.url}
                        target="_blank"
                        rel="noreferrer"
                        data-action="open-video"
                        data-bvid={box.video.bvid}
                        onClick={() => markOpened(box.id)}
                        style={openLinkStyle(accent, opened[box.id] === true)}
                      >
                        {opened[box.id] === true ? '再次打开 B 站视频页' : '打开 B 站视频页'}
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void fetchData()}
                        style={secondaryButtonStyle()}
                      >
                        重新生成这一页
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <section style={{
          background: '#15192A',
          border: '1px solid rgba(255,255,255,0.05)',
          borderRadius: '14px',
          padding: '14px',
        }}>
          <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>说明</div>
          <div style={{ color: '#A8B0CE', fontSize: '12px', lineHeight: 1.7 }}>
            随机探索只使用少量本地近期视频作为种子，请求公开相关视频候选后在本地随机抽取；跨区漫游只把本地近期历史用于识别要避开的高频分区，候选视频来自 B 站公开分区新视频池；冷门收藏的来源是本地收藏；UP 主考古的来源是已关注 UP 的公开较早投稿。打开动作只会新开一个 B 站视频页，不会回写收藏、关注或观看状态。
          </div>
        </section>
      </div>
    </ErrorBoundary>
  );
}

function sourceMetaStyle(): Record<string, string> {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    color: '#A8B0CE',
    fontSize: '12px',
    lineHeight: '1.5',
    background: 'rgba(255,255,255,0.025)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '6px',
    padding: '9px 10px',
  };
}

function primaryButtonStyle(accent: string): Record<string, string> {
  return {
    width: '100%',
    border: 'none',
    borderRadius: '12px',
    padding: '11px 14px',
    background: `linear-gradient(135deg, ${accent}, ${BILI_PINK})`,
    color: '#18191C',
    fontSize: '13px',
    fontWeight: '700',
    cursor: 'pointer',
  };
}

function secondaryButtonStyle(): Record<string, string> {
  return {
    width: '100%',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px',
    padding: '11px 14px',
    background: 'rgba(255,255,255,0.03)',
    color: '#DCE2F8',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
  };
}

function openLinkStyle(accent: string, opened: boolean): Record<string, string> {
  return {
    display: 'block',
    textAlign: 'center',
    textDecoration: 'none',
    borderRadius: '12px',
    padding: '11px 14px',
    background: opened ? 'rgba(0,161,214,0.14)' : 'rgba(251,114,153,0.12)',
    border: `1px solid ${opened ? BILI_BLUE : accent}55`,
    color: opened ? BILI_BLUE : BILI_PINK,
    fontSize: '13px',
    fontWeight: '700',
  };
}
