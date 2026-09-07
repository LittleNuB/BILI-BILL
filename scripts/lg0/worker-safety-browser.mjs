import { LearningWorkerClient } from "./worker-client.mjs";
import { fixture } from "./fixtures.mjs";
import { encodeBackup, MAX_BYTES, MAX_FILE_BYTES } from "./learning-lab.mjs";

let client;
let name;
let incoming;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, reason) => { if (!ok) throw new Error(reason); };

async function connect(databaseName) {
  client?.dispose();
  name = databaseName;
  client = new LearningWorkerClient("/worker.js", name);
  await client.ready;
}

globalThis.safety = {
  async setup(databaseName) {
    await connect(databaseName);
    const file = await client.request("fixture", { scenario: "typical" });
    const state = await client.request("state");
    await client.request("restore", { file, epoch: state.epoch });
    const changed = fixture("typical");
    changed.forEach(row => { row.personal.note += " changed incoming content"; });
    incoming = new Blob([await encodeBackup(changed)]);
    return client.request("state");
  },
  async reopen(databaseName) {
    await connect(databaseName);
    return client.request("state");
  },
  async cancel(command, phaseToCancel) {
    // Export must operate on the actual capacity-sized database too.
    const original = await client.request("export");
    const file = await client.request("fixture", { scenario: "single-large" });
    if (command === "export") {
      await client.request("clear");
      const empty = await client.request("state");
      await client.request("restore", { file, epoch: empty.epoch });
    }
    const before = await client.request("state");
    check(file.size === MAX_FILE_BYTES, "cancel_input_not_at_capacity");
    if (command === "export") check(before.bytes === MAX_BYTES, "cancel_export_not_at_capacity");
    const phases = [];
    const controller = new AbortController();
    let requested;
    let error;
    const start = performance.now();
    try {
      await client.request(command, { file, epoch: before.epoch }, {
        signal: controller.signal,
        onPhase: phase => {
          phases.push({ phase, elapsedMs: performance.now() - start });
          if (phase === phaseToCancel && requested === undefined) {
            requested = performance.now();
            controller.abort();
          }
        },
      });
    } catch (failure) { error = failure.message; }
    const acknowledged = performance.now();
    check(requested !== undefined && error === "cancelled", "cancel_not_observed");
    const after = await client.request("state");
    await delay(Math.max(0, requested + 2100 - performance.now()));
    const later = await client.request("state");
    check(same(before, after) && same(before, later), "cancel_late_write");
    const result = { command, phaseToCancel, phases, error, fileBytes: file.size,
      before, after, later,
      acknowledgementMs: acknowledged - requested,
      afterCheckMs: performance.now() - requested, stateUnchanged: true };
    if (command === "export") {
      await client.request("clear");
      const empty = await client.request("state");
      await client.request("restore", { file: original, epoch: empty.epoch });
    }
    return result;
  },
  async startInterruption(phaseToHold) {
    const before = await client.request("state");
    globalThis.interruptionPhase = null;
    globalThis.interruptionOutcome = null;
    void client.request("restore", { file: incoming, epoch: before.epoch, holdAfterWrite: phaseToHold === "written" }, {
      onPhase: phase => {
        if (phase === phaseToHold) globalThis.interruptionPhase = phase;
      },
    }).then(result => { globalThis.interruptionOutcome = result; },
      error => { globalThis.interruptionOutcome = { error: error.message }; });
    return before;
  },
  async quota() {
    const before = await client.request("state");
    const rows = fixture("single-large");
    rows[0].id = "f".repeat(64);
    // Deterministic, low-compression input for browser quota accounting.
    const bytes = new Uint8Array(9 * 1024 * 1024);
    let seed = 0x140927;
    for (let i = 0; i < bytes.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      bytes[i] = 65 + (seed >>> 24) % 26;
    }
    rows[0].personal.note = new TextDecoder().decode(bytes);
    const file = new Blob([await encodeBackup(rows)]);
    let error;
    let errorName;
    let errorNames;
    try { await client.request("restore", { file, epoch: before.epoch }); }
    catch (failure) { error = failure.message; errorName = failure.name; errorNames = failure.errorNames; }
    const after = await client.request("state");
    check(errorNames?.includes("QuotaExceededError"), `browser_quota_not_enforced:${JSON.stringify(errorNames)}:${error ?? "write_succeeded"}`);
    check(same(before, after), "quota_partial_write");
    return { errorName, errorNames, reason: error, fileBytes: file.size, stateUnchanged: true, before, after };
  },
  async recover() {
    const before = await client.request("state");
    const restored = await client.request("restore", { file: incoming, epoch: before.epoch });
    const after = await client.request("state");
    check(restored.count === 60 && after.count === 60, "post_fault_restore_failed");
    await client.request("restore", { file: incoming, epoch: before.epoch });
    check(same(after, await client.request("state")), "post_fault_not_idempotent");
    return { restoredCount: 60, idempotent: true, state: after };
  },
  async adversarial(scenario) {
    const text = scenario === "over-file-limit" ? "x".repeat(MAX_FILE_BYTES + 1)
      : scenario === "wide-array" ? ("[" + "0,".repeat(4097) + "0]").padEnd(MAX_FILE_BYTES, " ")
        : scenario === "malformed-max" ? '{"assets":"'.padEnd(MAX_FILE_BYTES, "x")
          : null;
    check(text !== null, "unknown_adversarial_case");
    const before = await client.request("state");
    const file = new Blob([text]);
    let error;
    const start = performance.now();
    try { await client.request("restore", { file, epoch: before.epoch }); }
    catch (failure) { error = failure.message; }
    const elapsedMs = performance.now() - start;
    check(Boolean(error) && same(before, await client.request("state")), "invalid_input_changed_state");
    const after = await client.request("state");
    return { scenario, error, elapsedMs, fileBytes: file.size, before, after, stateUnchanged: true };
  },
  dispose() { client?.dispose(); },
};
