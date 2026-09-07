import { LearningWorkerClient } from "./worker-client.mjs";
import { fixture } from "./fixtures.mjs";
import { openLab, change, readState, logicalBytes, canonical } from "./learning-lab.mjs";
import { seedLegacy, legacySnapshot } from "./legacy-fixture.mjs";

let client;
let databaseName;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
const check = (value, message) => { if (!value) throw new Error(message); };
const tasks = [];
new PerformanceObserver(list => tasks.push(...list.getEntries())).observe({ type: "longtask", buffered: true });
async function connect(name, stores) {
  databaseName = name;
  client = new LearningWorkerClient("/worker.js", name, stores);
  await client.ready;
}
globalThis.formal = {
  async seed(name, scenario) {
    const legacy = await seedLegacy(name);
    const db = await openLab(name, legacy.stores);
    try {
      await change(db, 0, () => fixture(scenario));
      const { assets, meta } = await readState(db);
      check(await legacySnapshot(db, Object.keys(legacy.stores)) === legacy.before, "legacy_changed");
      return { count: assets.length, bytes: logicalBytes(assets), ...meta,
        digest: await digest(new TextEncoder().encode(canonical(assets))),
        legacyPreserved: true, legacyTables: Object.keys(legacy.stores).length, stores: legacy.stores };
    } finally { db.close(); }
  },
  async run({ name, scenario, mode, stores, seeded }) {
    const stages = [];
    const start = performance.now();
    const measure = async (name, action) => {
      const begin = performance.now();
      const phases = [];
      const value = await action(phase => phases.push({ phase, elapsedMs: performance.now() - begin }));
      stages.push({ name, elapsedMs: performance.now() - begin, phases });
      return value;
    };
    const ids = await measure("search", async () => {
      if (!client) await connect(name, stores);
      check(databaseName === name, "wrong_database");
      const ids = await client.request("search", { query: "\u5b66\u4e60 alpha" });
      document.querySelector("output").textContent = String(ids.length);
      await frames();
      return ids;
    });
    const before = await client.request("state");
    check(before.digest === seeded.digest && before.count === seeded.count && before.bytes === seeded.bytes, "cold_reopen_content_changed");
    const file = await measure("export", onPhase => client.request("export", {}, { onPhase }));
    const fileHash = await digest(await file.arrayBuffer());
    await client.request("clear");
    const empty = await client.request("state");
    await measure("restore-fresh", onPhase => client.request("restore", { file, epoch: empty.epoch }, { onPhase }));
    const restored = await client.request("state");
    check(restored.digest === before.digest, "fresh_restore_changed_content");
    await measure("restore-idempotent", onPhase => client.request("restore", { file, epoch: empty.epoch }, { onPhase }));
    const after = await client.request("state");
    check(canonical(after) === canonical(restored), "idempotent_restore_changed_state");
    check(await digest(await (await client.request("export")).arrayBuffer()) === fileHash, "export_bytes_changed");
    const end = performance.now();
    await delay(60);
    return { scenario, mode, count: after.count, bytes: after.bytes, fileBytes: file.size, fileHash,
      searchCount: ids.length, fullDigestMatches: true, idempotentStateUnchanged: true,
      stages, elapsedMs: end - start,
      longTasks: tasks.filter(t => t.startTime < end && t.startTime + t.duration > start)
        .map(t => ({ startMs: t.startTime - start, durationMs: t.duration })) };
  },
  dispose() { client?.dispose(); client = null; },
};
