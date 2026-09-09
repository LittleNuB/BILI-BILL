import { useEffect, useRef, useState } from "preact/hooks";
import { requestSW } from "../../utils/messaging";
import type { LearningAsset } from "../../../src/shared/learning.ts";
import type {
  WikiView,
  WikiViewTopic,
} from "../../../src/shared/video-wiki.ts";
import { learningIconPaths } from "../../../src/shared/learning-icons.ts";
import "./video-wiki.css";

type WikiVersion = {
  epoch: number;
  assetRevision: number;
  wikiRevision: number;
};
type TopicChange =
  | { action: "create"; name: string }
  | { action: "rename"; id: string; name: string }
  | {
      action: "relation";
      id: string;
      bvid: string;
      mode: "include" | "exclude" | "automatic";
    };
type WorkerReply = { id: string; result?: unknown; error?: unknown };
type WorkerTask = {
  id: string;
  resolve: (value: any) => void;
  reject: () => void;
};
type EditDraft = { asset: LearningAsset; title: string; note: string };

const labels = {
  summary: "已保存摘要",
  highlights: "已保存要点",
  subtitle: "视频摘录",
  answer: "问答收藏",
};

function Icon({ name }: { name: keyof typeof learningIconPaths }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {learningIconPaths[name].map((path) => (
        <path d={path} />
      ))}
    </svg>
  );
}

function versionOf(view: WikiView): WikiVersion {
  return {
    epoch: view.epoch,
    assetRevision: view.assetRevision,
    wikiRevision: view.state.revision,
  };
}

function isOrganized(asset: LearningAsset): boolean {
  return (
    asset.snapshot?.origin === "summary" ||
    asset.snapshot?.origin === "highlights"
  );
}

function partGroups(assets: LearningAsset[]) {
  const groups = new Map<number | null, LearningAsset[]>();
  for (const asset of assets) {
    const key = asset.part?.page ?? null;
    groups.set(key, [...(groups.get(key) ?? []), asset]);
  }
  return [...groups].sort(
    ([left], [right]) =>
      (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER),
  );
}

function relationMode(
  view: WikiView,
  topic: WikiViewTopic,
  bvid: string,
): "automatic" | "include" | "exclude" {
  return (
    view.state.relations.find(
      (relation) => relation.topicId === topic.id && relation.bvid === bvid,
    )?.mode ?? "automatic"
  );
}

