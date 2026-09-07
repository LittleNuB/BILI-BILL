import assert from "node:assert/strict";

export async function workerHeapSampler(cdp) {
  const workers = new Set();
  const pending = new Map();
  let sequence = 0;
  cdp.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type === "worker") workers.add(sessionId);
  });
  cdp.on("Target.detachedFromTarget", ({ sessionId }) => workers.delete(sessionId));
  cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
    const data = JSON.parse(message);
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) entry.reject(new Error(data.error.message));
    else entry.resolve(data.result);
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  const workerHeap = sessionId => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("worker_heap_timeout")); }, 5000);
    pending.set(id, { resolve, reject, timer });
    cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method: "Runtime.getHeapUsage" }) })
      .catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
  const sample = async () => {
    assert.ok(workers.size <= 1, "at most one isolated Worker required");
    const started = performance.now();
    const main = await cdp.send("Runtime.getHeapUsage");
    const worker = workers.size ? await workerHeap([...workers][0]) : { usedSize: 0 };
    return { timestampMs: performance.now(), sampleDurationMs: performance.now() - started,
      pageUsedBytes: main.usedSize, workerUsedBytes: worker.usedSize,
      combinedUsedBytes: main.usedSize + worker.usedSize,
      backingStorageBytes: (main.backingStorageSize ?? 0) + (worker.backingStorageSize ?? 0) };
  };
  return {
    async measure(action) {
      const samples = [await sample()];
      let running = true;
      let samplingError;
      const sampling = (async () => {
        try {
          while (running) {
            await new Promise(resolve => setTimeout(resolve, 25));
            if (running) samples.push(await sample());
          }
        } catch (error) { samplingError = error; }
      })();
      let result;
      try { result = await action(); }
      finally { running = false; await sampling; }
      if (samplingError) throw samplingError;
      samples.push(await sample());
      const peak = Math.max(...samples.map(s => s.combinedUsedBytes));
      return { result, memory: { samples, sampledCombinedHeapPeakBytes: peak,
        sampledCombinedHeapGrowthBytes: Math.max(0, peak - samples[0].combinedUsedBytes),
        maximumSampleGapMs: Math.max(...samples.slice(1).map((s, i) => s.timestampMs - samples[i].timestampMs)) } };
    },
  };
}
