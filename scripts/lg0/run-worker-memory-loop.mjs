import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WORKER_INPUTS, buildWorkerBundles } from "./verify-worker-report.mjs";
import { workerHeapSampler } from "./worker-heap-sampler.mjs";

const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(process.argv.length, 2, "fixed diagnostic: one cold plus eight warm workflows");
assert.ok(process.env.LG0_PLAYWRIGHT_MODULE && process.env.LG0_CHROME_EXECUTABLE, "explicit synthetic runtime required");
const { chromium } = await import(pathToFileURL(process.env.LG0_PLAYWRIGHT_MODULE).href);
const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const directory = path.join(root, "release-artifacts", "lg0-memory-loop", runId);
await mkdir(directory, { recursive: true });
const bundles = await buildWorkerBundles(root);
const report = {
  kind: "diagnostic-worker-memory-loop", runId, baselineCommit: git("rev-parse", "HEAD"),
  sourceRevisionState: git("status", "--porcelain") ? "working-tree-snapshot" : "clean",
  sourceEncoding: "utf8-lf", sources: {},
  bundles: Object.fromEntries(Object.entries(bundles).map(([url, bytes]) => [url, sha(bytes)])),
  formalGateStatus: "not_evaluated", lg1Unlocked: false, runs: [], errors: [], networkRejected: 0,
  measurement: "Single-large actual formal workflow, one browser cold reopen and eight warm iterations; same heap sampler and all integrity readbacks. No forced GC, no peak guarantee, not a formal matrix or p95 evidence.",
};
for (const file of [...WORKER_INPUTS, "scripts/lg0/run-worker-memory-loop.mjs"])
  report.sources[file] = sha((await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n"));
await writeFile(path.join(directory, "preflight.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/" ? "text/html" : "text/javascript");
  if (request.url === "/") response.end('<!doctype html><meta charset="utf-8"><title>LG-0 memory diagnostic</title><output>0</output><script type="module" src="/formal.js"></script>');
  else if (bundles[request.url]) response.end(bundles[request.url]);
  else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = path.join(directory, "synthetic-profile");
let context;
async function launch() {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.LG0_CHROME_EXECUTABLE,
    headless: true, args: ["--disable-background-networking", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  await context.route("**/*", route => {
    if (route.request().url().startsWith(origin + "/")) return route.continue();
    report.networkRejected++; return route.abort();
  });
  const page = context.pages()[0];
  page.on("pageerror", error => report.errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const sampler = await workerHeapSampler(cdp);
  const browser = await cdp.send("Browser.getVersion");
  if (report.browser) assert.equal(browser.product, report.browser.product);
  else report.browser = browser;
  await page.goto(origin); await page.waitForFunction(() => globalThis.formal);
  return { page, sampler };
}
try {
  let runtime = await launch();
  const name = "lg0-memory-" + randomUUID();
  const seeded = await runtime.page.evaluate(name => formal.seed(name, "single-large"), name);
  await context.close(); context = null;
  runtime = await launch();
  for (let iteration = 0; iteration <= 8; iteration++) {
    const measured = await runtime.sampler.measure(() => runtime.page.evaluate(params => formal.run(params),
      { name, scenario: "single-large", mode: iteration ? "warm" : "cold", stores: seeded.stores, seeded }));
    const run = { iteration, ...measured.result, memory: measured.memory };
    report.runs.push(run);
    console.log(JSON.stringify({ iteration, growthMiB: run.memory.sampledCombinedHeapGrowthBytes / 1024 ** 2,
      maximumSampleGapMs: run.memory.maximumSampleGapMs }));
  }
  report.failures = report.runs.filter(r => r.memory.sampledCombinedHeapGrowthBytes > 256 * 1024 ** 2).map(r => r.iteration);
  report.evidenceGaps = report.runs.filter(r => r.memory.maximumSampleGapMs > 250 || r.memory.samples.some(s => s.sampleDurationMs > 250)).map(r => r.iteration);
  assert.deepEqual(report.errors, []); assert.equal(report.networkRejected, 0);
  report.diagnosticStatus = report.failures.length ? "fail" : report.evidenceGaps.length ? "insufficient_evidence" : "pass";
  if (report.diagnosticStatus !== "pass") process.exitCode = 1;
} catch (error) {
  report.diagnosticStatus = "incomplete"; report.errors.push(error.message.split("\n")[0]); process.exitCode = 1;
} finally {
  try {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    const actual = await realpath(profile);
    assert.equal(path.dirname(actual), await realpath(directory));
    assert.equal(path.basename(actual), "synthetic-profile");
    assert.ok(path.relative(root, actual).startsWith(`release-artifacts${path.sep}lg0-memory-loop${path.sep}`));
    await rm(actual, { recursive: true, maxRetries: 8, retryDelay: 250 });
    report.profileRemoved = true;
  } catch (error) {
    report.diagnosticStatus = "incomplete"; report.errors.push("cleanup: " + error.message); process.exitCode = 1;
  }
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ directory, diagnosticStatus: report.diagnosticStatus, failures: report.failures,
    evidenceGaps: report.evidenceGaps, errors: report.errors, profileRemoved: report.profileRemoved }, null, 2));
}