export function VideoWikiPage() {
  const worker = useRef<Worker | null>(null);
  const task = useRef<WorkerTask | null>(null);
  const operationRef = useRef("");
  const selectedBvidRef = useRef<string | null>(null);
  const editingRef = useRef(false);
  const guarded = useRef(false);
  const [view, setView] = useState<WikiView | null>(null);
  const [assets, setAssets] = useState<LearningAsset[]>([]);
  const [selectedBvid, setSelectedBvid] = useState<string | null>(null);
  const [topicFilter, setTopicFilter] = useState("");
  const [operation, setOperation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [newTopic, setNewTopic] = useState(false);
  const [newTopicName, setNewTopicName] = useState("");
  const [renameTopic, setRenameTopic] = useState(false);
  const [renameTopicName, setRenameTopicName] = useState("");
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const [returnId, setReturnId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteAssets, setDeleteAssets] = useState(false);
  guarded.current = Boolean(edit) || (newTopic && Boolean(newTopicName.trim()))
    || (renameTopic && renameTopicName !== view?.topics.find(topic => topic.id === topicFilter)?.name)
    || ['保存笔记', '删除视频页', '更新主题归属', '新建主题', '重命名主题'].includes(operation);

  useEffect(() => {
    const navigate = (event: Event) => {
      if (!guarded.current) return;
      event.preventDefault();
      setNotice("请先完成或取消当前编辑。");
    };
    const leaving = (event: BeforeUnloadEvent) => {
      if (!guarded.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("bb-before-navigate", navigate);
    window.addEventListener("beforeunload", leaving);
    return () => {
      window.removeEventListener("bb-before-navigate", navigate);
      window.removeEventListener("beforeunload", leaving);
    };
  }, []);

  useEffect(() => {
    let instance: Worker;
    try {
      instance = new Worker(
        new URL("./video-wiki-worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      setUnavailable(true);
      setError("本地 Wiki 暂不可用，请刷新后重试。");
      return;
    }
    worker.current = instance;
    instance.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      const pending = task.current;
      if (!pending || data.id !== pending.id) return;
      task.current = null;
      if (data.error) pending.reject();
      else pending.resolve(data.result);
    };
    instance.onerror = () => {
      task.current?.reject();
      task.current = null;
      worker.current = null;
      instance.terminate();
      setUnavailable(true);
      setError("本地 Wiki 连接中断，请刷新后确认结果。");
    };
    void refresh(false);
    const focus = () => {
      if (!guarded.current) void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
      task.current?.reject();
      task.current = null;
      instance.terminate();
      if (worker.current === instance) worker.current = null;
    };
  }, []);

  function call<T>(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!worker.current || task.current) {
        reject(new Error("unavailable"));
        return;
      }
      const id = crypto.randomUUID();
      task.current = { id, resolve, reject: () => reject(new Error("failed")) };
      worker.current.postMessage({ id, action, params });
    });
  }

  async function run<T>(
    name: string,
    work: () => Promise<T>,
    onSuccess?: (value: T) => void,
  ): Promise<void> {
    if (operationRef.current || unavailable) return;
    operationRef.current = name;
    setOperation(name);
    setError("");
    try {
      const result = await work();
      onSuccess?.(result);
    } catch {
      setError(`${name}未完成，请刷新后确认。`);
    } finally {
      operationRef.current = "";
      setOperation("");
    }
  }

  async function refresh(
    includePage = selectedBvidRef.current !== null,
  ): Promise<void> {
    if (editingRef.current || operationRef.current || unavailable) return;
    await run(
      "刷新",
      async () => {
        const next = await call<WikiView>("view");
        const bvid = selectedBvidRef.current;
        const page =
          includePage && bvid && next.pages.some(page => page.bvid === bvid)
            ? await call<LearningAsset[]>("page", { bvid })
            : null;
        return { next, page, bvid };
      },
      ({ next, page, bvid }) => {
        setView(next);
        if (bvid && !next.pages.some(page => page.bvid === bvid)) {
          selectedBvidRef.current = null; setSelectedBvid(null); setAssets([]); setDeleteOpen(false);
        }
        setTopicFilter(current => next.topics.some(topic => topic.id === current) ? current : '');
        if (page && selectedBvidRef.current === bvid) setAssets(page);
      },
    );
  }

  function openPage(bvid: string): void {
    if (guarded.current) return;
    void run(
      "读取视频页",
      async () => ({
        bvid,
        assets: await call<LearningAsset[]>("page", { bvid }),
      }),
      (result) => {
        selectedBvidRef.current = result.bvid;
        setSelectedBvid(result.bvid);
        setAssets(result.assets);
        setDeleteOpen(false);
        setPreviewSourceId(null);
        setNotice("");
      },
    );
  }

  function closePage(): void {
    if (guarded.current) return;
    selectedBvidRef.current = null;
    setSelectedBvid(null);
    setAssets([]);
    setPreviewSourceId(null);
    setDeleteOpen(false);
  }

  function applyTopic(
    result: { view: WikiView; topicId: string },
    select = false,
  ): void {
    setView(result.view);
    if (select) setTopicFilter(result.topicId);
  }

  function createTopic(event: Event): void {
    event.preventDefault();
    const name = newTopicName.trim();
    if (!name) {
      setError("请输入主题名称。");
      return;
    }
    if (!view) return;
    void run(
      "新建主题",
      () =>
        call<{ view: WikiView; topicId: string }>("topic", {
          version: versionOf(view),
          change: { action: "create", name } satisfies TopicChange,
        }),
      (result) => {
        applyTopic(result, true);
        setNewTopic(false);
        setNewTopicName("");
        setNotice("主题已新建。");
      },
    );
  }

  function saveRename(event: Event): void {
    event.preventDefault();
    const name = renameTopicName.trim();
    if (!view || !topicFilter || !name) {
      setError("请输入主题名称。");
      return;
    }
    void run(
      "重命名主题",
      () =>
        call<{ view: WikiView; topicId: string }>("topic", {
          version: versionOf(view),
          change: {
            action: "rename",
            id: topicFilter,
            name,
          } satisfies TopicChange,
        }),
      (result) => {
        applyTopic(result);
        setRenameTopic(false);
        setNotice("主题名称已更新。");
      },
    );
  }

  function updateRelation(
    topic: WikiViewTopic,
    mode: "automatic" | "include" | "exclude",
  ): void {
    if (!view || !selectedBvid) return;
    void run(
      "更新主题归属",
      () =>
        call<{ view: WikiView; topicId: string }>("topic", {
          version: versionOf(view),
          change: {
            action: "relation",
            id: topic.id,
            bvid: selectedBvid,
            mode,
          } satisfies TopicChange,
        }),
      (result) => {
        applyTopic(result);
        setNotice("主题归属已更新。");
      },
    );
  }

  function beginEdit(asset: LearningAsset): void {
    if (guarded.current) return;
    editingRef.current = true;
    setEdit({
      asset: structuredClone(asset),
      title: asset.personal.title,
      note: asset.personal.note,
    });
    setPreviewSourceId(null);
    setDeleteOpen(false);
    setError("");
  }

  function cancelEdit(): void {
    if (operationRef.current) return;
    editingRef.current = false;
    setEdit(null);
  }

  function saveEdit(event: Event): void {
    event.preventDefault();
    if (!edit || !view) return;
    void run(
      "保存笔记",
      async () => {
        const row = await requestSW<LearningAsset>("LEARNING_EDIT", {
          epoch: view.epoch,
          id: edit.asset.id,
          expected: edit.asset,
          personal: {
            title: edit.title,
            note: edit.note,
            tags: edit.asset.personal.tags,
          },
        });
        const next = await call<WikiView>("view");
        return { row, next };
      },
      ({ row, next }) => {
        editingRef.current = false;
        setEdit(null);
        setAssets((current) =>
          current.map((asset) => (asset.id === row.id ? row : asset)),
        );
        setView(next);
        setNotice("笔记已保存。");
      },
    );
  }

  function openSource(asset: LearningAsset): void {
    void run(
      "打开来源",
      () =>
        requestSW<{ returnId: string; message: string }>(
          "LEARNING_OPEN_SOURCE",
          { id: asset.id, expected: asset },
        ),
      (result) => {
        setReturnId(result.returnId);
        setPreviewSourceId(null);
        setNotice(result.message || "已打开来源。");
      },
    );
  }

  function returnToSource(): void {
    if (!returnId) return;
    void run(
      "返回来源",
      () =>
        requestSW<{ message: string }>("LEARNING_RETURN_SOURCE", { returnId }),
      (result) => {
        setReturnId(null);
        setNotice(result.message || "已返回来源。");
      },
    );
  }

  function removePage(): void {
    if (!view || !selectedBvid) return;
    void run(
      "删除视频页",
      () =>
        call<WikiView>("removePage", {
          version: versionOf(view),
          bvid: selectedBvid,
          removeAssets: deleteAssets,
        }),
      (next) => {
        setView(next);
        selectedBvidRef.current = null;
        setSelectedBvid(null);
        setAssets([]);
        setDeleteOpen(false);
        setDeleteAssets(false);
        setNotice(
          deleteAssets
            ? "视频页与相关学习内容已删除。"
            : "视频页已删除，学习内容仍保留。",
        );
      },
    );
  }

  function downloadMarkdown(): void {
    if (!selectedBvid) return;
    void run(
      "导出 Markdown",
      () => call<{ file: Blob }>("markdown", { bvid: selectedBvid }),
      ({ file }) => {
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = `Bili-Bill-Wiki-${selectedBvid}.md`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        setNotice("Markdown 已导出。");
      },
    );
  }

  const selectedTopic =
    view?.topics.find((topic) => topic.id === topicFilter) ?? null;
  const pages =
    view?.pages.filter(
      (page) => !topicFilter || selectedTopic?.bvids.includes(page.bvid),
    ) ?? [];
  const selectedPage =
    view?.pages.find((page) => page.bvid === selectedBvid) ?? null;
  const busy = Boolean(operation);

  return (
    <section class="bb-video-wiki" aria-label="视频 Wiki">
      <header class="wiki-heading">
        <div class="wiki-heading-title">
          <span class="wiki-kicker">学习内容</span>
          <h1>视频 Wiki</h1>
          <span>
            {view
              ? `${view.pages.length} 个视频页 · ${view.topics.length} 个主题`
              : "本地内容"}
          </span>
        </div>
        <div class="wiki-heading-tools">
          <a
            href="#learning-notes"
            onClick={(event) => {
              if (guarded.current) {
                event.preventDefault();
                setNotice("请先完成或取消当前编辑。");
              }
            }}
          >
            学习笔记备份
          </a>
          <button
            class="wiki-icon-button"
            title="刷新视频 Wiki"
            aria-label="刷新视频 Wiki"
            disabled={busy || unavailable}
            onClick={() => void refresh()}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>

      <div class="wiki-controls" aria-label="主题工具">
        <label>
          <span>主题筛选</span>
          <select
            value={topicFilter}
            disabled={busy || unavailable}
            onChange={(event) => {
              const id = event.currentTarget.value;
              setTopicFilter(id);
              const topic = view?.topics.find((item) => item.id === id);
              setRenameTopic(false);
              setRenameTopicName(topic?.name ?? "");
            }}
          >
            <option value="">全部主题</option>
            {view?.topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.name}
                {topic.automatic ? "" : " · 已调整"}
              </option>
            ))}
          </select>
        </label>
        <div class="wiki-topic-actions">
          <button
            class="wiki-icon-button"
            title="新建主题"
            aria-label="新建主题"
            disabled={busy || unavailable}
            onClick={() => {
              setNewTopic(true);
              setRenameTopic(false);
            }}
          >
            <span aria-hidden="true">+</span>
          </button>
          <button
            class="wiki-icon-button"
            title="重命名当前主题"
            aria-label="重命名当前主题"
            disabled={!selectedTopic || busy || unavailable}
            onClick={() => {
              setRenameTopic(true);
              setNewTopic(false);
              setRenameTopicName(selectedTopic?.name ?? "");
            }}
          >
            <Icon name="note" />
          </button>
        </div>
        {newTopic && (
          <form class="wiki-inline-form" onSubmit={createTopic}>
            <input
              aria-label="新主题名称"
              value={newTopicName}
              maxLength={80}
              onInput={(event) => setNewTopicName(event.currentTarget.value)}
              placeholder="主题名称"
              autoFocus
            />
            <button type="submit" disabled={busy}>
              新建
            </button>
            <button
              class="wiki-icon-button"
              type="button"
              title="取消新建"
              aria-label="取消新建"
              disabled={busy}
              onClick={() => {
                setNewTopic(false);
                setNewTopicName("");
              }}
            >
              <Icon name="close" />
            </button>
          </form>
        )}
        {renameTopic && selectedTopic && (
          <form class="wiki-inline-form" onSubmit={saveRename}>
            <input
              aria-label="主题名称"
              value={renameTopicName}
              maxLength={80}
              onInput={(event) => setRenameTopicName(event.currentTarget.value)}
              autoFocus
            />
            <button type="submit" disabled={busy}>
              保存
            </button>
            <button
              class="wiki-icon-button"
              type="button"
              title="取消重命名"
              aria-label="取消重命名"
              disabled={busy}
              onClick={() => setRenameTopic(false)}
            >
              <Icon name="close" />
            </button>
          </form>
        )}
      </div>

      <div class="wiki-notice" role={error ? "alert" : "status"}>
        {error || (operation ? `正在${operation}...` : notice)}
        {returnId && !busy && (
          <button onClick={returnToSource}>返回笔记与原位置</button>
        )}
      </div>

      {!view && !error ? (
        <div class="wiki-empty">读取本地视频页...</div>
      ) : (
        <div class={`wiki-workspace${selectedBvid ? " has-page" : ""}`}>
          <aside class="wiki-index" aria-label="视频页列表">
            <div class="wiki-index-title">
              <strong>视频页</strong>
              <span>{pages.length}</span>
            </div>
            <div class="wiki-page-list">
              {pages.map((page) => (
                <button
                  key={page.bvid}
                  class={`wiki-page-row${page.bvid === selectedBvid ? " selected" : ""}`}
                  disabled={busy}
                  onClick={() => openPage(page.bvid)}
                >
                  <span class="wiki-page-row-title">
                    {page.title || page.bvid}
                  </span>
                  <span class="wiki-page-row-meta">
                    {page.count} 条已保存内容
                  </span>
                  <span class="wiki-page-row-topics">
                    {view?.topics
                      .filter((topic) => topic.bvids.includes(page.bvid))
                      .slice(0, 3)
                      .map((topic) => (
                        <i key={topic.id}>{topic.name}</i>
                      ))}
                  </span>
                </button>
              ))}
              {!pages.length && (
                <div class="wiki-index-empty">没有符合筛选的视频页</div>
              )}
            </div>
          </aside>

          <main class="wiki-detail">
            {!selectedBvid || !selectedPage ? (
              <div class="wiki-detail-empty">
                <Icon name="note" />
                <span>选择一个视频页</span>
              </div>
            ) : (
              <>
                <div class="wiki-detail-top">
                  <div>
                    <button
                      class="wiki-back"
                      onClick={closePage}
                      disabled={busy}
                    >
                      返回视频页
                    </button>
                    <h2>{selectedPage.title || selectedPage.bvid}</h2>
                    <span>
                      {selectedPage.bvid} · {assets.length} 条已保存内容
                    </span>
                  </div>
                  <div class="wiki-detail-tools">
                    <button
                      class="wiki-icon-button"
                      title={assets.length ? '导出 Markdown' : '暂无可导出的内容'}
                      aria-label="导出 Markdown"
                      disabled={busy || assets.length === 0}
                      onClick={downloadMarkdown}
                    >
                      <Icon name="download" />
                    </button>
                    <button
                      class="wiki-delete-button"
                      disabled={busy}
                      onClick={() => {
                        setDeleteOpen(true);
                        setPreviewSourceId(null);
                      }}
                    >
                      删除视频页
                    </button>
                  </div>
                </div>

                {deleteOpen && (
                  <section class="wiki-delete-confirm" role="alert">
                    <strong>删除此视频页？</strong>
                    <p>默认只删除组织页，{assets.length} 条学习内容会保留。</p>
                    <label>
                      <input
                        type="checkbox"
                        checked={deleteAssets}
                        disabled={busy}
                        onChange={(event) =>
                          setDeleteAssets(event.currentTarget.checked)
                        }
                      />
                      同时删除相关的 {assets.length} 条学习内容
                    </label>
                    <p>其他未提交的保存需要重新确认。</p>
                    <div>
                      <button
                        class="wiki-delete-button"
                        disabled={busy}
                        onClick={removePage}
                      >
                        {deleteAssets ? "确认删除页面与内容" : "确认删除页面"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setDeleteOpen(false);
                          setDeleteAssets(false);
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </section>
                )}

                <details class="wiki-membership">
                  <summary>主题归属</summary>
                  <div class="wiki-membership-list">
                    {view?.topics.map((topic) => (
                      <label key={topic.id}>
                        <span>{topic.name}</span>
                        <select
                          aria-label={`${topic.name} 的归属方式`}
                          value={relationMode(view, topic, selectedBvid)}
                          disabled={busy}
                          onChange={(event) =>
                            updateRelation(
                              topic,
                              event.currentTarget.value as
                                "automatic" | "include" | "exclude",
                            )
                          }
                        >
                          <option value="automatic">自动</option>
                          <option value="include">手动加入</option>
                          <option value="exclude">手动排除</option>
                        </select>
                      </label>
                    ))}
                    {!view?.topics.length && (
                      <span class="wiki-membership-empty">暂无主题</span>
                    )}
                  </div>
                </details>

                <div class="wiki-parts">
                  {partGroups(assets).map(([page, rows]) => (
                    <section class="wiki-part" key={page ?? "none"}>
                      <header>
                        <strong>
                          {page === null ? "未分 P 的记录" : `P${page}`}
                        </strong>
                        <span>{rows.length} 条</span>
                      </header>
                      <AssetSection
                        title="视频整理"
                        assets={rows.filter(isOrganized)}
                        edit={edit}
                        previewSourceId={previewSourceId}
                        busy={busy}
                        onEdit={beginEdit}
                        onPreview={setPreviewSourceId}
                        onOpenSource={openSource}
                      />
                      <AssetSection
                        title="我的笔记"
                        assets={rows.filter(
                          (asset) =>
                            !isOrganized(asset) && Boolean(asset.personal.note),
                        )}
                        edit={edit}
                        previewSourceId={previewSourceId}
                        busy={busy}
                        onEdit={beginEdit}
                        onPreview={setPreviewSourceId}
                        onOpenSource={openSource}
                      />
                      <AssetSection
                        title="学习记录"
                        assets={rows.filter(
                          (asset) =>
                            !isOrganized(asset) && !asset.personal.note,
                        )}
                        edit={edit}
                        previewSourceId={previewSourceId}
                        busy={busy}
                        onEdit={beginEdit}
                        onPreview={setPreviewSourceId}
                        onOpenSource={openSource}
                      />
                    </section>
                  ))}
                  {!assets.length && (
                    <div class="wiki-part-empty">暂无已保存内容</div>
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      )}

      {edit && (
        <EditDialog
          draft={edit}
          error={error}
          busy={busy}
          onChange={setEdit}
          onSave={saveEdit}
          onCancel={cancelEdit}
        />
      )}
    </section>
  );
}

function AssetSection({
  title,
  assets,
  edit,
  previewSourceId,
  busy,
  onEdit,
  onPreview,
  onOpenSource,
}: {
  title: string;
  assets: LearningAsset[];
  edit: EditDraft | null;
  previewSourceId: string | null;
  busy: boolean;
  onEdit: (asset: LearningAsset) => void;
  onPreview: (id: string | null) => void;
  onOpenSource: (asset: LearningAsset) => void;
}) {
  return (
    <section class="wiki-asset-section">
      <h3>
        {title}
        <span>{assets.length}</span>
      </h3>
      {!assets.length ? (
        <p class="wiki-asset-empty">暂无</p>
      ) : (
        assets.map((asset) => (
          <article class="wiki-asset" key={asset.id}>
            <div class="wiki-asset-top">
              <div>
                <strong>
                  {asset.personal.title ||
                    (asset.snapshot
                      ? labels[asset.snapshot.origin]
                      : "学习记录")}
                </strong>
                <span>
                  {asset.kind === "bookmark"
                    ? "时间书签"
                    : asset.snapshot
                      ? labels[asset.snapshot.origin]
                      : "个人笔记"}
                </span>
              </div>
              <div class="wiki-asset-tools">
                  <button
                    title="预览来源"
                    aria-label="预览来源"
                    disabled={busy}
                    onClick={() =>
                      onPreview(previewSourceId === asset.id ? null : asset.id)
                    }
                  >
                    来源
                  </button>
                <button
                  class="wiki-icon-button"
                  title="编辑笔记"
                  aria-label="编辑笔记"
                  disabled={busy || Boolean(edit)}
                  onClick={() => onEdit(asset)}
                >
                  <Icon name="note" />
                </button>
              </div>
            </div>
            {asset.snapshot && (
              <div class="wiki-asset-body">
                <span>{labels[asset.snapshot.origin]}</span>
                <p>{asset.snapshot.body}</p>
              </div>
            )}
            {asset.personal.note && (
              <div class="wiki-asset-note">
                <span>我的笔记</span>
                <p>{asset.personal.note}</p>
              </div>
            )}
            {asset.bookmarkMs !== null && (
              <div class="wiki-asset-time">
                记录时间点 {Math.floor(asset.bookmarkMs / 60000)}:
                {String(Math.floor(asset.bookmarkMs / 1000) % 60).padStart(
                  2,
                  "0",
                )}
              </div>
            )}
            {previewSourceId === asset.id && (
              <div
                class="wiki-source-preview"
                role="region"
                aria-label="来源预览"
              >
                <strong>
                  {asset.video.title}
                  {asset.part ? ` · P${asset.part.page}` : ""}
                </strong>
                {asset.snapshot?.citations.length ? (
                  <blockquote>{asset.snapshot.citations[0].text}</blockquote>
                ) : (
                  <p>将按保存时的定位信息核对来源。</p>
                )}
                <div>
                  <button disabled={busy} onClick={() => onOpenSource(asset)}>
                    确认打开来源
                  </button>
                  <button disabled={busy} onClick={() => onPreview(null)}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </article>
        ))
      )}
    </section>
  );
}

function EditDialog({
  draft,
  error,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: EditDraft;
  error: string;
  busy: boolean;
  onChange: (next: EditDraft) => void;
  onSave: (event: Event) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close(); }; }, []);
  return (
    <dialog ref={dialog} class="wiki-edit-layer" aria-label="编辑学习笔记" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
      <form class="wiki-edit-dialog" onSubmit={onSave}>
        <header>
          <strong>编辑笔记</strong>
          <button
            class="wiki-icon-button"
            type="button"
            title="取消编辑"
            aria-label="取消编辑"
            disabled={busy}
            onClick={onCancel}
          >
            <Icon name="close" />
          </button>
        </header>
        <label>
          标题
          <input
            value={draft.title}
            maxLength={4096}
            disabled={busy}
            onInput={(event) =>
              onChange({ ...draft, title: event.currentTarget.value })
            }
          />
        </label>
        <label>
          我的笔记
          <textarea
            value={draft.note}
            rows={10}
            disabled={busy}
            onInput={(event) =>
              onChange({ ...draft, note: event.currentTarget.value })
            }
          />
        </label>
        {error && <p role="alert">{error} 内容仍保留，可取消后重新打开。</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button class="wiki-primary-button" type="submit" disabled={busy}>
            {busy ? "保存中" : "保存修改"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
