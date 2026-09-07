import {
  newLearningId,
  learningTime,
  type LearningAsset,
  type LearningPrepared,
  type LearningSourceRequest,
} from "../../shared/learning.ts";
import { LearningDraftStore, learningDraftKey, type LearningDraft } from "./learning-drafts.ts";
import { learningIcon } from "../../shared/learning-icons.ts";
import { requestLearning as request } from "./learning-request.ts";

const DIALOG_ID = "bb-learning-editor";
const drafts = new LearningDraftStore();
const CSS = `
#bb-learning-editor{box-sizing:border-box;position:fixed;inset:0;margin:auto;padding:0;border:1px solid #e3e5e7;border-radius:8px;width:520px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);background:#fff;color:#18191c;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:0;z-index:2147483647;box-shadow:0 12px 48px #0003;overflow:auto}
#bb-learning-editor *{box-sizing:border-box;font:inherit;letter-spacing:0}
#bb-learning-editor::backdrop{background:#0006}
#bb-learning-editor header,#bb-learning-editor footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px}
#bb-learning-editor header{border-bottom:1px solid #e3e5e7}#bb-learning-editor header strong{font-size:16px;font-weight:600}
#bb-learning-editor button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;border:1px solid #dce0e3;border-radius:6px;padding:6px 12px;background:transparent;color:inherit;cursor:pointer;white-space:normal}
#bb-learning-editor button:disabled{opacity:.5;cursor:default}#bb-learning-editor button:focus-visible,#bb-learning-editor input:focus-visible,#bb-learning-editor textarea:focus-visible{outline:2px solid #00aeec;outline-offset:2px}
#bb-learning-editor [hidden]{display:none!important}
#bb-learning-editor button.primary{background:#00aeec;color:white;border-color:#00aeec}
#bb-learning-editor .fields{padding:16px 20px 0}#bb-learning-editor label{display:block;margin:12px 0 5px;color:#61666d}
#bb-learning-editor input,#bb-learning-editor textarea{display:block;width:100%;border:1px solid #dce0e3;border-radius:6px;padding:10px 12px;background:transparent;color:inherit}
#bb-learning-editor textarea{height:170px;min-height:90px;max-height:35dvh;resize:vertical;line-height:1.7}
#bb-learning-editor .source{color:#61666d;overflow-wrap:anywhere}#bb-learning-editor .status{padding:0 20px;min-height:24px;color:#61666d;overflow-wrap:anywhere}
#bb-learning-editor a{color:#00aeec;text-decoration:none}#bb-learning-editor footer{flex-wrap:wrap}#bb-learning-editor .footer-actions{display:flex;gap:8px;flex-wrap:wrap}
#bb-learning-editor[data-theme=dark]{background:#202124;color:#e3e5e7;border-color:#424448}#bb-learning-editor[data-theme=dark] .source,#bb-learning-editor[data-theme=dark] label,#bb-learning-editor[data-theme=dark] .status{color:#b3b6bb}
@media(max-height:480px){#bb-learning-editor header,#bb-learning-editor footer{padding:10px 16px}#bb-learning-editor .fields{padding:8px 16px 0}#bb-learning-editor textarea{height:90px}}
`;
export function learningEditorButton(
  kind: "note" | "bookmark",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "bdc-assistant-button bdc-assistant-button-quiet";
  const label = kind === "note" ? "记笔记" : "存书签";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(learningIcon(kind));
  button.onclick = () => {
    void openLearningEditor(kind, button);
  };
  return button;
}

export function learningSourceButton(source: LearningSourceRequest, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "bdc-assistant-button bdc-assistant-button-quiet";
  button.type = "button"; button.title = label; button.setAttribute("aria-label", label);
  button.append(learningIcon("bookmark"));
  button.onclick = () => { void openLearningEditor(source.origin === "answer" ? "answer" : "excerpt", button, source); };
  return button;
}

