import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  DynamicBillColumn,
  DynamicBillExplanationResult,
  DynamicBillFeedbackStateView,
  DynamicBillFilterPreference,
  DynamicBillGenerateResult,
  DynamicBillEvidence,
  DynamicBillItem,
  DynamicBillLessReminderResult,
  DynamicBillPendingFeedbackActionView,
  DynamicBillCreatorReviewPromptView,
  DynamicBillOverview,
  DynamicBillStatus,
  DynamicBillStatusFilter,
  DynamicSyncResult,
  DynamicSyncStatus,
  DynamicBillUndoFeedbackResult,
} from "../../../src/shared/types/dynamic-bill";
import type { UserConfig } from "../../../src/shared/types/config";
import { requestSW } from "../../utils/messaging";
import { dynamicBillFailureCopy, explanationStateCopy } from "./failure-copy";
import {
  chooseDynamicBillSelectedKey,
  resolveDynamicBillLayoutState,
} from "./layout-state";

const STATUS_FILTERS: Array<{
  key: DynamicBillStatusFilter;
  label: string;
  detail: string;
}> = [
  { key: "active", label: "待查看", detail: "优先展示未打开和已打开，不包含已消费或已处理" },
  { key: "unopened", label: "未打开", detail: "尚未从动态账单打开新投稿" },
  { key: "opened", label: "已打开", detail: "打开过，但尚未确认有效观看" },
  { key: "consumed", label: "已消费", detail: "由观看历史或播放器事件确认" },
  { key: "processed", label: "已处理", detail: "用户手动完成或忽略，不等同于消费" },
];

const BILL_COLUMNS: Array<{
  key: DynamicBillColumn;
  title: string;
  detail: string;
  accent: "pink" | "blue" | "mint";
}> = [
  {
    key: "buried_follow",
    title: "被淹没的关注",
    detail: "关注关系有记忆证据，近期观看缺席或近乎缺席，并且最近 7 天有新投稿。",
    accent: "mint",
  },
  {
    key: "favorite_related",
    title: "收藏关联更新",
    detail: "本地已同步收藏里有这个 UP 的既有作品，并且最近 7 天有新投稿。",
    accent: "pink",
  },
  {
    key: "follow_rotation",
    title: "关注轮换",
    detail: "剩余已关注 UP 的最近新投稿，按全局轮换扩大创作者覆盖。",
    accent: "blue",
  },
];

const EMPTY_FEEDBACK_STATE: DynamicBillFeedbackStateView = {
  pendingActions: [],
  reviewPrompts: [],
};

