import { useEffect, useRef, useState } from "preact/hooks";
import { requestSW } from "../../utils/messaging";
import {
  learningTime,
  type LearningAsset,
  type LearningList,
  type LearningFilter,
  LEARNING_MAX_BYTES,
} from "../../../src/shared/learning.ts";
import { learningIconPaths } from "../../../src/shared/learning-icons.ts";
import "./learning.css";
import { LearningBackup } from "./LearningBackup";

const kindNames = { note: "个人笔记", bookmark: "时间书签", excerpt: "视频摘录", answer: "问答收藏" };

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
  const filters = useRef<LearningFilter>({});
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<LearningFilter["kind"]>("");
  const [bvid, setBvid] = useState("");
  const [editing, setEditing] = useState(false);
  const editBase = useRef<LearningAsset | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editTags, setEditTags] = useState("");

  async function refresh(offset = pageOffset.current) {
    const generation = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      let result = await requestSW<LearningList>("LEARNING_LIST", { offset, filters: filters.current });
      if (offset >= result.total && offset > 0)
        result = await requestSW("LEARNING_LIST", {
          offset: Math.max(0, Math.floor((result.total - 1) / 30) * 30),
          filters: filters.current,
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
  useEffect(() => {
    const timer = window.setTimeout(() => {
      filters.current = { query, kind, bvid };
      void refresh(0);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, kind, bvid]);
  async function open(id: string) {
    if (editing || busy) return;
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
  function startEdit() {
    if (!selected) return;
    editBase.current = structuredClone(selected);
    setEditTitle(selected.personal.title);
    setEditNote(selected.personal.note);
    setEditTags(selected.personal.tags.join("\n"));
    setEditing(true);
    setConfirmDelete(false);
    setError("");
  }
  async function saveEdit() {
    const base = editBase.current;
    if (!base || !list || busy) return;
    setBusy(true);
    setError("");
    try {
      const row = await requestSW<LearningAsset>("LEARNING_EDIT", {
        epoch: list.epoch, id: base.id, expected: base,
        personal: { title: editTitle, note: editNote, tags: [...new Set(editTags.split("\n").map(tag => tag.trim()).filter(Boolean))] },
      });
      setSelected(row);
      setEditing(false);
      editBase.current = null;
      setNotice("已保存修改");
      await refresh();
    } catch {
      setError("修改未保存，内容仍保留。若其他窗口已修改这条记录，请取消后重新打开。");
    } finally { setBusy(false); }
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
          <span title="最多保存 1000 条">{list ? `${list.allTotal} 条记录 · ${(list.bytes / 1048576).toFixed(2)} / 10 MiB` : "本地保存"}</span>
          {list && <meter class="learning-capacity" aria-label="学习笔记已用空间" value={list.bytes} max={LEARNING_MAX_BYTES} />}
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
      <div class="learning-filters">
        <input type="search" aria-label="搜索已保存内容" placeholder="搜索已保存内容" maxLength={256} value={query} onInput={event => setQuery(event.currentTarget.value)} />
        <select aria-label="笔记类型" value={kind} onChange={event => setKind(event.currentTarget.value as LearningFilter["kind"])}>
          <option value="">全部类型</option>{Object.entries(kindNames).map(([value, label]) => <option value={value}>{label}</option>)}
        </select>
        <select aria-label="来源视频" value={bvid} onChange={event => setBvid(event.currentTarget.value)}>
          <option value="">全部视频</option>
          {list?.videos.map(video => <option key={video.bvid} value={video.bvid}>{video.title || "视频"}</option>)}
        </select>
      </div>
      <LearningBackup disabled={editing || busy} onChange={() => { void refresh(); }} />
      <div class="learning-notice" role={error ? "alert" : "status"}>
        {error || notice}
      </div>
      {loading && !list ? (
        <div class="learning-empty">读取中</div>
      ) : !list?.total && !selected ? (
        <div class="learning-empty">
          <Icon name="note" />
          <h2>{list?.allTotal ? "没有匹配的内容" : "暂无学习笔记"}</h2>
        </div>
      ) : (
        <div class={`learning-workspace${selected ? " has-selection" : ""}`}>
          <div class="learning-master">
            <div class="learning-list" aria-label="已保存的笔记">
              {list?.items.map((item) => (
                <button
                  key={item.id}
                  class={`learning-row${selected?.id === item.id ? " selected" : ""}`}
                  onClick={() => void open(item.id)}
                  disabled={busy || editing}
                >
                  <span class={`learning-kind ${item.kind}`}>
                    <Icon name={item.kind === "bookmark" ? "bookmark" : "note"} />
                  </span>
                  <span class="learning-row-text">
                    <strong>
                      {item.title ||
                        (item.kind === "note" ? "未命名笔记" : kindNames[item.kind])}
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
            {list && list.total > 30 && (
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
                  {kindNames[selected.kind]}
                </span>
                <div>
                  <button class="learning-icon" title="编辑笔记" aria-label="编辑笔记" disabled={busy || editing} onClick={startEdit}><Icon name="note" /></button>
                  <button
                    class="learning-delete"
                    disabled={busy || editing}
                    onClick={() => setConfirmDelete(true)}
                  >
                    删除
                  </button>
                  <button
                    class="learning-icon"
                    title="关闭详情"
                    aria-label="关闭详情"
                    disabled={busy || editing}
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
              {editing ? <form class="learning-edit" onSubmit={event => { event.preventDefault(); void saveEdit(); }}>
                <label>标题<input aria-label="编辑标题" value={editTitle} maxLength={4096} disabled={busy} onInput={event => setEditTitle(event.currentTarget.value)} /></label>
                <label>笔记<textarea aria-label="编辑笔记正文" value={editNote} disabled={busy} onInput={event => setEditNote(event.currentTarget.value)} rows={10} /></label>
                <label>标签<textarea aria-label="编辑标签" value={editTags} disabled={busy} onInput={event => setEditTags(event.currentTarget.value)} rows={2} /></label>
                <div class="learning-edit-actions"><button type="submit" disabled={busy}>{busy ? "保存中" : "保存修改"}</button><button type="button" disabled={busy} onClick={() => { setEditing(false); editBase.current = null; }}>取消编辑</button></div>
              </form> : <><h2>
                {selected.personal.title ||
                  (selected.kind === "note" ? "未命名笔记" : kindNames[selected.kind])}
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
              {selected.personal.tags.length > 0 && <div class="learning-tags">{selected.personal.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}
              {selected.snapshot && <section class="learning-snapshot" aria-label="保存时的内容">
                <h3>保存时的内容</h3><p class="learning-body">{selected.snapshot.body}</p>
                <details><summary>引用原句 · {selected.snapshot.source.kind === "bilibili" ? "B站字幕" : "本地转录"}</summary>
                  {selected.snapshot.citations.map((span, index) => <blockquote key={index}><time>{learningTime(span.fromMs)}</time><p>{span.text}</p></blockquote>)}
                </details>
              </section>}
              {selected.importedFrom && <details class="learning-import-original"><summary>导入时的原始个人内容</summary><ImportedOriginal row={selected} /></details>}
              </>}
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

function ImportedOriginal({ row }: { row: LearningAsset }) {
  try {
    const original = JSON.parse(row.importedFrom!.original) as LearningAsset;
    return <div class="learning-body"><strong>{original.personal.title}</strong><p>{original.personal.note}</p><span>{original.personal.tags.join(" · ")}</span></div>;
  } catch { return <p>原始内容暂时无法读取</p>; }
}
