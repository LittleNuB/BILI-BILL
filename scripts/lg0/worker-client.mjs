export class LearningWorkerClient {
  constructor(url, name, legacyStores = {}) {
    this.worker = new Worker(url, { type: "module" });
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.worker.onmessage = ({ data }) => {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      if (data.phase) {
        try {
          entry.onPhase?.(data.phase);
        } finally {
          // Same-port ordering delivers a callback-triggered cancel before resume.
          if (data.phase === "prepared")
            this.worker.postMessage({ id: data.id, command: "resume" });
        }
        return;
      }
      this.pending.delete(data.id);
      entry.cleanup();
      if (data.error) {
        const error = new Error(data.error);
        error.name = data.errorName ?? "Error";
        error.errorNames = data.errorNames ?? [error.name];
        entry.reject(error);
      }
      else entry.resolve(data.result);
    };
    this.worker.onerror = () => this.dispose("worker_failed_outcome_unknown");
    this.worker.onmessageerror = () =>
      this.dispose("worker_message_failed_outcome_unknown");
    this.ready = this.request("init", { name, legacyStores });
  }

  request(command, payload = {}, { signal, onPhase } = {}) {
    if (this.closed) return Promise.reject(new Error("worker_closed"));
    if (signal?.aborted) return Promise.reject(new Error("cancelled"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      // Do not acknowledge cancellation locally: the worker may have committed.
      const abort = () => this.worker.postMessage({ id, command: "cancel" });
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, cleanup, onPhase });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.worker.postMessage({ id, command, payload });
      } catch (error) {
        cleanup();
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  dispose(reason = "worker_stopped_outcome_unknown") {
    this.closed = true;
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
