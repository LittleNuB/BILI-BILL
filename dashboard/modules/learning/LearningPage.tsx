import { useEffect, useRef, useState } from "preact/hooks";
import { requestSW } from "../../utils/messaging";
import {
  learningTime,
  type LearningAsset,
  type LearningList,
} from "../../../src/shared/learning.ts";
import { learningIconPaths } from "../../../src/shared/learning-icons.ts";
import "./learning.css";

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
      {learningIconPaths[name].map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}
export function LearningPage() {
  const [list, setList] = useState<LearningList | null>(null);
  const [selected, setSelected] = useState<LearningAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sequence = useRef(0);
  const detailSequence = useRef(0);
  const pageOffset = useRef(0);
  const selectedId = useRef<string | null>(null);

  async function refresh(offset = pageOffset.current) {
    const generation = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      let result = await requestSW<LearningList>("LEARNING_LIST", { offset });
      if (offset >= result.total && offset > 0)
        result = await requestSW("LEARNING_LIST", {
          offset: Math.max(0, Math.floor((result.total - 1) / 30) * 30),
        });
      if (sequence.current !== generation) return;
      pageOffset.current = result.offset;
      setList(result);
      if (selectedId.current) {
        const id = selectedId.current;
        const row = await requestSW<LearningAsset | null>("LEARNING_GET", {
          id,
        });
        if (sequence.current === generation && selectedId.current === id) {
          setSelected(row);
          if (!row) selectedId.current = null;
        }
      }
    } catch {
      if (sequence.current === generation)
        setError("暂时无法读取学习笔记，请重试。");
    } finally {
      if (sequence.current === generation) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      sequence.current++;
      detailSequence.current++;
      window.removeEventListener("focus", focus);
    };
  }, []);
  async function open(id: string) {
    selectedId.current = id;
    setConfirmDelete(false);
    setError("");
    setNotice("");
    const generation = ++detailSequence.current;
    try {
      const row = await requestSW<LearningAsset | null>("LEARNING_GET", { id });
      if (detailSequence.current !== generation || selectedId.current !== id)
        return;
      setSelected(row);
      if (!row) {
        selectedId.current = null;
        setNotice("这条笔记已被删除。");
        void refresh();
      }
    } catch {
      if (detailSequence.current === generation)
        setError("暂时无法打开这条笔记，请重试。");
    }
  }
  async function remove() {
    if (!selected || !list || busy) return;
    setBusy(true);
    setError("");
    try {
      await requestSW("LEARNING_DELETE", {
        id: selected.id,
        epoch: list.epoch,
      });
      selectedId.current = null;
      detailSequence.current++;
      setSelected(null);
      setConfirmDelete(false);
      setNotice("已删除");
      await refresh();
    } catch {
      setError("删除未完成，请刷新后确认。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="bb-learning" aria-label="学习笔记">
      <header class="learning-heading">
        <div>
          <h1>学习笔记</h1>
          <span>{list ? `${list.total} 条记录` : "本地保存"}</span>
        </div>
        <button
          class="learning-icon"
          title="刷新列表"
          aria-label="刷新列表"
          disabled={loading || busy}
          onClick={() => void refresh()}
        >
          <Icon name="refresh" />
        </button>
      </header>
      <div class="learning-notice" role={error ? "alert" : "status"}>
        {error || notice}
      </div>
      {loading && !list ? (
        <div class="learning-empty">读取中</div>
      ) : !list?.total ? (
        <div class="learning-empty">
          <Icon name="note" />
          <h2>暂无学习笔记</h2>
        </div>
      ) : (
        <div class={`learning-workspace${selected ? " has-selection" : ""}`}>
          <div class="learning-master">
            <div class="learning-list" aria-label="已保存的笔记">
              {list.items.map((item) => (
                <button
                  key={item.id}
                  class={`learning-row${selected?.id === item.id ? " selected" : ""}`}
                  onClick={() => void open(item.id)}
                  disabled={busy}
                >
                  <span class={`learning-kind ${item.kind}`}>
                    <Icon name={item.kind} />
                  </span>
                  <span class="learning-row-text">
                    <strong>
                      {item.title ||
                        (item.kind === "note" ? "未命名笔记" : "时间书签")}
                    </strong>
                    {item.preview && (
                      <span class="learning-preview">{item.preview}</span>
                    )}
                    <span class="learning-source">
                      {item.videoTitle || "视频"}
                      {item.page !== null ? ` · P${item.page}` : ""}
                      {item.bookmarkMs !== null
                        ? ` · ${learningTime(item.bookmarkMs)}`
                        : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {list.total > 30 && (
              <nav class="learning-pagination" aria-label="笔记分页">
                <button
                  disabled={loading || list.offset === 0}
                  onClick={() => void refresh(list.offset - 30)}
                >
                  上一页
                </button>
                <span>
                  {Math.floor(list.offset / 30) + 1} /{" "}
                  {Math.ceil(list.total / 30)}
                </span>
                <button
                  disabled={loading || list.offset + 30 >= list.total}
                  onClick={() => void refresh(list.offset + 30)}
                >
                  下一页
                </button>
              </nav>
            )}
          </div>
          {selected ? (
            <article class="learning-detail" aria-label="笔记详情">
              <div class="learning-detail-tools">
                <span>
                  {selected.kind === "note" ? "个人笔记" : "时间书签"}
                </span>
                <div>
                  <button
                    class="learning-delete"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    删除
                  </button>
                  <button
                    class="learning-icon"
                    title="关闭详情"
                    aria-label="关闭详情"
                    disabled={busy}
                    onClick={() => {
                      selectedId.current = null;
                      detailSequence.current++;
                      setSelected(null);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </div>
              {confirmDelete && (
                <div class="learning-confirm" role="alert">
                  <span>删除这条笔记？</span>
                  <button disabled={busy} onClick={() => void remove()}>
                    {busy ? "删除中" : "确认删除"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    取消
                  </button>
                </div>
              )}
              <h2>
                {selected.personal.title ||
                  (selected.kind === "note" ? "未命名笔记" : "时间书签")}
              </h2>
              <div class="learning-detail-source">
                {selected.video.title || "视频"}
                {selected.part ? ` · P${selected.part.page}` : ""}
                {selected.bookmarkMs !== null
                  ? ` · ${learningTime(selected.bookmarkMs)}`
                  : ""}
              </div>
              <div class="learning-body">
                {selected.personal.note || "未添加备注"}
              </div>
              <time dateTime={new Date(selected.createdAt).toISOString()}>
                {new Date(selected.createdAt).toLocaleString("zh-CN")}
              </time>
            </article>
          ) : (
            <div class="learning-detail-empty">
              <Icon name="note" />
              <span>已保存的内容</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
