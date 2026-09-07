import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, SEED } from "./fixtures.mjs";
import { MAX_ASSETS, MAX_BYTES, MAX_FILE_BYTES } from "./learning-lab.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const p95 = (values) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const finite = (value) =>
  assert.ok(
    Number.isFinite(value) && value >= 0,
    "finite nonnegative measurement required",
  );
const STAGES = [
  "search",
  "export",
  "import-validation",
  "merge-preflight",
  "atomic-commit",
];

export function evaluateReport(report) {
  assert.equal(report.seed, SEED);
  assert.equal(report.status, "measured");
  assert.equal(report.errors.length, 0);
  assert.equal(report.networkRejected.length, 0);
  assert.deepEqual(report.scenarios, SCENARIOS);
  assert.deepEqual(report.runsPerScenario, { cold: 3, warm: 5 });
  assert.equal(report.limits.assets, MAX_ASSETS);
  assert.equal(report.limits.logicalBytes, MAX_BYTES);
  assert.equal(report.limits.inputBytes, MAX_FILE_BYTES);
  assert.equal(report.limits.sampledHeapGrowthBytes, 256 * 1024 * 1024);
  assert.match(report.browser.product, /^Chrome\/\d+\.\d+\.\d+\.\d+$/);
  assert.equal(report.runs.length, SCENARIOS.length * 8);
  assert.equal(report.faults.upgradeRejected, true);
  assert.equal(report.faults.cancelled, true);
  assert.equal(report.faults.cancelUnchanged, true);
  assert.equal(report.faults.staleRejected, true);
  assert.equal(report.faults.legacyPreserved, true);
  assert.deepEqual(
    report.faults.failures.map((x) => x.fault),
    ["abort", "quota"],
  );
  report.faults.failures.forEach((x) => {
    assert.equal(x.rejected, true);
    assert.equal(x.unchanged, true);
  });
  const summary = [];
  const failures = [];
  for (const scenario of SCENARIOS) {
    const rows = report.runs.filter((run) => run.scenario === scenario);
    assert.equal(rows.length, 8);
    for (const mode of ["cold", "warm"]) {
      const selected = rows.filter((run) => run.mode === mode);
      assert.deepEqual(
        selected.map((run) => run.repetition).sort(),
        mode === "cold" ? [1, 2, 3] : [1, 2, 3, 4, 5],
      );
    }
    for (const run of rows) {
      assert.equal(run.consistent, true);
      assert.deepEqual(
        run.stages.map((stage) => stage.name),
        STAGES,
      );
      for (const stage of run.stages) {
        finite(stage.elapsedMs);
        finite(stage.heapBytes);
      }
      finite(run.heapStart);
      finite(run.heapEnd);
      for (const task of run.longTasks) {
        finite(task.start);
        finite(task.duration);
      }
      const count =
        scenario === "empty"
          ? 0
          : scenario === "typical"
            ? 30
            : scenario === "single-large"
              ? 1
              : 1000;
      assert.equal(run.count, count);
      assert.equal(run.searchCount, count);
      finite(run.bytes);
      finite(run.fileBytes);
      assert.ok(run.bytes <= MAX_BYTES && run.fileBytes <= MAX_FILE_BYTES);
      assert.equal(run.fileBytes - run.bytes, MAX_FILE_BYTES - MAX_BYTES);
      if (["byte-limit", "single-large"].includes(scenario))
        assert.equal(run.bytes, MAX_BYTES);
      if (run.mode === "cold") {
        assert.equal(run.seeded.preserved, true);
        assert.equal(run.seeded.count, count);
        assert.equal(run.seeded.bytes, run.bytes);
        assert.equal(run.seeded.legacyTables, 21);
      }
    }
    const coldP95Ms = p95(
      rows
        .filter((row) => row.mode === "cold")
        .map((row) => row.stages[0].elapsedMs),
    );
    const warmP95Ms = p95(
      rows
        .filter((row) => row.mode === "warm")
        .map((row) => row.stages[0].elapsedMs),
    );
    const maxLongTaskMs = Math.max(
      0,
      ...rows.flatMap((row) => row.longTasks.map((task) => task.duration)),
    );
    const sampledHeapGrowthBytes = Math.max(
      0,
      ...rows.map(
        (row) =>
          Math.max(row.heapEnd, ...row.stages.map((stage) => stage.heapBytes)) -
          row.heapStart,
      ),
    );
    const item = {
      scenario,
      coldP95Ms,
      warmP95Ms,
      maxLongTaskMs,
      sampledHeapGrowthBytes,
    };
    summary.push(item);
    if (coldP95Ms > 2000)
      failures.push({
        scenario,
        target: "cold-search",
        actual: coldP95Ms,
        limit: 2000,
      });
    if (warmP95Ms > 500)
      failures.push({
        scenario,
        target: "warm-search",
        actual: warmP95Ms,
        limit: 500,
      });
    if (maxLongTaskMs > 200)
      failures.push({
        scenario,
        target: "main-thread",
        actual: maxLongTaskMs,
        limit: 200,
      });
    if (sampledHeapGrowthBytes > 256 * 1024 * 1024)
      failures.push({
        scenario,
        target: "sampled-heap-growth",
        actual: sampledHeapGrowthBytes,
        limit: 256 * 1024 * 1024,
      });
  }
  return {
    artifactStatus: "pass",
    candidateGateStatus: failures.length ? "fail" : "insufficient_evidence",
    lg1Unlocked: false,
    failures,
    summary,
    missingEvidence: [
      "in-flight progress/cancellation",
      "absolute heap and adversarial input memory",
      "process/extension crash recovery",
      "real quota exhaustion",
      "production reset protection",
    ],
  };
}

