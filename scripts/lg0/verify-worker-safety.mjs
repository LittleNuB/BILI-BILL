import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BYTES, MAX_FILE_BYTES } from "./learning-lab.mjs";
import { verifyWorkerBindings } from "./verify-worker-report.mjs";

export const SAFETY_BUNDLES = {
  inputs: ["scripts/lg0/learning-lab.mjs", "scripts/lg0/fixtures.mjs", "scripts/lg0/learning-worker.mjs",
    "scripts/lg0/worker-client.mjs", "scripts/lg0/worker-safety-browser.mjs", "scripts/lg0/run-worker-safety.mjs",
    "scripts/lg0/verify-worker-safety.mjs", "scripts/lg0/verify-worker-report.mjs", "scripts/lg0/worker-heap-sampler.mjs",
    "docs/architecture/lg0-bounded-learning-contract.md", "package-lock.json"],
  entries: [["/safety.js", "worker-safety-browser.mjs"], ["/worker.js", "learning-worker.mjs"]],
};
const finite = n => assert.ok(Number.isFinite(n) && n >= 0);
function state(s) {
  assert.equal(s.key, "state");
  for (const key of ["epoch", "revision", "count", "bytes"]) assert.ok(Number.isSafeInteger(s[key]) && s[key] >= 0);
  assert.ok(s.count <= 1000 && s.bytes <= MAX_BYTES);
  assert.match(s.digest, /^[a-f0-9]{64}$/);
}
export function evaluateWorkerSafety(report) {
  assert.equal(report.kind, "worker-safety");
  assert.equal(report.status, "pass");
  assert.equal(report.sourceRevisionState, "clean");
  assert.equal(report.sourceEncoding, "utf8-lf");
  assert.equal(report.profileRemoved, true);
  assert.equal(report.networkRejected, 0);
  assert.deepEqual(report.errors, []);
  assert.match(report.browser.product, /^Chrome\/\d+\.\d+\.\d+\.\d+$/);
  assert.deepEqual(report.adversarial.map(c => c.scenario), ["over-file-limit", "wide-array", "malformed-max"]);
  const evidenceGaps = [];
  const failures = [];
  for (const c of report.adversarial) {
    state(c.before); state(c.after); assert.deepEqual(c.before, c.after);
    assert.equal(c.fileBytes, MAX_FILE_BYTES + (c.scenario === "over-file-limit" ? 1 : 0));
    assert.ok(typeof c.error === "string" && c.error.length > 0);
    if (c.scenario === "over-file-limit") assert.equal(c.error, "file_size");
    if (c.scenario === "wide-array") assert.equal(c.error, "json_resource_limit");
    finite(c.elapsedMs);
    const m = c.memory;
    assert.ok(m.samples.length >= 2 && m.samples.some(s => s.workerUsedBytes > 0));
    for (const s of m.samples) {
      for (const key of ["timestampMs", "sampleDurationMs", "pageUsedBytes", "workerUsedBytes", "combinedUsedBytes", "backingStorageBytes"]) finite(s[key]);
      assert.equal(s.combinedUsedBytes, s.pageUsedBytes + s.workerUsedBytes);
    }
    const peak = Math.max(...m.samples.map(s => s.combinedUsedBytes));
    const growth = Math.max(0, peak - m.samples[0].combinedUsedBytes);
    const gap = Math.max(...m.samples.slice(1).map((s, i) => s.timestampMs - m.samples[i].timestampMs));
    finite(gap); assert.equal(m.sampledCombinedHeapPeakBytes, peak);
    assert.equal(m.sampledCombinedHeapGrowthBytes, growth); assert.equal(m.maximumSampleGapMs, gap);
    if (growth > 256 * 1024 ** 2) failures.push({ scenario: c.scenario, target: "heap_growth", actual: growth });
    if (gap > 250 || m.samples.some(s => s.sampleDurationMs > 250)) evidenceGaps.push({ scenario: c.scenario, target: "heap_sampling_gap" });
  }
  assert.deepEqual(report.cancellations.map(c => [c.command, c.phaseToCancel]), [["restore", "decoding"], ["export", "encoding"]]);
  for (const c of report.cancellations) {
    assert.equal(c.fileBytes, MAX_FILE_BYTES);
    assert.equal(c.error, "cancelled");
    assert.ok(c.phases.some(p => p.phase === c.phaseToCancel));
    assert.ok(!c.phases.some(p => p.phase === "committing"));
    finite(c.acknowledgementMs); finite(c.afterCheckMs);
    assert.ok(c.acknowledgementMs <= 1000 && c.afterCheckMs >= 2000);
    state(c.before); state(c.after); state(c.later);
    assert.deepEqual(c.before, c.after); assert.deepEqual(c.before, c.later);
    if (c.command === "export") assert.equal(c.before.bytes, MAX_BYTES);
  }
  const crash = report.rendererCrash;
  assert.equal(crash.phase, "after-bulkPut-before-meta");
  assert.equal(crash.eventObserved, true);
  state(crash.before); state(crash.after);
  assert.deepEqual(crash.before, crash.after);
  const quota = report.quota;
  assert.equal(quota.method, "Storage.overrideQuotaForOrigin");
  assert.equal(quota.overrideActive, true);
  assert.equal(quota.reportedQuota, quota.quotaSize);
  assert.ok(quota.cacheExpiryWaitMs >= 31000 && quota.quotaSize > 0);
  assert.ok(quota.errorNames.includes("QuotaExceededError"), "typed browser quota error required");
  assert.ok(quota.fileBytes > 9 * 1024 * 1024 && quota.fileBytes <= MAX_FILE_BYTES);
  state(quota.before); state(quota.after); assert.deepEqual(quota.before, quota.after);
  assert.equal(report.recovery.restoredCount, 60);
  assert.equal(report.recovery.idempotent, true);
  state(report.recovery.state); assert.equal(report.recovery.state.count, 60);
  assert.deepEqual(report.reopenedState, report.recovery.state);
  assert.equal(report.reopenedFullDigestMatches, true);
  return { artifactStatus: "pass", candidateSafetyStatus: failures.length ? "fail" : evidenceGaps.length ? "insufficient_evidence" : "pass", lg1Unlocked: false, failures, evidenceGaps,
    disclosure: "Synthetic renderer transaction crash and controlled browser quota only; not production reset or extension lifecycle acceptance." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(await readFile(process.argv[2], "utf8"));
  assert.ok(process.argv[3] === undefined || process.argv[3] === "--historical");
  const historical = process.argv[3] === "--historical";
  await verifyWorkerBindings(report, fileURLToPath(new URL("../../", import.meta.url)), historical ? report.commit : undefined, SAFETY_BUNDLES);
  console.log(JSON.stringify({ ...evaluateWorkerSafety(report), verificationScope: historical ? "historical" : "HEAD", currentGateEligible: !historical }, null, 2));
}
