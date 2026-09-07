import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkerSafety } from "../scripts/lg0/verify-worker-safety.mjs";
import { MAX_BYTES, MAX_FILE_BYTES } from "../scripts/lg0/learning-lab.mjs";

function report() {
  const state = { key: "state", epoch: 0, revision: 1, count: 30, bytes: 10053, digest: "a".repeat(64) };
  const recovered = { ...state, revision: 2, count: 60, bytes: 37717, digest: "b".repeat(64) };
  return {
    kind: "worker-safety", status: "pass", sourceRevisionState: "clean", sourceEncoding: "utf8-lf",
    profileRemoved: true, networkRejected: 0, errors: [], browser: { product: "Chrome/152.0.7977.77" },
    adversarial: ["over-file-limit", "wide-array", "malformed-max"].map(scenario => ({
      scenario, before: { ...state }, after: { ...state }, elapsedMs: 10,
      error: scenario === "over-file-limit" ? "file_size" : scenario === "wide-array" ? "json_resource_limit" : "invalid_json",
      fileBytes: MAX_FILE_BYTES + (scenario === "over-file-limit" ? 1 : 0),
      memory: { samples: [0, 1].map(n => ({ timestampMs: n * 30, sampleDurationMs: 1, pageUsedBytes: 100,
        workerUsedBytes: 100 + n, combinedUsedBytes: 200 + n, backingStorageBytes: 0 })),
        sampledCombinedHeapPeakBytes: 201, sampledCombinedHeapGrowthBytes: 1, maximumSampleGapMs: 30 },
    })),
    cancellations: ["restore", "export"].map(command => {
      const before = command === "export" ? { ...state, count: 1, bytes: MAX_BYTES } : { ...state };
      const phase = command === "export" ? "encoding" : "decoding";
      return { command, phaseToCancel: phase, fileBytes: MAX_FILE_BYTES, error: "cancelled",
        phases: [{ phase, elapsedMs: 1 }], acknowledgementMs: 100, afterCheckMs: 2100,
        before, after: { ...before }, later: { ...before } };
    }),
    rendererCrash: { phase: "after-bulkPut-before-meta", eventObserved: true, before: { ...state }, after: { ...state } },
    quota: { method: "Storage.overrideQuotaForOrigin", overrideActive: true, reportedQuota: 101, quotaSize: 101,
      cacheExpiryWaitMs: 31000, errorNames: ["AbortError", "QuotaExceededError"], fileBytes: 9 * 1024 ** 2 + 100,
      before: { ...state }, after: { ...state } },
    recovery: { restoredCount: 60, idempotent: true, state: recovered }, reopenedState: { ...recovered }, reopenedFullDigestMatches: true,
  };
}

test("LG-0 safety checks typed quota, real crash and capacity-sized cancellation without unlocking production", () => {
  const verdict = evaluateWorkerSafety(report());
  assert.equal(verdict.candidateSafetyStatus, "pass");
  assert.equal(verdict.lg1Unlocked, false);
});

test("LG-0 safety rejects weak or incomplete fault receipts", () => {
  for (const mutate of [r => { r.sourceRevisionState = "working-tree-snapshot"; }, r => { r.profileRemoved = false; },
    r => { r.quota.errorNames = ["AbortError"]; r.quota.reason = "quota error"; },
    r => { r.cancellations[1].before.bytes = 100; }, r => { r.cancellations[0].phaseToCancel = "before-decode"; },
    r => { r.cancellations[0].later.digest = "c".repeat(64); }, r => { r.cancellations[0].acknowledgementMs = 1001; },
    r => { r.rendererCrash.eventObserved = false; }, r => { r.quota.overrideActive = false; },
    r => { r.reopenedState.revision++; }, r => { r.adversarial.pop(); }]) {
    const input = report(); mutate(input); assert.throws(() => evaluateWorkerSafety(input));
  }
});

test("LG-0 invalid-input memory does not pass with sparse or over-budget measurements", () => {
  const sparse = report();
  sparse.adversarial[0].memory.samples[1].timestampMs = 251;
  sparse.adversarial[0].memory.maximumSampleGapMs = 251;
  assert.equal(evaluateWorkerSafety(sparse).candidateSafetyStatus, "insufficient_evidence");
  const large = report(); const memory = large.adversarial[0].memory;
  memory.samples[1].workerUsedBytes += 256 * 1024 ** 2;
  memory.samples[1].combinedUsedBytes += 256 * 1024 ** 2;
  memory.sampledCombinedHeapPeakBytes += 256 * 1024 ** 2;
  memory.sampledCombinedHeapGrowthBytes += 256 * 1024 ** 2;
  assert.equal(evaluateWorkerSafety(large).candidateSafetyStatus, "fail");
});
