import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkerReport } from "../scripts/lg0/verify-worker-report.mjs";
import { SCENARIOS, SEED } from "../scripts/lg0/fixtures.mjs";
import { MAX_BYTES, MAX_FILE_BYTES } from "../scripts/lg0/learning-lab.mjs";

function report() {
  const runs = SCENARIOS.flatMap(scenario => {
    const count = scenario === "empty" ? 0 : scenario === "typical" ? 30 : scenario === "single-large" ? 1 : 1000;
    const bytes = ["byte-limit", "single-large"].includes(scenario) ? MAX_BYTES : 2 + count * 400;
    return ["cold", "warm"].flatMap(mode => Array.from({ length: mode === "cold" ? 3 : 5 }, (_, i) => ({
      scenario, mode, repetition: i + 1, count, searchCount: count, bytes,
      fileBytes: bytes + MAX_FILE_BYTES - MAX_BYTES, fileHash: "b".repeat(64),
      fullDigestMatches: true, idempotentStateUnchanged: true,
      seeded: { count, bytes, digest: "a".repeat(64), legacyPreserved: true, legacyTables: 21 },
      stages: ["search", "export", "restore-fresh", "restore-idempotent"].map(name => ({ name, elapsedMs: 100,
        phases: name === "search" ? [] : name === "export" ? [{ phase: "reading", elapsedMs: 1 }, { phase: "encoding", elapsedMs: 5 }]
          : [{ phase: "parsing", elapsedMs: 1 }, { phase: "prepared", elapsedMs: 10 }, { phase: "committing", elapsedMs: 15 }, { phase: "committed", elapsedMs: 90 }] })),
      longTasks: [], memory: { samples: [0, 1].map(n => ({ timestampMs: n * 30, sampleDurationMs: 1,
        pageUsedBytes: 100, workerUsedBytes: 100 + n, combinedUsedBytes: 200 + n, backingStorageBytes: 0 })),
        sampledCombinedHeapPeakBytes: 201, sampledCombinedHeapGrowthBytes: 1, maximumSampleGapMs: 30 },
    })));
  });
  return { kind: "formal-worker-matrix", status: "measured", sourceRevisionState: "clean", sourceEncoding: "utf8-lf",
    seed: SEED, scenarios: SCENARIOS, runsPerScenario: { cold: 3, warm: 5 },
    limits: { assets: 1000, logicalBytes: MAX_BYTES, inputBytes: MAX_FILE_BYTES, coldSearchMs: 2000,
      warmSearchMs: 500, mainThreadMs: 200, progressGapMs: 2000, sampledCombinedHeapGrowthBytes: 256 * 1024 * 1024 },
    profileCount: 18, profilesRemoved: 18, errors: [], networkRejected: 0,
    browser: { product: "Chrome/152.0.7977.77" }, runs };
}

test("LG-0 Worker matrix evaluates candidates without unlocking production", () => {
  const verdict = evaluateWorkerReport(report());
  assert.equal(verdict.artifactStatus, "pass");
  assert.equal(verdict.candidatePerformanceStatus, "pass");
  assert.equal(verdict.lg1Unlocked, false);
});
test("LG-0 Worker verifier rejects omissions, dirty bindings and main-only memory", () => {
  for (const mutate of [r => r.runs.pop(), r => { r.sourceRevisionState = "working-tree-snapshot"; },
    r => { r.profilesRemoved = 17; }, r => { r.runs[0].memory.samples[0].combinedUsedBytes = 999; },
    r => { r.runs[0].memory.samples.forEach(s => { s.workerUsedBytes = 0; }); }]) {
    const input = report(); mutate(input); assert.throws(() => evaluateWorkerReport(input));
  }
});
test("LG-0 Worker timing failures remain failures instead of artifact failures", () => {
  const input = report();
  input.runs[0].stages[0].elapsedMs = 2001;
  input.runs[0].longTasks.push({ startMs: 0, durationMs: 201 });
  const verdict = evaluateWorkerReport(input);
  assert.equal(verdict.artifactStatus, "pass");
  assert.equal(verdict.candidatePerformanceStatus, "fail");
  assert.ok(verdict.failures.some(f => f.target === "coldP95Ms"));
  assert.ok(verdict.failures.some(f => f.target === "maximumMainTaskMs"));
});
test("LG-0 Worker progress covers the whole cancellable export interval", () => {
  const input = report();
  input.runs[0].stages[1].elapsedMs = 2006;
  assert.ok(evaluateWorkerReport(input).failures.some(f => f.target === "progress"));
  input.runs[0].stages[1].elapsedMs = 2005;
  assert.equal(evaluateWorkerReport(input).candidatePerformanceStatus, "pass");
});

test("LG-0 Worker verifier refuses unmeasured commits and sparse heap evidence", () => {
  const missingEnd = report();
  missingEnd.runs[0].stages[2].phases.pop();
  assert.throws(() => evaluateWorkerReport(missingEnd), /unmeasured commit end/);
  const sparse = report();
  sparse.runs[0].memory.samples[1].timestampMs = 251;
  sparse.runs[0].memory.maximumSampleGapMs = 251;
  assert.equal(evaluateWorkerReport(sparse).candidatePerformanceStatus, "insufficient_evidence");
});
