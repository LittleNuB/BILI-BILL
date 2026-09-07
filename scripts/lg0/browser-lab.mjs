import * as lab from "./learning-lab.mjs";
import { fixture } from "./fixtures.mjs";
import { seedLegacy, legacySnapshot } from "./legacy-fixture.mjs";

let db;
const longTasks = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    longTasks.push({ start: entry.startTime, duration: entry.duration });
}).observe({ type: "longtask", buffered: true });

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
export async function seed(scenario) {
  const name = "lg0-browser";
  const legacy = await seedLegacy(name);
  db = await lab.openLab(name, legacy.stores);
  await lab.change(db, 0, () => fixture(scenario));
  const preserved =
    (await legacySnapshot(db, Object.keys(legacy.stores))) === legacy.before;
  const state = await lab.readState(db);
  db.close();
  db = null;
  return {
    preserved,
    count: state.assets.length,
    bytes: lab.logicalBytes(state.assets),
    legacyTables: Object.keys(legacy.stores).length,
  };
}

export async function run(scenario, mode) {
  const start = performance.now();
  const heapStart = performance.memory.usedJSHeapSize;
  const stages = [];
  async function measure(name, action) {
    const begin = performance.now();
    const result = await action();
    stages.push({
      name,
      elapsedMs: performance.now() - begin,
      heapBytes: performance.memory.usedJSHeapSize,
    });
    return result;
  }
  const ids = await measure("search", async () => {
    if (!db) db = await lab.openLab("lg0-browser");
    const result = await lab.search(db, "\u5b66\u4e60 alpha");
    document.getElementById("result").textContent = String(result.length);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return result;
  });
  const current = await lab.readState(db);
  const encoded = await measure("export", () =>
    lab.encodeBackup(current.assets),
  );
  const decoded = await measure("import-validation", () =>
    lab.decodeBackup(new Blob([encoded])),
  );
  await measure("merge-preflight", () =>
    lab.mergeAssets(current.assets, decoded),
  );
  await measure("atomic-commit", () =>
    lab.restore(db, current.meta.epoch, decoded),
  );
  const after = await lab.readState(db);
  const consistent =
    lab.canonical(after.assets) === lab.canonical(current.assets);
  const end = performance.now();
  await settle();
  return {
    scenario,
    mode,
    searchCount: ids.length,
    consistent,
    count: after.assets.length,
    bytes: lab.logicalBytes(after.assets),
    fileBytes: new TextEncoder().encode(encoded).length,
    stages,
    heapStart,
    heapEnd: performance.memory.usedJSHeapSize,
    longTasks: longTasks.filter(
      (task) => task.start >= start && task.start < end,
    ),
  };
}

export async function faults() {
  const name = "lg0-browser-faults";
  const legacy = await seedLegacy(name);
  let upgradeRejected = false;
  try {
    await lab.openLab(name, legacy.stores, { failUpgrade: true });
  } catch {
    upgradeRejected = true;
  }
  const faultDb = await lab.openLab(name, legacy.stores);
  try {
    await lab.change(faultDb, 0, () => fixture("typical"));
    const before = await lab.readState(faultDb);
    const failures = [];
    for (const fault of ["abort", "quota"]) {
      let rejected = false;
      try {
        await lab.change(faultDb, 0, () => [], { fault });
      } catch {
        rejected = true;
      }
      failures.push({
        fault,
        rejected,
        unchanged:
          lab.canonical(await lab.readState(faultDb)) === lab.canonical(before),
      });
    }
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    try {
      await lab.change(faultDb, 0, () => [], { signal: controller.signal });
    } catch {
      cancelled = true;
    }
    const cancelUnchanged =
      lab.canonical(await lab.readState(faultDb)) === lab.canonical(before);
    await lab.clearKnowledge(faultDb);
    let staleRejected = false;
    try {
      await lab.change(faultDb, 0, () => before.assets);
    } catch {
      staleRejected = true;
    }
    return {
      upgradeRejected,
      failures,
      cancelled,
      cancelUnchanged,
      staleRejected,
      legacyPreserved:
        (await legacySnapshot(faultDb, Object.keys(legacy.stores))) ===
        legacy.before,
    };
  } finally {
    await faultDb.delete();
  }
}

globalThis.lg0 = { seed, run, faults };
