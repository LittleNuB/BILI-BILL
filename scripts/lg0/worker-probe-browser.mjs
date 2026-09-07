import { LearningWorkerClient } from "./worker-client.mjs";

let client;
let file;
let name;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = async (blob) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
function check(ok, message) {
  if (!ok) throw new Error(message);
}

async function connect() {
  client = new LearningWorkerClient("/worker.js", name);
  await client.ready;
}

globalThis.workerProbe = {
  async setup(scenario, databaseName) {
    name = databaseName;
    await connect();
    file = await client.request("fixture", { scenario });
    const state = await client.request("state");
    check(state.count === 0 && state.epoch === 0, "fresh_database");
    return { fileBytes: file.size, before: state };
  },
  async run() {
    const tasks = [];
    const beats = [];
    const phases = [];
    const observer = new PerformanceObserver((list) =>
      tasks.push(...list.getEntries()),
    );
    observer.observe({ type: "longtask" });
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      beats.push(now - last);
      last = now;
    }, 20);
    const start = performance.now();
    let end;
    try {
      const result = await client.request(
        "restore",
        { file, epoch: 0 },
        {
          onPhase: (phase) =>
            phases.push({ phase, elapsedMs: performance.now() - start }),
        },
      );
      end = performance.now();
      beats.push(end - last);
      await delay(60);
      tasks.push(...observer.takeRecords());
      return {
        ...result,
        elapsedMs: end - start,
        phases,
        longTasks: tasks
          .filter(
            (task) =>
              task.startTime < end && task.startTime + task.duration > start,
          )
          .map((task) => ({
            startMs: task.startTime - start,
            durationMs: task.duration,
          })),
        maximumHeartbeatGapMs: Math.max(0, ...beats),
      };
    } finally {
      clearInterval(timer);
      observer.disconnect();
    }
  },
  async verify(scenario) {
    const state = await client.request("state");
    const exported = await client.request("export");
    check(exported instanceof Blob, "export_not_blob");
    check(
      (await digest(file)) === (await digest(exported)),
      "export_roundtrip",
    );
    const hits = await client.request("search", {
      query: scenario === "references" ? "Synthetic source" : "Alpha",
    });
    check(hits.length === state.count, "search_after_restore");
    return { ...state, exportMatches: true, searchCount: hits.length };
  },
  async safety() {
    await client.request("clear");
    const before = await client.request("state");
    file = await client.request("fixture", { scenario: "typical" });
    const controller = new AbortController();
    let error;
    try {
      await client.request(
        "restore",
        { file, epoch: before.epoch },
        {
          signal: controller.signal,
          onPhase: (phase) => {
            if (phase === "prepared") controller.abort();
          },
        },
      );
    } catch (failure) {
      error = failure.message;
    }
    check(error === "cancelled", "cancel_acknowledgement");
    check(
      JSON.stringify(await client.request("state")) === JSON.stringify(before),
      "cancel_partial_write",
    );
    let stopped;
    try {
      await client.request(
        "restore",
        { file, epoch: before.epoch },
        {
          onPhase: (phase) => {
            if (phase === "prepared") client.dispose();
          },
        },
      );
    } catch (failure) {
      stopped = failure.message;
    }
    check(stopped === "worker_stopped_outcome_unknown", "termination_outcome");
    await connect();
    check(
      JSON.stringify(await client.request("state")) === JSON.stringify(before),
      "termination_partial_write",
    );
    let stale;
    try {
      await client.request("restore", { file, epoch: before.epoch - 1 });
    } catch (failure) {
      stale = failure.message;
    }
    check(stale === "stale_epoch", "stale_epoch_accepted");
    const late = new AbortController();
    const committed = await client.request(
      "restore",
      { file, epoch: before.epoch },
      {
        signal: late.signal,
        onPhase: (phase) => {
          if (phase === "committing") late.abort();
        },
      },
    );
    check(
      committed.count === 30 && (await client.request("state")).count === 30,
      "late_cancel_misreported",
    );
    return {
      preparedCancelNoWrites: true,
      preparedTerminationNoWritesAfterReopen: true,
      staleEpochRejected: true,
      lateCancelReportsCommit: true,
    };
  },
  async rejectMalformedInputs() {
    const before = await client.request("state");
    const cases = [
      ["deep-arrays", "[".repeat(100000) + "]".repeat(100000)],
      ["wide-array", "[" + Array(4097).fill("0").join(",") + "]"],
      [
        "dense-containers",
        "[" +
          Array(100)
            .fill('{"x":[' + Array(4096).fill("{}").join(",") + "]}")
            .join(",") +
          "]",
      ],
    ];
    const results = [];
    for (const [label, text] of cases) {
      const hostile = new Blob([text]);
      const start = performance.now();
      let error;
      try {
        await client.request("restore", { file: hostile, epoch: before.epoch });
      } catch (failure) {
        error = failure.message;
      }
      const elapsedMs = performance.now() - start;
      check(error === "json_resource_limit", "malformed_input_not_rejected");
      check(
        JSON.stringify(await client.request("state")) ===
          JSON.stringify(before),
        "malformed_input_changed_state",
      );
      results.push({
        label,
        fileBytes: hostile.size,
        elapsedMs,
        error,
        stateUnchanged: true,
      });
    }
    return results;
  },
  dispose() {
    client?.dispose();
    file = null;
  },
};
