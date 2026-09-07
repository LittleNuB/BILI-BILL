import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  evaluateReport,
  verifyBindings,
} from "../scripts/lg0/verify-report.mjs";

const receipt = JSON.parse(
  await readFile(
    new URL(
      "../docs/benchmarks/lg0/2026-09-06T08-18-46-671Z-a891606c/report.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("LG-0 complete artifact is not a passing performance gate", () => {
  const result = evaluateReport(receipt);
  assert.equal(result.artifactStatus, "pass");
  assert.equal(result.candidateGateStatus, "fail");
  assert.equal(result.lg1Unlocked, false);
  assert.equal(result.failures.length, 5);
});

test("LG-0 reviewed-fix diagnostic rerun retains its measured failure", async () => {
  const report = JSON.parse(
    await readFile(
      new URL(
        "../docs/benchmarks/lg0/2026-09-06T08-31-42-524Z-77f22d7e/report.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(evaluateReport(report).candidateGateStatus, "fail");
  assert.equal(report.lg0GateStatus, "fail");
});

test("LG-0 historical clean-commit matrix retains its source identity and failure", async () => {
  const report = JSON.parse(
    await readFile(
      new URL(
        "../docs/benchmarks/lg0/2026-09-06T08-40-01-622Z-324b51e8/report.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(report.sourceRevisionState, "clean");
  assert.equal(report.commit, "3040206b980477f3a9cc989b9f2117901226b513");
  // Optimizations after this measured commit do not rewrite its historical
  // receipt. The CLI verifies archived bytes against this explicit revision.
  assert.equal(evaluateReport(report).candidateGateStatus, "fail");
});

test("LG-0 verifier rejects missing or duplicated runs and bad timing/size/count receipts", () => {
  for (const mutate of [
    (report) => report.runs.pop(),
    (report) => {
      report.runs[1] = report.runs[0];
    },
    (report) => {
      report.runs[0].stages[0].elapsedMs = NaN;
    },
    (report) => {
      report.runs[0].fileBytes++;
    },
    (report) => {
      report.runs[0].count++;
    },
    (report) => {
      report.runs[0].seeded.preserved = false;
    },
    (report) => {
      report.limits.sampledHeapGrowthBytes *= 2;
    },
  ]) {
    const report = structuredClone(receipt);
    mutate(report);
    assert.throws(() => evaluateReport(report));
  }
});

test("LG-0 no measured performance failure still does not fabricate missing evidence", () => {
  const report = structuredClone(receipt);
  for (const run of report.runs) {
    run.longTasks = [];
    run.heapStart = run.heapEnd = 1;
    for (const stage of run.stages) {
      stage.heapBytes = 1;
      stage.elapsedMs = 1;
    }
  }
  assert.equal(
    evaluateReport(report).candidateGateStatus,
    "insufficient_evidence",
  );
  assert.equal(evaluateReport(report).lg1Unlocked, false);
});

test("LG-0 source allowlist prevents arbitrary reads and fails changed source bytes", async () => {
  const report = structuredClone(receipt);
  report.sources["../outside"] = "a".repeat(64);
  let read = false;
  await assert.rejects(
    verifyBindings(report, async () => {
      read = true;
      return Buffer.from("");
    }),
  );
  assert.equal(read, false);
  await assert.rejects(
    verifyBindings(receipt, async () => Buffer.from("changed")),
  );
});
