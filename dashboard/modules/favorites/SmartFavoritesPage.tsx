import { useEffect, useMemo, useState } from 'preact/hooks';
import { requestSW } from '../../utils/messaging';
import { BILI_BLUE, BILI_PINK } from '../../../src/shared/constants';
import type { AssistantConfig, UserConfig } from '../../../src/shared/types/config';
import type {
  FavoriteFolderGapProbeResult,
  FavoriteFolderSyncDiagnostic,
  FavoriteSyncResult,
  SmartFavoriteCategoryEvidenceKind,
  SmartFavoriteOverview,
  SmartFavoriteQaCitedVideo,
  SmartFavoriteQaResponse,
  SmartFavoriteResult,
  SmartFavoriteSearchResponse,
  SmartFavoriteTreeNode,
  SmartIndexResult,
} from '../../../src/shared/types/favorite';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

const CARD = {
  background: '#FFFFFF',
  border: '1px solid #E3E5E7',
  borderRadius: '8px',
  padding: '12px',
};

export function SmartFavoritesPage() {
  const [overview, setOverview] = useState<SmartFavoriteOverview | null>(null);
  const [assistantConfig, setAssistantConfig] = useState<AssistantConfig>({
    currentVideoAiAssistantEnabled: false,
    smartFavoritesQaAiEnabled: false,
  });
  const [aiStatus, setAiStatus] = useState({ hasApiKey: false, model: '' });
  const [query, setQuery] = useState('');
  const [question, setQuestion] = useState('');
  const [search, setSearch] = useState<SmartFavoriteSearchResponse | null>(null);
  const [qa, setQa] = useState<SmartFavoriteQaResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string[]>([]);
  const [pathResults, setPathResults] = useState<SmartFavoriteResult[]>([]);
  const [expandedTree, setExpandedTree] = useState<Set<string>>(() => new Set());
  const [probeMediaId, setProbeMediaId] = useState('');
  const [probeResult, setProbeResult] = useState<FavoriteFolderGapProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => { void refreshAll(); }, []);

  const treeRows = useMemo(() => getVisibleTreeRows(overview?.tree ?? [], expandedTree), [overview, expandedTree]);

  async function refreshAll() {
    setLoading(true);
    setError(null);
    try {
      const [cfg, data] = await Promise.all([
        requestSW<UserConfig>('GET_CONFIG'),
        requestSW<SmartFavoriteOverview>('GET_SMART_FAVORITES'),
      ]);
      setAssistantConfig(cfg.assistant);
      setAiStatus({
        hasApiKey: Boolean(cfg.ai.apiKey.trim()),
        model: cfg.ai.chatModel,
      });
      setOverview(data);
      if (selectedPath.length > 0) {
        setPathResults(await requestSW<SmartFavoriteResult[]>('GET_SMART_FAVORITES_BY_PATH', { path: selectedPath, limit: 200 }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function syncFavorites() {
    setBusy('sync');
    setError(null);
    try {
      const result = await requestSW<FavoriteSyncResult>('SYNC_FAVORITES');
      if (result.status === 'blocked') {
        setError(result.blockedReason ?? '收藏同步未完成，已保留当前可用数据。');
        setNotice(joinNoticeParts([
          `收藏同步未完成：已保留并更新 ${result.insertedOrUpdated} 条可用视频，未删除旧数据。Bilibili 报告 ${result.reportedItems} 条，本次写入 ${result.items} 条，过滤 ${result.filteredItems} 条。`,
          ...result.notes,
        ]));
      } else {
        setNotice(joinNoticeParts([
          `收藏同步完成：${result.folders} 个收藏夹，本地写入 ${result.insertedOrUpdated} 条视频，过滤 ${result.filteredItems} 条资源。`,
          ...result.notes,
        ]));
      }
      setOverview(await requestSW<SmartFavoriteOverview>('GET_SMART_FAVORITES'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function buildIndex() {
    setBusy('index');
    setError(null);
    try {
      const result: SmartIndexResult = { processed: 0, indexed: 0, failed: 0, skipped: 0, notes: [] };
      const initialOverview = overview ?? await requestSW<SmartFavoriteOverview>('GET_SMART_FAVORITES');
      let pending = initialOverview.pendingItems;
      let guard = Math.ceil((initialOverview.totalItems + initialOverview.failedItems) / 8) + 4;

      while (pending > 0 && guard-- > 0) {
        const batch = await requestSW<SmartIndexResult>('BUILD_SMART_FAVORITE_INDEX', {
          maxItems: 8,
          includeFailed: false,
        });
        mergeIndexResult(result, batch);
        const latest = await requestSW<SmartFavoriteOverview>('GET_SMART_FAVORITES');
        setOverview(latest);
        pending = latest.pendingItems;
        setNotice(joinNoticeParts([
          `智能索引生成中：已处理 ${result.processed} 条，成功 ${result.indexed} 条，失败 ${result.failed} 条，跳过 ${result.skipped} 条。`,
          ...result.notes,
        ]));
        if (batch.processed === 0) break;
      }

      let failedRetriesLeft = initialOverview.failedItems;
      guard = Math.ceil(initialOverview.failedItems / 8) + 2;
      while (failedRetriesLeft > 0 && guard-- > 0) {
        const batch = await requestSW<SmartIndexResult>('BUILD_SMART_FAVORITE_INDEX', {
          maxItems: Math.min(8, failedRetriesLeft),
          includeFailed: true,
          failedOnly: true,
        });
        mergeIndexResult(result, batch);
        failedRetriesLeft -= batch.processed;
        const latest = await requestSW<SmartFavoriteOverview>('GET_SMART_FAVORITES');
        setOverview(latest);
        setNotice(joinNoticeParts([
          `失败项重试中：已处理 ${result.processed} 条，成功 ${result.indexed} 条，失败 ${result.failed} 条，跳过 ${result.skipped} 条。`,
          ...result.notes,
        ]));
        if (batch.processed === 0) break;
      }

      setNotice(joinNoticeParts([
        `智能索引完成：新增或更新 ${result.indexed} 条，失败 ${result.failed} 条，跳过 ${result.skipped} 条。`,
        ...result.notes,
      ]));
      setOverview(await requestSW<SmartFavoriteOverview>('GET_SMART_FAVORITES'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function runFolderProbe(mediaIdText = probeMediaId) {
    const mediaId = Number(mediaIdText);
    if (!Number.isFinite(mediaId) || mediaId <= 0) return;
    setBusy('probe');
    setError(null);
    try {
      setProbeMediaId(String(Math.floor(mediaId)));
      setProbeResult(await requestSW<FavoriteFolderGapProbeResult>('PROBE_FAVORITE_FOLDER_GAP', {
        mediaId: Math.floor(mediaId),
        maxPages: 12,
      }));
      setNotice(`收藏夹缺口诊断已完成：mediaId ${Math.floor(mediaId)}。请先查看下方拆分结果，再判断是否为插件侧缺口。`);
    } catch (e) {
      setProbeResult(null);
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setBusy('search');
    setError(null);
    try {
      setSearch(await requestSW<SmartFavoriteSearchResponse>('SEARCH_SMART_FAVORITES', { query: q, limit: 30 }));
      setQa(null);
      setSelectedPath([]);
      setPathResults([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function askFavorites() {
    const q = question.trim();
    if (!q) return;
    setBusy('qa');
    setError(null);
    try {
      setQa(await requestSW<SmartFavoriteQaResponse>('ASK_SMART_FAVORITES', { query: q, limit: 8 }));
      setSearch(null);
      setSelectedPath([]);
      setPathResults([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  function toggleTreeNode(path: string[]) {
    const key = pathKey(path);
    setExpandedTree(current => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function selectTreePath(path: string[]) {
    setBusy('path');
    setError(null);
    try {
      setSelectedPath(path);
      setSearch(null);
      setQa(null);
      setPathResults(await requestSW<SmartFavoriteResult[]>('GET_SMART_FAVORITES_BY_PATH', { path, limit: 200 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  function expandAllTree() {
    setExpandedTree(new Set(collectExpandablePathKeys(overview?.tree ?? [])));
  }

  function collapseAllTree() {
    setExpandedTree(new Set());
  }

  function openSettings() {
    window.location.hash = 'settings';
  }

  if (loading) return <div style={{ padding: '16px' }}><LoadingSkeleton height={420} /></div>;

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {error && <Status color="#FF6B6B" text={error} />}
      {notice && <Status color="#00D4AA" text={notice} />}

      <section style={CARD}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '12px' }}>
          <Metric label="收藏夹" value={overview?.folders.length ?? 0} />
          <Metric label="B站报告" value={overview?.reportedItems ?? 0} />
          <Metric label="本地保存" value={overview?.storedItems ?? 0} />
          <Metric label="已索引" value={overview?.indexedItems ?? 0} />
          <Metric label="索引失败" value={overview?.failedItems ?? 0} />
          <Metric label="待索引" value={overview?.pendingItems ?? 0} />
        </div>
        <div style={{ color: overview?.lastSyncDiagnostics.length && overview?.syncComplete === false ? '#FFB347' : '#9090A0', fontSize: '12px', lineHeight: 1.5, marginBottom: '12px' }}>
          {overview?.lastSyncDiagnostics.length && overview?.syncComplete === false
            ? `有 ${overview.incompleteFolders} 个收藏夹同步可能不完整；智能索引只覆盖当前本地快照：B站报告 ${overview.reportedItems} 条，本地保存 ${overview.storedItems} 条，已索引 ${overview.indexedItems} 条，失败 ${overview.failedItems} 条，待索引 ${overview.pendingItems} 条。`
            : `智能索引只覆盖本地已保存的收藏：B站报告 ${overview?.reportedItems ?? 0} 条，本地保存 ${overview?.storedItems ?? 0} 条，已索引 ${overview?.indexedItems ?? 0} 条，失败 ${overview?.failedItems ?? 0} 条，待索引 ${overview?.pendingItems ?? 0} 条。`}
        </div>
        <SyncDiagnostics
          diagnostics={overview?.lastSyncDiagnostics ?? []}
          onProbe={mediaId => { void runFolderProbe(String(mediaId)); }}
        />
        <details className="bb-inline-diagnostics" style={{ marginBottom: '12px' }}>
          <summary>收藏夹缺口诊断</summary>
          <div style={{ color: '#9090A0', fontSize: '12px', lineHeight: 1.5, marginBottom: '8px' }}>
            使用当前扩展运行时登录状态，对单个收藏夹做有边界的实时诊断。只记录数量统计，不保存完整收藏夹内容、原始接口响应、Cookie 或本地数据库转储。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
            <TextInput
              value={probeMediaId}
              onInput={setProbeMediaId}
              placeholder="收藏夹编号"
              onEnter={() => { void runFolderProbe(); }}
            />
            <ActionButton
              label={busy === 'probe' ? '诊断中...' : '运行诊断'}
              onClick={() => { void runFolderProbe(); }}
              disabled={!!busy || !probeMediaId.trim()}
            />
          </div>
        </details>
        {probeResult && <FavoriteFolderProbePanel result={probeResult} />}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <ActionButton label={busy === 'sync' ? '同步中...' : '同步收藏夹'} onClick={syncFavorites} disabled={!!busy} />
          <ActionButton label={busy === 'index' ? '生成中...' : '生成智能索引'} onClick={buildIndex} disabled={!!busy || !overview?.totalItems} />
          <ActionButton label="刷新" onClick={refreshAll} disabled={!!busy} variant="ghost" />
        </div>
      </section>

      <section style={CARD}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', alignItems: 'center' }}>
          <div>
            <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>AI 状态</div>
            <div style={{ color: '#9090A0', fontSize: '12px', lineHeight: 1.55 }}>
              {aiStatus.hasApiKey ? '服务已配置' : '尚未配置 AI，仍可查看本地引用'}
            </div>
          </div>
          <ActionButton label="前往设置" onClick={openSettings} disabled={!!busy} />
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
          <Badge text={aiStatus.hasApiKey ? 'AI 服务：已配置' : 'AI 服务：未配置'} color={aiStatus.hasApiKey ? '#00D4AA' : '#FFB347'} />
          <Badge text={`模型：${aiStatus.model || '未设置'}`} color="#9090A0" />
          <Badge text={assistantConfig.smartFavoritesQaAiEnabled ? '收藏问答：已启用' : '收藏问答：未启用'} color={assistantConfig.smartFavoritesQaAiEnabled ? '#00D4AA' : '#9090A0'} />
          <Badge text={assistantConfig.currentVideoAiAssistantEnabled ? '当前视频助手：已启用' : '当前视频助手：未启用'} color={assistantConfig.currentVideoAiAssistantEnabled ? '#00D4AA' : '#9090A0'} />
        </div>
      </section>

      <section style={CARD}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
          <TextInput value={query} onInput={setQuery} placeholder="输入模糊描述，例如：苏德战争 库尔斯克" onEnter={runSearch} />
          <ActionButton label={busy === 'search' ? '搜索中...' : '搜索'} onClick={runSearch} disabled={!!busy || !query.trim()} />
        </div>
        {search && (
          <div style={{ color: '#9090A0', fontSize: '12px', marginTop: '8px' }}>
            扩展词：{search.rewrittenTerms.length ? search.rewrittenTerms.join('、') : '无'}
          </div>
        )}
      </section>

      <section style={CARD}>
        <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>智能收藏问答</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
          <TextInput value={question} onInput={setQuestion} placeholder="询问当前已同步收藏，例如：有没有讲库尔斯克的二战视频" onEnter={askFavorites} />
          <ActionButton label={busy === 'qa' ? '回答中...' : '提问'} onClick={askFavorites} disabled={!!busy || !question.trim()} />
        </div>
        {qa && <QaAnswerPanel qa={qa} />}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: '12px', alignItems: 'start' }}>
        <section style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
            <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600 }}>AI 分类树</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <TreeAction label="展开" onClick={expandAllTree} disabled={!overview?.tree.length} />
              <TreeAction label="收起" onClick={collapseAllTree} disabled={!overview?.tree.length} />
            </div>
          </div>
          <div style={{ color: '#666', fontSize: '11px', lineHeight: 1.5, marginBottom: '8px' }}>
            待确认表示只有宽泛分类或路径提示，证据不足，未放入具体子类；未分类包含索引失败和待索引内容。
          </div>
          {treeRows.length === 0 ? (
            <div style={{ color: '#666', fontSize: '12px', lineHeight: 1.6 }}>同步并生成智能索引后显示分类</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {treeRows.map(row => (
                <TreeRow
                  key={row.path.join('/')}
                  row={row}
                  expanded={expandedTree.has(pathKey(row.path))}
                  selected={pathKey(selectedPath) === pathKey(row.path)}
                  onToggle={() => toggleTreeNode(row.path)}
                  onSelect={() => { void selectTreePath(row.path); }}
                />
              ))}
            </div>
          )}
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <ResultSection
            qa={qa}
            search={search}
            selectedPath={selectedPath}
            pathResults={pathResults}
            busy={busy}
          />
        </section>
      </div>
    </div>
  );
}

function mergeIndexResult(total: SmartIndexResult, batch: SmartIndexResult): void {
  total.processed += batch.processed;
  total.indexed += batch.indexed;
  total.failed += batch.failed;
  total.skipped += batch.skipped;
  for (const note of batch.notes) {
    if (!total.notes.includes(note)) {
      total.notes.push(note);
    }
  }
}

function joinNoticeParts(parts: string[]): string {
  return parts.filter(Boolean).join(' ');
}

function ResultSection({
  qa,
  search,
  selectedPath,
  pathResults,
  busy,
}: {
  qa: SmartFavoriteQaResponse | null;
  search: SmartFavoriteSearchResponse | null;
  selectedPath: string[];
  pathResults: SmartFavoriteResult[];
  busy: string;
}) {
  if (qa) {
    return (
      <>
        <ResultHeader title="本地引用证据" count={qa.citedVideos.length} />
        {qa.citedVideos.length === 0 ? (
          <EmptyPanel text={qa.answer} />
        ) : (
          qa.citedVideos.map(video => <QaCitationCard key={video.bvid || String(video.avid)} video={video} />)
        )}
      </>
    );
  }

  if (search) {
    return (
      <>
        <ResultHeader title="搜索结果" count={search.results.length} />
        {search.results.length === 0 ? (
          <EmptyPanel text="没有找到匹配收藏" />
        ) : (
          search.results.map(result => <ResultCard key={result.item.itemKey} result={result} />)
        )}
      </>
    );
  }

  if (selectedPath.length > 0) {
    const title = selectedPath.join(' / ');
    return (
      <>
        <ResultHeader title={title} count={pathResults.length} />
        {busy === 'path' ? (
          <EmptyPanel text="正在加载分类内容..." />
        ) : pathResults.length === 0 ? (
          <EmptyPanel text="这个分类下暂时没有视频" />
        ) : (
          pathResults.map(result => <ResultCard key={result.item.itemKey} result={result} />)
        )}
      </>
    );
  }

  return (
    <>
      <ResultHeader title="分类内容" count={0} />
      <EmptyPanel text="请选择一个分类或输入搜索" />
    </>
  );
}

function ResultHeader({ title, count }: { title: string; count: number }) {
  return (
    <div style={{ ...CARD, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
      <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
      </div>
      <div style={{ color: BILI_BLUE, fontSize: '12px', whiteSpace: 'nowrap' }}>{count} 个视频</div>
    </div>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div style={{ ...CARD, color: '#9090A0', fontSize: '13px', textAlign: 'center', padding: '40px 12px' }}>
      {text}
    </div>
  );
}

function QaAnswerPanel({ qa }: { qa: SmartFavoriteQaResponse }) {
  const statusTone = getQaStatusTone(qa.status.kind);
  const synthesisTone = getQaSynthesisTone(qa.synthesis?.status ?? 'local_fallback');
  return (
    <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <Badge text={qaAnswerTypeLabel(qa.answerType)} color={statusTone} />
        <Badge text={`证据强度：${qaConfidenceLabel(qa.confidence)}`} color={qa.confidence === 'high' ? '#00D4AA' : qa.confidence === 'medium' ? BILI_BLUE : '#FFB347'} />
        <Badge text={`结果状态：${qaStatusLabel(qa.status.kind)}`} color={statusTone} />
        <Badge text={`AI：${qaSynthesisStatusLabel(qa.synthesis?.status ?? 'local_fallback')}`} color={synthesisTone} />
      </div>
      {qa.synthesis?.status === 'generated' && qa.synthesis.answer && (
        <div style={{
          background: '#F6F7F8',
          border: `1px solid ${BILI_BLUE}`,
          borderRadius: '8px',
          padding: '10px',
        }}>
          <div style={{ color: BILI_BLUE, fontSize: '11px', fontWeight: 600, marginBottom: '5px' }}>
            AI 综合回答
          </div>
          <div style={{ color: '#18191C', fontSize: '13px', lineHeight: 1.5 }}>{qa.synthesis.answer}</div>
          <div style={{ color: '#9090A0', fontSize: '11px', lineHeight: 1.45, marginTop: '6px' }}>
            模型：{qa.synthesis.model ?? '未知'} / 引用来源：{(qa.synthesis.citedVideoRefs ?? []).join('、') || '下方引用视频'}
          </div>
        </div>
      )}
      <div style={{
        background: '#F6F7F8',
        border: '1px solid #E3E5E7',
        borderRadius: '8px',
        padding: '10px',
      }}>
        <div style={{ color: '#61666D', fontSize: '11px', fontWeight: 600, marginBottom: '5px' }}>
          本地引用回答
        </div>
        <div style={{ color: '#18191C', fontSize: '13px', lineHeight: 1.5 }}>{qa.answer}</div>
        <div style={{ color: '#61666D', fontSize: '12px', lineHeight: 1.5, marginTop: '6px' }}>{qa.evidenceSummary}</div>
      </div>
      {qa.synthesis && qa.synthesis.status !== 'generated' && (
        <div style={{ color: synthesisTone, fontSize: '12px', lineHeight: 1.5 }}>
          {qaSynthesisMessage(qa.synthesis)}
        </div>
      )}
      {qa.status.notes.length > 0 && (
        <div style={{ color: '#FFB347', fontSize: '12px', lineHeight: 1.5 }}>
          {qa.status.notes.join(' ')}
        </div>
      )}
    </div>
  );
}

function QaCitationCard({ video }: { video: SmartFavoriteQaCitedVideo }) {
  return (
    <a
      href={video.link || undefined}
      target="_blank"
      rel="noreferrer"
      onClick={event => {
        if (!video.link) event.preventDefault();
      }}
      style={{ ...CARD, display: 'flex', flexDirection: 'column', gap: '8px', textDecoration: 'none' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600, lineHeight: 1.4 }}>{video.title}</div>
          <div style={{ color: '#9090A0', fontSize: '11px', marginTop: '4px' }}>
            {video.bvid || `av${video.avid}`} · {video.authorName || '未知 UP'} · {video.folderTitle || '未知收藏夹'}
          </div>
        </div>
        <Badge text={qaConfidenceLabel(video.confidence)} color={video.confidence === 'high' ? '#00D4AA' : video.confidence === 'medium' ? BILI_BLUE : '#FFB347'} />
      </div>
      {video.smartPath.length > 0 && (
        <div style={{ color: BILI_BLUE, fontSize: '11px' }}>{video.smartPath.join(' / ')}</div>
      )}
      <div style={{ color: '#D8D8E8', fontSize: '12px', lineHeight: 1.5 }}>{video.evidence}</div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {video.matchReasons.map(reason => <Badge key={reason} text={reason} color="#6666AA" />)}
      </div>
      <div style={{ color: '#9090A0', fontSize: '11px', lineHeight: 1.5 }}>
        证据字段：{formatQaSourceFields(video.sourceFields)} · 本地评分 {video.score}
      </div>
      {video.evidenceHits.length > 0 && (
        <div style={{ display: 'grid', gap: '4px' }}>
          {video.evidenceHits.slice(0, 4).map(hit => (
            <div key={`${hit.field}:${hit.terms.join('|')}`} style={{ color: '#61666D', fontSize: '11px', lineHeight: 1.45 }}>
              {hit.label}: {hit.terms.join(', ')}
            </div>
          ))}
        </div>
      )}
      <div style={{ color: video.link ? BILI_PINK : '#666', fontSize: '11px' }}>{video.link ? '打开视频' : '无可用链接'}</div>
    </a>
  );
}

function qaAnswerTypeLabel(type: SmartFavoriteQaResponse['answerType']): string {
  switch (type) {
    case 'retrieval_answer':
      return '引用回答';
    case 'candidate_list':
      return '候选列表';
    case 'no_result':
      return '未找到结果';
    case 'insufficient_evidence':
      return '证据不足';
    default:
      return '本地回答';
  }
}

function qaConfidenceLabel(confidence: SmartFavoriteQaResponse['confidence']): string {
  switch (confidence) {
    case 'high':
      return '高';
    case 'medium':
      return '中';
    default:
      return '低';
  }
}

function qaStatusLabel(kind: SmartFavoriteQaResponse['status']['kind']): string {
  switch (kind) {
    case 'ok':
      return '可回答';
    case 'no_result':
      return '未找到匹配';
    case 'low_confidence':
      return '低置信候选';
    case 'stale_index':
      return '索引可能过期';
    case 'incomplete_sync':
      return '同步可能不完整';
    case 'index_missing':
      return '智能索引缺失';
    case 'insufficient_evidence':
      return '证据不足';
    default:
      return '待确认';
  }
}

function qaSynthesisStatusLabel(status: NonNullable<SmartFavoriteQaResponse['synthesis']>['status']): string {
  switch (status) {
    case 'generated':
      return '已综合';
    case 'disabled':
      return '未启用';
    case 'not_configured':
      return '未配置';
    case 'failed':
      return '生成失败';
    case 'rejected':
      return '已拒绝';
    case 'local_fallback':
      return '本地结果';
    default:
      return '本地结果';
  }
}

function qaSynthesisMessage(synthesis: NonNullable<SmartFavoriteQaResponse['synthesis']>): string {
  const reason = synthesis.reason ?? '';
  if (synthesis.status === 'disabled') {
    return 'AI 综合未在设置中启用，当前显示本地引用结果。';
  }
  if (synthesis.status === 'not_configured') {
    return 'AI 综合尚未在设置中配置 API Key，当前显示本地引用结果。';
  }
  if (synthesis.status === 'local_fallback') {
    return '没有可引用视频时不会请求 AI，当前显示本地检索结果。';
  }
  if (synthesis.status === 'rejected') {
    return `AI 综合结果未通过引用边界检查，已显示本地引用结果。${qaGuardReasonLabel(reason)}`;
  }
  if (synthesis.status === 'failed') {
    return 'AI 综合暂时不可用，已显示本地引用结果。';
  }
  return '当前显示本地引用结果。';
}

function qaGuardReasonLabel(reason: string): string {
  if (!reason) return '';
  if (reason.startsWith('AI_OUTSIDE_CITED_VIDEO_REF')) return '原因：AI 引用了未提供的视频编号。';
  if (reason.startsWith('AI_OUTSIDE_VIDEO_REFERENCE')) return '原因：AI 在回答中提到了引用列表外的视频。';
  if (reason.startsWith('AI_OUTSIDE_TITLE_REFERENCE')) return '原因：AI 提到了引用列表外的视频标题。';
  if (reason === 'AI_EMPTY_ANSWER') return '原因：AI 没有返回可用回答。';
  if (reason === 'AI_MISSING_CITED_VIDEO_REFS') return '原因：AI 没有标注引用视频。';
  return '原因：AI 返回内容不符合引用边界。';
}

function formatQaSourceFields(fields: string[]): string {
  const labels = fields.map(qaSourceFieldLabel).filter(Boolean);
  return labels.length ? labels.join('、') : '本地元数据';
}

function qaSourceFieldLabel(field: string): string {
  switch (field) {
    case 'bvid':
      return 'BVID';
    case 'title':
      return '标题';
    case 'authorName':
      return 'UP 主';
    case 'smart.path':
      return '智能分类路径';
    case 'smart.keywords':
      return '智能关键词';
    case 'smart.aliases':
      return '智能别名';
    case 'smart.summary':
      return '智能摘要';
    case 'folderTitle':
      return '收藏夹';
    case 'tagName':
      return '分区';
    case 'tags':
      return '标签';
    case 'intro':
      return '简介';
    default:
      return field;
  }
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        border: `1px solid ${color}`,
        borderRadius: '999px',
        color,
        fontSize: '11px',
        lineHeight: 1,
        padding: '4px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

function getQaStatusTone(kind: SmartFavoriteQaResponse['status']['kind']): string {
  switch (kind) {
    case 'ok':
      return '#00D4AA';
    case 'low_confidence':
    case 'stale_index':
    case 'index_missing':
      return '#FFB347';
    case 'incomplete_sync':
    case 'insufficient_evidence':
    case 'no_result':
      return '#FF6B6B';
    default:
      return '#9090A0';
  }
}

function getQaSynthesisTone(status: NonNullable<SmartFavoriteQaResponse['synthesis']>['status']): string {
  switch (status) {
    case 'generated':
      return '#00D4AA';
    case 'disabled':
    case 'not_configured':
    case 'local_fallback':
      return '#9090A0';
    case 'rejected':
    case 'failed':
      return '#FFB347';
    default:
      return '#9090A0';
  }
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: '#F6F7F8', borderRadius: '6px', padding: '10px', textAlign: 'center' }}>
      <div style={{ color: '#18191C', fontSize: '20px', fontWeight: 700 }}>{value}</div>
      <div style={{ color: '#9090A0', fontSize: '11px', marginTop: '2px' }}>{label}</div>
    </div>
  );
}

function Status({ color, text }: { color: string; text: string }) {
  return <div style={{ ...CARD, color, fontSize: '13px' }}>{text}</div>;
}

function SyncDiagnostics({
  diagnostics,
  onProbe,
}: {
  diagnostics: FavoriteFolderSyncDiagnostic[];
  onProbe?: (mediaId: number) => void;
}) {
  if (diagnostics.length === 0) return null;

  const totals = diagnostics.reduce((sum, diagnostic) => ({
    reported: sum.reported + diagnostic.reportedMediaCount,
    requestedPages: sum.requestedPages + diagnostic.requestedPages,
    fetchedPages: sum.fetchedPages + diagnostic.pagesFetched,
    stored: sum.stored + diagnostic.storedVideoItems,
    filtered: sum.filtered + diagnostic.filteredItems,
    delta: sum.delta + diagnostic.unexplainedDelta,
    errors: sum.errors + diagnostic.pageErrors,
    incomplete: sum.incomplete + (diagnostic.completenessState === 'incomplete' ? 1 : 0),
  }), { reported: 0, requestedPages: 0, fetchedPages: 0, stored: 0, filtered: 0, delta: 0, errors: 0, incomplete: 0 });
  const overallState = totals.incomplete > 0 ? 'incomplete' : 'complete';

  return (
    <div style={{ marginBottom: '12px', overflowX: 'auto' }}>
      <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>
        同步诊断：{syncCompletenessLabel(overallState)}，B站报告 {totals.reported} 条，请求/获取页数 {totals.requestedPages}/{totals.fetchedPages}，本地保存 {totals.stored} 条，过滤 {totals.filtered} 条，差异 {totals.delta} 条，页面错误 {totals.errors} 个。
      </div>
      <div style={{ minWidth: '1160px', display: 'grid', gridTemplateColumns: '1.5fr 88px 88px 92px 72px 72px 180px 72px 2fr 80px', gap: '1px', background: '#E3E5E7', border: '1px solid #E3E5E7', borderRadius: '6px', overflow: 'hidden' }}>
        {['收藏夹', '状态', 'B站报告', '请求/获取', '原始项', '已保存', '已过滤(失效/缺ID/非视频)', '差异', '页面问题', '诊断'].map(label => (
          <AuditCell key={label} header text={label} />
        ))}
        {diagnostics.map(diagnostic => (
          <SyncDiagnosticRow key={diagnostic.mediaId} diagnostic={diagnostic} onProbe={onProbe} />
        ))}
      </div>
    </div>
  );
}

function SyncDiagnosticRow({
  diagnostic,
  onProbe,
}: {
  diagnostic: FavoriteFolderSyncDiagnostic;
  onProbe?: (mediaId: number) => void;
}) {
  const filteredBreakdown = `${diagnostic.filteredItems} (${diagnostic.filteredUnavailableItems}/${diagnostic.filteredMissingIdItems}/${diagnostic.filteredNonVideoItems})`;
  const pageIssues = diagnostic.pageErrors > 0 ? `${diagnostic.pageErrors} 个：${diagnostic.errors.join(' | ')}` : '-';
  return (
    <>
      <AuditCell text={`${diagnostic.title || '未命名收藏夹'} #${diagnostic.mediaId}`} />
      <AuditCell text={syncCompletenessLabel(diagnostic.completenessState)} tone={diagnostic.completenessState === 'incomplete' ? 'error' : undefined} />
      <AuditCell text={String(diagnostic.reportedMediaCount)} tone={diagnostic.unexplainedDelta > 0 ? 'warn' : undefined} />
      <AuditCell text={`${diagnostic.requestedPages}/${diagnostic.pagesFetched}`} tone={diagnostic.requestedPages > diagnostic.pagesFetched ? 'warn' : undefined} />
      <AuditCell text={String(diagnostic.rawResourcesSeen)} />
      <AuditCell text={String(diagnostic.storedVideoItems)} />
      <AuditCell text={filteredBreakdown} />
      <AuditCell text={String(diagnostic.unexplainedDelta)} tone={diagnostic.unexplainedDelta > 0 ? 'warn' : undefined} />
      <AuditCell text={pageIssues} tone={diagnostic.pageErrors > 0 ? 'error' : undefined} />
      <AuditActionCell
        label="诊断"
        disabled={!onProbe}
        onClick={onProbe ? () => onProbe(diagnostic.mediaId) : undefined}
      />
    </>
  );
}

function FavoriteFolderProbePanel({ result }: { result: FavoriteFolderGapProbeResult }) {
  const { folder, diagnostic, gapBuckets, localIndexCoverage } = result;
  const pageCount = diagnostic.pageDiagnostics.length;

  return (
    <section style={{ ...CARD, marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'start', marginBottom: '8px' }}>
        <div>
          <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600 }}>
            诊断结果：{folder.title || '未命名收藏夹'} #{folder.mediaId}
          </div>
          <div style={{ color: '#9090A0', fontSize: '12px', lineHeight: 1.5, marginTop: '4px' }}>
            结论：{probeClassificationLabel(result.classification)} | 停止原因：{syncStopReasonLabel(diagnostic.stopReason)} | 页面 {pageCount} | B站报告 {folder.reportedMediaCount}
          </div>
        </div>
        <Badge text={probeClassificationLabel(result.classification)} color={result.classification === 'complete' ? '#00D4AA' : '#FFB347'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: '8px', marginBottom: '10px' }}>
        <Metric label="接口唯一项" value={diagnostic.uniqueResourcesSeen} />
        <Metric label="诊断保存" value={diagnostic.storedVideoItems} />
        <Metric label="过滤项" value={gapBuckets.filteredItems} />
        <Metric label="接口缺口" value={gapBuckets.apiMissingItems} />
        <Metric label="本地保存" value={localIndexCoverage.storedItems} />
        <Metric label="索引缺口" value={gapBuckets.storedButNotIndexedItems} />
      </div>

      <div style={{ color: '#61666D', fontSize: '12px', lineHeight: 1.6, marginBottom: '10px' }}>
        重复项：资源 ID {diagnostic.duplicateResourceIds}，BVID {diagnostic.duplicateBvids}。本地重合 {localIndexCoverage.overlapItems}，仅本地保留 {localIndexCoverage.localOnlyItems}，仅诊断命中 {localIndexCoverage.probeOnlyItems}。已索引 {localIndexCoverage.indexedItems}，失败 {localIndexCoverage.failedItems}，待索引 {localIndexCoverage.pendingItems}，可能过期 {localIndexCoverage.staleItems}。
      </div>

      {result.notes.length > 0 && (
        <div style={{ display: 'grid', gap: '4px', marginBottom: '10px' }}>
          {result.notes.map(note => (
            <div key={note} style={{ color: '#FFB347', fontSize: '12px', lineHeight: 1.5 }}>{note}</div>
          ))}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: '980px', display: 'grid', gridTemplateColumns: '74px 90px 90px 84px 96px 84px 84px 84px 100px 100px', gap: '1px', background: '#E3E5E7', border: '1px solid #E3E5E7', borderRadius: '6px', overflow: 'hidden' }}>
          {['页码', '尝试次数', '返回数量', '仍有更多', '短页', '已保存', '已过滤', '重复ID', '重复BVID', '重试改善'].map(label => (
            <AuditCell key={label} header text={label} />
          ))}
          {diagnostic.pageDiagnostics.map(page => (
            <FavoriteFolderProbePageRow key={page.pageNumber} page={page} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FavoriteFolderProbePageRow({
  page,
}: {
  page: FavoriteFolderGapProbeResult['diagnostic']['pageDiagnostics'][number];
}) {
  return (
    <>
      <AuditCell text={String(page.pageNumber)} />
      <AuditCell text={String(page.attempts)} tone={page.attempts > 1 ? 'warn' : undefined} />
      <AuditCell text={page.attemptResourceCounts.join(' / ')} tone={page.attempts > 1 ? 'warn' : undefined} />
      <AuditCell text={formatBoolean(page.hasMore)} tone={page.hasMore ? 'warn' : undefined} />
      <AuditCell text={page.shortPageWithHasMore ? `${page.returnedResourceCount}/${page.requestedPageSize}` : '完整页'} tone={page.shortPageWithHasMore ? 'warn' : undefined} />
      <AuditCell text={String(page.storedVideoItems)} />
      <AuditCell text={`${page.filteredItems} (${page.filteredUnavailableItems}/${page.filteredMissingIdItems}/${page.filteredNonVideoItems})`} />
      <AuditCell text={String(page.duplicateResourceIds)} tone={page.duplicateResourceIds > 0 ? 'warn' : undefined} />
      <AuditCell text={String(page.duplicateBvids)} tone={page.duplicateBvids > 0 ? 'warn' : undefined} />
      <AuditCell text={formatBoolean(page.retryImprovedShortPage)} tone={page.retryImprovedShortPage ? 'warn' : undefined} />
    </>
  );
}

function syncCompletenessLabel(state: FavoriteFolderSyncDiagnostic['completenessState']): string {
  return state === 'complete' ? '完整' : '可能不完整';
}

function syncStopReasonLabel(reason: FavoriteFolderSyncDiagnostic['stopReason']): string {
  switch (reason) {
    case 'has_more_false':
      return '接口提示已到末页';
    case 'empty_page':
      return '返回空页';
    case 'empty_page_has_more':
      return '空页但仍提示有更多';
    case 'request_error':
      return '请求出错';
    case 'max_pages_reached':
      return '达到页数上限';
    case 'probe_limit_reached':
      return '达到诊断上限';
    default:
      return '未知';
  }
}

function probeClassificationLabel(classification: FavoriteFolderGapProbeResult['classification']): string {
  switch (classification) {
    case 'complete':
      return '未发现缺口';
    case 'api_gap_only':
      return '接口侧缺口';
    case 'filtered_only':
      return '过滤项造成差异';
    case 'index_gap_only':
      return '索引缺口';
    case 'local_retained_only':
      return '仅本地保留差异';
    case 'mixed':
      return '混合差异';
    default:
      return '待确认';
  }
}

function formatBoolean(value: boolean): string {
  return value ? '是' : '否';
}

function AuditCell({
  text,
  header,
  tone,
}: {
  text: string;
  header?: boolean;
  tone?: 'warn' | 'error';
}) {
  return (
    <div
      title={text}
      style={{
        background: header ? '#F1F2F3' : '#F6F7F8',
        color: tone === 'error' ? '#FF6B6B' : tone === 'warn' ? '#FFB347' : header ? '#18191C' : '#61666D',
        fontSize: '11px',
        fontWeight: header ? 600 : 400,
        minWidth: 0,
        overflow: 'hidden',
        padding: '7px 8px',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

function AuditActionCell({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ background: '#F6F7F8', padding: '6px 8px' }}>
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          width: '100%',
          background: 'transparent',
          color: disabled ? '#666' : BILI_BLUE,
          border: '1px solid #E3E5E7',
          borderRadius: '5px',
          padding: '4px 6px',
          fontSize: '11px',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {label}
      </button>
    </div>
  );
}

function TextInput({
  value,
  onInput,
  placeholder,
  password,
  onEnter,
}: {
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
  password?: boolean;
  onEnter?: () => void;
}) {
  return (
    <input
      value={value}
      type={password ? 'password' : 'text'}
      placeholder={placeholder}
      onInput={event => onInput((event.target as HTMLInputElement).value)}
      onKeyDown={event => { if (event.key === 'Enter') onEnter?.(); }}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        background: '#F6F7F8',
        border: '1px solid #E3E5E7',
        color: '#18191C',
        borderRadius: '6px',
        padding: '9px 10px',
        fontSize: '12px',
        outline: 'none',
      }}
    />
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  variant = 'solid',
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'solid' | 'ghost';
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: variant === 'solid' ? BILI_PINK : 'transparent',
        color: variant === 'solid' ? '#FFFFFF' : '#61666D',
        border: variant === 'solid' ? 'none' : '1px solid #E3E5E7',
        borderRadius: '6px',
        padding: '9px 12px',
        fontSize: '12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function TreeAction({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: '#F6F7F8',
        color: '#61666D',
        border: '1px solid #E3E5E7',
        borderRadius: '5px',
        padding: '3px 7px',
        fontSize: '11px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function TreeRow({
  row,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  row: TreeRowData;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const hasChildren = row.children.length > 0;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '18px 1fr auto',
        alignItems: 'center',
        gap: '6px',
        width: '100%',
        padding: '3px 4px',
        paddingLeft: `${row.depth * 12 + 2}px`,
        background: selected ? 'rgba(251, 114, 153, 0.16)' : 'transparent',
        border: selected ? `1px solid ${BILI_PINK}` : '1px solid transparent',
        borderRadius: '4px',
        color: 'inherit',
      }}
    >
      <button
        onClick={hasChildren ? onToggle : undefined}
        disabled={!hasChildren}
        title={hasChildren ? (expanded ? '收起' : '展开') : ''}
        style={{
          width: '18px',
          height: '18px',
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: hasChildren ? BILI_BLUE : '#555',
          cursor: hasChildren ? 'pointer' : 'default',
          fontSize: '12px',
          lineHeight: '18px',
        }}
      >
        {hasChildren ? (expanded ? '-' : '+') : ''}
      </button>
      <button
        onClick={onSelect}
        title={row.path.join(' / ')}
        style={{
          minWidth: 0,
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: selected ? '#FFFFFF' : row.depth === 0 ? '#FFFFFF' : '#61666D',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: row.depth === 0 ? 600 : 400,
          lineHeight: 1.4,
          overflow: 'hidden',
          textAlign: 'left',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.name}
      </button>
      <span style={{ color: BILI_BLUE, fontSize: '11px' }}>{row.count}</span>
    </div>
  );
}

function ResultCard({ result }: { result: SmartFavoriteResult }) {
  const item = result.item;
  const videoUrl = getVideoUrl(item);
  const categoryEvidence = result.smart?.categoryEvidence;
  return (
    <a
      href={videoUrl ?? undefined}
      target="_blank"
      rel="noreferrer"
      onClick={event => {
        if (!videoUrl) event.preventDefault();
      }}
      style={{ ...CARD, display: 'grid', gridTemplateColumns: '112px 1fr', gap: '10px', textDecoration: 'none' }}
    >
      <img
        src={item.cover}
        alt=""
        style={{ width: '112px', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: '6px', background: '#F6F7F8' }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: '#18191C', fontSize: '13px', fontWeight: 600, lineHeight: 1.4, marginBottom: '5px' }}>{item.title}</div>
        <div style={{ color: '#9090A0', fontSize: '11px', marginBottom: '6px' }}>
          {item.authorName || '未知UP主'} · {item.folderTitle}
        </div>
        <div style={{ color: BILI_BLUE, fontSize: '11px', marginBottom: '6px' }}>
          {(result.smart?.path ?? ['未分类']).join(' / ')}
        </div>
        <div style={{ color: '#61666D', fontSize: '12px', lineHeight: 1.5 }}>
          {result.smart?.summary || item.intro || '暂无摘要'}
        </div>
        <div style={{ color: getCategoryEvidenceColor(categoryEvidence?.kind), fontSize: '11px', lineHeight: 1.5, marginTop: '6px' }}>
          分类证据：{categoryEvidence?.summary ?? '暂无分类证据说明。'}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
          <span style={{ color: '#666', fontSize: '11px' }}>
            {result.reasons.join(' · ')}{result.score > 0 ? ` · 分数 ${Math.round(result.score)}` : ''}
          </span>
          <span style={{ color: videoUrl ? BILI_PINK : '#666', fontSize: '11px', whiteSpace: 'nowrap' }}>
            {videoUrl ? '打开' : '无可用链接'}
          </span>
        </div>
      </div>
    </a>
  );
}

function getVideoUrl(item: SmartFavoriteResult['item']): string | null {
  if (item.bvid) return `https://www.bilibili.com/video/${item.bvid}`;
  if (item.avid) return `https://www.bilibili.com/video/av${item.avid}`;
  return null;
}

function getCategoryEvidenceColor(kind: SmartFavoriteCategoryEvidenceKind | undefined): string {
  switch (kind) {
    case 'ai':
      return '#7FD1FF';
    case 'metadata':
      return '#A8E6A1';
    case 'mixed':
      return '#C9B6FF';
    case 'path_fallback':
      return '#FFB347';
    default:
      return '#9090A0';
  }
}

interface TreeRowData extends SmartFavoriteTreeNode {
  depth: number;
}

function getVisibleTreeRows(
  nodes: SmartFavoriteTreeNode[],
  expanded: Set<string>,
  depth = 0,
): TreeRowData[] {
  const rows: TreeRowData[] = [];
  for (const node of nodes) {
    rows.push({ ...node, depth });
    if (node.children.length > 0 && expanded.has(pathKey(node.path))) {
      rows.push(...getVisibleTreeRows(node.children, expanded, depth + 1));
    }
  }
  return rows;
}

function collectExpandablePathKeys(nodes: SmartFavoriteTreeNode[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (node.children.length > 0) {
      keys.push(pathKey(node.path));
      keys.push(...collectExpandablePathKeys(node.children));
    }
  }
  return keys;
}

function pathKey(path: string[]): string {
  return path.join('\u0001');
}
