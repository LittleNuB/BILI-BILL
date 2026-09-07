import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SCENARIOS, SEED } from "./fixtures.mjs";
import { MAX_BYTES, MAX_FILE_BYTES } from "./learning-lab.mjs";

export const WORKER_INPUTS = [
  "scripts/lg0/learning-lab.mjs", "scripts/lg0/fixtures.mjs", "scripts/lg0/legacy-fixture.mjs",
  "scripts/lg0/learning-worker.mjs", "scripts/lg0/worker-client.mjs", "scripts/lg0/worker-formal-browser.mjs",
  "scripts/lg0/worker-heap-sampler.mjs", "scripts/lg0/run-worker-formal.mjs", "scripts/lg0/verify-worker-report.mjs",
  "src/background/storage/db.ts", "src/background/storage/current-video-transcript-migration.ts",
  "docs/architecture/lg0-bounded-learning-contract.md", "package-lock.json",
];
const finite = v => assert.ok(Number.isFinite(v) && v >= 0, "nonnegative finite metric required");
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
export function evaluateWorkerReport(report) {
  assert.equal(report.kind, "formal-worker-matrix");
  assert.equal(report.status, "measured");
  assert.equal(report.sourceRevisionState, "clean");
  assert.equal(report.sourceEncoding, "utf8-lf");
  assert.equal(report.seed, SEED);
  assert.deepEqual(report.scenarios, SCENARIOS);
  assert.deepEqual(report.runsPerScenario, { cold: 3, warm: 5 });
  assert.deepEqual(report.limits, { assets: 1000, logicalBytes: MAX_BYTES, inputBytes: MAX_FILE_BYTES,
    coldSearchMs: 2000, warmSearchMs: 500, mainThreadMs: 200, progressGapMs: 2000,
    sampledCombinedHeapGrowthBytes: 256 * 1024 * 1024 });
  assert.equal(report.profileCount, 18);
  assert.equal(report.profilesRemoved, 18);
  assert.deepEqual(report.errors, []);
  assert.equal(report.networkRejected, 0);
  assert.match(report.browser.product, /^Chrome\/\d+\.\d+\.\d+\.\d+$/);
  assert.equal(report.runs.length, 48);
  const failures = [];
  const evidenceGaps = [];
  const summary = [];
  for (const scenario of SCENARIOS) {
    const runCommitIntervals = [];
    const runs = report.runs.filter(run => run.scenario === scenario);
    assert.equal(runs.length, 8);
    const expectedCount = scenario === "empty" ? 0 : scenario === "typical" ? 30 : scenario === "single-large" ? 1 : 1000;
    for (const mode of ["cold", "warm"]) assert.deepEqual(runs.filter(r => r.mode === mode).map(r => r.repetition).sort(),
      mode === "cold" ? [1, 2, 3] : [1, 2, 3, 4, 5]);
    for (const run of runs) {
      assert.equal(run.count, expectedCount);
      assert.equal(run.searchCount, expectedCount);
      assert.equal(run.fullDigestMatches, true);
      assert.equal(run.idempotentStateUnchanged, true);
      finite(run.bytes); finite(run.fileBytes);
      assert.ok(run.bytes <= MAX_BYTES && run.fileBytes <= MAX_FILE_BYTES);
      assert.equal(run.fileBytes - run.bytes, MAX_FILE_BYTES - MAX_BYTES);
      if (["byte-limit", "single-large"].includes(scenario)) assert.equal(run.bytes, MAX_BYTES);
      assert.match(run.fileHash, /^[a-f0-9]{64}$/);
      if (run.mode === "cold") {
        assert.equal(run.seeded.legacyPreserved, true);
        assert.equal(run.seeded.legacyTables, 21);
        assert.equal(run.seeded.count, run.count);
        assert.equal(run.seeded.bytes, run.bytes);
        assert.match(run.seeded.digest, /^[a-f0-9]{64}$/);
      }
      assert.deepEqual(run.stages.map(s => s.name), ["search", "export", "restore-fresh", "restore-idempotent"]);
      for (const stage of run.stages) {
        finite(stage.elapsedMs);
        let previous = 0;
        let committing = false;
        let commitStarted;
        for (const phase of stage.phases) {
          finite(phase.elapsedMs);
          assert.ok(phase.elapsedMs >= previous && phase.elapsedMs <= stage.elapsedMs);
          if (!committing && phase.elapsedMs - previous > 2000) failures.push({ scenario, target: "progress", actual: phase.elapsedMs - previous });
          if (["prepared", "preparing", "parsing", "before-decode"].includes(phase.phase)) {
            if (committing) {
              runCommitIntervals.push(phase.elapsedMs - commitStarted);
              committing = false;
            }
          } else if (phase.phase === "committing") {
            assert.equal(committing, false, "duplicate commit start");
            committing = true; commitStarted = phase.elapsedMs;
          } else if (phase.phase === "committed") {
            assert.equal(committing, true, "commit end without start");
            runCommitIntervals.push(phase.elapsedMs - commitStarted);
            committing = false;
          }
          previous = phase.elapsedMs;
        }
        if (stage.name !== "search") {
          assert.ok(stage.phases.length > 0);
          assert.equal(committing, false, "unmeasured commit end");
          if (!committing && stage.elapsedMs - previous > 2000) failures.push({ scenario, target: "progress", actual: stage.elapsedMs - previous });
        }
      }
      for (const task of run.longTasks) finite(task.durationMs);
      const memory = run.memory;
      assert.ok(memory.samples.length >= 2);
      for (const sample of memory.samples) {
        for (const key of ["timestampMs", "sampleDurationMs", "pageUsedBytes", "workerUsedBytes", "combinedUsedBytes", "backingStorageBytes"]) finite(sample[key]);
        assert.equal(sample.combinedUsedBytes, sample.pageUsedBytes + sample.workerUsedBytes);
      }
      const peak = Math.max(...memory.samples.map(s => s.combinedUsedBytes));
      assert.equal(memory.sampledCombinedHeapPeakBytes, peak);
      assert.equal(memory.sampledCombinedHeapGrowthBytes, Math.max(0, peak - memory.samples[0].combinedUsedBytes));
      assert.ok(memory.samples.some(s => s.workerUsedBytes > 0), "Worker heap must be included");
      const gap = Math.max(...memory.samples.slice(1).map((s, i) => s.timestampMs - memory.samples[i].timestampMs));
      finite(gap);
      assert.equal(memory.maximumSampleGapMs, gap);
      if (gap > 250 || memory.samples.some(s => s.sampleDurationMs > 250))
        evidenceGaps.push({ scenario, target: "heap_sampling_gap", maximumGapMs: gap });
    }
    const metrics = {
      scenario,
      coldP95Ms: p95(runs.filter(r => r.mode === "cold").map(r => r.stages[0].elapsedMs)),
      warmP95Ms: p95(runs.filter(r => r.mode === "warm").map(r => r.stages[0].elapsedMs)),
      maximumMainTaskMs: Math.max(0, ...runs.flatMap(r => r.longTasks.map(t => t.durationMs))),
      sampledCombinedHeapGrowthBytes: Math.max(...runs.map(r => r.memory.sampledCombinedHeapGrowthBytes)),
      maximumSampleGapMs: Math.max(...runs.map(r => r.memory.maximumSampleGapMs)),
      maximumCommitIntervalMs: Math.max(0, ...runCommitIntervals),
    };
    for (const [key, limit] of [["coldP95Ms", 2000], ["warmP95Ms", 500], ["maximumMainTaskMs", 200], ["sampledCombinedHeapGrowthBytes", 256 * 1024 * 1024]]) {
      if (metrics[key] > limit) failures.push({ scenario, target: key, actual: metrics[key], limit });
    }
    summary.push(metrics);
  }
  return { artifactStatus: "pass", candidatePerformanceStatus: failures.length ? "fail" : evidenceGaps.length ? "insufficient_evidence" : "pass",
    lg1Unlocked: false, failures, evidenceGaps, summary,
    disclosure: "Performance evidence only. Requires safety receipts and PM/reviewer acceptance; sampling is not an absolute heap/RSS guarantee. Historical receipts unchanged." };
}