export function DynamicBillPage() {
  const [statusFilter, setStatusFilter] = useState<DynamicBillStatusFilter>("active");
  const [overview, setOverview] = useState<DynamicBillOverview | null>(null);
  const [items, setItems] = useState<DynamicBillItem[]>([]);
  const [userConfig, setUserConfig] = useState<UserConfig | null>(null);
  const [selectedBillKey, setSelectedBillKey] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [processingBillKey, setProcessingBillKey] = useState("");
  const [reviewPromptResolvingMid, setReviewPromptResolvingMid] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [feedbackState, setFeedbackState] =
    useState<DynamicBillFeedbackStateView>(EMPTY_FEEDBACK_STATE);
  const undoingActionKeysRef = useRef<Set<string>>(new Set());
  const [undoingActionKeys, setUndoingActionKeys] = useState<Set<string>>(
    () => new Set(),
  );

  const activeStatus =
    STATUS_FILTERS.find((item) => item.key === statusFilter) ?? STATUS_FILTERS[0];
  const syncState = overview?.syncState;
  const isSyncing = syncing || syncState?.status === "syncing";
  const isAiEnabled = userConfig?.dynamicBill.aiExplanationsEnabled === true;
  const isAiConfigured = Boolean(userConfig?.ai.apiKey.trim());
  const overviewNotice = overview
    ? describeOverview(overview)
    : "正在读取动态账单同步状态。";
  const layoutState = useMemo(
    () => resolveDynamicBillLayoutState(items, statusFilter, selectedBillKey),
    [items, selectedBillKey, statusFilter],
  );
  const visibleItems = layoutState.visibleItems;
  const selectedItem = layoutState.selectedItem;
  const statusCounts = useMemo(() => countByStatus(items), [items]);
  const allColumnsEmpty = layoutState.allColumnsEmpty;

  useEffect(() => {
    refreshConfig().catch((error) => {
      setNotice(dynamicBillFailureCopy("readConfig", error));
    });
    refreshFilterPreference().catch((error) => {
      setNotice(dynamicBillFailureCopy("readFilter", error));
    });
    refreshOverview().catch((error) => {
      setNotice(dynamicBillFailureCopy("readOverview", error));
    });
    refreshBillItems().catch((error) => {
      setNotice(dynamicBillFailureCopy("readItems", error));
    });
    refreshFeedbackState().catch((error) => {
      setNotice(dynamicBillFailureCopy("readItems", error));
    });
  }, []);

  useEffect(() => {
    const nextDeadline = feedbackState.pendingActions.reduce((earliest, action) => {
      if (action.undoDeadlineAt <= Date.now()) return earliest;
      return Math.min(earliest, action.undoDeadlineAt);
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextDeadline)) return undefined;

    const timeout = window.setTimeout(() => {
      refreshBillItems().catch(() => {});
      refreshFeedbackState().catch(() => {});
    }, Math.max(0, nextDeadline - Date.now() + 80));

    return () => window.clearTimeout(timeout);
  }, [feedbackState.pendingActions]);

  useEffect(() => {
    setSelectedBillKey((current) =>
      chooseDynamicBillSelectedKey(current, items, statusFilter),
    );
  }, [items, statusFilter]);

  async function refreshOverview() {
    const next = await requestSW<DynamicBillOverview>("GET_DYNAMIC_BILL_OVERVIEW");
    setOverview(next);
  }

  async function refreshConfig() {
    setUserConfig(await requestSW<UserConfig>("GET_CONFIG"));
  }

  async function refreshFilterPreference() {
    const preference = await requestSW<DynamicBillFilterPreference>(
      "GET_DYNAMIC_BILL_FILTER",
    );
    setStatusFilter(preference.status);
  }

  async function refreshBillItems() {
    const next = await requestSW<DynamicBillItem[]>("GET_DYNAMIC_BILL_ITEMS");
    setItems(next);
    setSelectedBillKey((current) =>
      chooseDynamicBillSelectedKey(current, next, statusFilter),
    );
  }

  async function refreshFeedbackState() {
    const next = await requestSW<DynamicBillFeedbackStateView>(
      "GET_DYNAMIC_BILL_FEEDBACK_STATE",
    );
    setFeedbackState(next);
  }

  async function generateLocalBill(): Promise<DynamicBillGenerateResult> {
    const result = await requestSW<DynamicBillGenerateResult>("GENERATE_DYNAMIC_BILL");
    setOverview(result.overview);
    setItems(result.items);
    setSelectedBillKey((current) =>
      chooseDynamicBillSelectedKey(current, result.items, statusFilter),
    );
    return result;
  }

  async function handleStatusFilterChange(nextStatus: DynamicBillStatusFilter) {
    setStatusFilter(nextStatus);
    setSelectedBillKey((current) =>
      chooseDynamicBillSelectedKey(current, items, nextStatus),
    );
    try {
      await requestSW<DynamicBillFilterPreference>("UPDATE_DYNAMIC_BILL_FILTER", {
        status: nextStatus,
      });
    } catch (error) {
      setNotice(dynamicBillFailureCopy("saveFilter", error));
    }
  }

  async function handleOpenVideo(item: DynamicBillItem) {
    setProcessingBillKey(item.billKey);
    setNotice("");
    try {
      await requestSW<DynamicBillItem>("OPEN_DYNAMIC_BILL_VIDEO", {
        billKey: item.billKey,
      });
      await refreshBillItems();
      setNotice(`已打开《${videoTitle(item)}》，账单状态推进为已打开。`);
    } catch (error) {
      setNotice(dynamicBillFailureCopy("openVideo", error));
    } finally {
      setProcessingBillKey("");
    }
  }

  async function handleMarkProcessed(item: DynamicBillItem) {
    setProcessingBillKey(item.billKey);
    setNotice("");
    try {
      await requestSW<DynamicBillItem>("MARK_DYNAMIC_BILL_ITEM_PROCESSED", {
        billKey: item.billKey,
      });
      await refreshBillItems();
      setNotice(`已将「${item.creatorName}」标记为已处理；该动作不等同于已消费。`);
    } catch (error) {
      setNotice(dynamicBillFailureCopy("markProcessed", error));
    } finally {
      setProcessingBillKey("");
    }
  }

  async function handleLessReminder(item: DynamicBillItem) {
    setProcessingBillKey(item.billKey);
    setNotice("");
    try {
      const result = await requestSW<DynamicBillLessReminderResult | null>(
        "APPLY_DYNAMIC_BILL_CREATOR_LESS_REMINDER",
        {
          billKey: item.billKey,
          idempotencyKey: `${item.billKey}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        },
      );
      if (!result) {
        setNotice("没有找到这个账单项，请刷新后重试。");
        return;
      }
      await Promise.all([refreshBillItems(), refreshFeedbackState()]);
      const seconds = result.action
        ? Math.max(1, Math.ceil((result.action.undoDeadlineAt - Date.now()) / 1000))
        : 0;
      setNotice(seconds > 0
        ? `已少提醒「${item.creatorName}」；${seconds} 秒内可撤销，过期后才计入有效次数。`
        : `已少提醒「${item.creatorName}」，这次操作已经生效。`);
    } catch (error) {
      setNotice(dynamicBillFailureCopy("markProcessed", error));
    } finally {
      setProcessingBillKey("");
    }
  }

  async function handleUndoLessReminder(action: DynamicBillPendingFeedbackActionView) {
    if (undoingActionKeysRef.current.has(action.actionKey)) return;
    undoingActionKeysRef.current.add(action.actionKey);
    setUndoingActionKeys((current) => {
      const next = new Set(current);
      next.add(action.actionKey);
      return next;
    });
    setNotice("");
    try {
      const result = await requestSW<DynamicBillUndoFeedbackResult>(
        "UNDO_DYNAMIC_BILL_CREATOR_LESS_REMINDER",
        { undoToken: action.undoToken },
      );
      await Promise.all([refreshBillItems(), refreshFeedbackState()]);
      if (result.status === "undone" || result.status === "already_undone") {
        setNotice(`已撤销对「${action.creatorName}」的少提醒，本次不会计入有效次数。`);
      } else if (result.status === "expired") {
        setNotice("撤销窗口已经结束，这次少提醒已按本地规则生效。");
      } else {
        setNotice("这次撤销没有生效；当前状态已有更新，请刷新后查看。");
      }
    } catch (error) {
      setNotice(dynamicBillFailureCopy("markProcessed", error));
    } finally {
      undoingActionKeysRef.current.delete(action.actionKey);
      setUndoingActionKeys((current) => {
        const next = new Set(current);
        next.delete(action.actionKey);
        return next;
      });
    }
  }

  async function handleReviewPromptOpen(prompt: DynamicBillCreatorReviewPromptView) {
    setReviewPromptResolvingMid(prompt.creatorMid);
    setNotice("");
    try {
      await requestSW("OPEN_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT", {
        creatorMid: prompt.creatorMid,
      });
      await refreshFeedbackState();
      setNotice(`已打开「${prompt.creatorName}」的 B 站主页；Bili-Bill 不会修改关注关系。`);
    } catch (error) {
      setNotice(dynamicBillFailureCopy("openVideo", error));
    } finally {
      setReviewPromptResolvingMid(null);
    }
  }

  async function handleReviewPromptDismiss(prompt: DynamicBillCreatorReviewPromptView) {
    setReviewPromptResolvingMid(prompt.creatorMid);
    setNotice("");
    try {
      await requestSW("DISMISS_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT", {
        creatorMid: prompt.creatorMid,
      });
      await refreshFeedbackState();
      setNotice(`已暂不处理「${prompt.creatorName}」；当前 30 天暂停不变。`);
    } catch (error) {
      setNotice(dynamicBillFailureCopy("markProcessed", error));
    } finally {
      setReviewPromptResolvingMid(null);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setNotice("");
    try {
      const result = await generateLocalBill();
      setNotice(describeGenerateResult(result));
    } catch (error) {
      setNotice(dynamicBillFailureCopy("generateBill", error));
    } finally {
      setGenerating(false);
    }
  }

  async function handleBuildExplanations() {
    setExplaining(true);
    setNotice("");
    try {
      const total: DynamicBillExplanationResult = {
        status: "idle",
        processed: 0,
        generated: 0,
        failed: 0,
        skipped: 0,
        fallback: 0,
        discarded: 0,
        pending: 0,
        items,
      };
      let guard = Math.ceil(Math.max(items.length, 1) / 6) + 2;
      let includeFailedInNextBatch = true;
      do {
        const batch = await requestSW<DynamicBillExplanationResult>(
          "BUILD_DYNAMIC_BILL_EXPLANATIONS",
          {
            maxItems: 6,
            includeFailed: includeFailedInNextBatch,
          },
        );
        includeFailedInNextBatch = false;
        total.status = batch.status;
        total.processed += batch.processed;
        total.generated += batch.generated;
        total.failed += batch.failed;
        total.skipped += batch.skipped;
        total.fallback += batch.fallback;
        total.discarded += batch.discarded;
        total.pending = batch.pending;
        total.items = batch.items;
        setItems(batch.items);
        setNotice(describeExplanationResult(total));
        if (
          batch.status === "disabled" ||
          batch.status === "not_configured" ||
          batch.processed === 0
        ) {
          break;
        }
      } while (total.pending > 0 && guard-- > 0);
      await refreshBillItems();
    } catch (error) {
      setNotice(dynamicBillFailureCopy("buildExplanations", error));
      await refreshBillItems().catch(() => {});
    } finally {
      setExplaining(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setNotice("");
    try {
      const result = await requestSW<DynamicSyncResult>("SYNC_DYNAMIC_UPDATES");
      setOverview(result.overview);
      let nextNotice = describeSyncResult(result);
      if (result.status === "success") {
        try {
          setGenerating(true);
          const generated = await generateLocalBill();
          nextNotice = `${nextNotice} ${describeGenerateResult(generated)}`;
        } catch (generateError) {
          await refreshBillItems().catch(() => {});
          nextNotice = `${nextNotice} ${dynamicBillFailureCopy("generateBill", generateError)}`;
        }
      } else {
        await refreshBillItems().catch(() => {});
      }
      setNotice(nextNotice);
    } catch (error) {
      setNotice(dynamicBillFailureCopy("syncRequest", error));
      await refreshOverview().catch(() => {});
      await refreshBillItems().catch(() => {});
    } finally {
      setGenerating(false);
      setSyncing(false);
    }
  }

  function openSettings() {
    window.location.hash = "settings";
  }

  return (
    <div className="dynamic-bill-page">
      <header className="dynamic-bill-hero">
        <div>
          <h2>动态账单</h2>
          <p>
            兴趣再平衡：被淹没的关注、收藏关联更新与关注轮换。
          </p>
        </div>
        <div className="dynamic-bill-scope">
          <details><summary>AI 解释与数据范围</summary><p>
            AI 只整理已入选账单项的新视频标题/简介、UP 名、分区/标签、发布时间、时长和紧凑证据事实；不发送完整历史、完整关注列表、本地登录凭据、用户账号标识、个人资料或反馈记录。
          </p><p>{dynamicBillAiSettingsCopy(isAiEnabled, isAiConfigured)}</p></details>
          <div className="dynamic-bill-scope-actions">
            <button
              type="button"
              className="dynamic-bill-sync-button"
              disabled={isSyncing || generating || explaining}
              onClick={handleSync}
            >
              {isSyncing ? "同步中..." : "同步并刷新"}
            </button>
            <button
              type="button"
              className="dynamic-bill-sync-button is-secondary"
              disabled={isSyncing || generating || explaining}
              onClick={handleGenerate}
            >
              {generating ? "生成中..." : "生成本地账单"}
            </button>
            <button
              type="button"
              className="dynamic-bill-sync-button is-secondary"
              disabled={isSyncing || generating || explaining || items.length === 0}
              onClick={handleBuildExplanations}
            >
              {explaining ? "解释生成中..." : "生成 AI 解释"}
            </button>
            <button
              type="button"
              className="dynamic-bill-sync-button is-ghost"
              disabled={isSyncing || generating || explaining}
              onClick={openSettings}
            >
              前往设置
            </button>
          </div>
        </div>
      </header>

      <section className="dynamic-bill-status-grid" aria-label="动态账单数据状态">
        <StatusMetric
          label="动态同步"
          value={syncStatusLabel(syncState?.status ?? "idle")}
          detail={lastSyncDetail(overview)}
        />
        <StatusMetric
          label="已关注 UP"
          value={String(overview?.activeFollowedCreatorCount ?? 0)}
          detail={`关注时间已知 ${overview?.followAgeKnownCount ?? 0} / 未知 ${overview?.followAgeUnknownCount ?? 0}`}
        />
        <StatusMetric
          label="最近投稿"
          value={String(overview?.recentVideoUpdateCount ?? 0)}
          detail={`最近 ${overview?.updateWindowDays ?? 7} 天视频投稿池`}
        />
        <StatusMetric
          label="本地账单"
          value={String(items.length)}
          detail={columnCountDetail(items)}
        />
      </section>

      <section className="dynamic-bill-status-copy" aria-label="动态账单同步说明">
        <strong>{notice || overviewNotice}</strong>
        <span>
          每轮每位 UP 最多一项，每栏最多 5 项，总计最多 15 项；三栏共用一份本地轮换记录。
        </span>
      </section>

      <FeedbackStateDock
        resolvingCreatorMid={reviewPromptResolvingMid}
        state={feedbackState}
        undoingActionKeys={undoingActionKeys}
        onUndo={handleUndoLessReminder}
        onOpenPrompt={handleReviewPromptOpen}
        onDismissPrompt={handleReviewPromptDismiss}
      />

      <section className="dynamic-bill-filters" aria-label="账单状态筛选">
        {STATUS_FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={statusFilter === item.key ? "is-selected" : ""}
            aria-pressed={statusFilter === item.key}
            data-testid={`dynamic-bill-filter-${item.key}`}
            onClick={() => handleStatusFilterChange(item.key)}
          >
            <span>{item.label}</span>
            <strong>{statusCounts[item.key] ?? 0}</strong>
          </button>
        ))}
      </section>

      {allColumnsEmpty ? (
        <section className="dynamic-bill-empty" aria-label="动态账单空状态">
          <strong>本轮暂无可展示的关注新投稿</strong>
          <p>
            完成同步后，Bili-Bill 会从最近 7 天已关注 UP 的视频投稿中重新生成三栏账单；不会用旧账单或 AI 结果补位。
          </p>
          <div className="dynamic-bill-scope-actions">
            <button
              type="button"
              className="dynamic-bill-sync-button"
              disabled={isSyncing || generating || explaining}
              onClick={handleSync}
            >
              同步并刷新
            </button>
            <button
              type="button"
              className="dynamic-bill-sync-button is-secondary"
              disabled={isSyncing || generating || explaining}
              onClick={handleGenerate}
            >
              重新生成本地账单
            </button>
          </div>
        </section>
      ) : (
        <section className="dynamic-bill-layout">
          <div className="dynamic-bill-board" aria-label="动态账单栏目">
            {BILL_COLUMNS.map((column) => {
              const columnItems = visibleItems.filter((item) => item.column === column.key);
              const columnCount = items.filter((item) => item.column === column.key).length;
              const emptyCopy = getColumnEmptyCopy(
                column.key,
                overview,
                activeStatus.label,
                columnCount,
              );

              return (
                <article
                  className={`dynamic-bill-column tone-${column.accent}${
                    columnItems.length === 0 ? " is-empty" : ""
                  }`}
                  key={column.key}
                >
                  <div className="dynamic-bill-column-head">
                    <div>
                      <h3>{column.title}</h3>
                      <p>{column.detail}</p>
                    </div>
                    <span
                      title={`${activeStatus.label} ${columnItems.length} / 全部 ${columnCount}`}
                      data-testid={`dynamic-bill-column-count-${column.key}`}
                    >
                      {columnItems.length}/{columnCount}
                    </span>
                  </div>
                  {columnItems.length > 0 ? (
                    <div className="dynamic-bill-item-list">
                      {columnItems.map((item) => (
                        <button
                          type="button"
                          className={`dynamic-bill-item-card ${
                            selectedItem?.billKey === item.billKey ? "is-selected" : ""
                          }`}
                          key={item.billKey}
                          data-testid="dynamic-bill-item-card"
                          onClick={() => setSelectedBillKey(item.billKey)}
                        >
                          <span className="dynamic-bill-card-meta">
                            #{item.localRank} · {statusLabel(item.status)}
                          </span>
                          <strong>{item.creatorName}</strong>
                          <span className="dynamic-bill-card-title">{videoTitle(item)}</span>
                          <span className="dynamic-bill-card-fact">{cardFact(item)}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="dynamic-bill-column-empty">
                      <strong>{emptyCopy.title}</strong>
                      <p>{emptyCopy.detail}</p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          <aside className="dynamic-bill-detail" aria-label="账单项详情">
            {selectedItem ? (
              <BillItemDetail
                item={selectedItem}
                busy={processingBillKey === selectedItem.billKey}
                onMarkProcessed={handleMarkProcessed}
                onLessReminder={handleLessReminder}
                onOpenVideo={handleOpenVideo}
                aiAvailability={{
                  enabled: isAiEnabled,
                  configured: isAiConfigured,
                  model: userConfig?.ai.chatModel ?? "",
                }}
              />
            ) : (
              <EmptyDetail status={activeStatus} />
            )}
          </aside>
        </section>
      )}
    </div>
  );
}

function BillItemDetail({
  aiAvailability,
  busy,
  item,
  onMarkProcessed,
  onLessReminder,
  onOpenVideo,
}: {
  aiAvailability: {
    enabled: boolean;
    configured: boolean;
    model: string;
  };
  busy: boolean;
  item: DynamicBillItem;
  onMarkProcessed: (item: DynamicBillItem) => void;
  onLessReminder: (item: DynamicBillItem) => void;
  onOpenVideo: (item: DynamicBillItem) => void;
}) {
  const evidence = item.evidence;
  const isProcessed = item.status === "processed";
  return (
    <>
      <span className="dynamic-bill-kicker">
        {columnTitle(item.column)} / {statusLabel(item.status)}
      </span>
      <h3>{item.creatorName}</h3>
      <p>新投稿：{videoTitle(item)}</p>
      <ExplanationPanel item={item} aiAvailability={aiAvailability} />
      <div className="dynamic-bill-status-copy">
        <strong>处理状态</strong>
        <span>{statusFlowCopy(item)}</span>
      </div>
      <div className="dynamic-bill-status-copy">
        <strong>关注关系证据</strong>
        <span>{followEvidenceCopy(evidence)}</span>
      </div>
      <div className="dynamic-bill-status-copy">
        <strong>新投稿证据</strong>
        <span>
          最近 {evidence.thresholds.updateWindowDays} 天发布；同一新视频只要出现在可用本地观看记录中，就不会进入账单。
        </span>
      </div>
      <div className="dynamic-bill-evidence-grid">
        <EvidenceStat
          label={`近 ${evidence.longWindow.windowDays} 天本地记录`}
          value={`${evidence.longWindow.watchedCount} 次观看`}
          detail={`${evidence.longWindow.positiveWatchCount} 次有效观看 · 平均完成度 ${formatPercent(evidence.longWindow.avgCompletion)}`}
        />
        <EvidenceStat
          label={`近 ${evidence.recentWindow.windowDays} 天本地记录`}
          value={`${evidence.recentWindow.watchedCount} 次观看`}
          detail={`${evidence.recentWindow.positiveWatchCount} 次有效观看`}
        />
      </div>
      <div className="dynamic-bill-status-copy">
        <strong>规则边界</strong>
        <span>{thresholdCopy(evidence)}</span>
      </div>
      <ul className="dynamic-bill-fact-list">
        {evidence.facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      <div className="dynamic-bill-status-copy">
        <strong>本地代表视频</strong>
        <span>
          {item.historyBvids.length > 0
            ? `已记录 ${item.historyBvids.length} 条近期窗口以前的本地代表视频。`
            : "近期窗口以前没有可展示的本地代表视频。"}
        </span>
      </div>
      <div className="dynamic-bill-action-grid">
        <button
          type="button"
          className="is-primary"
          disabled={busy}
          data-testid="dynamic-bill-open-video"
          onClick={() => onOpenVideo(item)}
        >
          打开新视频
        </button>
        <button
          type="button"
          disabled={busy || isProcessed}
          data-testid="dynamic-bill-mark-processed"
          onClick={() => onMarkProcessed(item)}
        >
          {isProcessed ? "已处理" : "标记已处理"}
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="dynamic-bill-less-remind-creator"
          onClick={() => onLessReminder(item)}
        >
          少提醒这个 UP
        </button>
        <a href={spaceUrl(item.creatorMid)} target="_blank" rel="noreferrer">
          打开 UP 主页
        </a>
      </div>
    </>
  );
}

function FeedbackStateDock({
  onDismissPrompt,
  onOpenPrompt,
  onUndo,
  resolvingCreatorMid,
  state,
  undoingActionKeys,
}: {
  onDismissPrompt: (prompt: DynamicBillCreatorReviewPromptView) => void;
  onOpenPrompt: (prompt: DynamicBillCreatorReviewPromptView) => void;
  onUndo: (action: DynamicBillPendingFeedbackActionView) => void;
  resolvingCreatorMid: number | null;
  state: DynamicBillFeedbackStateView;
  undoingActionKeys: Set<string>;
}) {
  if (state.pendingActions.length === 0 && state.reviewPrompts.length === 0) {
    return null;
  }

  return (
    <div className="dynamic-bill-feedback-dock" aria-live="polite">
      {state.pendingActions.map((action) => (
        <PendingFeedbackActionCard
          action={action}
          isUndoing={undoingActionKeys.has(action.actionKey)}
          key={action.actionKey}
          onUndo={onUndo}
        />
      ))}
      {state.reviewPrompts.map((prompt) => {
        const isResolving = resolvingCreatorMid === prompt.creatorMid;
        return (
          <section className="dynamic-bill-creator-review" key={prompt.creatorMid}>
            <strong>要检查「{prompt.creatorName}」的关注关系吗？</strong>
            <span>
              你已经 3 次选择少提醒这个 UP。Bili-Bill 只会打开主页或暂不处理，不会自动取关。
            </span>
            <div className="dynamic-bill-feedback-actions">
              <button
                type="button"
                disabled={isResolving}
                aria-busy={isResolving}
                data-testid="dynamic-bill-review-open"
                onClick={() => onOpenPrompt(prompt)}
              >
                {isResolving ? "处理中..." : "打开 UP 主页"}
              </button>
              <button
                type="button"
                disabled={isResolving}
                aria-busy={isResolving}
                data-testid="dynamic-bill-review-dismiss"
                onClick={() => onDismissPrompt(prompt)}
              >
                {isResolving ? "处理中..." : "暂不处理"}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PendingFeedbackActionCard({
  action,
  isUndoing,
  onUndo,
}: {
  action: DynamicBillPendingFeedbackActionView;
  isUndoing: boolean;
  onUndo: (action: DynamicBillPendingFeedbackActionView) => void;
}) {
  return (
    <section className="dynamic-bill-creator-review">
      <strong>已少提醒「{action.creatorName}」</strong>
      <span>
        撤销窗口为 8 秒；窗口结束后才计入有效次数，并保持当前 30 天暂停。
      </span>
      <div className="dynamic-bill-feedback-actions">
        <button
          type="button"
          aria-busy={isUndoing}
          data-testid="dynamic-bill-feedback-undo"
          disabled={isUndoing}
          onClick={() => onUndo(action)}
        >
          {isUndoing ? "撤销中..." : "撤销"}
        </button>
        <button type="button" disabled>等待生效</button>
      </div>
    </section>
  );
}

function ExplanationPanel({
  aiAvailability,
  item,
}: {
  aiAvailability: {
    enabled: boolean;
    configured: boolean;
    model: string;
  };
  item: DynamicBillItem;
}) {
  const explanation = item.explanation;
  const hasAiExplanation = explanation?.status === "generated";
  const summary = hasAiExplanation
    ? explanation.summary
    : localSummary(item);
  const reason = hasAiExplanation
    ? explanation.reason
    : localReason(item);
  const viewingAngle = hasAiExplanation
    ? explanation.viewingAngle
    : localViewingAngle(item);
  const keywords = hasAiExplanation
    ? explanation.keywords
    : localKeywords(item);

  return (
    <div
      className={`dynamic-bill-ai-panel ${hasAiExplanation ? "is-ai" : "is-local"}`}
      data-testid={`dynamic-bill-explanation-${hasAiExplanation ? "ai" : "local"}`}
    >
      <div className="dynamic-bill-ai-head">
        <div>
          <strong>{hasAiExplanation ? "AI 解释" : "本地证据说明"}</strong>
          <span>{explanationStateCopy(explanation, aiAvailability)}</span>
        </div>
      </div>
      <div className="dynamic-bill-ai-grid">
        <section>
          <span>摘要</span>
          <p>{summary}</p>
        </section>
        <section>
          <span>为什么出现</span>
          <p>{reason}</p>
        </section>
        <section>
          <span>观看角度</span>
          <p>{viewingAngle}</p>
        </section>
      </div>
      {keywords.length > 0 ? (
        <div className="dynamic-bill-keywords" aria-label="解释关键词">
          {keywords.map((keyword) => (
            <span key={keyword}>{keyword}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmptyDetail({
  status,
}: {
  status: { key: DynamicBillStatusFilter; label: string; detail: string };
}) {
  return (
    <>
      <span className="dynamic-bill-kicker">选中账单项</span>
      <h3>暂无{status.label}项</h3>
      <p>生成本地账单后，选择卡片即可查看关注关系、新投稿、轮换和本地证据事实。</p>
      <div className="dynamic-bill-status-copy">
        <strong>当前筛选：{status.label}</strong>
        <span>{status.detail}</span>
      </div>
    </>
  );
}

function syncStatusLabel(status: DynamicSyncStatus) {
  switch (status) {
    case "syncing":
      return "同步中";
    case "success":
      return "已同步";
    case "not_logged_in":
      return "未登录";
    case "failed":
      return "同步失败";
    default:
      return "待同步";
  }
}

function lastSyncDetail(overview: DynamicBillOverview | null): string {
  const state = overview?.syncState;
  if (!state) return "正在读取状态";
  if (state.status === "syncing") return `阶段：${stageLabel(state.stage)}`;
  if (state.lastSuccessAt > 0) return `最后成功：${formatTime(state.lastSuccessAt)}`;
  if (state.lastFinishedAt > 0) return `最后尝试：${formatTime(state.lastFinishedAt)}`;
  return "尚未完成同步";
}

function describeOverview(overview: DynamicBillOverview): string {
  const state = overview.syncState;
  if (state.status === "not_logged_in") {
    return "需要先登录 B 站账号，Bili-Bill 才能同步关注关系和关注动态；已存在的本地证据仍可读取。";
  }
  if (state.status === "failed") {
    return dynamicBillFailureCopy("syncState", state.lastError);
  }
  if (state.status === "success") {
    return `已同步 ${overview.activeFollowedCreatorCount} 个关注 UP，最近 ${overview.updateWindowDays} 天视频投稿 ${overview.recentVideoUpdateCount} 条。`;
  }
  if (state.status === "syncing") {
    return `正在同步动态账单数据，当前阶段：${stageLabel(state.stage)}。`;
  }
  return "尚未同步动态账单数据；可以手动同步关注关系和最近视频投稿。";
}

function describeSyncResult(result: DynamicSyncResult): string {
  if (result.status === "not_logged_in") {
    return "同步未完成：当前没有可用的 B 站登录态。";
  }
  if (result.status === "failed") {
    return dynamicBillFailureCopy("syncResult", result.error);
  }
  return `同步完成：关注 UP ${result.followedCreatorsStored} 个，最近视频投稿 ${result.videoUpdatesStored} 条，过滤非视频动态 ${result.filteredNonVideoCount} 条。`;
}

function describeGenerateResult(result: DynamicBillGenerateResult): string {
  return `本地账单生成 ${result.itemCount} 项：被淹没的关注 ${result.columnItemCounts.buried_follow} 项，收藏关联更新 ${result.columnItemCounts.favorite_related} 项，关注轮换 ${result.columnItemCounts.follow_rotation} 项；扫描最近投稿 ${result.candidatesScanned} 条，排除本地已记录同视频 ${result.excludedRecentSameVideoCount} 条。`;
}

function describeExplanationResult(result: DynamicBillExplanationResult): string {
  const refreshed = result.discarded > 0
    ? `；${result.discarded} 个账单项已更新，旧说明未写入`
    : "";
  if (result.status === "disabled") {
    return `AI 解释未启用，已为 ${result.fallback} 个账单项展示本地证据说明${refreshed}。`;
  }
  if (result.status === "not_configured") {
    return `AI 尚未在设置中配置 API Key，已为 ${result.fallback} 个账单项展示本地证据说明${refreshed}。`;
  }
  const pending = result.pending > 0 ? `，剩余 ${result.pending} 个待处理` : "";
  return `AI 解释处理 ${result.processed} 项：成功 ${result.generated} 项，失败 ${result.failed} 项，跳过 ${result.skipped} 项${pending}${refreshed}；失败项仍展示本地证据说明。`;
}

function getColumnEmptyCopy(
  column: DynamicBillColumn,
  overview: DynamicBillOverview | null,
  statusLabel: string,
  columnItemCount: number,
): { title: string; detail: string } {
  if (!overview) {
    return {
      title: "正在读取账单数据",
      detail: "同步状态加载后会显示关注快照、最近视频投稿池和本地账单项数量。",
    };
  }
  if (overview.syncState.status === "not_logged_in" && columnItemCount === 0) {
    return {
      title: "需要登录 B 站后同步",
      detail: "未登录时不会生成虚假账单；若本地已有证据，仍可直接展示。",
    };
  }
  if (overview.activeFollowedCreatorCount === 0) {
    return {
      title: "还没有关注快照",
      detail: "完成同步后，会从已关注 UP 的视频投稿池中寻找本地账单候选。",
    };
  }
  if (overview.recentVideoUpdateCount === 0) {
    return {
      title: "最近 7 天暂无已关注视频投稿",
      detail: "非视频动态已被过滤，不会进入动态账单候选池。",
    };
  }
  if (column === "favorite_related") {
    return {
      title: `暂无${statusLabel}收藏关联更新`,
      detail: "可能是最近新投稿的 UP 尚未出现在本地已同步收藏中，或已被更高状态筛选排除。",
    };
  }
  if (column === "buried_follow") {
    return {
      title: `暂无${statusLabel}被淹没的关注`,
      detail: "可能是关注记忆证据不足、近期仍有观看，或本轮没有满足该栏目条件的新投稿。",
    };
  }
  return {
    title: `暂无${statusLabel}关注轮换`,
    detail: "可能是剩余已关注 UP 没有可用本地观看记录中未出现的新投稿，或本轮都已归入前两栏。",
  };
}

function columnTitle(column: DynamicBillColumn): string {
  return BILL_COLUMNS.find((item) => item.key === column)?.title ?? column;
}

function columnCountDetail(items: DynamicBillItem[]): string {
  return `被淹没 ${items.filter((item) => item.column === "buried_follow").length} / 收藏关联 ${items.filter((item) => item.column === "favorite_related").length} / 关注轮换 ${items.filter((item) => item.column === "follow_rotation").length}`;
}

function cardFact(item: DynamicBillItem): string {
  if (item.column === "favorite_related") {
    return firstFact(item) || "本地收藏中有这个 UP 的既有作品";
  }
  if (item.column === "buried_follow") {
    return `${followShortCopy(item.evidence)} · 近期观看 ${item.evidence.recentWindow.watchedCount} 次`;
  }
  return firstFact(item) || "按全局轮换展示剩余已关注新投稿";
}

function dynamicBillAiSettingsCopy(enabled: boolean, configured: boolean): string {
  if (!enabled) return "AI 解释未在设置中启用；生成解释时会直接写入本地证据说明。";
  if (!configured) return "AI 解释已启用但尚未在设置中配置 API Key；生成解释时会使用本地证据说明。";
  return "AI 解释已在设置中启用；生成时只整理已入选账单项的必要证据。";
}

function localSummary(item: DynamicBillItem): string {
  return `来自已关注 UP「${item.creatorName}」的新投稿《${videoTitle(item)}》。`;
}

function localReason(item: DynamicBillItem): string {
  const facts = item.evidence.facts.slice(0, 2).join(" ");
  return `这个视频出现是因为它已由「${columnTitle(item.column)}」本地规则入选：${facts || localColumnReason(item)}。`;
}

function localViewingAngle(item: DynamicBillItem): string {
  if (item.column === "favorite_related") {
    return "从收藏关系出发回访这个 UP，判断它的新投稿是否仍然值得关注。";
  }
  if (item.column === "buried_follow") {
    return "把它当作一次低压力回访，看看这个关注是否被近期口味盖住了。";
  }
  return "把它当作关注覆盖的轮换项，先看一个较少出现在账单里的 UP。";
}

function localKeywords(item: DynamicBillItem): string[] {
  return Array.from(new Set([
    columnTitle(item.column),
    item.evidence.newVideo.tagName,
    ...item.evidence.newVideo.tags,
  ].map((keyword) => keyword.trim()).filter(Boolean))).slice(0, 8);
}

function localColumnReason(item: DynamicBillItem): string {
  if (item.column === "favorite_related") {
    return "本地已同步收藏中有这个 UP 的既有作品，且最近有新投稿。";
  }
  if (item.column === "buried_follow") {
    return "关注关系仍在，本地近期观看缺席或近乎缺席，且最近有新投稿。";
  }
  return "这条来自剩余已关注 UP 的最近新投稿，并按全局轮换扩大创作者覆盖。";
}

function thresholdCopy(evidence: DynamicBillEvidence): string {
  const positiveRule = `有效观看为完成度不少于 ${formatPercent(evidence.thresholds.positiveCompletionRate)}、观看不少于 ${formatDuration(evidence.thresholds.minPositiveWatchSeconds)} 或已收藏`;
  const sameVideoRule = "同一新视频只要出现在可用本地观看记录中就会排除";
  const capacityRule = `每栏最多 ${evidence.thresholds.maxItemsPerColumn} 项，总计最多 ${evidence.thresholds.maxItemsTotal} 项`;

  if (evidence.kind === "favorite_related") {
    return `本地已同步收藏中存在同 UP 作品，且最近 ${evidence.thresholds.updateWindowDays} 天有未在可用本地观看记录中出现的新投稿；${sameVideoRule}；${capacityRule}。`;
  }
  if (evidence.kind === "buried_follow") {
    return `基础入选必须是已关注 UP、最近 ${evidence.thresholds.updateWindowDays} 天有新视频投稿、近期 ${evidence.thresholds.recentWindowDays} 天观看不超过 ${evidence.thresholds.maxBuriedRecentWatchCount} 次且有效观看不超过 ${evidence.thresholds.maxBuriedRecentPositiveWatchCount} 次；关注记忆信号至少满足长期关注、特别关注、本地连续观察或近期窗口以前有观看记录之一；${positiveRule}；${sameVideoRule}；${capacityRule}。`;
  }
  return `在前两栏归属后，剩余已关注 UP 最近一条未在可用本地观看记录中出现的投稿按全局轮换展示；${sameVideoRule}；${capacityRule}。`;
}

function followEvidenceCopy(evidence: DynamicBillEvidence): string {
  const special = evidence.follow.special ? "；特别关注" : "";
  const memorySignals = evidence.follow.memorySignals?.length
    ? `；关注记忆信号：${followMemorySignalsCopy(evidence.follow.memorySignals)}`
    : "";
  return `${followShortCopy(evidence)}${special}${memorySignals}。`;
}

function followShortCopy(evidence: DynamicBillEvidence): string {
  if (evidence.follow.followAgeDays !== undefined) {
    return `已关注约 ${evidence.follow.followAgeDays} 天`;
  }
  return "已关注，关注时长未知";
}

function followMemorySignalsCopy(signals: NonNullable<DynamicBillEvidence["follow"]["memorySignals"]>): string {
  return signals.map((signal) => {
    switch (signal) {
      case "long_follow":
        return "长期关注";
      case "special_follow":
        return "特别关注";
      case "observed_follow":
        return "本地连续观察";
      case "weak_watch":
        return "历史观看";
      default:
        return signal;
    }
  }).join("、");
}

function countByStatus(items: DynamicBillItem[]): Record<DynamicBillStatusFilter, number> {
  const unopened = items.filter((item) => item.status === "unopened").length;
  const opened = items.filter((item) => item.status === "opened").length;
  return {
    active: unopened + opened,
    unopened,
    opened,
    consumed: items.filter((item) => item.status === "consumed").length,
    processed: items.filter((item) => item.status === "processed").length,
  };
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "following":
      return "关注关系";
    case "dynamic-feed":
      return "动态 feed";
    case "video-detail":
      return "视频详情补全";
    case "storage":
      return "本地写入";
    case "complete":
      return "完成";
    default:
      return "等待";
  }
}

function statusLabel(status: DynamicBillStatus): string {
  return STATUS_FILTERS.find((item) => item.key === status)?.label ?? "未打开";
}

function statusFlowCopy(item: DynamicBillItem): string {
  const events = [
    item.openedAt ? `打开于 ${formatTime(item.openedAt)}` : "尚未从动态账单打开",
    item.consumedAt ? `消费确认于 ${formatTime(item.consumedAt)}` : "尚未确认有效观看",
    item.processedAt ? `处理于 ${formatTime(item.processedAt)}` : "尚未手动处理",
  ];
  return `${statusLabel(item.status)}：${events.join("；")}。`;
}

function videoTitle(item: DynamicBillItem): string {
  return item.evidence.newVideo.title || "视频标题暂缺";
}

function firstFact(item: DynamicBillItem): string {
  return item.evidence.facts[0] ?? "";
}

function spaceUrl(mid: number): string {
  return `https://space.bilibili.com/${mid}`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN");
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

function StatusMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="dynamic-bill-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function EvidenceStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="dynamic-bill-evidence-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