export async function verifyBindings(
  report,
  readSource = (input) => readFile(path.join(root, input)),
) {
  const expected = [
    "scripts/lg0/learning-lab.mjs",
    "scripts/lg0/fixtures.mjs",
    "scripts/lg0/legacy-fixture.mjs",
    "scripts/lg0/browser-lab.mjs",
    "scripts/lg0/run-browser.mjs",
    "docs/architecture/lg0-bounded-learning-contract.md",
    "package-lock.json",
    "src/background/storage/db.ts",
    "src/background/storage/current-video-transcript-migration.ts",
  ];
  if (Object.hasOwn(report.sources, "scripts/lg0/verify-report.mjs"))
    expected.push("scripts/lg0/verify-report.mjs");
  assert.deepEqual(Object.keys(report.sources).sort(), expected.sort());
  for (const input of expected) {
    const bytes = await readSource(input);
    const source = bytes.toString("utf8");
    const candidates =
      report.sourceEncoding === "utf8-lf"
        ? [source.replace(/\r\n/g, "\n")]
        : [bytes, source.replace(/\r?\n/g, "\r\n")];
    assert.ok(
      candidates.some(
        (value) =>
          createHash("sha256").update(value).digest("hex") ===
          report.sources[input],
      ),
      `source changed: ${input}`,
    );
  }
  return true;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, input, revision] = process.argv.slice(2);
  assert.ok(
    ["--verify", "--archive"].includes(mode) && input,
    "Use --verify|--archive <run-directory>",
  );
  const directory = path.resolve(root, input);
  const allowed =
    mode === "--archive" ? path.join(root, "release-artifacts", "lg0") : root;
  assert.ok(
    directory.startsWith(allowed + path.sep),
    "report must be inside allowed workspace",
  );
  const report = JSON.parse(
    await readFile(path.join(directory, "report.json"), "utf8"),
  );
  const preflight = JSON.parse(
    await readFile(path.join(directory, "preflight.json"), "utf8"),
  );
  assert.equal(preflight.runId, report.runId);
  assert.deepEqual(preflight.sources, report.sources);
  assert.deepEqual(preflight.browser, report.browser);
  const result = evaluateReport(report);
  if (report.sourceRevisionState === "clean") {
    assert.match(report.commit, /^[a-f0-9]{40}$/);
    await verifyBindings(report, async (input) =>
      execFileSync("git", ["show", `${report.commit}:${input}`], {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
    result.sourceCommitBindingsVerified = true;
  }
  if (revision) {
    assert.equal(mode, "--verify");
    assert.match(revision, /^[a-f0-9]{40}$/);
    execFileSync("git", ["merge-base", "--is-ancestor", revision, "HEAD"], {
      cwd: root,
    });
    await verifyBindings(report, async (input) =>
      execFileSync("git", ["show", `${revision}:${input}`], {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
    result.historicalSourceCommit = revision;
    result.currentSourceBindingsVerified = false;
    result.historicalSourceBindingsVerified = true;
  } else result.currentSourceBindingsVerified = await verifyBindings(report);
  if (mode === "--archive") {
    assert.match(report.runId, /^[0-9TZ-]+-[a-f0-9]{8}$/);
    const destination = path.join(
      root,
      "docs",
      "benchmarks",
      "lg0",
      report.runId,
    );
    await mkdir(destination, { recursive: true });
    for (const [name, data] of Object.entries({
      report,
      preflight,
      verdict: result,
    })) {
      await writeFile(
        path.join(destination, name + ".json"),
        JSON.stringify(data, null, 2) + "\n",
        { flag: "wx" },
      );
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