export async function verifyWorkerBindings(report, root, commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), config = {}) {
  assert.equal(report.commit, commit);
  const inputs = config.inputs ?? WORKER_INPUTS;
  assert.deepEqual(Object.keys(report.sources).sort(), [...inputs].sort());
  for (const input of inputs) {
    const bytes = execFileSync("git", ["show", `${commit}:${input}`], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    const hash = createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
    assert.equal(hash, report.sources[input], `source_commit_mismatch: ${input}`);
  }
  const bundles = await buildWorkerBundles(root, commit, config);
  assert.deepEqual(report.bundles, Object.fromEntries(Object.entries(bundles).map(([url, bytes]) =>
    [url, createHash("sha256").update(bytes).digest("hex")])));
}

export async function buildWorkerBundles(root, commit, { inputs = WORKER_INPUTS,
  entries = [["/formal.js", "worker-formal-browser.mjs"], ["/worker.js", "learning-worker.mjs"]] } = {}) {
  const bundles = {};
  for (const [url, entry] of entries) {
    const result = await build({ absWorkingDir: root, entryPoints: ["scripts/lg0/" + entry],
      bundle: true, write: false, metafile: true, format: "esm", platform: "browser", target: "chrome152",
      plugins: commit ? [{ name: "bound-commit-source", setup(builder) {
        builder.onLoad({ filter: /\.(mjs|ts)$/ }, args => {
          const relative = path.relative(root, args.path).replaceAll(path.sep, "/");
          if (relative.startsWith("node_modules/") || relative.startsWith("../")) return;
          assert.ok(inputs.includes(relative), `unbound_source: ${relative}`);
          return { contents: execFileSync("git", ["show", `${commit}:${relative}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }),
            loader: relative.endsWith(".ts") ? "ts" : "js", resolveDir: path.dirname(args.path) };
        });
      } }] : [],
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      const relative = input.replaceAll("\\", "/");
      assert.ok(relative.startsWith("node_modules/") || inputs.includes(relative), `unbound_bundle_input: ${relative}`);
    }
    bundles[url] = result.outputFiles[0].contents;
  }
  return bundles;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(await readFile(process.argv[2], "utf8"));
  assert.ok(process.argv[3] === undefined || process.argv[3] === "--historical");
  const historical = process.argv[3] === "--historical";
  await verifyWorkerBindings(report, fileURLToPath(new URL("../../", import.meta.url)), historical ? report.commit : undefined);
  console.log(JSON.stringify({ ...evaluateWorkerReport(report), verificationScope: historical ? "historical" : "HEAD", currentGateEligible: !historical }, null, 2));
}
