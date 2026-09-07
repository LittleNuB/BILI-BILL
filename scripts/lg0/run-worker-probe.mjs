import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const runId =
  new Date().toISOString().replace(/[:.]/g, "-") +
  "-" +
  randomBytes(4).toString("hex");
const directory = path.join(root, "release-artifacts", "lg0-worker", runId);
await mkdir(directory, { recursive: true });
const sources = {};
for (const input of [
  "scripts/lg0/learning-lab.mjs",
  "scripts/lg0/fixtures.mjs",
  "scripts/lg0/learning-worker.mjs",
  "scripts/lg0/worker-client.mjs",
  "scripts/lg0/worker-probe-browser.mjs",
  "scripts/lg0/run-worker-probe.mjs",
  "docs/architecture/lg0-bounded-learning-contract.md",
  "package-lock.json",
])
  sources[input] = sha(
    (await readFile(path.join(root, input), "utf8")).replace(/\r\n/g, "\n"),
  );
const bundles = {};
for (const [url, entry] of [
  ["/probe.js", "worker-probe-browser.mjs"],
  ["/worker.js", "learning-worker.mjs"],
]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/lg0/" + entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "chrome152",
  });
  bundles[url] = result.outputFiles[0].contents;
}
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><meta charset="utf-8"><title>LG-0 synthetic Worker probe</title><script type="module" src="/probe.js"></script>',
    );
  } else if (bundles[request.url]) {
    response.setHeader("Content-Type", "text/javascript");
    response.end(bundles[request.url]);
  } else {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = path.join(directory, "synthetic-profile");
const report = {
  kind: "targeted-worker-probe",
  runId,
  baselineCommit: git("rev-parse", "HEAD"),
  sourceRevisionState: git("status", "--porcelain")
    ? "working-tree-snapshot"
    : "clean",
  sourceEncoding: "utf8-lf",
  sources,
  bundles: Object.fromEntries(
    Object.entries(bundles).map(([key, bytes]) => [key, sha(bytes)]),
  ),
  formalGateStatus: "not_evaluated",
  lg1Unlocked: false,
  measurement:
    "One fresh synthetic profile; three databases/workers; one fresh and one no-op restore each. No forced GC. CDP sampled JS heaps include page and Worker; sampling can miss peaks; not RSS. No p95 inference. Integrity/export checks excluded from restore timing. Not directly comparable to the old multi-stage main-thread pipeline.",
  runs: [],
};
let context;
let sampling;
let samplingDone;
try {
  assert.ok(
    process.env.LG0_PLAYWRIGHT_MODULE && process.env.LG0_CHROME_EXECUTABLE,
    "explicit test runtime required",
  );
  const { chromium } = await import(
    pathToFileURL(process.env.LG0_PLAYWRIGHT_MODULE).href
  );
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.LG0_CHROME_EXECUTABLE,
    headless: true,
    args: ["--no-first-run", "--disable-background-networking"],
  });
  await context.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(origin + "/")
      ? route.continue()
      : route.abort(),
  );
  const page = context.pages()[0] ?? (await context.newPage());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const workers = new Set();
  const pending = new Map();
  let sequence = 0;
  cdp.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type === "worker") workers.add(sessionId);
  });
  cdp.on("Target.detachedFromTarget", ({ sessionId }) =>
    workers.delete(sessionId),
  );
  cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
    const data = JSON.parse(message);
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    clearTimeout(waiter.timer);
    if (data.error) waiter.reject(new Error(data.error.message));
    else waiter.resolve(data.result);
  });
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  const workerHeap = (sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("worker_heap_timeout"));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      cdp
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method: "Runtime.getHeapUsage" }),
        })
        .catch((error) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });
    });
  const sample = async () => {
    assert.equal(workers.size, 1, "exactly one measured Worker required");
    const started = performance.now();
    const main = await cdp.send("Runtime.getHeapUsage");
    const worker = await workerHeap([...workers][0]);
    return {
      timestamp: performance.now(),
      sampleDurationMs: performance.now() - started,
      pageUsedBytes: main.usedSize,
      workerUsedBytes: worker.usedSize,
      combinedUsedBytes: main.usedSize + worker.usedSize,
      combinedBackingStorageBytes:
        (main.backingStorageSize ?? 0) + (worker.backingStorageSize ?? 0),
    };
  };
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.workerProbe);
  report.browser = await cdp.send("Browser.getVersion");
  for (const scenario of ["byte-limit", "single-large", "references"]) {
    const setup = await page.evaluate(
      ([scenario, name]) => workerProbe.setup(scenario, name),
      [
        scenario,
        "lg0-worker-" + scenario + "-" + randomBytes(4).toString("hex"),
      ],
    );
    let previous;
    for (const operation of ["fresh", "idempotent"]) {
      const samples = [await sample()];
      sampling = true;
      samplingDone = (async () => {
        while (sampling) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (sampling) samples.push(await sample());
        }
      })();
      let measured;
      try {
        measured = await page.evaluate(() => workerProbe.run());
      } finally {
        sampling = false;
        await samplingDone;
      }
      samples.push(await sample());
      const verified = await page.evaluate(
        (scenario) => workerProbe.verify(scenario),
        scenario,
      );
      assert.equal(verified.count, scenario === "single-large" ? 1 : 1000);
      if (scenario !== "references") assert.equal(verified.bytes, 10485760);
      if (previous)
        assert.deepEqual(
          verified,
          previous,
          "no-op preserves full state and revision",
        );
      previous = verified;
      const peak = Math.max(...samples.map((value) => value.combinedUsedBytes));
      const run = {
        scenario,
        operation,
        fileBytes: setup.fileBytes,
        ...measured,
        verified,
        sampledCombinedHeapPeakBytes: peak,
        sampledCombinedHeapGrowthBytes: Math.max(
          0,
          peak - samples[0].combinedUsedBytes,
        ),
        samples,
      };
      report.runs.push(run);
      console.log(
        JSON.stringify({
          scenario,
          operation,
          elapsedMs: run.elapsedMs,
          maxTaskMs: Math.max(
            0,
            ...run.longTasks.map((task) => task.durationMs),
          ),
          peak,
          growth: run.sampledCombinedHeapGrowthBytes,
        }),
      );
    }
    if (scenario === "references") {
      report.safety = await page.evaluate(() => workerProbe.safety());
      report.inputSafety = await page.evaluate(() =>
        workerProbe.rejectMalformedInputs(),
      );
    }
    await page.evaluate(() => workerProbe.dispose());
  }
  assert.deepEqual(errors, []);
  report.functionalStatus = "pass";
} catch (error) {
  report.functionalStatus = "fail";
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  sampling = false;
  await samplingDone?.catch(() => {});
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  // Only the fresh profile created by this invocation is eligible for cleanup.
  try {
    const actual = await realpath(profile);
    const parent = await realpath(directory);
    assert.equal(path.dirname(actual), parent);
    assert.equal(path.basename(actual), "synthetic-profile");
    await rm(actual, { recursive: true });
    report.profileRemoved = true;
  } catch (error) {
    report.profileRemoved = false;
    report.cleanupError = error.message;
  }
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      directory,
      functionalStatus: report.functionalStatus,
      error: report.error,
      profileRemoved: report.profileRemoved,
    }),
  );
}