async function openLearningEditor(
  kind: LearningAsset["kind"],
  trigger: HTMLElement,
  sourceRequest?: LearningSourceRequest,
) {
  const open = document.getElementById(DIALOG_ID) as HTMLDialogElement | null;
  if (open) {
    open.focus();
    return;
  }
  if (!document.getElementById(`${DIALOG_ID}-style`)) {
    const style = document.createElement("style");
    style.id = `${DIALOG_ID}-style`;
    style.textContent = CSS;
    document.head.append(style);
  }
  const dialog = document.createElement("dialog");
  dialog.id = DIALOG_ID;
  const label = kind === "note" ? "记笔记" : kind === "bookmark" ? "存书签" : kind === "answer" ? "保存答案" : "保存摘录";
  dialog.setAttribute("aria-label", label);
  dialog.dataset.theme =
    document.getElementById("bdc-current-video-assistant")?.dataset.theme ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  let draftKey: string | undefined;
  let draft: LearningDraft = { title: "", note: "" };
  const header = document.createElement("header");
  const heading = document.createElement("strong");
  heading.textContent = label;
  const close = document.createElement("button");
  close.title = "关闭并保留草稿";
  close.setAttribute("aria-label", close.title);
  close.append(learningIcon("close"));
  header.append(heading, close);
  const fields = document.createElement("div");
  fields.className = "fields";
  const source = document.createElement("div");
  source.className = "source";
  source.textContent = "正在确认当前视频";
  const titleLabel = document.createElement("label");
  titleLabel.htmlFor = "bb-learning-title";
  titleLabel.textContent = "标题";
  const title = document.createElement("input");
  title.id = titleLabel.htmlFor;
  title.maxLength = 4096;
  title.value = draft.title;
  title.disabled = true;
  const noteLabel = document.createElement("label");
  noteLabel.htmlFor = "bb-learning-note";
  noteLabel.textContent = kind === "note" ? "笔记" : "备注（选填）";
  const note = document.createElement("textarea");
  note.id = noteLabel.htmlFor;
  note.value = draft.note;
  note.disabled = true;
  fields.append(source, titleLabel, title, noteLabel, note);
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  const footer = document.createElement("footer");
  const link = document.createElement("a");
  link.textContent = "学习笔记";
  link.href = chrome.runtime.getURL("dashboard/index.html#learning-notes");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const actions = document.createElement("div");
  actions.className = "footer-actions";
  const cancel = document.createElement("button");
  cancel.textContent = "取消保存";
  cancel.hidden = true;
  const recheck = document.createElement("button");
  recheck.title = "重新确认当前视频";
  recheck.setAttribute("aria-label", recheck.title);
  recheck.append(learningIcon("refresh"));
  recheck.hidden = true;
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "保存";
  save.disabled = true;
  const discard = document.createElement("button");
  discard.textContent = "丢弃草稿";
  actions.append(discard, recheck, cancel, save);
  footer.append(link, actions);
  dialog.append(header, fields, status, footer);
  document.body.append(dialog);
  dialog.showModal();
  note.focus();
  let busy = false;
  let prepared: LearningPrepared | undefined;
  let saved = false;
  const persistDraft = () => {
    if (!draftKey) return false;
    const next = { ...draft, title: title.value, note: note.value };
    try { drafts.put(draftKey, next); draft = next; return true; }
    catch (error) { title.value = draft.title; note.value = draft.note; status.textContent = (error as Error).message; return false; }
  };
  const closeDialog = () => {
    if (busy) return;
    if (!saved) persistDraft();
    else if (draftKey) drafts.delete(draftKey);
    dialog.close();
    dialog.remove();
    trigger.isConnected && trigger.focus();
  };
  close.onclick = closeDialog;
  discard.onclick = () => {
    if (busy || draft.pending) { status.textContent = "请先确认保存结果，草稿仍保留。"; return; }
    if (!window.confirm("丢弃这份未保存草稿？")) return;
    if (draftKey) drafts.delete(draftKey);
    saved = true;
    closeDialog();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  const changed = () => {
    if (!persistDraft()) return;
    saved = false;
    if (draft.pending) {
      status.textContent = "先确认上次保存结果，再开始新的笔记。";
      return;
    }
    save.textContent = "保存";
    save.disabled = !prepared || (kind === "note" && !note.value.trim());
  };
  title.oninput = changed;
  note.oninput = changed;
  try {
    const fresh = await request<LearningPrepared>("LEARNING_PREPARE", { kind: sourceRequest ? "note" : kind });
    if (!dialog.isConnected) return;
    draftKey = learningDraftKey(kind, fresh, sourceRequest);
    draft = drafts.get(draftKey) ?? { title: "", note: "" };
    drafts.put(draftKey, draft);
    prepared = draft.pending?.prepared ?? (sourceRequest ? await request<LearningPrepared>("LEARNING_PREPARE_SOURCE", { source: sourceRequest }) : fresh);
    if (!dialog.isConnected) return;
    if (learningDraftKey(kind, prepared, sourceRequest) !== draftKey) { prepared = undefined; throw Error("视频已变化，请关闭后重新打开；原草稿仍保留。"); }
    title.value = draft.title; note.value = draft.note;
    title.disabled = false; note.disabled = false;
    const capture = prepared.capture;
    source.textContent = `${capture.video.title || "当前视频"}${capture.part ? ` · P${capture.part.page}` : ""}${capture.bookmarkMs !== null ? ` · ${learningTime(capture.bookmarkMs)}` : ""}`;
    if (!title.value)
      title.value =
        kind === "note"
          ? ""
          : kind === "bookmark" ? `${learningTime(capture.bookmarkMs ?? 0)} 的书签` : label;
    if (prepared.snapshot) {
      const preview = document.createElement("details");
      const summary = document.createElement("summary"); summary.textContent = "保存内容与引用";
      const text = document.createElement("p"); text.style.whiteSpace = "pre-wrap";
      text.textContent = prepared.snapshot.body;
      preview.append(summary, text); fields.prepend(preview);
    }
    if (draft.pending) {
      title.value = draft.pending.asset.personal.title;
      note.value = draft.pending.asset.personal.note;
      title.disabled = true;
      note.disabled = true;
      save.textContent = "重试确认";
    }
    save.disabled = kind === "note" && !note.value.trim();
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "当前视频暂不可用，草稿仍保留。";
    recheck.hidden = false;
  }
  recheck.onclick = async () => {
    recheck.disabled = true;
    try {
      const fresh = await request<LearningPrepared>(sourceRequest ? "LEARNING_PREPARE_SOURCE" : "LEARNING_PREPARE", sourceRequest ? { source: sourceRequest } : { kind });
      const key = learningDraftKey(kind, fresh, sourceRequest);
      if (draftKey && key !== draftKey) {
        status.textContent = "草稿属于之前的视频，请关闭后重新打开；原草稿仍保留。";
        return;
      }
      draftKey = key;
      drafts.put(key, draft);
      prepared = fresh;
      title.disabled = false; note.disabled = false;
      const capture = prepared.capture;
      source.textContent = `${capture.video.title || "当前视频"}${capture.part ? ` · P${capture.part.page}` : ""}${capture.bookmarkMs !== null ? ` · ${learningTime(capture.bookmarkMs)}` : ""}`;
      status.textContent = "已重新确认，请核对后保存。";
      recheck.hidden = true;
      changed();
    } catch {
      status.textContent = "当前视频暂不可用，草稿仍保留。";
    } finally {
      recheck.disabled = false;
    }
  };
  cancel.onclick = async () => {
    if (!draft.pending) return;
    cancel.disabled = true;
    try {
      const result = await request<{ phase: string }>("LEARNING_CANCEL", {
        id: draft.pending.asset.id,
      });
      status.textContent =
        result.phase === "committing"
          ? "正在提交，等待实际保存结果。"
          : "正在确认取消结果。";
    } catch {
      status.textContent = "连接已中断，等待保存结果后再重试。";
    }
  };
  save.onclick = async () => {
    if (busy || saved || !prepared) return;
    if (!persistDraft()) return;
    if (!draft.pending) {
      const now = Date.now();
      const pending = {
        prepared,
        asset: {
          id: newLearningId(),
          kind,
          createdAt: now,
          updatedAt: now,
          video: prepared.capture.video,
          part: prepared.capture.part,
          personal: { title: title.value, note: note.value, tags: [] },
          snapshot: prepared.snapshot ?? null,
          bookmarkMs: prepared.capture.bookmarkMs,
          importedFrom: null,
        },
      };
      try { const next = { ...draft, pending }; drafts.put(draftKey!, next); draft = next; }
      catch (error) { status.textContent = (error as Error).message; return; }
    }
    busy = true;
    const pending = draft.pending!;
    save.disabled = true;
    close.disabled = true;
    title.disabled = true;
    note.disabled = true;
    cancel.hidden = false;
    cancel.disabled = false;
    status.textContent = "正在保存；提交后无法取消。";
    try {
      await request("LEARNING_SAVE", {
        epoch: pending.prepared.epoch,
        token: pending.prepared.capture.token,
        asset: pending.asset,
      });
      status.textContent = "已保存";
      saved = true;
      save.textContent = "已保存";
      draft.pending = undefined;
      draft.title = "";
      draft.note = "";
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "保存结果待确认，请重试。";
      save.textContent = "重试确认";
      // A transport failure may follow a committed write. Keep the identical ID/content until acknowledged.
      if (
        status.textContent.includes("已取消") ||
        status.textContent.includes("已变化") ||
        status.textContent.includes("空间已满")
      ) {
        draft.pending = undefined;
        title.disabled = false;
        note.disabled = false;
        save.textContent = "保存";
        if (status.textContent.includes("已变化")) {
          prepared = undefined;
          recheck.hidden = false;
        }
      }
    } finally {
      busy = false;
      close.disabled = false;
      cancel.hidden = true;
      save.disabled = saved || !prepared;
    }
  };
}
