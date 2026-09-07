import { useEffect, useRef, useState } from "preact/hooks";
import { LEARNING_MAX_FILE_BYTES } from "../../../src/shared/learning-backup.ts";

interface Preview {
  token: string;
  incoming: number;
  added: number;
  total: number;
  bytes: number;
}
export function LearningBackup({
  onChange,
  disabled,
}: {
  onChange: () => void;
  disabled: boolean;
}) {
  const worker = useRef<Worker | null>(null);
  const running = useRef<{ id: string; action: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [phase, setPhase] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [clear, setClear] = useState<{ token: string; count: number } | null>(
    null,
  );
  const [clearText, setClearText] = useState("");
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    const instance = new Worker(
      new URL("./learning-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = instance;
    instance.onmessage = ({ data }) => {
      const operation = running.current;
      if (!operation || data.id !== operation.id) return;
      if (data.phase) {
        setPhase(data.phase);
        return;
      }
      running.current = null;
      setBusy(false);
      setPhase("");
      if (data.error) {
        setMessage(data.error);
        return;
      }
      if (operation.action === "export") {
        const url = URL.createObjectURL(data.result.file);
        const link = document.createElement("a");
        link.href = url;
        link.download = `Bili-Bill-learning-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        setMessage("已导出学习备份（未加密）");
      } else if (operation.action === "preflight") setPreview(data.result);
      else if (operation.action === "clearPreview") {
        setClear(data.result);
        setClearText("");
      } else {
        setPreview(null);
        setClear(null);
        setMessage(
          operation.action === "restore"
            ? `已恢复，新增 ${data.result.added} 条`
            : "学习笔记已清空",
        );
        changed.current();
      }
    };
    instance.onerror = () => {
      running.current = null;
      setBusy(false);
      setPhase("");
      instance.terminate();
      worker.current = null;
      setUnavailable(true);
      setMessage("后台连接已中断，结果待确认，请刷新页面。不要重复清空操作。");
      changed.current();
    };
    const leaving = (event: BeforeUnloadEvent) => {
      if (running.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leaving);
    const navigate = (event: Event) => {
      if (running.current) {
        event.preventDefault();
        setMessage("请等待当前操作完成，或先取消操作。");
      }
    };
    window.addEventListener("bb-before-navigate", navigate);
    return () => {
      window.removeEventListener("bb-before-navigate", navigate);
      window.removeEventListener("beforeunload", leaving);
      instance.terminate();
      worker.current = null;
    };
  }, []);
  function request(action: string, params: Record<string, unknown> = {}) {
    if (running.current || !worker.current || disabled) return;
    const id = crypto.randomUUID();
    running.current = { id, action };
    setBusy(true);
    setMessage("");
    setPhase("preparing");
    worker.current.postMessage({ id, action, ...params });
  }
  return (
    <details class="learning-backup">
      <summary>备份与空间</summary>
      <div class="learning-backup-actions">
        <button
          disabled={busy || disabled || unavailable}
          onClick={() => request("export")}
        >
          导出备份
        </button>
        <button
          disabled={busy || disabled || unavailable}
          onClick={() => input.current?.click()}
        >
          导入备份
        </button>
        <button
          class="learning-delete"
          disabled={busy || disabled || unavailable}
          onClick={() => {
            setPreview(null);
            request("clearPreview");
          }}
        >
          清空学习笔记
        </button>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="选择学习备份"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            setPreview(null);
            setClear(null);
            if (file.size > LEARNING_MAX_FILE_BYTES) {
              setMessage("文件超过学习备份大小上限，未读取文件。");
              return;
            }
            request("preflight", { file });
          }}
        />
      </div>
      {busy && (
        <div role="status" class="learning-confirm">
          <span>
            {phase === "committing" || phase === "committed"
              ? "正在提交，请勿关闭页面"
              : "正在处理"}
          </span>
          <button
            disabled={phase === "committing" || phase === "committed"}
            onClick={() =>
              worker.current?.postMessage({
                id: running.current?.id,
                action: "cancel",
              })
            }
          >
            取消操作
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {preview && (
        <div class="learning-confirm" role="region" aria-label="恢复预览">
          <span>
            备份 {preview.incoming} 条，新增 {preview.added} 条；恢复后{" "}
            {preview.total} 条，{(preview.bytes / 1048576).toFixed(2)}{" "}
            MiB。本地内容保留。
          </span>
          <button
            disabled={busy || disabled || unavailable}
            onClick={() => request("restore", { token: preview.token })}
          >
            确认恢复
          </button>
          <button disabled={busy} onClick={() => setPreview(null)}>
            取消恢复
          </button>
        </div>
      )}
      {clear && (
        <div
          class="learning-confirm"
          role="region"
          aria-label="清空学习笔记确认"
        >
          <label>
            将删除全部 {clear.count} 条学习笔记，无法撤销。
            <input
              aria-label="输入清空确认"
              placeholder="输入“清空学习笔记”"
              value={clearText}
              onInput={(event) => setClearText(event.currentTarget.value)}
            />
          </label>
          <button
            disabled={
              busy || disabled || unavailable || clearText !== "清空学习笔记"
            }
            onClick={() => request("clear", { token: clear.token })}
          >
            确认清空
          </button>
          <button disabled={busy} onClick={() => setClear(null)}>
            取消清空
          </button>
        </div>
      )}
    </details>
  );
}
